from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

import asyncpg


async def _init_connection(conn: asyncpg.Connection) -> None:
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
        paths = await asyncio.to_thread(lambda: sorted(Path(directory).glob("*.sql")))
        async with pool.acquire() as conn:
            for path in paths:
                sql = await asyncio.to_thread(path.read_text)
                await conn.execute(sql)

    async def create_account(
        self, external_ref: str, *, account_id: uuid.UUID | None = None
    ) -> str:
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
                "select * from billing_accounts where id=$1::uuid", account_id
            )
        return dict(row) if row is not None else None

    async def account_for_external_ref(self, external_ref: str) -> dict[str, Any]:
        if not external_ref:
            raise ValueError("authenticated external_ref cannot be empty")
        account_id = uuid.uuid4()
        pool = self.require_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """insert into billing_accounts(id,external_ref) values($1,$2)
                     on conflict(external_ref) do update set external_ref=excluded.external_ref
                     returning *""",
                account_id,
                external_ref,
            )
        assert row is not None
        return dict(row)

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
