from __future__ import annotations

from typing import Any

import asyncpg
import pytest

from stripe_entitlements.processor import EventProcessor
from tests.builders import (
    dispute,
    event,
    paid_invoice,
    payment_failed,
    refunded_charge,
    subscription_event,
)


@pytest.mark.parametrize("drift", ["amount", "quantity", "currency"])
async def test_catalog_amount_currency_and_quantity_drift_fail_closed(
    drift: str, processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, invoice_id=f"in_drift_{drift}")
    invoice = payload["data"]["object"]
    line = invoice["lines"]["data"][0]
    if drift == "amount":
        line["amount"] = invoice["amount_paid"] = invoice["total"] = 1
    elif drift == "quantity":
        line["quantity"] = 2
    else:
        line["currency"] = invoice["currency"] = "eur"

    result = await processor.process(payload)
    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "select credits_balance from billing_accounts where id=$1::uuid", account_id
        )
    assert row is not None and row["credits_balance"] == 0


async def _account(pool: asyncpg.Pool, account_id: str) -> dict[str, Any]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("select * from billing_accounts where id=$1::uuid", account_id)
    assert row is not None
    return dict(row)


async def _ledger(pool: asyncpg.Pool, account_id: str) -> list[dict[str, Any]]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "select * from credit_ledger where account_id=$1::uuid order by id", account_id
        )
    return [dict(row) for row in rows]


@pytest.mark.parametrize(
    ("mismatch", "expected_reason"),
    [
        ("livemode", "event livemode does not match the configured Stripe key mode"),
        ("api_version", "event API version does not match the pinned webhook endpoint"),
    ],
)
async def test_webhook_contract_mismatch_is_durable_and_has_no_business_effect(
    mismatch: str,
    expected_reason: str,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    payload = paid_invoice(
        account_id,
        invoice_id=f"in_contract_{mismatch}",
        event_id=f"evt_contract_{mismatch}",
    )
    if mismatch == "livemode":
        payload["livemode"] = True
    else:
        payload["api_version"] = "2025-12-15.clover"

    result = await processor.process(payload)
    duplicate = await processor.process(payload)

    assert (result.outcome, result.reason) == ("ignored", expected_reason)
    assert duplicate.outcome == "duplicate"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            """select plan_key,plan_interval,subscription_status,credits_balance
                 from billing_accounts where id=$1::uuid""",
            account_id,
        )
        inbox = await conn.fetchrow(
            """select outcome,reason,processed_at from stripe_webhook_events
                 where id=$1""",
            payload["id"],
        )
        incident = await conn.fetchrow(
            """select kind,seen_count,detail from billing_incidents
                 where stripe_event_id=$1""",
            payload["id"],
        )
        ledger_count = await conn.fetchval(
            "select count(*) from credit_ledger where account_id=$1::uuid", account_id
        )
        invoice_count = await conn.fetchval(
            "select count(*) from stripe_invoice_state where account_id=$1::uuid", account_id
        )

    assert account is not None and tuple(account) == ("free", None, "none", 0)
    assert inbox is not None and tuple(inbox)[:2] == ("ignored", expected_reason)
    assert inbox["processed_at"] is not None
    assert incident is not None
    assert (incident["kind"], incident["seen_count"]) == ("webhook_contract_mismatch", 1)
    assert incident["detail"]["event_api_version"] == payload["api_version"]
    assert ledger_count == 0
    assert invoice_count == 0


