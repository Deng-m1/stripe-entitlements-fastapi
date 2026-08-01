from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import asyncpg
import pytest

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
            billing_reason="subscription_create",
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
        assert (
            await conn.fetchval(
                "select count(*) from billing_incidents where kind='annual_plan_mismatch'"
            )
            == 1
        )


async def test_partial_annual_refund_reduces_slots_but_keeps_full_allowed_grants(
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
    assert account["credits_balance"] == 300


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


async def test_full_annual_refund_business_replay_does_not_create_new_epoch_debt(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _annual_setup(processor, account_id, invoice_id="in_annual_closed_replay")
    first = await processor.process(
        refunded_charge(
            invoice_id="in_annual_closed_replay",
            amount=13_700,
            amount_refunded=13_700,
            refunded=True,
            event_id="evt_annual_closed_a",
        )
    )
    replay = await processor.process(
        refunded_charge(
            invoice_id="in_annual_closed_replay",
            amount=13_700,
            amount_refunded=13_700,
            refunded=True,
            event_id="evt_annual_closed_b",
        )
    )
    assert first.outcome == "handled"
    assert replay.outcome == "replayed"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select credits_balance,grant_epoch,entitlement_revoked "
            "from billing_accounts where id=$1::uuid",
            account_id,
        )
        debts = await conn.fetch(
            """select grant_epoch,target_units,collected_units
                 from billing_clawback_debts
                where account_id=$1::uuid
                  and stripe_invoice_id='in_annual_closed_replay'
                order by grant_epoch""",
            account_id,
        )
        closure_applied = await conn.fetchval(
            "select closure_applied from stripe_invoice_state "
            "where invoice_id='in_annual_closed_replay'"
        )
    assert account is not None and tuple(account) == (0, 2, True)
    assert [tuple(row) for row in debts] == [(1, 300, 300)]
    assert closure_applied is True


@pytest.mark.parametrize("refund_percent", [25, 50, 75])
@pytest.mark.parametrize("issued", [1, 6, 11])
async def test_annual_partial_refund_has_one_slot_dimension_only(
    refund_percent: int,
    issued: int,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    account_id = await make_account()
    invoice_id = f"in_ratio_{refund_percent}_{issued}"
    await _annual_setup(processor, account_id, invoice_id=invoice_id)
    if issued > 1:
        await AnnualGrantService(pool, catalog, processor).grant_due(
            account_id,
            datetime(2026, issued, 15, tzinfo=UTC),
            SubscriptionSnapshot("sub_test", "active", "ent_starter_year"),
        )
    await processor.process(
        refunded_charge(
            invoice_id=invoice_id,
            amount=13_700,
            amount_refunded=13_700 * refund_percent // 100,
        )
    )
    funded_slots = {25: 9, 50: 6, 75: 3}[refund_percent]
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
    assert account is not None
    assert account["annual_grants_allowed"] == max(issued, funded_slots)
    if issued > funded_slots:
        assert account["entitlement_revoked"] is True
        assert account["credits_balance"] == 0
    else:
        assert account["entitlement_revoked"] is False
        assert account["credits_balance"] == 300


@pytest.mark.parametrize("refund_first", [False, True])
async def test_near_full_annual_refund_converges_before_or_after_paid(
    refund_first: bool,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account()
    invoice_id = "in_annual_near_full"
    paid = paid_invoice(
        account_id,
        invoice_id=invoice_id,
        plan="starter",
        interval="year",
        amount=13_700,
        period_start=ANCHOR,
        period_end=int(datetime(2027, 1, 1, tzinfo=UTC).timestamp()),
        billing_reason="subscription_create",
    )
    refund = refunded_charge(
        invoice_id=invoice_id,
        amount=13_700,
        amount_refunded=13_563,
    )
    for payload in [refund, paid] if refund_first else [paid, refund]:
        await processor.process(payload)
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
    assert account is not None
    assert account["credits_balance"] == 0
    assert account["entitlement_revoked"] is True or account["credit_expires_at"] is None
