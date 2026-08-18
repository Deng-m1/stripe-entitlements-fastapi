from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

import asyncpg
import pytest

from stripe_entitlements.checkout import CheckoutCoordinator
from stripe_entitlements.credits import CreditService, CreditsUnavailableError
from stripe_entitlements.processor import EventProcessor
from tests.builders import (
    checkout_event,
    dispute,
    paid_invoice,
    payment_failed,
    prorated_upgrade_invoice,
    refunded_charge,
    subscription_event,
)


async def _insert_change(
    pool: asyncpg.Pool,
    account_id: str,
    *,
    target_plan: str = "pro",
    target_interval: str = "month",
    mode: str = "immediate",
    status: str = "applied",
    policy: str = "full_period_reset",
    proration_date: int | None = None,
    source_proration: int = 950,
    target_proration: int = 2450,
) -> str:
    change_id = uuid.uuid4()
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
        assert account is not None
        source_invoice = None
        credit_delta = None
        if policy == "prorated_delta":
            source_invoice = await conn.fetchval(
                """select stripe_invoice_id from credit_ledger
                     where account_id=$1::uuid and grant_epoch=$2
                       and grant_slot is not null and entitlement_units > 0
                     order by id desc limit 1""",
                account_id,
                account["grant_epoch"],
            )
            source_credits = {"starter": 300, "pro": 1000, "ultra": 4000}[str(account["plan_key"])]
            target_credits = {"starter": 300, "pro": 1000, "ultra": 4000}[target_plan]
            credit_delta = target_credits - source_credits
        await conn.execute(
            """insert into billing_plan_changes(
                   id,account_id,idempotency_key,stripe_subscription_id,
                   from_plan_key,from_interval,target_plan_key,target_interval,
                   effective_mode,status,stripe_request_key,expected_grant_epoch,
                   expected_entitlement_period_end,expected_subscription_status,
                   expected_cancel_at_period_end,transition_policy,
                   expected_source_invoice_id,expected_credit_delta,
                   expected_entitlement_revoked,proration_date,
                   estimated_source_proration,estimated_target_proration,
                   estimated_amount_due,estimated_period_start,
                   estimated_period_end,estimate_currency)
                 values($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                        $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)""",
            change_id,
            account_id,
            f"request-{change_id}",
            account["stripe_subscription_id"],
            account["plan_key"],
            account["plan_interval"],
            target_plan,
            target_interval,
            mode,
            status,
            f"plan-change:{change_id}",
            account["grant_epoch"],
            account["entitlement_period_end"],
            account["subscription_status"],
            account["cancel_at_period_end"],
            policy,
            source_invoice,
            credit_delta,
            account["entitlement_revoked"],
            proration_date,
            source_proration if policy == "prorated_delta" else None,
            target_proration if policy == "prorated_delta" else None,
            target_proration - source_proration if policy == "prorated_delta" else None,
            datetime.fromtimestamp(proration_date, tz=UTC)
            if policy == "prorated_delta" and proration_date is not None
            else None,
            account["entitlement_period_end"] if policy == "prorated_delta" else None,
            "usd" if policy == "prorated_delta" else None,
        )
    return str(change_id)


async def _initial_paid(processor: EventProcessor, account_id: str) -> None:
    result = await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_initial_paid",
            period_start=1_800_000_000,
            period_end=1_802_592_000,
            created=100,
        )
    )
    assert result.outcome == "handled"


