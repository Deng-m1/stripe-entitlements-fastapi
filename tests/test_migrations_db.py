from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import uuid
from pathlib import Path

import asyncpg
import pytest

from stripe_entitlements.database import Database
from tests.conftest import TEST_DSN

ROOT = Path(__file__).parents[1]
BASELINE = "001_v3_baseline.sql"
REQUEST_SNAPSHOTS = "002_stripe_request_snapshots.sql"
CURRENT_MIGRATIONS = (BASELINE, REQUEST_SNAPSHOTS)
CORRECTNESS_TABLES = (
    "billing_accounts",
    "stripe_webhook_events",
    "stripe_invoice_state",
    "credit_ledger",
    "credit_debits",
    "credit_pack_orders",
    "credit_funding_lots",
    "credit_debit_allocations",
    "credit_pack_clawback_debts",
    "checkout_claims",
    "billing_plan_changes",
    "billing_funding_allocations",
    "billing_clawback_debts",
    "billing_incidents",
)
V4_SCHEMA_CATALOG_SHA256 = "fdd08d8cf430ceb34e9564ccedc14bd7809201bf92f5f6e259451417b4565bb5"


async def _create_database(prefix: str) -> tuple[str, str]:
    database_name = f"{prefix}_{uuid.uuid4().hex}"
    dsn = f"{TEST_DSN.rsplit('/', 1)[0]}/{database_name}"
    admin = await asyncpg.connect(TEST_DSN)
    try:
        await admin.execute(f'create database "{database_name}"')
    finally:
        await admin.close()
    return database_name, dsn


async def _drop_database(database_name: str) -> None:
    admin = await asyncpg.connect(TEST_DSN)
    try:
        await admin.execute(f'drop database if exists "{database_name}" with (force)')
    finally:
        await admin.close()


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


async def test_migration_runner_serializes_and_records_baseline_checksum(
    pool: asyncpg.Pool,
) -> None:
    database = Database(TEST_DSN)
    database.pool = pool
    await asyncio.gather(*(database.apply_migrations(ROOT / "migrations") for _ in range(8)))
    async with pool.acquire() as conn:
        rows = await conn.fetch("select filename,sha256 from schema_migrations order by filename")
    assert [row["filename"] for row in rows] == list(CURRENT_MIGRATIONS)
    assert all(len(row["sha256"]) == 64 for row in rows)
    assert await database.schema_ready()


async def test_fresh_baseline_is_safe_under_concurrent_first_apply() -> None:
    database_name, dsn = await _create_database("migration_concurrent_baseline")
    databases = [Database(dsn) for _ in range(8)]
    try:
        await asyncio.gather(*(database.connect() for database in databases))
        await asyncio.gather(
            *(database.apply_migrations(ROOT / "migrations") for database in databases)
        )
        await asyncio.gather(
            *(database.apply_migrations(ROOT / "migrations") for database in databases)
        )
        async with databases[0].require_pool().acquire() as conn:
            rows = await conn.fetch(
                "select filename,sha256 from schema_migrations order by filename"
            )
            tables = await conn.fetch(
                """select tablename from pg_tables
                    where schemaname='public' and tablename = any($1::text[])
                    order by tablename""",
                list(CORRECTNESS_TABLES),
            )
        assert [row["filename"] for row in rows] == list(CURRENT_MIGRATIONS)
        assert all(len(row["sha256"]) == 64 for row in rows)
        assert [row["tablename"] for row in tables] == sorted(CORRECTNESS_TABLES)
        assert all(await asyncio.gather(*(database.schema_ready() for database in databases)))
    finally:
        await asyncio.gather(*(database.close() for database in databases))
        await _drop_database(database_name)


async def test_failed_baseline_rolls_back_every_schema_effect(tmp_path: Path) -> None:
    database_name, dsn = await _create_database("migration_atomic_baseline")
    broken_dir = tmp_path / "broken-baseline"
    broken_dir.mkdir()
    baseline = (ROOT / "migrations" / BASELINE).read_text(encoding="utf-8")
    (broken_dir / BASELINE).write_text(
        f"{baseline}\nselect * from baseline_statement_that_must_not_exist;\n",
        encoding="utf-8",
    )
    database = Database(dsn)
    try:
        await database.connect()
        with pytest.raises(asyncpg.UndefinedTableError):
            await database.apply_migrations(broken_dir)
        async with database.require_pool().acquire() as conn:
            relations = await conn.fetchrow(
                """select to_regclass('public.schema_migrations') as history,
                          to_regclass('public.billing_accounts') as accounts,
                          to_regclass('public.billing_incidents') as incidents"""
            )
        assert relations is not None
        assert tuple(relations) == (None, None, None)

        await database.apply_migrations(ROOT / "migrations")
        assert await database.schema_ready()
    finally:
        await database.close()
        await _drop_database(database_name)


