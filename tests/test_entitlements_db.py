from __future__ import annotations

import asyncio
import uuid

import asyncpg
import pytest

from stripe_entitlements.catalog import PlanCatalog
from stripe_entitlements.credit_packs import CreditPackCoordinator
from stripe_entitlements.credits import (
    CreditDebitOwnerMismatchError,
    CreditService,
    InsufficientCreditsError,
)
from stripe_entitlements.entitlements import (
    CreditIdempotencyConflictError,
    CreditOperationNotFoundError,
    EntitlementService,
    InvalidOwnerReferenceError,
    validate_owner_external_ref,
)
from stripe_entitlements.processor import EventProcessor
from tests.builders import paid_invoice


@pytest.mark.parametrize(
    "selector",
    [
        "cus_test_owner",
        "sub_test_owner",
        "acct_test_owner",
        "00000000-0000-4000-8000-000000000001",
        "00000000000040008000000000000001",
        " padded ",
        "line\nbreak",
    ],
)
def test_owner_selector_rejects_stripe_and_internal_identifiers(selector: str) -> None:
    with pytest.raises(InvalidOwnerReferenceError):
        validate_owner_external_ref(selector)


def test_namespaced_immutable_owner_reference_is_accepted() -> None:
    owner = f"v1:tenant:{uuid.uuid4()}"
    assert validate_owner_external_ref(owner) == owner