async def test_immediate_invoice_real_shape_activates_only_with_intent_and_replays(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(pool, account_id)
    # A later observed update may arrive first. It must neither grant nor make the
    # immutable paid invoice stale.
    await processor.process(
        subscription_event(account_id, plan="pro", interval="month", created=202)
    )
    invoice = paid_invoice(
        account_id,
        invoice_id="in_upgrade",
        plan="pro",
        interval="month",
        billing_reason="subscription_update",
        period_start=1_801_000_000,
        period_end=1_803_592_000,
        created=201,
        event_id="evt_upgrade_paid_1",
    )
    assert (await processor.process(invoice)).outcome == "handled"
    replay = paid_invoice(
        account_id,
        invoice_id="in_upgrade",
        plan="pro",
        interval="month",
        billing_reason="subscription_update",
        period_start=1_801_000_000,
        period_end=1_803_592_000,
        created=203,
        event_id="evt_upgrade_paid_2",
    )
    assert (await processor.process(replay)).outcome == "replayed"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
        change_status = await conn.fetchval("select status from billing_plan_changes")
        settlement_invoice_id = await conn.fetchval(
            "select settlement_invoice_id from billing_plan_changes"
        )
    assert account is not None
    assert (account["plan_key"], account["credits_balance"]) == ("pro", 1000)
    assert change_status == "completed"
    assert settlement_invoice_id == "in_upgrade"


async def test_unconfirmed_preview_cannot_authorize_external_paid_update(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(pool, account_id, status="previewed")
    result = await processor.process(
        paid_invoice(
            account_id,
            plan="pro",
            invoice_id="in_unconfirmed_external_update",
            billing_reason="subscription_update",
            period_start=1_802_592_001,
            period_end=1_805_184_001,
        )
    )
    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select plan_key,credits_balance from billing_accounts where id=$1::uuid",
            account_id,
        )
        incident = await conn.fetchval(
            """select count(*) from billing_incidents
                 where kind='paid_plan_change_without_intent'"""
        )
    assert account is not None and tuple(account) == ("starter", 300)
    assert incident == 1


async def test_plan_change_invoice_with_old_invoice_proration_fails_closed(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(pool, account_id)
    result = await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_cross_funded_upgrade",
            plan="pro",
            interval="month",
            billing_reason="subscription_update",
            proration_amount=-900,
            period_start=1_801_000_000,
            period_end=1_803_592_000,
            created=201,
        )
    )

    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select plan_key,credits_balance from billing_accounts where id=$1::uuid",
            account_id,
        )
        incidents = await conn.fetchval(
            "select count(*) from billing_incidents where kind='unsafe_cross_invoice_proration'"
        )
    assert account is not None and tuple(account) == ("starter", 300)
    assert incidents == 1


@pytest.mark.parametrize("subscription_update_first", [False, True])
async def test_prorated_delta_upgrade_preserves_period_and_used_balance_in_both_orders(
    subscription_update_first: bool,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await CreditService(pool).charge(account_id, 50, "used-before-upgrade")
    change_id = await _insert_change(
        pool,
        account_id,
        policy="prorated_delta",
        proration_date=1_801_000_000,
    )
    if subscription_update_first:
        updated = subscription_event(account_id, plan="pro", interval="month", created=250)
        assert (await processor.process(updated)).outcome == "handled"
    result = await processor.process(
        prorated_upgrade_invoice(
            account_id,
            invoice_id="in_delta_ordered",
            event_id="evt_delta_ordered",
            created=201,
        )
    )
    assert result.outcome == "handled"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
        allocation = await conn.fetchrow(
            "select * from billing_funding_allocations where plan_change_id=$1::uuid",
            change_id,
        )
    assert account is not None and allocation is not None
    assert (account["plan_key"], account["credits_balance"], account["grant_epoch"]) == (
        "pro",
        950,
        1,
    )
    assert account["entitlement_period_end"] == datetime.fromtimestamp(1_802_592_000, tz=UTC)
    assert (
        allocation["source_invoice_id"],
        allocation["entitlement_delta"],
        allocation["amount_paid"],
        allocation["status"],
    ) == ("in_initial_paid", 700, 1500, "active")


async def test_prorated_delta_different_events_same_invoice_are_concurrent_safe(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(
        pool,
        account_id,
        policy="prorated_delta",
        proration_date=1_801_000_000,
    )
    first = prorated_upgrade_invoice(
        account_id, invoice_id="in_delta_race", event_id="evt_delta_race_a"
    )
    second = prorated_upgrade_invoice(
        account_id, invoice_id="in_delta_race", event_id="evt_delta_race_b"
    )
    results = await asyncio.gather(processor.process(first), processor.process(second))
    assert sorted(result.outcome for result in results) == ["handled", "replayed"]
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                """select count(*) from credit_ledger
                 where stripe_invoice_id='in_delta_race' and grant_slot=1"""
            )
            == 1
        )
        assert (
            await conn.fetchval(
                "select credits_balance from billing_accounts where id=$1::uuid", account_id
            )
            == 1000
        )


