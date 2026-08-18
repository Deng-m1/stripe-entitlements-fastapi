from __future__ import annotations

import sys
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import asyncpg
import pytest

from stripe_entitlements import cli
from stripe_entitlements.config import Settings
from stripe_entitlements.resources import (
    default_migration_directory,
    default_plan_catalog_path,
)


@pytest.mark.parametrize(
    ("secret_key", "expected_livemode"),
    [("sk_test_dummy", False), ("sk_live_dummy", True)],
)
def test_cli_processor_uses_configured_mode_and_event_version(
    secret_key: str,
    expected_livemode: bool,
    pool: asyncpg.Pool,
    catalog,  # type: ignore[no-untyped-def]
) -> None:
    settings = Settings(
        database_url="postgresql://unused",
        stripe_secret_key=secret_key,
        stripe_webhook_secret="whsec_test",
        stripe_webhook_api_version="2025-12-15.clover",
        plan_catalog_path=default_plan_catalog_path(),
    )
    processor = cli._event_processor(pool, catalog, settings)
    assert processor.expected_livemode is expected_livemode
    assert processor.expected_api_version == "2025-12-15.clover"


def test_default_resources_ignore_untrusted_current_working_directory(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    shadow_catalog = tmp_path / "plans.toml"
    shadow_catalog.write_text("[plans.attacker]\n", encoding="utf-8")
    shadow_migrations = tmp_path / "migrations"
    shadow_migrations.mkdir()
    (shadow_migrations / "001_attacker.sql").write_text(
        "select 'untrusted cwd';\n", encoding="utf-8"
    )
    monkeypatch.chdir(tmp_path)

    catalog = Path(default_plan_catalog_path()).resolve()
    migrations = default_migration_directory().resolve()
    assert catalog != shadow_catalog.resolve()
    assert migrations != shadow_migrations.resolve()
    assert catalog.name == "plans.toml"
    assert (migrations / "001_schema.sql").is_file()


def test_default_repository_resources_are_complete() -> None:
    catalog = Path(default_plan_catalog_path())
    migrations = default_migration_directory()
    assert catalog.is_file()
    assert [path.name for path in sorted(migrations.glob("*.sql"))] == [
        "001_schema.sql",
        "002_plan_transitions.sql",
        "003_transition_policies.sql",
        "004_event_audit_hardening.sql",
    ]


async def test_candidate_batch_continues_after_one_failure_and_redacts_message(
    capsys: pytest.CaptureFixture[str],
) -> None:
    calls: list[str] = []

    async def operation(candidate):  # type: ignore[no-untyped-def]
        candidate_id = str(candidate["id"])
        calls.append(candidate_id)
        if candidate_id == "bad":
            raise RuntimeError("sk_test_do_not_print_this_message")
        from stripe_entitlements.types import ProcessResult

        return ProcessResult("handled", "ok", candidate_id)

    failures = await cli._run_candidate_batch(
        [{"id": "first"}, {"id": "bad"}, {"id": "last"}], operation
    )
    captured = capsys.readouterr()
    assert failures == 1
    assert calls == ["first", "bad", "last"]
    assert "RuntimeError" in captured.err
    assert "sk_test_" not in captured.err


async def test_migrate_uses_resolved_resource_and_always_closes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    migration_dir = tmp_path / "migrations"
    migration_dir.mkdir()
    calls: list[object] = []

    class FakeDatabase:
        def __init__(self, dsn: str) -> None:
            calls.append(("init", dsn))

        async def connect(self) -> None:
            calls.append("connect")

        async def apply_migrations(self, directory: Path) -> None:
            calls.append(("migrate", directory))

        async def close(self) -> None:
            calls.append("close")

    monkeypatch.setattr(cli, "get_settings", lambda: SimpleNamespace(database_url="db://test"))
    monkeypatch.setattr(cli, "Database", FakeDatabase)
    monkeypatch.setattr(cli, "default_migration_directory", lambda: migration_dir)

    await cli._migrate()
    assert calls == [
        ("init", "db://test"),
        "connect",
        ("migrate", migration_dir),
        "close",
    ]


async def test_reconcile_cli_uses_database_clock_and_excludes_attempted_accounts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[object] = []
    run_started = datetime(2026, 8, 18, tzinfo=UTC)

    class FakeDatabase:
        def __init__(self, dsn: str) -> None:
            calls.append(("database", dsn))

        async def connect(self) -> None:
            calls.append("connect")

        def require_pool(self):  # type: ignore[no-untyped-def]
            return "pool"

        async def close(self) -> None:
            calls.append("close")

    class FakeReconciliationService:
        def __init__(self, pool, processor, gateway):  # type: ignore[no-untyped-def]
            del pool, processor, gateway
            self.scan = 0

        async def database_now(self) -> datetime:
            calls.append("database_now")
            return run_started

        async def candidates(
            self,
            now,
            *,
            attempted_before=None,
            exclude_account_ids=None,
        ):  # type: ignore[no-untyped-def]
            calls.append(
                (
                    "candidates",
                    now,
                    attempted_before,
                    set(exclude_account_ids or ()),
                )
            )
            self.scan += 1
            return [{"id": "account-1"}] if self.scan == 1 else []

        async def reconcile_account(self, account_id: str):  # type: ignore[no-untyped-def]
            from stripe_entitlements.types import ProcessResult

            calls.append(("reconcile", account_id))
            return ProcessResult("handled", account_id=account_id)

    settings = SimpleNamespace(
        database_url="db://test",
        plan_catalog_path="plans.toml",
        lookup_prefix="ent",
        product_line="example-entitlements",
        stripe_secret_key="sk_test_dummy",
        stripe_webhook_secret="whsec_test",
        stripe_api_version="2026-06-24.dahlia",
        stripe_webhook_api_version="2026-06-24.dahlia",
    )
    monkeypatch.setattr(cli, "get_settings", lambda: settings)
    monkeypatch.setattr(cli, "Database", FakeDatabase)
    monkeypatch.setattr(cli.PlanCatalog, "from_toml", lambda *args: "catalog")
    monkeypatch.setattr(cli, "_event_processor", lambda *args: "processor")
    monkeypatch.setattr(cli, "StripeGateway", lambda *args, **kwargs: "gateway")
    monkeypatch.setattr(cli, "ReconciliationService", FakeReconciliationService)

    await cli._reconcile()

    candidate_calls = [
        call for call in calls if isinstance(call, tuple) and call[0] == "candidates"
    ]
    assert candidate_calls == [
        ("candidates", None, run_started, set()),
        ("candidates", None, run_started, {"account-1"}),
    ]
    assert ("reconcile", "account-1") in calls
    assert calls[-1] == "close"


@pytest.mark.parametrize("command", ["migrate", "grant-due", "reconcile"])
def test_cli_main_dispatches_each_command(command: str, monkeypatch: pytest.MonkeyPatch) -> None:
    called: list[str] = []

    async def selected() -> None:
        called.append(command)

    monkeypatch.setattr(cli, "_migrate", selected if command == "migrate" else cli._migrate)
    monkeypatch.setattr(cli, "_grant_due", selected if command == "grant-due" else cli._grant_due)
    monkeypatch.setattr(cli, "_reconcile", selected if command == "reconcile" else cli._reconcile)
    monkeypatch.setattr(sys, "argv", ["stripe-entitlements", command])
    cli.main()
    assert called == [command]
