from __future__ import annotations

import asyncio
from datetime import datetime

import asyncpg


async def wait_for_account_row_lock_waiter(
    pool: asyncpg.Pool,
    *,
    timeout_seconds: float = 5.0,
) -> None:
    """Wait until a second PostgreSQL session is blocked on the account row lock."""

    deadline = asyncio.get_running_loop().time() + timeout_seconds
    async with pool.acquire() as conn:
        while asyncio.get_running_loop().time() < deadline:
            waiting = await conn.fetchval(
                """select exists(
                       select 1 from pg_stat_activity
                        where pid <> pg_backend_pid()
                          and datname=current_database()
                          and wait_event_type='Lock'
                          and query like '%billing_accounts%'
                          and query like '%for update%'
                     )"""
            )
            if waiting:
                return
            await asyncio.sleep(0.01)
    raise AssertionError("credit operation did not block on the billing account row lock")


async def wait_until_database_time_after(
    pool: asyncpg.Pool,
    boundary: datetime,
    *,
    timeout_seconds: float = 5.0,
) -> None:
    """Cross a timestamp using PostgreSQL's wall clock rather than process time."""

    deadline = asyncio.get_running_loop().time() + timeout_seconds
    async with pool.acquire() as conn:
        while asyncio.get_running_loop().time() < deadline:
            if await conn.fetchval("select clock_timestamp() > $1", boundary):
                return
            await asyncio.sleep(0.01)
    raise AssertionError("PostgreSQL wall clock did not cross the expiry boundary")