async def test_002_upgrades_legacy_rows_without_inventing_remote_request_facts(
    tmp_path: Path,
) -> None:
    database_name, dsn = await _create_database("migration_002_upgrade")
    baseline_bundle = tmp_path / "baseline-only"
    baseline_bundle.mkdir()
    shutil.copy2(ROOT / "migrations" / BASELINE, baseline_bundle / BASELINE)
    database = Database(dsn)
    account_id = uuid.uuid4()
    try:
        await database.connect()
        await database.apply_migrations(baseline_bundle)
        assert not await database.schema_ready()
        async with database.require_pool().acquire() as conn:
            await conn.execute(
                "insert into billing_accounts(id,external_ref) values($1,$2)",
                account_id,
                f"migration-legacy-{account_id}",
            )
            await conn.execute(
                """insert into checkout_claims(
                       account_id,claim_token,plan_key,plan_interval,expires_at,
                       client_request_key
                     ) values($1,$2,'starter','month',clock_timestamp()+interval '1 hour',$3)""",
                account_id,
                uuid.uuid4(),
                f"checkout-{uuid.uuid4()}",
            )
            await conn.execute(
                """insert into credit_pack_orders(
                       id,account_id,client_idempotency_key,stripe_request_key,
                       pack_key,pack_credits,price_amount,currency,expires_days,
                       price_lookup_key,claim_expires_at
                     ) values($1,$2,$3,$4,'boost_100',100000000,900,'usd',365,
                              'pack_boost_100',clock_timestamp()+interval '1 hour')""",
                uuid.uuid4(),
                account_id,
                f"pack-client-{uuid.uuid4()}",
                f"pack-stripe-{uuid.uuid4()}",
            )
            await conn.execute(
                """insert into billing_plan_changes(
                       id,account_id,idempotency_key,stripe_subscription_id,
                       from_plan_key,from_interval,target_plan_key,target_interval,
                       effective_mode,status,stripe_request_key,expected_grant_epoch,
                       expected_subscription_status,expected_cancel_at_period_end
                     ) values($1,$2,$3,'sub_legacy','starter','month','pro','month',
                              'immediate','failed',$4,0,'active',false)""",
                uuid.uuid4(),
                account_id,
                f"plan-client-{uuid.uuid4()}",
                f"plan-stripe-{uuid.uuid4()}",
            )

        await database.apply_migrations(ROOT / "migrations")
        assert await database.schema_ready()
        async with database.require_pool().acquire() as conn:
            history = await conn.fetch("select filename from schema_migrations order by filename")
            legacy = await conn.fetchrow(
                """select
                     (select request_snapshot_version from checkout_claims
                       where account_id=$1) as checkout_version,
                     (select stripe_request_snapshot from checkout_claims
                       where account_id=$1) as checkout_snapshot,
                     (select request_snapshot_version from credit_pack_orders
                       where account_id=$1) as pack_version,
                     (select stripe_request_snapshot from credit_pack_orders
                       where account_id=$1) as pack_snapshot,
                     (select request_snapshot_version from billing_plan_changes
                       where account_id=$1) as plan_version,
                     (select stripe_request_snapshot from billing_plan_changes
                       where account_id=$1) as plan_snapshot""",
                account_id,
            )
        assert [row["filename"] for row in history] == list(CURRENT_MIGRATIONS)
        assert legacy is not None
        assert tuple(legacy) == (None, None, None, None, None, None)
    finally:
        await database.close()
        await _drop_database(database_name)


async def test_failed_002_rolls_back_columns_constraints_and_history(tmp_path: Path) -> None:
    database_name, dsn = await _create_database("migration_002_atomic")
    baseline_bundle = tmp_path / "baseline"
    broken_bundle = tmp_path / "broken-002"
    baseline_bundle.mkdir()
    broken_bundle.mkdir()
    shutil.copy2(ROOT / "migrations" / BASELINE, baseline_bundle / BASELINE)
    shutil.copy2(ROOT / "migrations" / BASELINE, broken_bundle / BASELINE)
    migration = (ROOT / "migrations" / REQUEST_SNAPSHOTS).read_text(encoding="utf-8")
    (broken_bundle / REQUEST_SNAPSHOTS).write_text(
        f"{migration}\nselect * from migration_002_statement_that_must_not_exist;\n",
        encoding="utf-8",
    )
    database = Database(dsn)
    try:
        await database.connect()
        await database.apply_migrations(baseline_bundle)
        with pytest.raises(asyncpg.UndefinedTableError):
            await database.apply_migrations(broken_bundle)
        async with database.require_pool().acquire() as conn:
            history = await conn.fetch("select filename from schema_migrations order by filename")
            snapshot_columns = await conn.fetchval(
                """select count(*) from information_schema.columns
                     where table_schema='public'
                       and table_name in (
                         'checkout_claims','credit_pack_orders','billing_plan_changes'
                       )
                       and column_name in (
                         'request_snapshot_version','stripe_request_snapshot'
                       )"""
            )
        assert [row["filename"] for row in history] == [BASELINE]
        assert snapshot_columns == 0

        await database.apply_migrations(ROOT / "migrations")
        assert await database.schema_ready()
    finally:
        await database.close()
        await _drop_database(database_name)


