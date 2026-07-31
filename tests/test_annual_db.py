from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import asyncpg

from stripe_entitlements.annual import AnnualGrantService
from stripe_entitlements.catalog import PlanCatalog
from stripe_entitlements.processor import EventProcessor
from stripe_entitlements.types import SubscriptionSnapshot
from tests.builders import paid_invoice, refunded_charge

ANCHOR = int(datetime(2026, 1, 1, tzinfo=UTC).timestamp())


async def _annual_setup(
    processor: EventProcessor, account_id: str, *, invoice_id: str = "in_annual"
) -> None:
    result = await processor.process(
        paid_invoice(
            account_id,
            invoice_id=invoice_id,
            plan="starter",
            interval="year",
            amount=13_700,
            period_start=ANCHOR,
            period_end=int(datetime(2027, 1, 1, tzinfo=UTC).timestamp()),
        )
    )
    assert result.outcome == "handled"


async def test_annual_invoice_issues_only_first_month(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _annual_setup(processor, account_id)
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
        slots = await conn.fetch("select grant_slot from credit_ledger order by id")
    assert account is not None
    assert account["annual_grants_issued"] == 1
    assert account["annual_grants_allowed"] == 12
    assert [row["grant_slot"] for row in slots] == [1]


async def test_many_workers_issue_one_due_slot(
    processor: EventProcessor, pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await make_account()
    await _annual_setup(processor, account_id, invoice_id="in_annual_race")
    service = AnnualGrantService(pool, catalog, processor)
    snapshot = SubscriptionSnapshot("sub_test", "active", "ent_starter_year")
    now = datetime(2026, 2, 2, tzinfo=UTC)
    results = await asyncio.gather(
        *(service.grant_due(account_id, now, snapshot) for _ in range(20))
    )
    assert sum(result.outcome == "handled" for result in results) == 1
    async with pool.acquire() as conn:
        slots = await conn.fetch(
            """select grant_slot from credit_ledger
                 where stripe_invoice_id='in_annual_race' order by grant_slot"""
        )
    assert [row["grant_slot"] for row in slots] == [1, 2]


async def test_downtime_jumps_to_current_slot_without_backfill_spam(
    processor: EventProcessor, pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await make_account()
    await _annual_setup(processor, account_id, invoice_id="in_annual_jump")
    service = AnnualGrantService(pool, catalog, processor)
    result = await service.grant_due(
        account_id,
        datetime(2026, 6, 15, tzinfo=UTC),
        SubscriptionSnapshot("sub_test", "active", "ent_starter_year"),
    )
    assert result.reason == "granted annual slot 6"
    async with pool.acquire() as conn:
        slots = await conn.fetch(
            """select grant_slot from credit_ledger
                 where stripe_invoice_id='in_annual_jump' order by grant_slot"""
        )
    assert [row["grant_slot"] for row in slots] == [1, 6]


async def test_annual_plan_mismatch_fails_closed_with_incident(
    processor: EventProcessor, pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await make_account()
    await _annual_setup(processor, account_id, invoice_id="in_annual_mismatch")
    service = AnnualGrantService(pool, catalog, processor)
    result = await service.grant_due(
        account_id,
        datetime(2026, 2, 2, tzinfo=UTC),
        SubscriptionSnapshot("sub_test", "active", "ent_pro_year"),
    )
    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        assert await conn.fetchval(
            "select count(*) from billing_incidents where kind='annual_plan_mismatch'"
        ) == 1


async def test_partial_annual_refund_reduces_future_slots_and_each_new_grant(
    processor: EventProcessor, pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await make_account()
    await _annual_setup(processor, account_id, invoice_id="in_annual_partial")
    await processor.process(
        refunded_charge(
            invoice_id="in_annual_partial",
            amount=13_700,
            amount_refunded=6_850,
        )
    )
    service = AnnualGrantService(pool, catalog, processor)
    await service.grant_due(
        account_id,
        datetime(2026, 2, 2, tzinfo=UTC),
        SubscriptionSnapshot("sub_test", "active", "ent_starter_year"),
    )
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select credits_balance,annual_grants_allowed from billing_accounts where id=$1::uuid",
            account_id,
        )
    assert account is not None
    assert account["annual_grants_allowed"] == 6
    assert account["credits_balance"] == 150


async def test_full_annual_refund_stops_future_worker_grants(
    processor: EventProcessor, pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await make_account()
    await _annual_setup(processor, account_id, invoice_id="in_annual_full")
    await processor.process(
        refunded_charge(
            invoice_id="in_annual_full",
            amount=13_700,
            amount_refunded=13_700,
            refunded=True,
        )
    )
    service = AnnualGrantService(pool, catalog, processor)
    result = await service.grant_due(
        account_id,
        datetime(2026, 2, 2, tzinfo=UTC),
        SubscriptionSnapshot("sub_test", "active", "ent_starter_year"),
    )
    assert result.outcome in {"ignored", "replayed"}
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            """select credits_balance,annual_grants_issued,annual_grants_allowed
                 from billing_accounts where id=$1::uuid""",
            account_id,
        )
    assert account is not None
    assert tuple(account) == (0, 1, 1)