async def test_paid_invoice_grants_from_invoice_snapshot(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    result = await processor.process(paid_invoice(account_id))
    assert result.outcome == "handled"
    account = await _account(pool, account_id)
    assert (account["plan_key"], account["plan_interval"]) == ("starter", "month")
    assert account["subscription_status"] == "active"
    assert account["credits_balance"] == 300
    rows = await _ledger(pool, account_id)
    assert [(row["reason"], row["delta"], row["grant_slot"]) for row in rows] == [
        ("subscription_grant", 300, 1)
    ]


async def test_same_event_id_is_duplicate(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, event_id="evt_same")
    assert (await processor.process(payload)).outcome == "handled"
    assert (await processor.process(payload)).outcome == "duplicate"
    assert len(await _ledger(pool, account_id)) == 1


async def test_different_event_id_same_invoice_is_business_replay(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    first = paid_invoice(account_id, event_id="evt_business_1")
    replay = paid_invoice(account_id, event_id="evt_business_2", created=1_800_000_011)
    assert (await processor.process(first)).outcome == "handled"
    assert (await processor.process(replay)).outcome == "replayed"
    assert len(await _ledger(pool, account_id)) == 1


async def test_new_cycle_resets_credits_instead_of_accumulating(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, invoice_id="in_cycle_1"))
    async with pool.acquire() as conn:
        await conn.execute(
            "update billing_accounts set credits_balance=125 where id=$1::uuid", account_id
        )
    await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_cycle_2",
            event_id="evt_cycle_2",
            created=1_800_000_100,
            period_start=1_802_592_000,
        )
    )
    account = await _account(pool, account_id)
    assert account["credits_balance"] == 300
    rows = await _ledger(pool, account_id)
    assert rows[-1]["delta"] == 175


async def test_unknown_price_fails_closed_and_records_incident(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, invoice_id="in_unknown")
    payload["data"]["object"]["lines"]["data"][0]["price"]["lookup_key"] = "bad_key"
    result = await processor.process(payload)
    assert result.outcome == "ignored"
    assert (await _account(pool, account_id))["credits_balance"] == 0
    async with pool.acquire() as conn:
        incident = await conn.fetchrow("select * from billing_incidents")
    assert incident is not None and incident["kind"] == "unknown_price"


async def test_positive_proration_fails_closed(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    result = await processor.process(
        paid_invoice(account_id, invoice_id="in_proration", proration_amount=100)
    )
    assert result.reason == "cross-invoice proration is unsafe"
    async with pool.acquire() as conn:
        assert await conn.fetchval(
            "select count(*) from billing_incidents where kind='unsafe_cross_invoice_proration'"
        ) == 1


async def test_negative_proration_also_fails_closed_without_funding_lineage(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    result = await processor.process(
        paid_invoice(account_id, invoice_id="in_negative_proration", proration_amount=-500)
    )
    assert result.outcome == "ignored"
    assert (await _account(pool, account_id))["credits_balance"] == 0


async def test_partial_refund_after_paid_claws_cumulative_ratio(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id))
    result = await processor.process(refunded_charge(amount_refunded=950))
    assert result.outcome == "handled"
    assert (await _account(pool, account_id))["credits_balance"] == 150
    assert [row["delta"] for row in await _ledger(pool, account_id)] == [300, -150]


@pytest.mark.parametrize("refund_first", [False, True])
async def test_partial_refund_order_converges(
    refund_first: bool, processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    paid = paid_invoice(account_id, invoice_id="in_partial_order")
    refund = refunded_charge(invoice_id="in_partial_order", amount_refunded=475)
    for payload in ([refund, paid] if refund_first else [paid, refund]):
        await processor.process(payload)
    account = await _account(pool, account_id)
    assert account["credits_balance"] == 225


@pytest.mark.parametrize("refund_first", [False, True])
async def test_full_refund_order_converges(
    refund_first: bool, processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    paid = paid_invoice(account_id, invoice_id="in_full_order")
    refund = refunded_charge(
        invoice_id="in_full_order", amount_refunded=1900, refunded=True
    )
    for payload in ([refund, paid] if refund_first else [paid, refund]):
        await processor.process(payload)
    account = await _account(pool, account_id)
    assert account["credits_balance"] == 0
    assert account["plan_key"] == "starter"
    async with pool.acquire() as conn:
        state = await conn.fetchrow(
            "select * from stripe_invoice_state where invoice_id='in_full_order'"
        )
    assert state is not None and state["fully_refunded"]


async def test_multiple_partial_refunds_use_cumulative_amount(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, invoice_id="in_multi_refund"))
    await processor.process(
        refunded_charge(
            invoice_id="in_multi_refund", amount_refunded=475, event_id="evt_refund_25"
        )
    )
    await processor.process(
        refunded_charge(
            invoice_id="in_multi_refund", amount_refunded=950, event_id="evt_refund_50"
        )
    )
    assert (await _account(pool, account_id))["credits_balance"] == 150
    rows = await _ledger(pool, account_id)
    assert [row["delta"] for row in rows] == [300, -75, -75]


@pytest.mark.parametrize("dispute_first", [False, True])
async def test_dispute_order_converges(
    dispute_first: bool, processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    paid = paid_invoice(account_id, invoice_id="in_dispute")
    disputed = dispute(invoice_id="in_dispute")
    for payload in ([disputed, paid] if dispute_first else [paid, disputed]):
        await processor.process(payload)
    assert (await _account(pool, account_id))["credits_balance"] == 0
    async with pool.acquire() as conn:
        assert await conn.fetchval(
            "select disputed from stripe_invoice_state where invoice_id='in_dispute'"
        )


async def test_same_second_paid_outranks_payment_failure(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, created=200))
    result = await processor.process(payment_failed(account_id, created=200))
    assert result.outcome == "ignored"
    assert (await _account(pool, account_id))["subscription_status"] == "active"


async def test_newer_payment_failure_freezes_account(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, created=200))
    await processor.process(payment_failed(account_id, created=201))
    assert (await _account(pool, account_id))["subscription_status"] == "past_due"


async def test_deleted_subscription_clears_entitlement_and_cannot_be_revived(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, created=200))
    await processor.process(
        subscription_event(
            account_id,
            "customer.subscription.deleted",
            status="canceled",
            event_id="evt_deleted",
            created=300,
        )
    )
    stale = await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_stale",
            event_id="evt_stale_paid",
            created=299,
        )
    )
    assert stale.outcome == "ignored"
    account = await _account(pool, account_id)
    assert (account["plan_key"], account["credits_balance"]) == ("free", 0)


