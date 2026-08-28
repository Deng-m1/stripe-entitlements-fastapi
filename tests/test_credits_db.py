from __future__ import annotations

import asyncio

import asyncpg
import pytest

from stripe_entitlements.bounds import POSTGRES_BIGINT_MAX
from stripe_entitlements.catalog import PlanCatalog
from stripe_entitlements.credit_amount import MAX_CREDIT_ATOMS, CreditAmount
from stripe_entitlements.credits import (
    CreditService,
    CreditsUnavailableError,
    InsufficientCreditsError,
)
from stripe_entitlements.processor import EventProcessor
from tests.builders import paid_invoice, payment_failed, refunded_charge
from tests.credit_helpers import atoms, catalog_with_credits


async def test_credit_charge_rejects_amount_outside_postgresql_bigint_range(
    pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    with pytest.raises(ValueError, match="bigint atom range"):
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
    assert (charged.outcome, charged.balance.atoms) == ("charged", 260_000_000)
    assert (refunded.outcome, refunded.balance.atoms) == ("refunded", 300_000_000)


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
            == 275_000_000
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
    assert [row["credits_balance"] for row in balances] == [275_000_000, 300_000_000]
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
    assert all(result.balance.atoms == 300_000_000 for result in results)


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
    assert (result.outcome, result.balance.atoms) == ("epoch_expired", 300_000_000)


async def test_fractional_charge_is_exact_and_equivalent_forms_replay(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id))
    service = CreditService(pool)

    first = await service.charge(account_id, "0.1", "fractional-job")
    replay = await service.charge(
        account_id,
        CreditAmount.parse("0.100000"),
        "fractional-job",
    )

    assert (first.outcome, first.balance.atoms) == ("charged", 299_900_000)
    assert (replay.outcome, replay.balance.atoms) == ("replayed", 299_900_000)
    async with pool.acquire() as conn:
        debit = await conn.fetchrow(
            "select amount from credit_debits where idempotency_key='fractional-job'"
        )
        ledger = await conn.fetchrow(
            "select delta,balance_after from credit_ledger "
            "where stripe_event_id='usage:fractional-job'"
        )
    assert debit is not None and debit["amount"] == 100_000
    assert ledger is not None and tuple(ledger) == (-100_000, 299_900_000)


async def test_ten_fractional_charges_have_no_binary_float_drift(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id))
    service = CreditService(pool)

    for index in range(10):
        await service.charge(account_id, "0.1", f"fractional-tenth:{index}")

    async with pool.acquire() as conn:
        balance = await conn.fetchval(
            "select credits_balance from billing_accounts where id=$1::uuid", account_id
        )
    assert balance == 299_000_000


async def test_refund_rejects_balance_overflow_before_any_effect(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id))
    service = CreditService(pool)
    await service.charge(account_id, 1, "overflow-refund")
    async with pool.acquire() as conn:
        await conn.execute(
            "update billing_accounts set credits_balance=$2 where id=$1::uuid",
            account_id,
            MAX_CREDIT_ATOMS,
        )

    with pytest.raises(OverflowError, match="bigint atom range"):
        await service.refund("overflow-refund")

    async with pool.acquire() as conn:
        debit = await conn.fetchrow(
            "select refunded_at from credit_debits where idempotency_key='overflow-refund'"
        )
        refund_count = await conn.fetchval(
            "select count(*) from credit_ledger "
            "where stripe_event_id='usage-refund:overflow-refund'"
        )
    assert debit is not None and debit["refunded_at"] is None
    assert refund_count == 0


async def test_fractional_subscription_clawback_rounds_up_to_one_atom(
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
    await processor.process(paid_invoice(account_id, invoice_id="in_fractional_clawback"))

    result = await processor.process(
        refunded_charge(
            invoice_id="in_fractional_clawback",
            amount=1900,
            amount_refunded=950,
            event_id="evt_fractional_clawback_half",
        )
    )

    assert result.outcome == "handled"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select credits_balance from billing_accounts where id=$1::uuid",
            account_id,
        )
        debt = await conn.fetchrow(
            "select target_units,collected_units from billing_clawback_debts "
            "where account_id=$1::uuid and stripe_invoice_id='in_fractional_clawback'",
            account_id,
        )
    assert account is not None and account["credits_balance"] == atoms(150)
    assert debt is not None and tuple(debt) == (atoms("150.000001"), atoms("150.000001"))


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
