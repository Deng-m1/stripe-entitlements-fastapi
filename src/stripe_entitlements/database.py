from __future__ import annotations

import asyncio
import hashlib
import json
import re
import uuid
from pathlib import Path
from typing import Any

import asyncpg

from .resources import default_migration_directory

MigrationFile = tuple[str, str, str]
_MIGRATION_NAME = re.compile(r"^(\d{3})_[a-z0-9][a-z0-9_]*\.sql$")


def _migration_paths(root: Path) -> list[Path]:
    if not root.is_dir():
        raise FileNotFoundError(f"migration directory does not exist: {root}")
    paths = sorted(root.glob("*.sql"))
    if not paths:
        raise RuntimeError(f"migration directory contains no SQL files: {root}")
    sequences: list[int] = []
    for path in paths:
        match = _MIGRATION_NAME.fullmatch(path.name)
        if match is None:
            raise RuntimeError(f"invalid migration filename: {path.name!r}")
        sequences.append(int(match.group(1)))
    expected_sequences = list(range(1, len(paths) + 1))
    if sequences != expected_sequences:
        raise RuntimeError(
            "migration filenames must form one contiguous append-only sequence "
            f"starting at 001; observed={sequences}"
        )
    return paths


def _load_migrations(root: Path) -> list[MigrationFile]:
    loaded: list[MigrationFile] = []
    for path in _migration_paths(root):
        payload = path.read_bytes()
        loaded.append(
            (
                path.name,
                payload.decode("utf-8"),
                hashlib.sha256(payload).hexdigest(),
            )
        )
    return loaded


def _validate_external_ref(external_ref: str) -> str:
    if (
        not external_ref
        or external_ref != external_ref.strip()
        or len(external_ref.encode("utf-8")) > 512
        or any(not character.isprintable() for character in external_ref)
    ):
        raise ValueError("external_ref must be 1 to 512 visible UTF-8 bytes without padding")
    return external_ref


async def _init_connection(conn: asyncpg.Connection) -> None:
    await conn.execute("set time zone 'UTC'")
    await conn.set_type_codec(
        "json",
        schema="pg_catalog",
        encoder=json.dumps,
        decoder=json.loads,
        format="text",
    )
    await conn.set_type_codec(
        "jsonb",
        schema="pg_catalog",
        encoder=json.dumps,
        decoder=json.loads,
        format="text",
    )


class Database:
    def __init__(self, dsn: str) -> None:
        self.dsn = dsn
        self.pool: asyncpg.Pool | None = None

    async def connect(self) -> None:
        self.pool = await asyncpg.create_pool(
            self.dsn, min_size=1, max_size=20, init=_init_connection
        )

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()
            self.pool = None

    def require_pool(self) -> asyncpg.Pool:
        if self.pool is None:
            raise RuntimeError("database is not connected")
        return self.pool

    async def apply_migrations(self, directory: str | Path) -> None:
        pool = self.require_pool()
        root = Path(directory)
        migrations = await asyncio.to_thread(_load_migrations, root)
        async with pool.acquire() as conn, conn.transaction():
            await conn.fetchval("select pg_advisory_xact_lock(7769476304708398194)")
            await conn.execute(
                """create table if not exists schema_migrations(
                       filename text primary key,
                       sha256 text not null check(length(sha256)=64),
                       applied_at timestamptz not null default now()
                     )"""
            )
            applied_rows = await conn.fetch(
                "select filename,sha256 from schema_migrations order by filename"
            )
            applied = {str(row["filename"]): str(row["sha256"]) for row in applied_rows}
            bundled = {filename: checksum for filename, _, checksum in migrations}
            # A database may legitimately be ahead during rolling upgrades or a
            # rollback. Verify every migration this binary knows about, but do not
            # reject later history owned by a newer binary.
            for filename, checksum in bundled.items():
                if filename in applied and applied[filename] != checksum:
                    raise RuntimeError(f"applied migration checksum changed for {filename!r}")
            max_applied = max(applied, default="")
            for filename, sql, checksum in migrations:
                if filename in applied:
                    continue
                if max_applied and filename < max_applied:
                    raise RuntimeError(
                        f"migration {filename!r} was inserted before already applied history"
                    )
                await conn.execute(sql)
                await conn.execute(
                    "insert into schema_migrations(filename,sha256) values($1,$2)",
                    filename,
                    checksum,
                )
                max_applied = filename

    async def schema_ready(self) -> bool:
        pool = self.require_pool()
        required = (
            "billing_accounts",
            "stripe_webhook_events",
            "stripe_invoice_state",
            "credit_ledger",
            "credit_debits",
            "checkout_claims",
            "billing_plan_changes",
            "billing_funding_allocations",
            "billing_clawback_debts",
            "billing_incidents",
            "schema_migrations",
        )
        try:
            expected_paths = await asyncio.to_thread(
                _migration_paths, default_migration_directory()
            )
        except (FileNotFoundError, RuntimeError):
            return False
        async with pool.acquire() as conn:
            present = await conn.fetchval(
                """select count(*) = $2
                     from unnest($1::text[]) as required(name)
                    where to_regclass(required.name) is not null""",
                list(required),
                len(required),
            )
            if not present:
                return False
            rows = await conn.fetch("select filename from schema_migrations")
        applied = {str(row["filename"]) for row in rows}
        expected_filenames = {path.name for path in expected_paths}
        # The migration command enforces immutable checksums. Readiness only verifies
        # that this binary's schema versions are present; it stays cheap and allows a
        # database to be ahead during a rolling deployment.
        return expected_filenames.issubset(applied)

    async def create_account(
        self, external_ref: str, *, account_id: uuid.UUID | None = None
    ) -> str:
        external_ref = _validate_external_ref(external_ref)
        account_id = account_id or uuid.uuid4()
        pool = self.require_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                "insert into billing_accounts(id, external_ref) values($1, $2)",
                account_id,
                external_ref,
            )
        return str(account_id)

    async def account(self, account_id: str) -> dict[str, Any] | None:
        pool = self.require_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "select *,now() as database_now from billing_accounts where id=$1::uuid",
                account_id,
            )
        return dict(row) if row is not None else None

    async def existing_account_for_external_ref(self, external_ref: str) -> dict[str, Any] | None:
        external_ref = _validate_external_ref(external_ref)
        pool = self.require_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """select *,now() as database_now from billing_accounts
                     where external_ref=$1""",
                external_ref,
            )
        return dict(row) if row is not None else None

    async def account_for_external_ref(self, external_ref: str) -> dict[str, Any]:
        external_ref = _validate_external_ref(external_ref)
        pool = self.require_pool()
        async with pool.acquire() as conn:
            for _ in range(2):
                row = await conn.fetchrow(
                    """insert into billing_accounts(id,external_ref) values($1,$2)
                         on conflict(external_ref) do nothing
                         returning *,now() as database_now""",
                    uuid.uuid4(),
                    external_ref,
                )
                if row is not None:
                    return dict(row)
                row = await conn.fetchrow(
                    """select *,now() as database_now from billing_accounts
                         where external_ref=$1""",
                    external_ref,
                )
                if row is not None:
                    return dict(row)
        raise RuntimeError("billing account disappeared during identity resolution")

    async def pending_plan_change(self, account_id: str) -> dict[str, Any] | None:
        pool = self.require_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """select * from billing_plan_changes where account_id=$1::uuid
                     and status in (
                       'reserved','previewed','applying','scheduled','applied','requires_action'
                     ) order by created_at desc limit 1""",
                account_id,
            )
        return dict(row) if row is not None else None