async def test_002_enforces_reserved_and_frozen_snapshot_states(
    pool: asyncpg.Pool,
) -> None:
    account_id = uuid.uuid4()
    pack_id = uuid.uuid4()
    plan_change_id = uuid.uuid4()
    async with pool.acquire() as conn:
        await conn.execute(
            "insert into billing_accounts(id,external_ref) values($1,$2)",
            account_id,
            f"migration-snapshot-{account_id}",
        )
        await conn.execute(
            """insert into checkout_claims(
                   account_id,claim_token,plan_key,plan_interval,expires_at,
                   client_request_key,request_snapshot_version
                 ) values($1,$2,'starter','month',clock_timestamp()+interval '1 hour',
                          $3,0)""",
            account_id,
            uuid.uuid4(),
            f"checkout-{uuid.uuid4()}",
        )
        await conn.execute(
            """insert into credit_pack_orders(
                   id,account_id,client_idempotency_key,stripe_request_key,
                   pack_key,pack_credits,price_amount,currency,expires_days,
                   price_lookup_key,claim_expires_at,request_snapshot_version
                 ) values($1,$2,$3,$4,'boost_100',100000000,900,'usd',365,
                          'pack_boost_100',clock_timestamp()+interval '1 hour',0)""",
            pack_id,
            account_id,
            f"pack-client-{uuid.uuid4()}",
            f"pack-stripe-{uuid.uuid4()}",
        )
        await conn.execute(
            """insert into billing_plan_changes(
                   id,account_id,idempotency_key,stripe_subscription_id,
                   from_plan_key,from_interval,target_plan_key,target_interval,
                   effective_mode,status,stripe_request_key,expected_grant_epoch,
                   expected_subscription_status,expected_cancel_at_period_end,
                   request_snapshot_version
                 ) values($1,$2,$3,'sub_snapshot','starter','month','pro','month',
                          'immediate','failed',$4,0,'active',false,0)""",
            plan_change_id,
            account_id,
            f"plan-client-{uuid.uuid4()}",
            f"plan-stripe-{uuid.uuid4()}",
        )
        rows = (
            ("checkout_claims", "account_id", account_id),
            ("credit_pack_orders", "id", pack_id),
            ("billing_plan_changes", "id", plan_change_id),
        )
        for table, key, value in rows:
            with pytest.raises(asyncpg.CheckViolationError):
                async with conn.transaction():
                    await conn.execute(
                        f"update {table} set stripe_request_snapshot='{{}}'::jsonb where {key}=$1",
                        value,
                    )
            await conn.execute(
                f"update {table} set request_snapshot_version=1, "
                f"stripe_request_snapshot='{{}}'::jsonb where {key}=$1",
                value,
            )
            with pytest.raises(asyncpg.CheckViolationError):
                async with conn.transaction():
                    await conn.execute(
                        f"update {table} set request_snapshot_version=2 where {key}=$1",
                        value,
                    )
            with pytest.raises(asyncpg.CheckViolationError):
                async with conn.transaction():
                    await conn.execute(
                        f"update {table} set stripe_request_snapshot=null where {key}=$1",
                        value,
                    )
            # PostgreSQL CHECK constraints accept UNKNOWN unless the whole
            # predicate is forced to TRUE.  This is the critical NULL-version +
            # non-NULL-snapshot corruption case that migration 002 must reject.
            with pytest.raises(asyncpg.CheckViolationError):
                async with conn.transaction():
                    await conn.execute(
                        f"update {table} set request_snapshot_version=null where {key}=$1",
                        value,
                    )
            for invalid_json in ("[]", '"scalar"', "null"):
                with pytest.raises(asyncpg.CheckViolationError):
                    async with conn.transaction():
                        await conn.execute(
                            f"update {table} set stripe_request_snapshot=$2::jsonb where {key}=$1",
                            value,
                            invalid_json,
                        )