@pytest.mark.parametrize(
    "malformation",
    [
        "missing_source",
        "unknown_price",
        "pagination_incomplete",
        "zero_target",
        "customer_balance",
        "tax",
        "discount",
        "wrong_proration_date",
        "inconsistent_fraction",
        "overfull_fraction",
        "preview_fact_drift",
        "price_product_identity",
        "extra_line",
    ],
)
async def test_prorated_delta_unknown_or_ambiguous_invoice_shapes_fail_closed(
    malformation: str,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(
        pool,
        account_id,
        policy="prorated_delta",
        proration_date=1_801_000_000,
    )
    payload = prorated_upgrade_invoice(account_id, invoice_id=f"in_bad_{malformation}")
    invoice = payload["data"]["object"]
    lines = invoice["lines"]["data"]
    if malformation == "missing_source":
        lines.pop(0)
    elif malformation == "unknown_price":
        lines[0]["price"]["lookup_key"] = "ent_unknown_month"
    elif malformation == "pagination_incomplete":
        invoice["lines"]["has_more"] = True
    elif malformation == "zero_target":
        lines[1]["amount"] = 0
    elif malformation == "customer_balance":
        invoice["starting_balance"] = -100
    elif malformation == "tax":
        invoice["total_tax_amounts"] = [{"amount": 1}]
    elif malformation == "discount":
        invoice["total_discount_amounts"] = [{"amount": 1}]
    elif malformation == "wrong_proration_date":
        lines[0]["period"]["start"] += 1
        lines[1]["period"]["start"] += 1
    elif malformation == "inconsistent_fraction":
        lines[1]["amount"] = 2400
        invoice["amount_paid"] = invoice["amount_due"] = invoice["subtotal"] = invoice["total"] = (
            1450
        )
    elif malformation == "overfull_fraction":
        lines[0]["amount"] = -3800
        lines[1]["amount"] = 9800
        invoice["amount_paid"] = invoice["amount_due"] = invoice["subtotal"] = invoice["total"] = (
            6000
        )
        async with pool.acquire() as conn:
            await conn.execute(
                """update billing_plan_changes set estimated_source_proration=3800,
                       estimated_target_proration=9800,estimated_amount_due=6000
                     where account_id=$1::uuid""",
                account_id,
            )
    elif malformation == "preview_fact_drift":
        lines[0]["amount"] = -475
        lines[1]["amount"] = 1225
        invoice["amount_paid"] = invoice["amount_due"] = invoice["subtotal"] = invoice["total"] = (
            750
        )
    elif malformation == "price_product_identity":
        lines[1]["_resolved_price"]["product"]["metadata"]["plan"] = "ultra"
    elif malformation == "extra_line":
        lines.append(dict(lines[1], id="il_extra"))
    result = await processor.process(payload)
    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select plan_key,credits_balance from billing_accounts where id=$1::uuid",
            account_id,
        )
        expected_kind = (
            "incomplete_invoice_lines"
            if malformation == "pagination_incomplete"
            else "invalid_prorated_delta_invoice"
        )
        incident = await conn.fetchval(
            "select count(*) from billing_incidents where kind=$1",
            expected_kind,
        )
    assert account is not None and tuple(account) == ("starter", 300)
    assert incident == 1


