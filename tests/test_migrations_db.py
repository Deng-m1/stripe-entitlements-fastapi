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
        "005_simplify_event_audit.sql",
        "006_invoice_ownership_and_incident_causality.sql",
    ]
    assert all(len(row["sha256"]) == 64 for row in rows)
    assert await database.schema_ready()


async def test_schema_ready_does_not_read_or_rehash_migration_contents(
    pool: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = Database(TEST_DSN)
    database.pool = pool

    def unexpected_read(path: Path) -> bytes:
        raise AssertionError(f"readiness tried to read migration contents: {path}")

    monkeypatch.setattr(Path, "read_bytes", unexpected_read)
    assert await database.schema_ready()


async def test_schema_ready_requires_known_versions_without_rehashing_files(
    pool: asyncpg.Pool,
) -> None:
    database = Database(TEST_DSN)
    database.pool = pool
    filename = "006_invoice_ownership_and_incident_causality.sql"
    async with pool.acquire() as conn:
        original = await conn.fetchval(
            "select sha256 from schema_migrations where filename=$1", filename
        )
        assert original is not None
        await conn.execute("delete from schema_migrations where filename=$1", filename)
    assert not await database.schema_ready()
    async with pool.acquire() as conn:
        await conn.execute(
            "insert into schema_migrations(filename,sha256) values($1,$2)",
            filename,
            "0" * 64,
        )
    # The migration command owns checksum enforcement. A hot readiness probe only
    # checks that this binary's migration versions are present.
    assert await database.schema_ready()
    async with pool.acquire() as conn:
        await conn.execute(
            "update schema_migrations set sha256=$2 where filename=$1",
            filename,
            original,
        )


async def test_migration_runner_rejects_changed_applied_file(
    pool: asyncpg.Pool, tmp_path: Path
) -> None:
    migration_dir = tmp_path / "migrations"
    shutil.copytree(ROOT / "migrations", migration_dir)
    filename = "007_checksum_probe.sql"
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
            "insert into schema_migrations(filename,sha256) values('007_removed.sql',$1)",
            "a" * 64,
        )
    assert await database.schema_ready()
    async with pool.acquire() as conn:
        await conn.execute("delete from schema_migrations where filename='007_removed.sql'")
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


async def test_invoice_owner_migration_explicitly_restricts_account_deletion_and_rebind(
    pool: asyncpg.Pool,
) -> None:
    owner_id = uuid.uuid4()
    other_id = uuid.uuid4()
    async with pool.acquire() as conn:
        await conn.executemany(
            "insert into billing_accounts(id,external_ref) values($1,$2)",
            [(owner_id, f"owner-{owner_id}"), (other_id, f"other-{other_id}")],
        )
        await conn.execute(
            """insert into stripe_invoice_state(invoice_id,account_id,amount_total)
                 values('in_retained_owner',$1,1900)""",
            owner_id,
        )
        with pytest.raises(asyncpg.ForeignKeyViolationError):
            async with conn.transaction():
                await conn.execute("delete from billing_accounts where id=$1", owner_id)
        with pytest.raises(asyncpg.RaiseError, match="immutable once assigned"):
            async with conn.transaction():
                await conn.execute(
                    """update stripe_invoice_state set account_id=$2
                         where invoice_id='in_retained_owner' and account_id=$1""",
                    owner_id,
                    other_id,
                )
        retained = await conn.fetchval(
            "select account_id from stripe_invoice_state where invoice_id='in_retained_owner'"
        )
        causal_index = await conn.fetchval(
            "select to_regclass('billing_incidents_unresolved_account_kind_seen') is not null"
        )
    assert retained == owner_id
    assert causal_index is True