async def test_subscription_update_never_projects_unpaid_plan_or_features(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    result = await processor.process(
        subscription_event(account_id, plan="pro", interval="year", created=100)
    )
    account = await _account(pool, account_id)
    assert result.outcome == "handled"
    assert (account["plan_key"], account["plan_interval"]) == ("starter", "month")
    assert account["credits_balance"] == 0


async def test_unhandled_event_is_audited_without_side_effects(
    processor: EventProcessor, pool: asyncpg.Pool
) -> None:
    result = await processor.process(event("customer.created", {"id": "cus_other"}))
    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        row = await conn.fetchrow("select outcome,processed_at from stripe_webhook_events")
    assert row is not None and row["outcome"] == "ignored" and row["processed_at"] is not None


async def test_incident_deduplication_updates_seen_count(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    for event_id in ("evt_bad_1", "evt_bad_2"):
        payload = paid_invoice(account_id, invoice_id="in_same_bad", event_id=event_id)
        payload["data"]["object"]["lines"]["data"][0]["price"]["lookup_key"] = "bad"
        await processor.process(payload)
    async with pool.acquire() as conn:
        rows = await conn.fetch("select * from billing_incidents")
    assert len(rows) == 1 and rows[0]["seen_count"] == 2


async def test_processing_exception_rolls_back_event_claim(
    processor: EventProcessor, pool: asyncpg.Pool, catalog, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, event_id="evt_retry_after_rollback")

    class ExplodingProcessor(EventProcessor):
        async def _dispatch(self, conn, event):  # type: ignore[no-untyped-def]
            raise RuntimeError("simulated crash")

    exploding = ExplodingProcessor(pool, catalog, "example-entitlements")
    with pytest.raises(RuntimeError, match="simulated crash"):
        await exploding.process(payload)
    async with pool.acquire() as conn:
        assert await conn.fetchval(
            "select count(*) from stripe_webhook_events where id='evt_retry_after_rollback'"
        ) == 0
    assert (await processor.process(payload)).outcome == "handled"


async def test_ledger_delta_sum_matches_current_balance(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id))
    await processor.process(refunded_charge(amount_refunded=475))
    async with pool.acquire() as conn:
        balance, ledger_sum = await conn.fetchrow(
            """select a.credits_balance,
                 (select coalesce(sum(delta),0) from credit_ledger where account_id=a.id)
                 from billing_accounts a where id=$1::uuid""",
            account_id,
        )
    assert balance == ledger_sum == 225
