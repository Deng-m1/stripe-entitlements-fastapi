from __future__ import annotations

import asyncio

import asyncpg

from stripe_entitlements.processor import EventProcessor
from tests.builders import paid_invoice, payment_failed, refunded_charge, subscription_event


async def _balance(pool: asyncpg.Pool, account_id: str) -> int:
    async with pool.acquire() as conn:
        return int(
            await conn.fetchval(
                "select credits_balance from billing_accounts where id=$1::uuid", account_id
            )
        )


async def test_twenty_concurrent_same_event_deliveries_commit_once(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, event_id="evt_concurrent_same")
    results = await asyncio.gather(*(processor.process(payload) for _ in range(20)))
    assert sum(result.outcome == "handled" for result in results) == 1
    assert sum(result.outcome == "duplicate" for result in results) == 19
    assert await _balance(pool, account_id) == 300


async def test_concurrent_different_events_same_invoice_grant_once(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payloads = [
        paid_invoice(
            account_id,
            invoice_id="in_concurrent_business",
            event_id=f"evt_concurrent_business_{index}",
            created=1_800_000_010 + index,
        )
        for index in range(10)
    ]
    results = await asyncio.gather(*(processor.process(payload) for payload in payloads))
    assert sum(result.outcome == "handled" for result in results) == 1
    assert sum(result.outcome in {"replayed", "ignored"} for result in results) == 9
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                "select count(*) from credit_ledger "
                "where stripe_invoice_id='in_concurrent_business'"
            )
            == 1
        )


async def test_concurrent_paid_and_partial_refund_converge(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await asyncio.gather(
        processor.process(paid_invoice(account_id, invoice_id="in_paid_refund_race")),
        processor.process(
            refunded_charge(
                invoice_id="in_paid_refund_race",
                amount_refunded=950,
                event_id="evt_refund_race",
            )
        ),
    )
    assert await _balance(pool, account_id) == 150


async def test_concurrent_cumulative_refunds_keep_greatest_amount(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, invoice_id="in_refund_race"))
    await asyncio.gather(
        processor.process(
            refunded_charge(
                invoice_id="in_refund_race",
                amount_refunded=475,
                event_id="evt_refund_race_25",
            )
        ),
        processor.process(
            refunded_charge(
                invoice_id="in_refund_race",
                amount_refunded=950,
                event_id="evt_refund_race_50",
            )
        ),
    )
    assert await _balance(pool, account_id) == 150
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                "select amount_refunded from stripe_invoice_state where invoice_id='in_refund_race'"
            )
            == 950
        )


async def test_same_second_paid_and_failed_race_always_ends_active(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await asyncio.gather(
        processor.process(paid_invoice(account_id, created=500, event_id="evt_paid_tie")),
        processor.process(payment_failed(account_id, created=500, event_id="evt_failed_tie")),
    )
    async with pool.acquire() as conn:
        status = await conn.fetchval(
            "select subscription_status from billing_accounts where id=$1::uuid", account_id
        )
    assert status == "active"
    assert await _balance(pool, account_id) == 300


async def test_same_second_paid_and_deleted_race_always_ends_canceled(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    deleted = subscription_event(
        account_id,
        "customer.subscription.deleted",
        status="canceled",
        event_id="evt_deleted_tie",
        created=700,
    )
    await asyncio.gather(
        processor.process(paid_invoice(account_id, created=700, event_id="evt_paid_delete_tie")),
        processor.process(deleted),
    )
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """select subscription_status,plan_key,credits_balance
                 from billing_accounts where id=$1::uuid""",
            account_id,
        )
    assert row is not None
    assert tuple(row) == ("canceled", "free", 0)