async def test_existing_five_migration_schema_upgrades_to_invoice_owner_hardening(
    tmp_path: Path,
) -> None:
    database_name = f"migration_invoice_owner_{uuid.uuid4().hex}"
    upgrade_dsn = f"{TEST_DSN.rsplit('/', 1)[0]}/{database_name}"
    first_five = tmp_path / "first-five-migrations"
    first_five.mkdir()
    for path in sorted((ROOT / "migrations").glob("*.sql"))[:5]:
        shutil.copy2(path, first_five / path.name)

    admin = await asyncpg.connect(TEST_DSN)
    try:
        await admin.execute(f'create database "{database_name}"')
    finally:
        await admin.close()

    owner_id = uuid.uuid4()
    other_id = uuid.uuid4()
    database = Database(upgrade_dsn)
    try:
        await database.connect()
        await database.apply_migrations(first_five)
        async with database.require_pool().acquire() as conn:
            await conn.executemany(
                "insert into billing_accounts(id,external_ref) values($1,$2)",
                [
                    (owner_id, f"upgrade-owner-{owner_id}"),
                    (other_id, f"upgrade-other-{other_id}"),
                ],
            )
            await conn.execute(
                """insert into stripe_invoice_state(
                       invoice_id,account_id,amount_total,amount_refunded)
                     values('in_upgrade_retained',$1,1900,475)""",
                owner_id,
            )
            await conn.execute(
                """insert into billing_incidents(kind,dedupe_key,account_id,detail)
                     values('reconciliation_failed','upgrade-incident',$1,'{}'::jsonb)""",
                owner_id,
            )

        await database.apply_migrations(ROOT / "migrations")
        await database.apply_migrations(ROOT / "migrations")
        # A draining older binary with only migrations 001-005 must accept a database
        # that is ahead by this backward-compatible migration.
        await database.apply_migrations(first_five)

        async with database.require_pool().acquire() as conn:
            retained = await conn.fetchrow(
                """select account_id,amount_total,amount_refunded
                     from stripe_invoice_state where invoice_id='in_upgrade_retained'"""
            )
            migration_rows = await conn.fetch(
                "select filename,sha256 from schema_migrations order by filename"
            )
            constraint = await conn.fetchval(
                """select pg_get_constraintdef(c.oid)
                     from pg_constraint c
                     join pg_class t on t.oid=c.conrelid
                     join pg_namespace n on n.oid=t.relnamespace
                    where n.nspname='public' and t.relname='stripe_invoice_state'
                      and c.conname='stripe_invoice_state_account_id_fkey'"""
            )
            causal_index = await conn.fetchval(
                """select indexdef from pg_indexes
                    where schemaname='public'
                      and indexname='billing_incidents_unresolved_account_kind_seen'"""
            )
            last_seen_default = await conn.fetchval(
                """select column_default from information_schema.columns
                    where table_schema='public' and table_name='billing_incidents'
                      and column_name='last_seen_at'"""
            )
            with pytest.raises(asyncpg.ForeignKeyViolationError):
                async with conn.transaction():
                    await conn.execute("delete from billing_accounts where id=$1", owner_id)
            with pytest.raises(asyncpg.RaiseError, match="immutable once assigned"):
                async with conn.transaction():
                    await conn.execute(
                        """update stripe_invoice_state set account_id=$2
                             where invoice_id='in_upgrade_retained' and account_id=$1""",
                        owner_id,
                        other_id,
                    )

        assert retained is not None and tuple(retained) == (owner_id, 1900, 475)
        assert [row["filename"] for row in migration_rows] == [
            "001_schema.sql",
            "002_plan_transitions.sql",
            "003_transition_policies.sql",
            "004_event_audit_hardening.sql",
            "005_simplify_event_audit.sql",
            "006_invoice_ownership_and_incident_causality.sql",
        ]
        assert all(len(row["sha256"]) == 64 for row in migration_rows)
        assert constraint is not None and "ON DELETE RESTRICT" in constraint
        assert causal_index is not None
        assert "WHERE (resolved_at IS NULL)" in causal_index
        assert last_seen_default == "clock_timestamp()"
    finally:
        await database.close()
        admin = await asyncpg.connect(TEST_DSN)
        try:
            await admin.execute(f'drop database if exists "{database_name}" with (force)')
        finally:
            await admin.close()


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
            async with conn.transaction():
                await conn.execute(
                    """insert into stripe_webhook_events(id,event_type,livemode,payload)
                         values('evt_missing_audit','invoice.paid',false,'{}'::jsonb)"""
                )

        await conn.execute((ROOT / "migrations/005_simplify_event_audit.sql").read_text())
        assert await conn.fetchval(
            """select exists(
                   select 1 from information_schema.columns
                    where table_schema=$1 and table_name='stripe_webhook_events'
                      and column_name='payload_sha256'
                 )""",
            schema,
        )
        assert not await conn.fetchval(
            """select exists(
                   select 1 from pg_constraint con
                   join pg_class c on c.oid=con.conrelid
                   join pg_namespace n on n.oid=c.relnamespace
                  where n.nspname=$1 and c.relname='stripe_webhook_events'
                    and con.conname in (
                      'stripe_webhook_events_payload_sha256_ck',
                      'stripe_webhook_events_payload_audit_ck'
                    )
                 )""",
            schema,
        )
        await conn.execute(
            """insert into stripe_webhook_events(id,event_type,livemode,payload)
                 values('evt_redacted_only','customer.created',false,
                        '{"id":"evt_redacted_only","type":"customer.created"}'::jsonb)"""
        )
        assert await conn.fetchval(
            "select payload_sha256 is null from stripe_webhook_events where id='evt_redacted_only'"
        )
        # A draining 0.2.1 replica still names the compatibility column in its INSERT.
        # Keep that write shape valid for this rolling-upgrade window.
        await conn.execute(
            """insert into stripe_webhook_events(
                   id,event_type,livemode,payload,payload_sha256)
                 values('evt_old_writer','customer.created',false,
                        '{"id":"evt_old_writer","type":"customer.created"}'::jsonb,$1)""",
            "a" * 64,
        )
        assert await conn.fetchval(
            "select payload_sha256=$1 from stripe_webhook_events where id='evt_old_writer'",
            "a" * 64,
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