async def test_pre_v3_history_is_rejected_without_partial_baseline() -> None:
    database_name, dsn = await _create_database("migration_old_lineage")
    database = Database(dsn)
    try:
        await database.connect()
        async with database.require_pool().acquire() as conn:
            await conn.execute(
                """create table schema_migrations(
                       filename text primary key,
                       sha256 text not null check(length(sha256)=64),
                       applied_at timestamptz not null default now()
                     )"""
            )
            await conn.execute(
                """insert into schema_migrations(filename,sha256)
                     values('001_schema.sql',$1)""",
                "a" * 64,
            )

        assert not await database.schema_ready()
        with pytest.raises(RuntimeError, match=r"unsupported pre-0\.3 migration lineage"):
            await database.apply_migrations(ROOT / "migrations")

        async with database.require_pool().acquire() as conn:
            history = await conn.fetchval("select array_agg(filename) from schema_migrations")
            accounts = await conn.fetchval("select to_regclass('public.billing_accounts')")
        assert history == ["001_schema.sql"]
        assert accounts is None
    finally:
        await database.close()
        await _drop_database(database_name)


async def test_pre_v3_binary_is_rejected_by_v3_history_without_schema_changes(
    pool: asyncpg.Pool, tmp_path: Path
) -> None:
    old_bundle = tmp_path / "pre-v3-migrations"
    old_bundle.mkdir()
    old_filenames = (
        "001_schema.sql",
        "002_plan_transitions.sql",
        "003_transition_policies.sql",
        "004_event_audit_hardening.sql",
        "005_simplify_event_audit.sql",
        "006_invoice_ownership_and_incident_causality.sql",
    )
    for filename in old_filenames:
        sql = "select 1;\n"
        if filename == "001_schema.sql":
            sql = "alter table stripe_webhook_events add column payload_sha256 text;\n"
        (old_bundle / filename).write_text(sql, encoding="utf-8")

    old_database = Database(TEST_DSN)
    old_database.pool = pool
    with pytest.raises(RuntimeError, match="inserted before already applied history"):
        await old_database.apply_migrations(old_bundle)

    async with pool.acquire() as conn:
        rows = await conn.fetch("select filename from schema_migrations order by filename")
        payload_sha256_exists = await conn.fetchval(
            """select exists(
                   select 1 from information_schema.columns
                    where table_schema='public' and table_name='stripe_webhook_events'
                      and column_name='payload_sha256'
                 )"""
        )
    assert [row["filename"] for row in rows] == list(CURRENT_MIGRATIONS)
    assert payload_sha256_exists is False


async def test_mixed_pre_v3_and_v3_history_is_never_ready(pool: asyncpg.Pool) -> None:
    database = Database(TEST_DSN)
    database.pool = pool
    async with pool.acquire() as conn:
        await conn.execute(
            "insert into schema_migrations(filename,sha256) values('001_schema.sql',$1)",
            "a" * 64,
        )
    try:
        assert not await database.schema_ready()
        with pytest.raises(RuntimeError, match=r"unsupported pre-0\.3 migration lineage"):
            await database.apply_migrations(ROOT / "migrations")
    finally:
        async with pool.acquire() as conn:
            await conn.execute("delete from schema_migrations where filename='001_schema.sql'")
    assert await database.schema_ready()


async def test_v3_can_append_a_future_migration_that_reuses_an_old_suffix(
    pool: asyncpg.Pool, tmp_path: Path
) -> None:
    future_bundle = tmp_path / "future-v3-migrations"
    shutil.copytree(ROOT / "migrations", future_bundle)
    future_name = "003_plan_transitions.sql"
    (future_bundle / future_name).write_text("select 1;\n", encoding="utf-8")
    database = Database(TEST_DSN)
    database.pool = pool
    await database.apply_migrations(future_bundle)
    await database.apply_migrations(future_bundle)
    async with pool.acquire() as conn:
        filenames = await conn.fetch("select filename from schema_migrations order by filename")
        await conn.execute("delete from schema_migrations where filename=$1", future_name)
    assert [row["filename"] for row in filenames] == [*CURRENT_MIGRATIONS, future_name]