async def test_check_enforces_features_limits_and_does_not_create_missing_owner(
    processor: EventProcessor,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    owner = f"v1:tenant:{uuid.uuid4()}"
    account_id = await make_account(external_ref=owner)
    await processor.process(paid_invoice(account_id))
    service = EntitlementService(pool, catalog)

    allowed = await service.check(
        owner,
        required_features=["pdf_to_ppt"],
        required_limits={"max_file_mb": 30, "max_pages_per_job": 100},
    )
    denied_feature = await service.check(owner, required_features=["api_access"])
    denied_limit = await service.check(owner, required_limits={"max_file_mb": 31})
    missing = await service.check(f"v1:tenant:{uuid.uuid4()}")

    assert allowed.allowed is True
    assert allowed.reason == "allowed"
    assert allowed.entitlements_enforceable is True
    assert allowed.credits_spendable is True
    assert allowed.credit_balance.atoms == 300_000_000
    assert allowed.credit_expires_at is not None
    assert allowed.features == {"pdf_to_ppt": True}
    assert allowed.limits["max_file_mb"].maximum == 30
    assert denied_feature.allowed is False
    assert denied_feature.reason == "feature_not_available"
    assert denied_limit.allowed is False
    assert denied_limit.reason == "limit_exceeded"
    assert missing.reason == "owner_not_found"
    async with pool.acquire() as conn:
        assert await conn.fetchval("select count(*) from billing_accounts") == 1


async def test_check_fails_closed_after_credit_window_expiry(
    processor: EventProcessor,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    owner = f"v1:user:{uuid.uuid4()}"
    account_id = await make_account(external_ref=owner)
    await processor.process(paid_invoice(account_id))
    async with pool.acquire() as conn:
        await conn.execute(
            "update billing_accounts set credit_expires_at=now()-interval '1 second' "
            "where id=$1::uuid",
            account_id,
        )

    decision = await EntitlementService(pool, catalog).check(
        owner,
        required_features=["pdf_to_ppt"],
        required_limits={"max_file_mb": 1},
    )

    assert decision.allowed is False
    assert decision.reason == "entitlement_not_enforceable"
    assert decision.entitlements_enforceable is False
    assert decision.credits_spendable is False
    assert decision.credit_balance.atoms == 0
    assert decision.credit_expires_at is None
    assert decision.features == {"pdf_to_ppt": False}
    assert decision.limits["max_file_mb"].allowed is False


async def test_check_separates_pack_spendability_from_subscription_entitlements(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    owner = f"v1:user:{uuid.uuid4()}"
    account_id = await make_account(external_ref=owner)
    reservation = await CreditPackCoordinator(pool, catalog).reserve(
        account_id,
        catalog.require_credit_pack("boost-100"),
        "pack-only-entitlement-check",
    )
    lot_id = uuid.uuid4()
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute(
            """update credit_pack_orders
                  set checkout_status='completed',payment_status='paid',
                      stripe_checkout_session_id=$2,stripe_payment_intent_id=$3,
                      stripe_charge_id=$4,amount_paid=price_amount,paid_at=now()
                where id=$1::uuid""",
            reservation.order_id,
            f"cs_{reservation.order_id}",
            f"pi_{reservation.order_id}",
            f"ch_{reservation.order_id}",
        )
        await conn.execute(
            """insert into credit_funding_lots(
                   id,order_id,account_id,original_credits,remaining_credits,expires_at)
                 values($1,$2::uuid,$3::uuid,$4,$4,now()+interval '30 days')""",
            lot_id,
            reservation.order_id,
            account_id,
            100_000_000,
        )

    service = EntitlementService(pool, catalog)
    decision = await service.check(owner, required_features=["pdf_to_ppt"])

    assert decision.allowed is False
    assert decision.reason == "entitlement_not_enforceable"
    assert decision.entitlements_enforceable is False
    assert decision.features == {"pdf_to_ppt": False}
    assert decision.credits_spendable is True
    assert decision.credit_balance.atoms == 100_000_000
    assert decision.credit_expires_at is not None

    charged = await service.charge(owner, "25", "pack-only-job")
    after_charge = await service.check(owner)
    assert charged.balance.atoms == 75_000_000
    assert after_charge.credits_spendable is True
    assert after_charge.credit_balance.atoms == 75_000_000


async def test_owner_bound_exact_charge_replays_equivalent_decimal_only(
    processor: EventProcessor,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    owner = f"v1:user:{uuid.uuid4()}"
    account_id = await make_account(external_ref=owner)
    await processor.process(paid_invoice(account_id))
    service = EntitlementService(pool, catalog)

    charged = await service.charge(owner, "0.125", "product-job-1")
    replayed = await service.charge(owner, "0.125000", "product-job-1")

    assert (charged.outcome, charged.balance.atoms) == ("charged", 299_875_000)
    assert (replayed.outcome, replayed.balance.atoms) == ("replayed", 299_875_000)
    with pytest.raises(CreditIdempotencyConflictError):
        await service.charge(owner, "0.125001", "product-job-1")


async def test_same_owner_charge_is_concurrent_and_effectively_once(
    processor: EventProcessor,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    owner = f"v1:user:{uuid.uuid4()}"
    account_id = await make_account(external_ref=owner)
    await processor.process(paid_invoice(account_id))
    service = EntitlementService(pool, catalog)

    results = await asyncio.gather(
        *(service.charge(owner, "25", "concurrent-product-job") for _ in range(20))
    )

    assert sum(result.outcome == "charged" for result in results) == 1
    assert sum(result.outcome == "replayed" for result in results) == 19
    assert all(result.balance.atoms == 275_000_000 for result in results)


async def test_distinct_owner_bound_charges_cannot_concurrently_overdraw(
    processor: EventProcessor,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    owner = f"v1:user:{uuid.uuid4()}"
    account_id = await make_account(external_ref=owner)
    await processor.process(paid_invoice(account_id))
    service = EntitlementService(pool, catalog)

    async def charge(index: int) -> str:
        try:
            return (await service.charge(owner, "100", f"distinct-job-{index}")).outcome
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


async def test_refund_is_owner_bound_and_concurrent_replay_safe(
    processor: EventProcessor,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    first_owner = f"v1:tenant:{uuid.uuid4()}"
    second_owner = f"v1:tenant:{uuid.uuid4()}"
    first_id = await make_account(
        external_ref=first_owner,
        customer="cus_owner_first",
        subscription="sub_owner_first",
    )
    second_id = await make_account(
        external_ref=second_owner,
        customer="cus_owner_second",
        subscription="sub_owner_second",
    )
    await processor.process(
        paid_invoice(
            first_id,
            invoice_id="in_owner_first",
            customer="cus_owner_first",
            subscription="sub_owner_first",
        )
    )
    await processor.process(
        paid_invoice(
            second_id,
            invoice_id="in_owner_second",
            customer="cus_owner_second",
            subscription="sub_owner_second",
        )
    )
    service = EntitlementService(pool, catalog)
    await service.charge(first_owner, "40", "owner-bound-job")

    with pytest.raises(CreditOperationNotFoundError):
        await service.refund(second_owner, "owner-bound-job")
    results = await asyncio.gather(
        *(service.refund(first_owner, "owner-bound-job") for _ in range(20))
    )

    assert sum(result.outcome == "refunded" for result in results) == 1
    assert sum(result.outcome == "replayed" for result in results) == 19
    async with pool.acquire() as conn:
        balances = await conn.fetch(
            "select external_ref,credits_balance from billing_accounts "
            "where id=any($1::uuid[]) order by external_ref",
            [first_id, second_id],
        )
    assert {row["external_ref"]: row["credits_balance"] for row in balances} == {
        first_owner: 300_000_000,
        second_owner: 300_000_000,
    }


async def test_locked_refund_owner_check_converges_with_legitimate_concurrent_refund(
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    first_id = await make_account(
        customer="cus_locked_owner_first",
        subscription="sub_locked_owner_first",
    )
    second_id = await make_account(
        customer="cus_locked_owner_second",
        subscription="sub_locked_owner_second",
    )
    await processor.process(
        paid_invoice(
            first_id,
            invoice_id="in_locked_owner_first",
            customer="cus_locked_owner_first",
            subscription="sub_locked_owner_first",
        )
    )
    await processor.process(
        paid_invoice(
            second_id,
            invoice_id="in_locked_owner_second",
            customer="cus_locked_owner_second",
            subscription="sub_locked_owner_second",
        )
    )
    service = CreditService(pool)
    await service.charge(first_id, "40", "locked-owner-job")

    async def legitimate() -> str:
        return (await service.refund("locked-owner-job", expected_account_id=first_id)).outcome

    async def cross_owner() -> str:
        try:
            await service.refund("locked-owner-job", expected_account_id=second_id)
        except CreditDebitOwnerMismatchError:
            return "owner_mismatch"
        raise AssertionError("cross-owner refund unexpectedly succeeded")

    results = await asyncio.gather(
        *(legitimate() for _ in range(10)),
        *(cross_owner() for _ in range(10)),
    )

    assert results.count("refunded") == 1
    assert results.count("replayed") == 9
    assert results.count("owner_mismatch") == 10
    async with pool.acquire() as conn:
        balances = await conn.fetch(
            "select id,credits_balance from billing_accounts where id=any($1::uuid[]) order by id",
            [first_id, second_id],
        )
        refund_rows = await conn.fetchval(
            "select count(*) from credit_ledger "
            "where stripe_event_id='usage-refund:locked-owner-job'"
        )
    assert {str(row["id"]): row["credits_balance"] for row in balances} == {
        first_id: 300_000_000,
        second_id: 300_000_000,
    }
    assert refund_rows == 1


async def test_owner_bound_refund_cannot_cross_grant_epoch(
    processor: EventProcessor,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    owner = f"v1:user:{uuid.uuid4()}"
    account_id = await make_account(external_ref=owner)
    await processor.process(paid_invoice(account_id, invoice_id="in_internal_epoch_1"))
    service = EntitlementService(pool, catalog)
    await service.charge(owner, "10", "old-epoch-product-job")
    await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_internal_epoch_2",
            event_id="evt_internal_epoch_2",
            created=1_800_000_100,
            period_start=1_802_592_000,
        )
    )

    result = await service.refund(owner, "old-epoch-product-job")

    assert (result.outcome, result.balance.atoms) == ("epoch_expired", 300_000_000)