@pytest.mark.parametrize("refund_first", [False, True])
@pytest.mark.parametrize("full", [False, True])
async def test_prorated_delta_refund_before_and_after_paid_converges(
    refund_first: bool,
    full: bool,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    change_id = await _insert_change(
        pool,
        account_id,
        policy="prorated_delta",
        proration_date=1_801_000_000,
    )
    paid = prorated_upgrade_invoice(account_id, invoice_id="in_delta_refund")
    refund = refunded_charge(
        amount=1500,
        amount_refunded=1500 if full else 750,
        invoice_id="in_delta_refund",
        refunded=full,
    )
    events = [refund, paid] if refund_first else [paid, refund]
    for payload in events:
        await processor.process(payload)
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
        allocation = await conn.fetchrow(
            "select * from billing_funding_allocations where plan_change_id=$1::uuid",
            change_id,
        )
        change = await conn.fetchrow(
            "select status,last_error from billing_plan_changes where id=$1::uuid",
            change_id,
        )
    assert account is not None and allocation is not None and change is not None
    if full:
        assert (
            account["plan_key"],
            account["credits_balance"],
            account["entitlement_revoked"],
        ) == ("starter", 300, False)
        assert allocation["status"] == "closed"
        assert tuple(change) == ("failed", "settlement_funding_closed") or tuple(change) == (
            "failed",
            "invoice_funding_closed",
        )
    else:
        assert (
            account["plan_key"],
            account["credits_balance"],
            account["entitlement_revoked"],
        ) == ("pro", 650, False)
        assert allocation["status"] == "partially_refunded"
        assert allocation["refunded_units"] == 350


async def test_full_period_closed_before_paid_business_replay_keeps_source_entitlement(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(pool, account_id, status="applying")
    first_refund = refunded_charge(
        invoice_id="in_full_period_closed_before_paid",
        amount=4900,
        amount_refunded=4900,
        refunded=True,
        event_id="evt_full_period_closed_a",
    )
    assert (await processor.process(first_refund)).outcome == "ignored"
    paid = paid_invoice(
        account_id,
        invoice_id="in_full_period_closed_before_paid",
        plan="pro",
        interval="month",
        billing_reason="subscription_update",
        period_start=1_801_000_000,
        period_end=1_803_592_000,
        created=201,
        event_id="evt_full_period_closed_paid",
    )
    assert (await processor.process(paid)).outcome == "ignored"
    replay = refunded_charge(
        invoice_id="in_full_period_closed_before_paid",
        amount=4900,
        amount_refunded=4900,
        refunded=True,
        event_id="evt_full_period_closed_b",
    )
    assert (await processor.process(replay)).outcome == "replayed"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select plan_key,credits_balance,grant_epoch,entitlement_revoked "
            "from billing_accounts where id=$1::uuid",
            account_id,
        )
        state = await conn.fetchrow(
            "select closure_applied from stripe_invoice_state "
            "where invoice_id='in_full_period_closed_before_paid'"
        )
        blocked = await conn.fetchval(
            """select count(*) from credit_ledger
                where stripe_invoice_id='in_full_period_closed_before_paid'
                  and reason='subscription_grant_blocked'"""
        )
    assert account is not None and tuple(account) == ("starter", 300, 1, False)
    assert state is not None and state["closure_applied"] is True
    assert blocked == 1


async def test_leaf_delta_closure_advances_epoch_and_blocks_late_usage_refund(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(
        pool,
        account_id,
        policy="prorated_delta",
        proration_date=1_801_000_000,
    )
    await processor.process(prorated_upgrade_invoice(account_id, invoice_id="in_delta_usage_epoch"))
    credits = CreditService(pool)
    assert (await credits.charge(account_id, 700, "delta-funded-job")).outcome == "charged"
    await processor.process(
        refunded_charge(
            invoice_id="in_delta_usage_epoch",
            amount=1500,
            amount_refunded=1500,
            refunded=True,
        )
    )
    late = await credits.refund("delta-funded-job")
    assert late.outcome == "epoch_expired"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
    assert account is not None
    assert (
        account["plan_key"],
        account["credits_balance"],
        account["grant_epoch"],
        account["entitlement_revoked"],
    ) == ("starter", 0, 2, False)


async def test_closed_delta_business_replay_cannot_move_debt_to_new_epoch(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(
        pool,
        account_id,
        policy="prorated_delta",
        proration_date=1_801_000_000,
    )
    await processor.process(prorated_upgrade_invoice(account_id, invoice_id="in_delta_debt_replay"))
    await CreditService(pool).charge(account_id, 1_000, "spent-before-delta-refund")

    first = await processor.process(
        refunded_charge(
            invoice_id="in_delta_debt_replay",
            amount=1500,
            amount_refunded=1500,
            refunded=True,
            event_id="evt_delta_debt_closed_a",
        )
    )
    replay = await processor.process(
        refunded_charge(
            invoice_id="in_delta_debt_replay",
            amount=1500,
            amount_refunded=1500,
            refunded=True,
            event_id="evt_delta_debt_closed_b",
        )
    )

    assert first.outcome == "handled"
    assert replay.outcome == "replayed"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select plan_key,credits_balance,grant_epoch from billing_accounts where id=$1::uuid",
            account_id,
        )
        debts = await conn.fetch(
            """select grant_epoch,target_units,collected_units
                 from billing_clawback_debts
                where account_id=$1::uuid
                  and stripe_invoice_id='in_delta_debt_replay'
                order by grant_epoch""",
            account_id,
        )
    assert account is not None and tuple(account) == ("starter", 0, 2)
    assert [tuple(row) for row in debts] == [(1, 700, 0)]


async def test_source_refund_remains_attributed_after_leaf_delta_reversion(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(
        pool,
        account_id,
        policy="prorated_delta",
        proration_date=1_801_000_000,
    )
    await processor.process(
        prorated_upgrade_invoice(account_id, invoice_id="in_delta_then_source_refund")
    )
    await processor.process(
        refunded_charge(
            invoice_id="in_delta_then_source_refund",
            amount=1500,
            amount_refunded=1500,
            refunded=True,
        )
    )
    source_refund = await processor.process(
        refunded_charge(
            invoice_id="in_initial_paid",
            amount=1900,
            amount_refunded=950,
            event_id="evt_source_after_revert",
        )
    )
    assert source_refund.outcome == "handled"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
    assert account is not None
    assert (
        account["plan_key"],
        account["credits_balance"],
        account["grant_epoch"],
        account["entitlement_revoked"],
    ) == ("starter", 150, 2, False)


async def test_full_source_refund_after_leaf_reversion_closes_active_lineage(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(
        pool,
        account_id,
        policy="prorated_delta",
        proration_date=1_801_000_000,
    )
    await processor.process(
        prorated_upgrade_invoice(account_id, invoice_id="in_leaf_then_source_close")
    )
    await processor.process(
        refunded_charge(
            invoice_id="in_leaf_then_source_close",
            amount=1500,
            amount_refunded=1500,
            refunded=True,
        )
    )
    await processor.process(
        refunded_charge(
            invoice_id="in_initial_paid",
            amount=1900,
            amount_refunded=1900,
            refunded=True,
            event_id="evt_source_closed_after_leaf",
        )
    )
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
        incidents = await conn.fetchval(
            """select count(*) from billing_incidents
                 where kind='funding_lineage_closed'"""
        )
    assert account is not None
    assert (
        account["plan_key"],
        account["credits_balance"],
        account["grant_epoch"],
        account["entitlement_revoked"],
    ) == ("starter", 0, 3, True)
    assert incidents == 1


async def test_refund_of_source_invoice_after_delta_remains_attributed(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(
        pool,
        account_id,
        policy="prorated_delta",
        proration_date=1_801_000_000,
    )
    await processor.process(prorated_upgrade_invoice(account_id, invoice_id="in_delta_source"))
    result = await processor.process(
        refunded_charge(invoice_id="in_initial_paid", amount=1900, amount_refunded=950)
    )
    assert result.outcome == "handled"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
    assert account is not None
    assert (account["plan_key"], account["credits_balance"], account["entitlement_revoked"]) == (
        "pro",
        850,
        False,
    )


async def test_delta_grant_collects_outstanding_source_clawback_debt(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    credits = CreditService(pool)
    await credits.charge(account_id, 300, "spent-source-before-partial-refund")
    await processor.process(
        refunded_charge(
            invoice_id="in_initial_paid",
            amount=1900,
            amount_refunded=950,
            event_id="evt_source_partial_debt",
        )
    )
    await _insert_change(
        pool,
        account_id,
        policy="prorated_delta",
        proration_date=1_801_000_000,
    )
    result = await processor.process(
        prorated_upgrade_invoice(account_id, invoice_id="in_delta_pays_source_debt")
    )
    assert result.outcome == "handled"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select plan_key,credits_balance from billing_accounts where id=$1::uuid",
            account_id,
        )
        debt = await conn.fetchrow(
            """select target_units,collected_units from billing_clawback_debts
                 where account_id=$1::uuid and stripe_invoice_id='in_initial_paid'""",
            account_id,
        )
    assert account is not None and tuple(account) == ("pro", 550)
    assert debt is not None and tuple(debt) == (150, 150)


@pytest.mark.parametrize("dispute_first", [False, True])
async def test_prorated_delta_dispute_before_and_after_paid_reverts_to_source(
    dispute_first: bool,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(
        pool,
        account_id,
        policy="prorated_delta",
        proration_date=1_801_000_000,
    )
    paid = prorated_upgrade_invoice(account_id, invoice_id="in_delta_dispute")
    disputed = dispute(invoice_id="in_delta_dispute", amount=1500)
    for payload in [disputed, paid] if dispute_first else [paid, disputed]:
        await processor.process(payload)
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
        allocation = await conn.fetchrow(
            """select status,refunded_units from billing_funding_allocations
                 where stripe_invoice_id='in_delta_dispute'"""
        )
    assert account is not None and allocation is not None
    assert (account["plan_key"], account["credits_balance"], account["entitlement_revoked"]) == (
        "starter",
        300,
        False,
    )
    assert tuple(allocation) == ("disputed", 700)


async def test_prorated_delta_transaction_rolls_back_and_same_event_retries(
    processor: EventProcessor, pool: asyncpg.Pool, make_account, monkeypatch
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(
        pool,
        account_id,
        policy="prorated_delta",
        proration_date=1_801_000_000,
    )
    await processor.process(
        refunded_charge(
            invoice_id="in_delta_retry",
            amount=1500,
            amount_refunded=750,
            event_id="evt_delta_retry_refund",
        )
    )
    payload = prorated_upgrade_invoice(
        account_id,
        invoice_id="in_delta_retry",
        event_id="evt_delta_retry_paid",
    )
    original = processor._apply_clawback_to_grant
    attempts = 0

    async def fail_once(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("injected delta rollback")
        return await original(*args, **kwargs)

    monkeypatch.setattr(processor, "_apply_clawback_to_grant", fail_once)
    with pytest.raises(RuntimeError, match="injected delta rollback"):
        await processor.process(payload)
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                "select count(*) from stripe_webhook_events where id='evt_delta_retry_paid'"
            )
            == 0
        )
        assert await conn.fetchval("select count(*) from billing_funding_allocations") == 0
        assert (
            await conn.fetchval(
                "select credits_balance from billing_accounts where id=$1::uuid", account_id
            )
            == 300
        )

    retried = await processor.process(payload)
    assert retried.outcome == "handled"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select plan_key,credits_balance from billing_accounts where id=$1::uuid",
            account_id,
        )
    assert account is not None and tuple(account) == ("pro", 650)


async def test_full_source_refund_after_delta_revokes_the_dependent_lineage(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(
        pool,
        account_id,
        policy="prorated_delta",
        proration_date=1_801_000_000,
    )
    await processor.process(
        prorated_upgrade_invoice(account_id, invoice_id="in_delta_depends_on_source")
    )
    await processor.process(
        refunded_charge(
            invoice_id="in_initial_paid",
            amount=1900,
            amount_refunded=1900,
            refunded=True,
        )
    )
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
        incident = await conn.fetchval(
            "select count(*) from billing_incidents where kind='funding_lineage_closed'"
        )
    assert account is not None
    assert account["plan_key"] == "pro"
    assert account["credits_balance"] == 700
    assert account["entitlement_revoked"] is True
    assert account["grant_epoch"] == 2
    assert incident == 1


async def test_refunding_an_intermediate_delta_with_downstream_upgrade_revokes(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(
        pool,
        account_id,
        policy="prorated_delta",
        proration_date=1_801_000_000,
    )
    await processor.process(prorated_upgrade_invoice(account_id, invoice_id="in_delta_starter_pro"))
    await _insert_change(
        pool,
        account_id,
        target_plan="ultra",
        policy="prorated_delta",
        proration_date=1_801_100_000,
        source_proration=2450,
        target_proration=7450,
    )
    await processor.process(
        prorated_upgrade_invoice(
            account_id,
            invoice_id="in_delta_pro_ultra",
            source_plan="pro",
            target_plan="ultra",
            source_credit=2450,
            target_charge=7450,
            proration_date=1_801_100_000,
        )
    )
    await processor.process(
        refunded_charge(
            invoice_id="in_delta_starter_pro",
            amount=1500,
            amount_refunded=1500,
            refunded=True,
        )
    )
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
        lineage = await conn.fetchval(
            "select count(*) from billing_incidents where kind='funding_lineage_closed'"
        )
    assert account is not None
    assert (account["plan_key"], account["credits_balance"]) == ("ultra", 3300)
    assert account["entitlement_revoked"] is True
    assert account["grant_epoch"] == 2
    assert lineage == 1


async def test_old_delta_refund_after_renewal_cannot_rewrite_new_epoch(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(
        pool,
        account_id,
        policy="prorated_delta",
        proration_date=1_801_000_000,
    )
    await processor.process(
        prorated_upgrade_invoice(account_id, invoice_id="in_delta_before_renewal")
    )
    renewed = await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_pro_renewal",
            plan="pro",
            interval="month",
            period_start=1_802_592_000,
            period_end=1_805_184_000,
            created=500,
        )
    )
    assert renewed.outcome == "handled"
    old_refund = await processor.process(
        refunded_charge(
            invoice_id="in_delta_before_renewal",
            amount=1500,
            amount_refunded=1500,
            refunded=True,
            created=600,
        )
    )
    assert old_refund.outcome == "ignored"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
    assert account is not None
    assert (
        account["plan_key"],
        account["credits_balance"],
        account["grant_epoch"],
        account["entitlement_revoked"],
    ) == ("pro", 1000, 2, False)


async def test_delta_payment_failure_keeps_the_source_entitlement(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(
        pool,
        account_id,
        policy="prorated_delta",
        proration_date=1_801_000_000,
    )
    async with pool.acquire() as conn:
        await conn.execute("update billing_plan_changes set settlement_invoice_id='in_failed'")
    failed = payment_failed(account_id, event_id="evt_delta_payment_failed")
    failed["data"]["object"]["billing_reason"] = "subscription_update"
    result = await processor.process(failed)
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
        status = await conn.fetchval("select status from billing_plan_changes")
    assert result.outcome == "ignored"
    assert account is not None
    assert (account["plan_key"], account["credits_balance"], account["grant_epoch"]) == (
        "starter",
        300,
        1,
    )
    assert account["entitlement_revoked"] is False
    assert status == "requires_action"


async def test_dashboard_price_change_cycle_without_intent_fails_closed(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    result = await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_unauthorized_cycle",
            plan="pro",
            billing_reason="subscription_cycle",
        )
    )
    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select plan_key,credits_balance from billing_accounts where id=$1::uuid", account_id
        )
        incident = await conn.fetchval(
            "select count(*) from billing_incidents where kind='paid_plan_change_without_intent'"
        )
    assert account is not None and tuple(account) == ("starter", 0)
    assert incident == 1


async def test_optional_upgrade_payment_failure_keeps_old_paid_entitlement(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(pool, account_id)
    async with pool.acquire() as conn:
        await conn.execute("update billing_plan_changes set settlement_invoice_id='in_failed'")
    failed = payment_failed(account_id, created=300)
    failed["data"]["object"]["billing_reason"] = "subscription_update"
    result = await processor.process(failed)
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
        status = await conn.fetchval("select status from billing_plan_changes")
    assert result.outcome == "ignored"
    assert account is not None
    assert (account["plan_key"], account["subscription_status"]) == ("starter", "active")
    assert account["credits_balance"] == 300
    assert status == "requires_action"


async def test_paid_settlement_resolves_its_payment_failure_incident(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await _insert_change(pool, account_id)
    async with pool.acquire() as conn:
        await conn.execute(
            "update billing_plan_changes set settlement_invoice_id='in_recovered_upgrade'"
        )
    failed = payment_failed(account_id, event_id="evt_recovered_upgrade_failed")
    failed["data"]["object"].update(
        {"id": "in_recovered_upgrade", "billing_reason": "subscription_update"}
    )
    assert (await processor.process(failed)).outcome == "ignored"

    paid = paid_invoice(
        account_id,
        invoice_id="in_recovered_upgrade",
        plan="pro",
        interval="month",
        billing_reason="subscription_update",
        period_start=1_801_000_000,
        period_end=1_803_592_000,
        created=301,
        event_id="evt_recovered_upgrade_paid",
    )
    assert (await processor.process(paid)).outcome == "handled"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select plan_key,credits_balance from billing_accounts where id=$1::uuid",
            account_id,
        )
        incident = await conn.fetchrow(
            """select resolved_at from billing_incidents
                 where kind='plan_change_payment_failed'
                   and invoice_id='in_recovered_upgrade'"""
        )
    assert account is not None and tuple(account) == ("pro", 1000)
    assert incident is not None and incident["resolved_at"] is not None


async def test_delayed_old_payment_failure_cannot_mutate_new_plan_change(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    old_change_id = await _insert_change(pool, account_id)
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_plan_changes set status='completed',completed_at=now(),
                     settlement_invoice_id='in_old_failed'
                 where id=$1::uuid""",
            old_change_id,
        )
    new_change_id = await _insert_change(
        pool,
        account_id,
        target_plan="ultra",
        status="applying",
    )
    delayed = payment_failed(account_id, event_id="evt_delayed_old_failure")
    delayed["data"]["object"].update(
        {"id": "in_old_failed", "billing_reason": "subscription_update"}
    )

    result = await processor.process(delayed)
    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select subscription_status,plan_key,credits_balance "
            "from billing_accounts where id=$1::uuid",
            account_id,
        )
        new_status = await conn.fetchval(
            "select status from billing_plan_changes where id=$1::uuid",
            new_change_id,
        )
        incidents = await conn.fetchval(
            "select count(*) from billing_incidents where kind='unbound_plan_change_payment_failed'"
        )
    assert account is not None and tuple(account) == ("active", "starter", 300)
    assert new_status == "applying"
    assert incidents == 1


async def test_dahlia_cancel_projection_exposes_pending_free_without_changing_paid_plan(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await processor.process(subscription_event(account_id, cancel_at_period_end=True, created=400))
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
    assert account is not None
    assert account["plan_key"] == "starter"
    assert account["cancel_at_period_end"] is True
    assert account["pending_free_at"] == datetime.fromtimestamp(1_802_592_000, tz=UTC)


@pytest.mark.parametrize("paid_first", [False, True])
async def test_checkout_completed_and_paid_create_converge_in_either_order(
    paid_first: bool, processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    checkout = CheckoutCoordinator(pool)
    claim = await checkout.reserve(account_id, "starter", "month", request_key="first-buy")
    await checkout.attach_session(claim, "cs_first", "https://checkout.test/first")
    completed = checkout_event(
        "checkout.session.completed",
        account_id,
        "cs_first",
        subscription="sub_first",
        customer="cus_first",
    )
    paid = paid_invoice(
        account_id,
        invoice_id="in_first",
        customer="cus_first",
        subscription="sub_first",
        billing_reason="subscription_create",
        claim_token=claim.claim_token,
    )
    events = [paid, completed] if paid_first else [completed, paid]
    for payload in events:
        await processor.process(payload)
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
    assert account is not None
    assert (account["stripe_subscription_id"], account["credits_balance"]) == (
        "sub_first",
        300,
    )


async def test_paid_create_before_session_attach_requires_exact_claim_token(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    checkout = CheckoutCoordinator(pool)
    claim = await checkout.reserve(account_id, "starter", "month", request_key="paid-before-attach")
    wrong = await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_wrong_claim",
            subscription="sub_wrong",
            billing_reason="subscription_create",
            claim_token="00000000-0000-0000-0000-000000000000",
        )
    )
    paid = await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_matching_claim",
            subscription="sub_matching",
            billing_reason="subscription_create",
            claim_token=claim.claim_token,
        )
    )

    assert wrong.outcome == "ignored"
    assert paid.outcome == "handled"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
    assert account is not None
    assert (account["stripe_subscription_id"], account["credits_balance"]) == (
        "sub_matching",
        300,
    )


async def test_delayed_paid_create_uses_attached_claim_even_after_local_expiry(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    checkout = CheckoutCoordinator(pool)
    claim = await checkout.reserve(account_id, "starter", "month", request_key="delayed")
    await checkout.attach_session(claim, "cs_delayed", "https://checkout.test/delayed")
    async with pool.acquire() as conn:
        await conn.execute("update checkout_claims set expires_at=now()-interval '1 hour'")
    result = await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_delayed",
            subscription="sub_delayed",
            billing_reason="subscription_create",
            claim_token=claim.claim_token,
        )
    )
    assert result.outcome == "handled"


async def test_full_refund_revokes_features_and_credit_consumption(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await processor.process(
        refunded_charge(
            invoice_id="in_initial_paid", amount=1900, amount_refunded=1900, refunded=True
        )
    )
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
    assert account is not None and account["entitlement_revoked"] is True
    with pytest.raises(CreditsUnavailableError):
        await CreditService(pool).charge(account_id, 1, "revoked-job")