async def test_schema_ready_does_not_read_or_rehash_migration_contents(
    pool: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = Database(TEST_DSN)
    database.pool = pool

    def unexpected_read(path: Path) -> bytes:
        raise AssertionError(f"readiness tried to read migration contents: {path}")

    monkeypatch.setattr(Path, "read_bytes", unexpected_read)
    assert await database.schema_ready()


async def test_schema_ready_requires_baseline_version_without_rehashing_files(
    pool: asyncpg.Pool,
) -> None:
    database = Database(TEST_DSN)
    database.pool = pool
    async with pool.acquire() as conn:
        original = await conn.fetchval(
            "select sha256 from schema_migrations where filename=$1", BASELINE
        )
        assert original is not None
        await conn.execute("delete from schema_migrations where filename=$1", BASELINE)
    assert not await database.schema_ready()
    async with pool.acquire() as conn:
        await conn.execute(
            "insert into schema_migrations(filename,sha256) values($1,$2)",
            BASELINE,
            "0" * 64,
        )
    # The migration command owns checksum enforcement. A hot readiness probe only
    # checks that this binary's schema version is present.
    assert await database.schema_ready()
    async with pool.acquire() as conn:
        await conn.execute(
            "update schema_migrations set sha256=$2 where filename=$1",
            BASELINE,
            original,
        )


async def test_migration_runner_rejects_changed_applied_file(
    pool: asyncpg.Pool, tmp_path: Path
) -> None:
    migration_dir = tmp_path / "migrations"
    shutil.copytree(ROOT / "migrations", migration_dir)
    filename = "003_checksum_probe.sql"
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
        [BASELINE, "003_gap.sql"],
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
    older_binary = tmp_path / "older-binary-migrations"
    older_binary.mkdir()
    shutil.copy2(ROOT / "migrations" / BASELINE, older_binary / BASELINE)
    async with pool.acquire() as conn:
        await conn.execute(
            """insert into schema_migrations(filename,sha256)
                 values('003_forward_probe.sql',$1)""",
            "a" * 64,
        )
    database = Database(TEST_DSN)
    database.pool = pool
    try:
        await database.apply_migrations(older_binary)
    finally:
        async with pool.acquire() as conn:
            await conn.execute(
                "delete from schema_migrations where filename='003_forward_probe.sql'"
            )


async def test_schema_ready_allows_extra_forward_migration_history(
    pool: asyncpg.Pool,
) -> None:
    database = Database(TEST_DSN)
    database.pool = pool
    async with pool.acquire() as conn:
        await conn.execute(
            "insert into schema_migrations(filename,sha256) values('003_removed.sql',$1)",
            "a" * 64,
        )
    assert await database.schema_ready()
    async with pool.acquire() as conn:
        await conn.execute("delete from schema_migrations where filename='003_removed.sql'")
    assert await database.schema_ready()


@pytest.mark.parametrize("table_name", (*CORRECTNESS_TABLES, "schema_migrations"))
async def test_schema_ready_requires_every_table(table_name: str, pool: asyncpg.Pool) -> None:
    database = Database(TEST_DSN)
    database.pool = pool
    missing_name = f"{table_name}_missing"
    async with pool.acquire() as conn:
        await conn.execute(f'alter table "{table_name}" rename to "{missing_name}"')
    try:
        assert not await database.schema_ready()
    finally:
        async with pool.acquire() as conn:
            await conn.execute(f'alter table "{missing_name}" rename to "{table_name}"')
    assert await database.schema_ready()


async def test_baseline_declares_exact_runtime_columns(pool: asyncpg.Pool) -> None:
    expected = {
        "billing_accounts": {
            "id",
            "external_ref",
            "stripe_customer_id",
            "stripe_subscription_id",
            "plan_key",
            "plan_interval",
            "subscription_status",
            "credits_balance",
            "grant_epoch",
            "event_created",
            "event_rank",
            "current_period_end",
            "annual_anchor",
            "annual_grants_issued",
            "annual_grants_allowed",
            "funding_invoice_id",
            "cancel_at_period_end",
            "pending_free_at",
            "entitlement_period_end",
            "credit_expires_at",
            "entitlement_revoked",
            "last_reconciled_at",
            "created_at",
            "updated_at",
        },
        "stripe_webhook_events": {
            "id",
            "event_type",
            "livemode",
            "payload",
            "outcome",
            "reason",
            "received_at",
            "processed_at",
        },
        "stripe_invoice_state": {
            "invoice_id",
            "account_id",
            "amount_total",
            "amount_refunded",
            "fully_refunded",
            "disputed",
            "grant_units_per_slot",
            "grants_issued",
            "closure_applied",
            "updated_at",
        },
        "credit_ledger": {
            "id",
            "account_id",
            "delta",
            "balance_after",
            "entitlement_units",
            "reason",
            "grant_epoch",
            "stripe_event_id",
            "stripe_invoice_id",
            "grant_slot",
            "created_at",
        },
        "credit_debits": {
            "idempotency_key",
            "account_id",
            "amount",
            "grant_epoch",
            "kind",
            "clawback_order_id",
            "restored_credits",
            "created_at",
            "refunded_at",
        },
        "credit_pack_orders": {
            "id",
            "account_id",
            "client_idempotency_key",
            "stripe_request_key",
            "pack_key",
            "pack_credits",
            "price_amount",
            "currency",
            "expires_days",
            "price_lookup_key",
            "request_customer_id",
            "request_snapshot_version",
            "stripe_request_snapshot",
            "checkout_status",
            "payment_status",
            "stripe_checkout_session_id",
            "stripe_payment_intent_id",
            "stripe_charge_id",
            "stripe_customer_id",
            "session_url",
            "claim_expires_at",
            "reconcile_claim_token",
            "reconcile_claim_expires_at",
            "last_reconciled_at",
            "last_reconcile_error",
            "amount_paid",
            "amount_refunded",
            "refunded_credits",
            "paid_at",
            "created_at",
            "updated_at",
        },
        "credit_funding_lots": {
            "id",
            "order_id",
            "account_id",
            "original_credits",
            "remaining_credits",
            "expired_credits",
            "cash_clawed_back_credits",
            "expires_at",
            "status",
            "closed_at",
            "created_at",
            "updated_at",
        },
        "credit_debit_allocations": {
            "id",
            "debit_idempotency_key",
            "account_id",
            "source_type",
            "subscription_grant_epoch",
            "funding_lot_id",
            "amount",
            "refunded_amount",
            "created_at",
            "updated_at",
        },
        "credit_pack_clawback_debts": {
            "order_id",
            "account_id",
            "target_credits",
            "collected_credits",
            "released_credits",
            "created_at",
            "updated_at",
        },
        "checkout_claims": {
            "account_id",
            "claim_token",
            "session_id",
            "plan_key",
            "plan_interval",
            "request_customer_id",
            "expires_at",
            "client_request_key",
            "session_url",
            "request_snapshot_version",
            "stripe_request_snapshot",
            "created_at",
        },
        "billing_incidents": {
            "id",
            "kind",
            "dedupe_key",
            "stripe_event_id",
            "invoice_id",
            "account_id",
            "detail",
            "seen_count",
            "first_seen_at",
            "last_seen_at",
            "resolved_at",
        },
        "billing_plan_changes": {
            "id",
            "account_id",
            "idempotency_key",
            "stripe_subscription_id",
            "from_plan_key",
            "from_interval",
            "target_plan_key",
            "target_interval",
            "effective_mode",
            "status",
            "effective_at",
            "stripe_schedule_id",
            "stripe_request_key",
            "expected_grant_epoch",
            "expected_entitlement_period_end",
            "expected_subscription_status",
            "expected_cancel_at_period_end",
            "proration_date",
            "estimated_amount_due",
            "estimated_credit_applied",
            "estimated_customer_balance_credit",
            "estimate_currency",
            "preview_expires_at",
            "lease_token",
            "lease_expires_at",
            "remote_pending_expires_at",
            "recovery_url",
            "last_error",
            "transition_policy",
            "expected_source_invoice_id",
            "expected_credit_delta",
            "expected_entitlement_revoked",
            "settlement_invoice_id",
            "remote_started_at",
            "request_snapshot_version",
            "stripe_request_snapshot",
            "estimated_source_proration",
            "estimated_target_proration",
            "estimated_period_start",
            "estimated_period_end",
            "created_at",
            "updated_at",
            "completed_at",
        },
        "billing_funding_allocations": {
            "id",
            "account_id",
            "plan_change_id",
            "stripe_invoice_id",
            "source_invoice_id",
            "stripe_event_id",
            "transition_policy",
            "source_plan_key",
            "source_interval",
            "target_plan_key",
            "target_interval",
            "source_line_id",
            "target_line_id",
            "entitlement_delta",
            "refunded_units",
            "source_credit_amount",
            "target_charge_amount",
            "amount_paid",
            "currency",
            "period_start",
            "period_end",
            "grant_epoch",
            "status",
            "created_at",
            "updated_at",
        },
        "billing_clawback_debts": {
            "account_id",
            "grant_epoch",
            "stripe_invoice_id",
            "target_units",
            "collected_units",
            "created_at",
            "updated_at",
        },
    }
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """select table_name,column_name
                 from information_schema.columns
                where table_schema='public' and table_name = any($1::text[])""",
            list(CORRECTNESS_TABLES),
        )
    observed = {table_name: set() for table_name in CORRECTNESS_TABLES}
    for row in rows:
        observed[row["table_name"]].add(row["column_name"])
    assert observed == expected


