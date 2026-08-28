from __future__ import annotations

import asyncio

import asyncpg
import pytest

from stripe_entitlements.database import Database, _init_connection
from tests.conftest import TEST_DSN


async def test_connection_initializer_forces_utc_before_timestamp_arithmetic() -> None:
    calls: list[tuple[str, object]] = []

    class FakeConnection:
        async def execute(self, statement: str) -> None:
            calls.append(("execute", statement))

        async def set_type_codec(self, name: str, **kwargs: object) -> None:
            calls.append(("codec", name))

    await _init_connection(FakeConnection())  # type: ignore[arg-type]
    assert calls[0] == ("execute", "set time zone 'UTC'")
    assert calls[1:] == [("codec", "json"), ("codec", "jsonb")]


@pytest.mark.parametrize(
    "external_ref",
    [
        "",
        " padded ",
        "line\nbreak",
        "delete\x7f",
        "zero\u200bwidth",
        "x" * 513,
        "00000000-0000-4000-8000-000000000001",
        "cus_database_owner",
        "sub_database_owner",
        "acct_database_owner",
    ],
)
async def test_database_rejects_invalid_external_refs_before_write(
    external_ref: str, pool: asyncpg.Pool
) -> None:
    database = Database(TEST_DSN)
    database.pool = pool
    with pytest.raises(ValueError, match=r"external_ref|Stripe identifier|internal account ID"):
        await database.create_account(external_ref)
    with pytest.raises(ValueError, match=r"external_ref|Stripe identifier|internal account ID"):
        await database.account_for_external_ref(external_ref)
    async with pool.acquire() as conn:
        assert await conn.fetchval("select count(*) from billing_accounts") == 0


async def test_existing_external_ref_resolution_does_not_create_a_new_row_version(
    pool: asyncpg.Pool,
) -> None:
    database = Database(TEST_DSN)
    database.pool = pool
    first = await database.account_for_external_ref("read-mostly-host-subject")
    async with pool.acquire() as conn:
        before = await conn.fetchrow(
            """select xmin::text as xmin,ctid::text as ctid
                 from billing_accounts where id=$1::uuid""",
            first["id"],
        )
    for _ in range(10):
        resolved = await database.account_for_external_ref("read-mostly-host-subject")
        assert resolved["id"] == first["id"]
    async with pool.acquire() as conn:
        after = await conn.fetchrow(
            """select xmin::text as xmin,ctid::text as ctid
                 from billing_accounts where id=$1::uuid""",
            first["id"],
        )
    assert before is not None and after is not None
    assert tuple(before) == tuple(after)


async def test_concurrent_external_ref_resolution_creates_one_account(
    pool: asyncpg.Pool,
) -> None:
    database = Database(TEST_DSN)
    database.pool = pool
    accounts = await asyncio.gather(
        *(database.account_for_external_ref("stable-host-subject") for _ in range(32))
    )
    assert len({account["id"] for account in accounts}) == 1
    assert all(account["database_now"] is not None for account in accounts)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "select id,external_ref from billing_accounts where external_ref=$1",
            "stable-host-subject",
        )
    assert len(rows) == 1
