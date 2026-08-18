from __future__ import annotations

import asyncio
import shutil
import uuid
from pathlib import Path

import asyncpg
import pytest

from stripe_entitlements.database import Database
from tests.conftest import TEST_DSN

ROOT = Path(__file__).parents[1]


async def test_migration_runner_rejects_missing_or_empty_directory(
    pool: asyncpg.Pool, tmp_path: Path
) -> None:
    database = Database(TEST_DSN)
    database.pool = pool
    with pytest.raises(FileNotFoundError, match="does not exist"):
        await database.apply_migrations(tmp_path / "missing")
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(RuntimeError, match="contains no SQL"):
        await database.apply_migrations(empty)


async def test_migration_runner_serializes_and_records_checksums(
    pool: asyncpg.Pool,
) -> None:
    database = Database(TEST_DSN)
    database.pool = pool
    await asyncio.gather(*(database.apply_migrations(ROOT / "migrations") for _ in range(8)))
    async with pool.acquire() as conn:
        rows = await conn.fetch("select filename,sha256 from schema_migrations order by filename")
    assert [row["filename"] for row in rows] == [
        "001_schema.sql",
        "002_plan_transitions.sql",
        "003_transition_policies.sql",
        "004_event_audit_hardening.sql",
    ]
    assert all(len(row["sha256"]) == 64 for row in rows)
    assert await database.schema_ready()


async def test_schema_ready_rejects_missing_or_drifted_migration_ledger(
    pool: asyncpg.Pool,
) -> None:
    database = Database(TEST_DSN)
    database.pool = pool
    async with pool.acquire() as conn:
        original = await conn.fetchval(
            "select sha256 from schema_migrations where filename='004_event_audit_hardening.sql'"
        )
        assert original is not None
        await conn.execute(
            "delete from schema_migrations where filename='004_event_audit_hardening.sql'"
        )
    assert not await database.schema_ready()
    async with pool.acquire() as conn:
        await conn.execute(
            "insert into schema_migrations(filename,sha256) values($1,$2)",
            "004_event_audit_hardening.sql",
            "0" * 64,
        )
    assert not await database.schema_ready()
    async with pool.acquire() as conn:
        await conn.execute(
            "update schema_migrations set sha256=$2 where filename=$1",
            "004_event_audit_hardening.sql",
            original,
        )
    assert await database.schema_ready()


