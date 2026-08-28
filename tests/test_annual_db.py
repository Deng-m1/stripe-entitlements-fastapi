from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import UTC, datetime

import asyncpg
import pytest

from stripe_entitlements.annual import AnnualGrantService
from stripe_entitlements.catalog import PlanCatalog
from stripe_entitlements.credits import CreditService
from stripe_entitlements.processor import EventProcessor
from stripe_entitlements.types import SubscriptionSnapshot
from tests.builders import paid_invoice, refunded_charge, resolved_price
from tests.credit_helpers import STARTER_CREDITS, atoms, catalog_with_credits

ANCHOR = int(datetime(2026, 1, 1, tzinfo=UTC).timestamp())
PERIOD_END = datetime(2027, 1, 1, tzinfo=UTC)


def _snapshot(lookup_key: str = "ent_starter_year") -> SubscriptionSnapshot:
    plan = lookup_key.split("_")[1]
    return SubscriptionSnapshot(
        "sub_test",
        "active",
        lookup_key,
        PERIOD_END,
        resolved_price(plan, "year"),
        1,
    )


async def _annual_setup(
    processor: EventProcessor,
    account_id: str,
    *,
    invoice_id: str = "in_annual",
    customer: str = "cus_test",
    subscription: str = "sub_test",
) -> None:
    result = await processor.process(
        paid_invoice(
            account_id,
            invoice_id=invoice_id,
            customer=customer,
            subscription=subscription,
            plan="starter",
            interval="year",
            amount=13_700,
            period_start=ANCHOR,
            period_end=int(PERIOD_END.timestamp()),
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


async def test_fractional_annual_slot_resets_to_exact_catalog_atoms(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    fractional_catalog = catalog_with_credits(
        catalog,
        starter="300.000001",
        pro="1000.000003",
        ultra="4000.000005",
    )
    processor = EventProcessor(
        pool,
        fractional_catalog,
        "example-entitlements",
        expected_api_version="2026-06-24.dahlia",
    )
    account_id = await make_account()
    await _annual_setup(processor, account_id, invoice_id="in_fractional_annual")
    async with pool.acquire() as conn:
        await conn.execute(
            "update billing_accounts set credit_expires_at=now()+interval '1 hour' "
            "where id=$1::uuid",
            account_id,
        )
    charged = await CreditService(pool).charge(
        account_id,
        "0.125",
        "fractional-annual-use",
    )
    assert charged.balance.atoms == atoms("299.875001")

    result = await AnnualGrantService(pool, fractional_catalog, processor).grant_due(
        account_id,
        datetime(2026, 2, 2, tzinfo=UTC),
        _snapshot(),
    )
    assert result.outcome == "handled"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select credits_balance,annual_grants_issued from billing_accounts where id=$1::uuid",
            account_id,
        )
        slot = await conn.fetchrow(
            "select delta,balance_after,entitlement_units from credit_ledger "
            "where stripe_invoice_id='in_fractional_annual' and grant_slot=2"
        )
    assert account is not None and tuple(account) == (atoms("300.000001"), 2)
    assert slot is not None and tuple(slot) == (
        atoms("0.125"),
        atoms("300.000001"),
        atoms("300.000001"),
    )


async def test_many_workers_issue_one_due_slot(
    processor: EventProcessor, pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await make_account()
    await _annual_setup(processor, account_id, invoice_id="in_annual_race")
    service = AnnualGrantService(pool, catalog, processor)
    snapshot = _snapshot()
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
        _snapshot(),
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
        _snapshot("ent_pro_year"),
    )
    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                "select count(*) from billing_incidents where kind='annual_plan_mismatch'"
            )
            == 1
        )


