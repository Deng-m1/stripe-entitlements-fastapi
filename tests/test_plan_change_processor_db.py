from __future__ import annotations

import uuid
from datetime import UTC, datetime

import asyncpg
import pytest

from stripe_entitlements.checkout import CheckoutCoordinator
from stripe_entitlements.credits import CreditService, CreditsUnavailableError
from stripe_entitlements.processor import EventProcessor
from tests.builders import (
    checkout_event,
    paid_invoice,
    payment_failed,
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
) -> str:
    change_id = uuid.uuid4()
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
        assert account is not None
        await conn.execute(
            """insert into billing_plan_changes(
                   id,account_id,idempotency_key,stripe_subscription_id,
                   from_plan_key,from_interval,target_plan_key,target_interval,
                   effective_mode,status,stripe_request_key,expected_grant_epoch,
                   expected_entitlement_period_end,expected_subscription_status,
                   expected_cancel_at_period_end)
                 values($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)""",
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
    assert account is not None
    assert (account["plan_key"], account["credits_balance"]) == ("pro", 1000)
    assert change_status == "completed"


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


async def test_dahlia_cancel_projection_exposes_pending_free_without_changing_paid_plan(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await _initial_paid(processor, account_id)
    await processor.process(
        subscription_event(account_id, cancel_at_period_end=True, created=400)
    )
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
        "checkout.session.completed", account_id, "cs_first", subscription="sub_first"
    )
    paid = paid_invoice(
        account_id,
        invoice_id="in_first",
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
    claim = await checkout.reserve(
        account_id, "starter", "month", request_key="paid-before-attach"
    )
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