async def test_v4_schema_catalog_fingerprint_is_exact(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as conn:
        table_rows = await conn.fetch(
            """select tablename
                 from pg_tables
                where schemaname='public' and tablename <> 'schema_migrations'
                order by tablename"""
        )
        column_rows = await conn.fetch(
            """select table_name,column_name,ordinal_position::text,data_type,udt_name,
                      is_nullable,coalesce(column_default,'') as column_default
                 from information_schema.columns
                where table_schema='public' and table_name = any($1::text[])
                order by table_name,ordinal_position""",
            list(CORRECTNESS_TABLES),
        )
        constraint_rows = await conn.fetch(
            """select conrelid::regclass::text as table_name,conname,
                      contype::text as constraint_type,pg_get_constraintdef(oid) as definition
                 from pg_constraint
                where connamespace='public'::regnamespace
                  and conrelid::regclass::text = any($1::text[])
                order by table_name,conname""",
            list(CORRECTNESS_TABLES),
        )
        index_rows = await conn.fetch(
            """select tablename,indexname,indexdef
                 from pg_indexes
                where schemaname='public' and tablename = any($1::text[])
                order by tablename,indexname""",
            list(CORRECTNESS_TABLES),
        )
        trigger_rows = await conn.fetch(
            """select tgrelid::regclass::text as table_name,tgname,tgenabled::text,
                      pg_get_triggerdef(oid) as definition
                 from pg_trigger
                where not tgisinternal and tgrelid::regclass::text = any($1::text[])
                order by table_name,tgname""",
            list(CORRECTNESS_TABLES),
        )
        function_rows = await conn.fetch(
            """select proname,pg_get_function_identity_arguments(oid) as arguments,
                      pg_get_functiondef(oid) as definition
                from pg_proc
                where pronamespace='public'::regnamespace
                  and proname = any($1::text[])
                order by proname,arguments""",
            [
                "assert_credit_pack_state",
                "enforce_credit_debit_state",
                "enforce_credit_pack_collection_state",
                "enforce_credit_pack_state",
                "prevent_invoice_account_rebind",
            ],
        )
        comment_rows = await conn.fetch(
            """select c.relname as table_name,a.attname as column_name,
                      col_description(c.oid,a.attnum) as comment
                 from pg_class c
                 join pg_namespace n on n.oid=c.relnamespace
                 join pg_attribute a on a.attrelid=c.oid and a.attnum > 0
                where n.nspname='public' and c.relname = any($1::text[])
                  and col_description(c.oid,a.attnum) is not null
                order by table_name,column_name""",
            list(CORRECTNESS_TABLES),
        )
        sequence_rows = await conn.fetch(
            """select sequencename,data_type,start_value::text,min_value::text,
                      max_value::text,increment_by::text,cycle::text,cache_size::text
                 from pg_sequences
                where schemaname='public'
                order by sequencename"""
        )

    tables = [row["tablename"] for row in table_rows]
    assert tables == sorted(CORRECTNESS_TABLES)
    manifest = {
        "columns": [tuple(row) for row in column_rows],
        "constraints": [tuple(row) for row in constraint_rows],
        "indexes": [tuple(row) for row in index_rows],
        "triggers": [tuple(row) for row in trigger_rows],
        "functions": [tuple(row) for row in function_rows],
        "comments": [tuple(row) for row in comment_rows],
        "sequences": [tuple(row) for row in sequence_rows],
    }
    serialized = json.dumps(manifest, ensure_ascii=True, separators=(",", ":"))
    fingerprint = hashlib.sha256(serialized.encode()).hexdigest()
    assert fingerprint == V4_SCHEMA_CATALOG_SHA256, fingerprint


async def test_baseline_preserves_ownership_causality_and_audit_contracts(
    pool: asyncpg.Pool,
) -> None:
    owner_id = uuid.uuid4()
    other_id = uuid.uuid4()
    async with pool.acquire() as conn:
        defaults = await conn.fetch(
            """select table_name,column_name,column_default
                 from information_schema.columns
                where table_schema='public' and (
                  (table_name='billing_incidents' and column_name='last_seen_at') or
                  (table_name='stripe_invoice_state' and column_name='closure_applied') or
                  (table_name='billing_plan_changes' and column_name='transition_policy')
                )"""
        )
        default_map = {
            (row["table_name"], row["column_name"]): row["column_default"] for row in defaults
        }
        assert default_map[("billing_incidents", "last_seen_at")] == "clock_timestamp()"
        assert default_map[("stripe_invoice_state", "closure_applied")] == "false"
        assert (
            default_map[("billing_plan_changes", "transition_policy")]
            == "'full_period_reset'::text"
        )
        assert not await conn.fetchval(
            """select exists(
                   select 1 from information_schema.columns
                    where table_schema='public' and table_name='stripe_webhook_events'
                      and column_name='payload_sha256'
                 )"""
        )

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
        invoice_fk = await conn.fetchval(
            """select pg_get_constraintdef(c.oid)
                 from pg_constraint c
                where c.conrelid='stripe_invoice_state'::regclass
                  and c.conname='stripe_invoice_state_account_id_fkey'"""
        )
        trigger = await conn.fetchval(
            """select tgenabled::text from pg_trigger
                where tgrelid='stripe_invoice_state'::regclass
                  and tgname='stripe_invoice_state_account_immutable'
                  and not tgisinternal"""
        )
        payload_comment = await conn.fetchval(
            """select col_description('stripe_webhook_events'::regclass,a.attnum)
                 from pg_attribute a
                where a.attrelid='stripe_webhook_events'::regclass
                  and a.attname='payload'"""
        )
    assert retained == owner_id
    assert invoice_fk is not None and "ON DELETE RESTRICT" in invoice_fk
    assert trigger == "O"
    assert payload_comment == (
        "Minimal allowlisted operational audit snapshot; never the exact signed request body."
    )


async def test_baseline_declares_all_named_coordination_indexes(pool: asyncpg.Pool) -> None:
    expected_names = {
        "billing_accounts_annual_due",
        "billing_accounts_reconcile_rotation",
        "credit_ledger_invoice_slot_unique",
        "credit_ledger_account_created",
        "credit_debits_account_created",
        "credit_debits_clawback_order",
        "credit_pack_orders_account_created",
        "credit_pack_orders_expired_claims",
        "credit_pack_orders_reconcile_due",
        "credit_funding_lots_spendable",
        "credit_debit_allocations_subscription_unique",
        "credit_debit_allocations_pack_unique",
        "credit_debit_allocations_lot",
        "credit_pack_clawback_debts_outstanding",
        "billing_incidents_unresolved_unique",
        "billing_incidents_unresolved_account_kind_seen",
        "billing_plan_changes_one_pending",
        "billing_plan_changes_account_created",
        "billing_plan_changes_settlement_invoice_unique",
        "billing_funding_allocations_account_epoch",
        "billing_funding_allocations_source_invoice",
        "billing_clawback_debts_outstanding",
    }
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "select indexname,indexdef from pg_indexes where schemaname='public'"
        )
    indexes = {row["indexname"]: row["indexdef"] for row in rows}
    assert expected_names.issubset(indexes)
    assert "NULLS FIRST" in indexes["billing_accounts_reconcile_rotation"]
    assert (
        "WHERE (stripe_subscription_id IS NOT NULL)"
        in indexes["billing_accounts_reconcile_rotation"]
    )
    assert (
        "WHERE (resolved_at IS NULL)" in indexes["billing_incidents_unresolved_account_kind_seen"]
    )
    assert "WHERE (collected_units < target_units)" in indexes["billing_clawback_debts_outstanding"]
    assert "UNIQUE" in indexes["credit_ledger_invoice_slot_unique"]
    assert "UNIQUE" in indexes["billing_plan_changes_one_pending"]
    assert "UNIQUE" in indexes["billing_plan_changes_settlement_invoice_unique"]