async def test_annual_network_failure_incident_resolves_after_success(
    processor: EventProcessor, pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await make_account()
    await _annual_setup(processor, account_id, invoice_id="in_annual_failure_recovery")
    service = AnnualGrantService(pool, catalog, processor)
    await service.record_failure(
        account_id,
        "sub_test",
        "subscription snapshot failed: TimeoutError",
    )
    async with pool.acquire() as conn:
        incident = await conn.fetchrow(
            """select detail,resolved_at from billing_incidents
                 where kind='annual_grant_failed'"""
        )
    assert incident is not None
    assert incident["detail"]["reason"] == "subscription snapshot failed: TimeoutError"
    assert incident["resolved_at"] is None

    result = await service.grant_due(
        account_id,
        datetime(2026, 2, 2, tzinfo=UTC),
        _snapshot(),
    )
    async with pool.acquire() as conn:
        resolved = await conn.fetchval(
            """select resolved_at is not null from billing_incidents
                 where kind='annual_grant_failed'"""
        )
    assert result.outcome == "handled"
    assert resolved is True


async def test_annual_period_mismatch_fails_closed_with_incident(
    processor: EventProcessor, pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await make_account()
    await _annual_setup(processor, account_id, invoice_id="in_annual_period_mismatch")
    service = AnnualGrantService(pool, catalog, processor)
    result = await service.grant_due(
        account_id,
        datetime(2026, 2, 2, tzinfo=UTC),
        SubscriptionSnapshot(
            "sub_test",
            "active",
            "ent_starter_year",
            datetime(2027, 2, 1, tzinfo=UTC),
            resolved_price("starter", "year"),
            1,
        ),
    )
    assert result.outcome == "ignored"
    assert result.reason == "remote and local annual plans differ"
    async with pool.acquire() as conn:
        detail = await conn.fetchval(
            """select detail from billing_incidents
                 where kind='annual_plan_mismatch'"""
        )
    assert detail["remote_period_end"] == "2027-02-01T00:00:00+00:00"
    assert detail["local_period_end"] == PERIOD_END.isoformat()


@pytest.mark.parametrize("quantity", [None, 2, "1"])
async def test_annual_worker_requires_exactly_one_remote_item_quantity(
    quantity: object,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    account_id = await make_account()
    await _annual_setup(processor, account_id, invoice_id=f"in_annual_quantity_{quantity}")
    snapshot = replace(_snapshot(), quantity=quantity)  # type: ignore[arg-type]
    result = await AnnualGrantService(pool, catalog, processor).grant_due(
        account_id,
        datetime(2026, 2, 2, tzinfo=UTC),
        snapshot,
    )
    async with pool.acquire() as conn:
        slots = await conn.fetchval(
            """select count(*) from credit_ledger
                 where account_id=$1::uuid and grant_slot is not null""",
            account_id,
        )
        incident = await conn.fetchval(
            "select count(*) from billing_incidents where kind='annual_plan_mismatch'"
        )
    assert result.outcome == "ignored"
    assert slots == 1
    assert incident == 1


async def test_annual_price_product_identity_mismatch_fails_closed(
    processor: EventProcessor, pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await make_account()
    await _annual_setup(processor, account_id, invoice_id="in_annual_price_mismatch")
    snapshot = _snapshot()
    assert snapshot.resolved_price is not None
    snapshot.resolved_price["product"]["metadata"]["product_line"] = "other-product"

    result = await AnnualGrantService(pool, catalog, processor).grant_due(
        account_id,
        datetime(2026, 2, 2, tzinfo=UTC),
        snapshot,
    )
    async with pool.acquire() as conn:
        slots = await conn.fetchval(
            """select count(*) from credit_ledger
                 where account_id=$1::uuid and grant_slot is not null""",
            account_id,
        )
        incident = await conn.fetchval(
            "select count(*) from billing_incidents where kind='annual_plan_mismatch'"
        )
    assert result.outcome == "ignored"
    assert slots == 1
    assert incident == 1


async def test_due_account_exclusion_prevents_batch_starvation(
    processor: EventProcessor, pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_ids: set[str] = set()
    for index in range(3):
        account_id = await make_account(
            customer=f"cus_annual_rotation_{index}",
            subscription=f"sub_annual_rotation_{index}",
        )
        account_ids.add(account_id)
        await _annual_setup(
            processor,
            account_id,
            invoice_id=f"in_annual_rotation_{index}",
            customer=f"cus_annual_rotation_{index}",
            subscription=f"sub_annual_rotation_{index}",
        )
    service = AnnualGrantService(pool, catalog, processor)
    now = datetime(2026, 2, 2, tzinfo=UTC)
    first = await service.due_accounts(now, limit=2)
    first_ids = {str(candidate["id"]) for candidate in first}
    second = await service.due_accounts(
        now,
        limit=2,
        exclude_account_ids=first_ids,
    )
    second_ids = {str(candidate["id"]) for candidate in second}
    assert len(first_ids) == 2
    assert len(second_ids) == 1
    assert first_ids.isdisjoint(second_ids)
    assert first_ids | second_ids == account_ids


async def test_annual_worker_rejects_naive_time(
    processor: EventProcessor, pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await make_account()
    await _annual_setup(processor, account_id, invoice_id="in_annual_naive_time")
    service = AnnualGrantService(pool, catalog, processor)
    with pytest.raises(ValueError, match="timezone-aware"):
        await service.due_accounts(datetime(2026, 2, 2))
    with pytest.raises(ValueError, match="timezone-aware"):
        await service.grant_due(account_id, datetime(2026, 2, 2), _snapshot())


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
        _snapshot(),
    )
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select credits_balance,annual_grants_allowed from billing_accounts where id=$1::uuid",
            account_id,
        )
    assert account is not None
    assert account["annual_grants_allowed"] == 6
    assert account["credits_balance"] == STARTER_CREDITS


@pytest.mark.parametrize("state", ["revoked", "expired"])
async def test_annual_worker_skips_revoked_or_expired_funding(
    state: str,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    account_id = await make_account()
    await _annual_setup(processor, account_id, invoice_id=f"in_annual_{state}")
    now = datetime(2026, 2, 2, tzinfo=UTC)
    async with pool.acquire() as conn:
        if state == "revoked":
            await conn.execute(
                "update billing_accounts set entitlement_revoked=true where id=$1::uuid",
                account_id,
            )
        else:
            await conn.execute(
                """update billing_accounts set entitlement_period_end=$2::timestamptz
                     where id=$1::uuid""",
                account_id,
                datetime(2026, 2, 1, tzinfo=UTC),
            )
    service = AnnualGrantService(pool, catalog, processor)
    candidates = await service.due_accounts(now)
    result = await service.grant_due(
        account_id,
        now,
        _snapshot(),
    )
    assert account_id not in {str(candidate["id"]) for candidate in candidates}
    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        slots = await conn.fetchval(
            """select count(*) from credit_ledger
                 where account_id=$1::uuid and grant_slot is not null""",
            account_id,
        )
    assert slots == 1


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
        _snapshot(),
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
    assert [tuple(row) for row in debts] == [(1, STARTER_CREDITS, STARTER_CREDITS)]
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
            _snapshot(),
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
        assert account["credits_balance"] == STARTER_CREDITS


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
