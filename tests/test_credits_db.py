from __future__ import annotations

import asyncio

import asyncpg
import pytest

from stripe_entitlements.bounds import POSTGRES_BIGINT_MAX
from stripe_entitlements.credits import (
    CreditService,
    CreditsUnavailableError,
    InsufficientCreditsError,
)
from stripe_entitlements.processor import EventProcessor
from tests.builders import paid_invoice, payment_failed


async def test_credit_charge_rejects_amount_outside_postgresql_bigint_range(
    pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    with pytest.raises(ValueError, match="bigint maximum"):
        await CreditService(pool).charge(
            account_id,
            POSTGRES_BIGINT_MAX + 1,
            "oversized-credit-charge",
        )
    async with pool.acquire() as conn:
        assert await conn.fetchval("select count(*) from credit_debits") == 0


async def test_atomic_charge_and_refund(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id))
    service = CreditService(pool)
    charged = await service.charge(account_id, 40, "job-1")
    refunded = await service.refund("job-1")
    assert (charged.outcome, charged.balance) == ("charged", 260)
    assert (refunded.outcome, refunded.balance) == ("refunded", 300)


async def test_same_charge_idempotency_key_never_double_spends(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id))
    service = CreditService(pool)
    results = await asyncio.gather(*(service.charge(account_id, 25, "same-job") for _ in range(20)))
    assert sum(result.outcome == "charged" for result in results) == 1
    assert sum(result.outcome == "replayed" for result in results) == 19
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                "select credits_balance from billing_accounts where id=$1::uuid", account_id
            )
            == 275
        )


async def test_cross_account_concurrent_idempotency_conflict_is_deterministic(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    first_id = await make_account(customer="cus_credit_first", subscription="sub_credit_first")
    second_id = await make_account(customer="cus_credit_second", subscription="sub_credit_second")
    await processor.process(
        paid_invoice(
            first_id,
            invoice_id="in_credit_first",
            customer="cus_credit_first",
            subscription="sub_credit_first",
        )
    )
    await processor.process(
        paid_invoice(
            second_id,
            invoice_id="in_credit_second",
            customer="cus_credit_second",
            subscription="sub_credit_second",
        )
    )
    service = CreditService(pool)

    async def charge(account_id: str) -> str:
        try:
            return (await service.charge(account_id, 25, "global-job-key")).outcome
        except ValueError as exc:
            assert "different parameters" in str(exc)
            return "conflict"

    results = await asyncio.gather(charge(first_id), charge(second_id))
    async with pool.acquire() as conn:
        balances = await conn.fetch(
            """select credits_balance from billing_accounts
                 where id=any($1::uuid[]) order by credits_balance""",
            [first_id, second_id],
        )
        debit_count = await conn.fetchval(
            "select count(*) from credit_debits where idempotency_key='global-job-key'"
        )
        ledger_count = await conn.fetchval(
            "select count(*) from credit_ledger where reason='usage_charge'"
        )
    assert sorted(results) == ["charged", "conflict"]
    assert [row["credits_balance"] for row in balances] == [275, 300]
    assert debit_count == 1
    assert ledger_count == 1


async def test_concurrent_distinct_charges_cannot_overdraw(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id))
    service = CreditService(pool)

    async def charge(index: int) -> str:
        try:
            return (await service.charge(account_id, 100, f"job-{index}")).outcome
        except InsufficientCreditsError:
            return "insufficient"

    results = await asyncio.gather(*(charge(index) for index in range(10)))
    assert results.count("charged") == 3
    assert results.count("insufficient") == 7
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                "select credits_balance from billing_accounts where id=$1::uuid", account_id
            )
            == 0
        )


async def test_concurrent_refund_happens_once(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id))
    service = CreditService(pool)
    await service.charge(account_id, 80, "refund-race")
    results = await asyncio.gather(*(service.refund("refund-race") for _ in range(20)))
    assert sum(result.outcome == "refunded" for result in results) == 1
    assert sum(result.outcome == "replayed" for result in results) == 19
    assert all(result.balance == 300 for result in results)


async def test_refund_cannot_cross_a_new_grant_epoch(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, invoice_id="in_epoch_1"))
    service = CreditService(pool)
    await service.charge(account_id, 50, "old-job")
    await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_epoch_2",
            event_id="evt_epoch_2",
            created=1_800_000_100,
            period_start=1_802_592_000,
        )
    )
    result = await service.refund("old-job")
    assert (result.outcome, result.balance) == ("epoch_expired", 300)


async def test_past_due_account_cannot_consume_credits(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, created=100))
    await processor.process(payment_failed(account_id, created=101))
    with pytest.raises(CreditsUnavailableError):
        await CreditService(pool).charge(account_id, 1, "past-due-job")


@pytest.mark.parametrize("status", ["none", "canceled"])
async def test_non_active_status_blocks_even_with_a_future_credit_window(
    status: str, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_accounts set subscription_status=$2,credits_balance=10,
                   entitlement_revoked=false,credit_expires_at=now()+interval '1 hour'
                 where id=$1::uuid""",
            account_id,
            status,
        )

    with pytest.raises(CreditsUnavailableError, match="not active"):
        await CreditService(pool).charge(account_id, 1, f"job-{status}")


@pytest.mark.parametrize(
    "key",
    ["", " padded ", "line\nbreak", "delete\x7f", "zero\u200bwidth", "x" * 201, "💳" * 51],
)
async def test_credit_idempotency_keys_have_bounded_visible_shape(
    key: str, processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id))
    service = CreditService(pool)
    with pytest.raises(ValueError, match="1 to 200"):
        await service.charge(account_id, 1, key)
    with pytest.raises(ValueError, match="1 to 200"):
        await service.refund(key)


async def test_idempotency_key_parameter_mismatch_is_rejected(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id))
    service = CreditService(pool)
    await service.charge(account_id, 10, "mismatch")
    with pytest.raises(ValueError, match="different parameters"):
        await service.charge(account_id, 11, "mismatch")