async def test_baseline_preserves_foreign_key_delete_actions(pool: asyncpg.Pool) -> None:
    expected = {
        "stripe_invoice_state_account_id_fkey": "r",
        "credit_ledger_account_id_fkey": "c",
        "credit_debits_account_id_fkey": "c",
        "credit_debits_clawback_order_fk": "r",
        "credit_pack_orders_account_id_fkey": "r",
        "credit_funding_lots_order_account_fk": "r",
        "credit_funding_lots_account_id_fkey": "r",
        "credit_debit_allocations_debit_account_fk": "r",
        "credit_debit_allocations_account_id_fkey": "r",
        "credit_debit_allocations_lot_account_fk": "r",
        "credit_pack_debts_order_account_fk": "r",
        "credit_pack_clawback_debts_account_id_fkey": "r",
        "checkout_claims_account_id_fkey": "c",
        "billing_incidents_account_id_fkey": "n",
        "billing_plan_changes_account_id_fkey": "c",
        "billing_funding_allocations_account_id_fkey": "c",
        "billing_funding_allocations_plan_change_id_fkey": "r",
        "billing_clawback_debts_account_id_fkey": "c",
        "billing_clawback_debts_stripe_invoice_id_fkey": "r",
    }
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """select conname,confdeltype::text as delete_action
                 from pg_constraint
                where contype='f' and conname = any($1::text[])""",
            list(expected),
        )
    assert {row["conname"]: row["delete_action"] for row in rows} == expected