async def test_migration_runner_rejects_changed_applied_file(
    pool: asyncpg.Pool, tmp_path: Path
) -> None:
    migration_dir = tmp_path / "migrations"
    shutil.copytree(ROOT / "migrations", migration_dir)
    filename = "005_checksum_probe.sql"
    migration = migration_dir / filename
    migration.write_text("select 1;\n", encoding="utf-8")
    database = Database(TEST_DSN)
    database.pool = pool
    await database.apply_migrations(migration_dir)
    migration.write_text("select 2;\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="checksum changed"):
        await database.apply_migrations(migration_dir)
    async with pool.acquire() as conn:
        await conn.execute("delete from schema_migrations where filename=$1", filename)


@pytest.mark.parametrize(
    "filenames",
    [
        ["schema.sql"],
        ["001_schema.sql", "003_gap.sql"],
        ["000_zero.sql"],
        ["001_UPPER.sql"],
    ],
)
async def test_migration_runner_requires_contiguous_append_only_filenames(
    filenames: list[str], pool: asyncpg.Pool, tmp_path: Path
) -> None:
    migration_dir = tmp_path / "invalid-migrations"
    migration_dir.mkdir()
    for filename in filenames:
        (migration_dir / filename).write_text("select 1;\n", encoding="utf-8")
    database = Database(TEST_DSN)
    database.pool = pool
    with pytest.raises(RuntimeError, match="migration"):
        await database.apply_migrations(migration_dir)


async def test_migration_runner_allows_database_ahead_of_binary(
    pool: asyncpg.Pool, tmp_path: Path
) -> None:
    migration_dir = tmp_path / "older-binary-migrations"
    migration_dir.mkdir()
    for path in sorted((ROOT / "migrations").glob("*.sql"))[:3]:
        shutil.copy2(path, migration_dir / path.name)
    database = Database(TEST_DSN)
    database.pool = pool
    await database.apply_migrations(migration_dir)


async def test_schema_ready_allows_extra_forward_migration_history(
    pool: asyncpg.Pool,
) -> None:
    database = Database(TEST_DSN)
    database.pool = pool
    async with pool.acquire() as conn:
        await conn.execute(
            "insert into schema_migrations(filename,sha256) values('005_removed.sql',$1)",
            "a" * 64,
        )
    assert await database.schema_ready()
    async with pool.acquire() as conn:
        await conn.execute("delete from schema_migrations where filename='005_removed.sql'")
    assert await database.schema_ready()


async def test_schema_ready_requires_every_correctness_table(
    pool: asyncpg.Pool,
) -> None:
    database = Database(TEST_DSN)
    database.pool = pool
    async with pool.acquire() as conn:
        await conn.execute("alter table credit_debits rename to credit_debits_missing")
    try:
        assert not await database.schema_ready()
    finally:
        async with pool.acquire() as conn:
            await conn.execute("alter table credit_debits_missing rename to credit_debits")
    assert await database.schema_ready()


async def test_event_audit_migration_scrubs_legacy_full_payloads(
    pool: asyncpg.Pool,
) -> None:
    schema = f"migration_event_audit_{uuid.uuid4().hex}"
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute(f'create schema "{schema}"')
        await conn.execute(f'set local search_path to "{schema}", public')
        await conn.execute((ROOT / "migrations/001_schema.sql").read_text())
        await conn.execute((ROOT / "migrations/002_plan_transitions.sql").read_text())
        await conn.execute((ROOT / "migrations/003_transition_policies.sql").read_text())
        await conn.execute(
            """insert into stripe_webhook_events(id,event_type,livemode,payload)
                 values('evt_legacy_secret','invoice.paid',false,$1::jsonb)""",
            {
                "id": "evt_legacy_secret",
                "type": "invoice.paid",
                "data": {
                    "object": {
                        "id": "in_legacy_secret",
                        "customer_email": "legacy@example.test",
                        "confirmation_secret": {"client_secret": "pi_legacy_secret_private"},
                        "hosted_invoice_url": "https://invoice.stripe.test/private",
                    }
                },
            },
        )

        await conn.execute((ROOT / "migrations/004_event_audit_hardening.sql").read_text())

        row = await conn.fetchrow(
            """select payload,payload_sha256 from stripe_webhook_events
                 where id='evt_legacy_secret'"""
        )
        assert row is not None
        serialized = str(row["payload"])
        assert row["payload"] == {
            "id": "evt_legacy_secret",
            "type": "invoice.paid",
            "livemode": False,
            "historical_payload": "[redacted]",
        }
        assert row["payload_sha256"] is None
        for secret in (
            "legacy@example.test",
            "pi_legacy_secret_private",
            "invoice.stripe.test/private",
        ):
            assert secret not in serialized
        with pytest.raises(asyncpg.CheckViolationError):
            await conn.execute(
                """insert into stripe_webhook_events(id,event_type,livemode,payload)
                     values('evt_missing_audit','invoice.paid',false,'{}'::jsonb)"""
            )


async def test_transition_policy_migration_backfills_only_applied_closures(
    pool: asyncpg.Pool,
) -> None:
    schema = f"migration_backfill_{uuid.uuid4().hex}"
    account_id = uuid.uuid4()
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute(f'create schema "{schema}"')
        await conn.execute(f'set local search_path to "{schema}", public')
        await conn.execute((ROOT / "migrations/001_schema.sql").read_text())
        await conn.execute((ROOT / "migrations/002_plan_transitions.sql").read_text())
        await conn.execute(
            "insert into billing_accounts(id,external_ref) values($1,'migration-user')",
            account_id,
        )
        await conn.executemany(
            """insert into stripe_invoice_state(
                   invoice_id,account_id,amount_total,amount_refunded,fully_refunded)
                 values($1,$2,100,$3,$4)""",
            [
                ("in_closure_was_applied", account_id, 100, True),
                ("in_refund_arrived_before_paid", account_id, 100, True),
                ("in_near_full_blocked", account_id, 99, False),
                ("in_partial_with_normal_grant", account_id, 50, False),
            ],
        )
        await conn.executemany(
            """insert into credit_ledger(
                   account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
                   stripe_invoice_id,grant_slot)
                 values($1,0,0,$2,$3,1,$4,1)""",
            [
                (account_id, 300, "subscription_grant", "in_closure_was_applied"),
                (account_id, 0, "subscription_grant_blocked", "in_near_full_blocked"),
                (account_id, 300, "subscription_grant", "in_partial_with_normal_grant"),
            ],
        )

        await conn.execute((ROOT / "migrations/003_transition_policies.sql").read_text())

        rows = await conn.fetch(
            "select invoice_id,closure_applied from stripe_invoice_state order by invoice_id"
        )
    assert [tuple(row) for row in rows] == [
        ("in_closure_was_applied", True),
        ("in_near_full_blocked", True),
        ("in_partial_with_normal_grant", False),
        ("in_refund_arrived_before_paid", False),
    ]
