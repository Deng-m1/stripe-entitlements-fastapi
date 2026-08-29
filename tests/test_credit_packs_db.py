from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

import asyncpg
import pytest

from stripe_entitlements.catalog import PlanCatalog
from stripe_entitlements.checkout import CheckoutBusyError, CheckoutCoordinator
from stripe_entitlements.credit_amount import MAX_CREDIT_ATOMS, CreditAmount
from stripe_entitlements.credit_packs import (
    CreditPackBusyError,
    CreditPackConflictError,
    CreditPackCoordinator,
    CreditPackReservation,
)
from stripe_entitlements.credits import (
    CreditResult,
    CreditService,
    CreditsUnavailableError,
    InsufficientCreditsError,
)
from stripe_entitlements.processor import EventProcessor
from stripe_entitlements.stripe_request_snapshots import (
    build_credit_pack_checkout_request_snapshot,
)
from tests.builders import paid_invoice
from tests.db_lock_helpers import (
    wait_for_account_row_lock_waiter,
    wait_until_database_time_after,
)

API_VERSION = "2026-06-24.dahlia"


def _metadata(
    order_id: str,
    account_id: str,
    pack_key: str = "boost-100",
    *,
    pack_credits: str = "100",
) -> dict[str, str]:
    return {
        "billing_kind": "credit_pack",
        "pack_schema_version": "1",
        "product_line": "example-entitlements",
        "credit_pack_order_id": order_id,
        "account_id": account_id,
        "pack_key": pack_key,
        "pack_credits": pack_credits,
        "price_amount": "1500",
        "currency": "usd",
        "expires_days": "365",
        "lookup_key": f"ent_pack_{pack_key}",
    }


def payment_succeeded(
    order_id: str,
    account_id: str,
    *,
    event_id: str = "evt_pack_paid",
    payment_intent_id: str = "pi_pack",
    charge_id: str = "ch_pack",
    customer_id: str = "cus_test",
    amount: int = 1500,
    authorized_amount: int | None = None,
    amount_received: int | None = None,
    currency: str = "usd",
    created: int = 1_800_000_000,
    livemode: bool = False,
    metadata: dict[str, str] | None = None,
) -> dict[str, Any]:
    return {
        "id": event_id,
        "type": "payment_intent.succeeded",
        "created": created,
        "livemode": livemode,
        "api_version": API_VERSION,
        "data": {
            "object": {
                "id": payment_intent_id,
                "object": "payment_intent",
                "status": "succeeded",
                "amount": amount if authorized_amount is None else authorized_amount,
                "amount_received": amount if amount_received is None else amount_received,
                "currency": currency,
                "customer": customer_id,
                "latest_charge": charge_id,
                "metadata": metadata or _metadata(order_id, account_id),
            }
        },
    }


def pack_checkout_event(
    order_id: str,
    account_id: str,
    *,
    event_id: str = "evt_pack_checkout",
    event_type: str = "checkout.session.completed",
    session_id: str = "cs_pack",
    payment_intent_id: str | None = "pi_pack",
    customer_id: str | None = "cus_test",
    amount_total: int = 1500,
    currency: str = "usd",
    metadata: dict[str, str] | None = None,
) -> dict[str, Any]:
    expired = event_type == "checkout.session.expired"
    return {
        "id": event_id,
        "type": event_type,
        "created": 1_800_000_000,
        "livemode": False,
        "api_version": API_VERSION,
        "data": {
            "object": {
                "id": session_id,
                "object": "checkout.session",
                "mode": "payment",
                "status": "expired" if expired else "complete",
                "payment_status": "unpaid" if expired else "paid",
                "payment_intent": None if expired else payment_intent_id,
                "customer": None if expired else customer_id,
                "client_reference_id": account_id,
                "amount_total": amount_total,
                "currency": currency,
                "metadata": metadata or _metadata(order_id, account_id),
            }
        },
    }


def pack_clawback(
    order_id: str,
    account_id: str,
    *,
    event_id: str,
    amount_refunded: int,
    disputed: bool = False,
    payment_intent_id: str = "pi_pack",
    charge_id: str = "ch_pack",
    customer_id: str = "cus_test",
    metadata: dict[str, str] | None = None,
) -> dict[str, Any]:
    charge_cash_refunded = 0 if disputed else amount_refunded
    payment_intent = {
        "id": payment_intent_id,
        "object": "payment_intent",
        "status": "succeeded",
        "amount": 1500,
        "amount_received": 1500,
        "currency": "usd",
        "customer": customer_id,
        "latest_charge": charge_id,
        "metadata": metadata or _metadata(order_id, account_id),
    }
    charge = {
        "id": charge_id,
        "object": "charge",
        "payment_intent": payment_intent_id,
        "customer": customer_id,
        "amount": 1500,
        "amount_refunded": charge_cash_refunded,
        "currency": "usd",
        "paid": True,
        "refunded": charge_cash_refunded == 1500,
        "disputed": disputed,
    }
    if disputed:
        obj: dict[str, Any] = {
            "id": f"dp_{event_id}",
            "object": "dispute",
            "charge": charge_id,
            "amount": 1500,
            "currency": "usd",
            "_resolved_charge": charge,
            "_resolved_payment_intent": payment_intent,
        }
        event_type = "charge.dispute.created"
    else:
        obj = {**charge, "_resolved_payment_intent": payment_intent}
        event_type = "charge.refunded"
    return {
        "id": event_id,
        "type": event_type,
        "created": 1_800_000_100,
        "livemode": False,
        "api_version": API_VERSION,
        "data": {"object": obj},
    }


async def reserve_pack(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    account_id: str,
    *,
    request_key: str = "buy-pack",
) -> str:
    reservation = await CreditPackCoordinator(pool, catalog).reserve(
        account_id,
        catalog.require_credit_pack("boost-100"),
        request_key,
    )
    return reservation.order_id


async def grant_pack(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    account_id: str,
    *,
    request_key: str = "buy-pack",
    event_id: str = "evt_pack_paid",
    payment_intent_id: str = "pi_pack",
    charge_id: str = "ch_pack",
    created: int = 1_800_000_000,
) -> str:
    order_id = await reserve_pack(pool, catalog, account_id, request_key=request_key)
    result = await processor.process(
        payment_succeeded(
            order_id,
            account_id,
            event_id=event_id,
            payment_intent_id=payment_intent_id,
            charge_id=charge_id,
            created=created,
        )
    )
    assert result.outcome == "handled"
    return order_id


class RecoveringCheckoutCreator:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.fail_once = True
        self.remote_calls = 0

    async def prepare_credit_pack_checkout_session(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return build_credit_pack_checkout_request_snapshot(
            order_id=kwargs["order_id"],
            account_id=kwargs["account_id"],
            customer_id=kwargs["customer_id"],
            price_id="price_test_pack",
            lookup_key=kwargs["lookup_key"],
            currency=kwargs["expected_currency"],
            unit_amount=kwargs["expected_unit_amount"],
            pack_key=kwargs["pack_key"],
            pack_credits=kwargs["pack_credits"],
            expires_days=kwargs["expires_days"],
            product_line="example-entitlements",
            success_url="https://app.example.test/success",
            cancel_url="https://app.example.test/pricing",
            expires_at=int(kwargs["expires_at"].timestamp()),
            request_api_version=API_VERSION,
        )

    async def create_checkout_session_from_snapshot(
        self, snapshot: dict[str, Any]
    ) -> tuple[str, str]:
        del snapshot
        self.remote_calls += 1
        if self.fail_once:
            self.fail_once = False
            raise RuntimeError("unknown remote outcome")
        return "cs_test_pack", "https://checkout.stripe.com/c/pay/cs_test_pack"


async def test_checkout_unknown_outcome_reuses_order_and_remote_identity(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    coordinator = CreditPackCoordinator(pool, catalog)
    creator = RecoveringCheckoutCreator()

    with pytest.raises(RuntimeError, match="unknown remote outcome"):
        await coordinator.create(
            creator,
            account_id=account_id,
            customer_id="cus_test",
            customer_email=None,
            pack_key="boost-100",
            request_key="browser-attempt",
        )
    recovered = await coordinator.create(
        creator,
        account_id=account_id,
        customer_id="cus_test",
        customer_email=None,
        pack_key="boost-100",
        request_key="browser-attempt",
    )

    assert recovered == (
        "cs_test_pack",
        "https://checkout.stripe.com/c/pay/cs_test_pack",
    )
    assert len({call["order_id"] for call in creator.calls}) == 1
    async with pool.acquire() as conn:
        assert await conn.fetchval("select count(*) from credit_pack_orders") == 1


async def test_checkout_replay_uses_snapshot_after_webhook_beats_session_attach(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None, customer=None)
    coordinator = CreditPackCoordinator(pool, catalog)
    creator = RecoveringCheckoutCreator()

    with pytest.raises(RuntimeError, match="unknown remote outcome"):
        await coordinator.create(
            creator,
            account_id=account_id,
            customer_id=None,
            customer_email="first@example.test",
            pack_key="boost-100",
            request_key="webhook-before-attach",
        )
    async with pool.acquire() as conn:
        order_id = str(
            await conn.fetchval(
                """select id from credit_pack_orders
                     where account_id=$1::uuid and client_idempotency_key=$2""",
                account_id,
                "webhook-before-attach",
            )
        )
    projected = await processor.process(
        pack_checkout_event(
            order_id,
            account_id,
            session_id="cs_test_pack",
            payment_intent_id="pi_webhook_first",
            customer_id="cus_webhook_first",
        )
    )
    assert projected.outcome == "handled"

    recovered = await coordinator.create(
        creator,
        account_id=account_id,
        customer_id="cus_webhook_first",
        customer_email="later@example.test",
        pack_key="boost-100",
        request_key="webhook-before-attach",
    )

    assert recovered == (
        "cs_test_pack",
        "https://checkout.stripe.com/c/pay/cs_test_pack",
    )
    assert [call["customer_id"] for call in creator.calls] == [None]
    assert [call["customer_email"] for call in creator.calls] == [None]
    assert len({call["order_id"] for call in creator.calls}) == 1
    async with pool.acquire() as conn:
        order = await conn.fetchrow(
            """select request_customer_id,stripe_customer_id,session_url,checkout_status
                 from credit_pack_orders where id=$1::uuid""",
            order_id,
        )
    assert tuple(order) == (
        None,
        "cus_webhook_first",
        "https://checkout.stripe.com/c/pay/cs_test_pack",
        "completed",
    )


async def test_checkout_replay_does_not_derive_parameters_from_changed_email(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    account_id = await make_account(subscription=None, customer=None)
    coordinator = CreditPackCoordinator(pool, catalog)
    creator = RecoveringCheckoutCreator()

    with pytest.raises(RuntimeError, match="unknown remote outcome"):
        await coordinator.create(
            creator,
            account_id=account_id,
            customer_id=None,
            customer_email="before@example.test",
            pack_key="boost-100",
            request_key="email-drift",
        )
    await coordinator.create(
        creator,
        account_id=account_id,
        customer_id=None,
        customer_email="after@example.test",
        pack_key="boost-100",
        request_key="email-drift",
    )

    assert [call["customer_id"] for call in creator.calls] == [None]
    assert [call["customer_email"] for call in creator.calls] == [None]


async def test_checkout_replay_keeps_reserved_customer_after_account_binding_changes(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    account_id = await make_account(subscription=None, customer="cus_original")
    coordinator = CreditPackCoordinator(pool, catalog)
    creator = RecoveringCheckoutCreator()

    with pytest.raises(RuntimeError, match="unknown remote outcome"):
        await coordinator.create(
            creator,
            account_id=account_id,
            customer_id="cus_original",
            customer_email=None,
            pack_key="boost-100",
            request_key="customer-drift",
        )
    async with pool.acquire() as conn:
        await conn.execute(
            "update billing_accounts set stripe_customer_id=$2 where id=$1::uuid",
            account_id,
            "cus_later_binding",
        )
    await coordinator.create(
        creator,
        account_id=account_id,
        customer_id="cus_later_binding",
        customer_email="changed@example.test",
        pack_key="boost-100",
        request_key="customer-drift",
    )

    assert [call["customer_id"] for call in creator.calls] == ["cus_original"]
    assert [call["customer_email"] for call in creator.calls] == [None]
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                """select request_customer_id from credit_pack_orders
                     where account_id=$1::uuid and client_idempotency_key=$2""",
                account_id,
                "customer-drift",
            )
            == "cus_original"
        )


async def test_order_idempotency_rejects_different_pack(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    coordinator = CreditPackCoordinator(pool, catalog)
    await coordinator.reserve(
        account_id, catalog.require_credit_pack("boost-100"), "same-browser-key"
    )
    with pytest.raises(CreditPackConflictError):
        await coordinator.reserve(
            account_id, catalog.require_credit_pack("boost-500"), "same-browser-key"
        )


async def test_expired_or_unsafe_old_same_key_checkout_never_calls_stripe_again(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    coordinator = CreditPackCoordinator(pool, catalog)
    creator = RecoveringCheckoutCreator()
    creator.fail_once = False

    expired_account = await make_account(subscription=None, customer=None)
    expired = await coordinator.reserve(
        expired_account,
        catalog.require_credit_pack("boost-100"),
        "expired-pack-intent",
    )
    result = await processor.process(
        pack_checkout_event(
            expired.order_id,
            expired_account,
            event_type="checkout.session.expired",
            session_id="cs_expired_pack",
        )
    )
    assert result.outcome == "handled"
    with pytest.raises(CreditPackConflictError, match="new Idempotency-Key"):
        await coordinator.create(
            creator,
            account_id=expired_account,
            customer_id="cus_test",
            customer_email=None,
            pack_key="boost-100",
            request_key="expired-pack-intent",
        )

    unknown_account = await make_account(subscription=None, customer=None)
    unknown = await coordinator.reserve(
        unknown_account,
        catalog.require_credit_pack("boost-100"),
        "unsafe-old-unknown",
    )
    async with pool.acquire() as conn:
        await conn.execute(
            """update credit_pack_orders
                  set claim_expires_at=clock_timestamp()-interval '1 second'
                where id=$1::uuid""",
            unknown.order_id,
        )
    with pytest.raises(CreditPackConflictError, match="operator reconciliation"):
        await coordinator.create(
            creator,
            account_id=unknown_account,
            customer_id="cus_test",
            customer_email=None,
            pack_key="boost-100",
            request_key="unsafe-old-unknown",
        )
    assert creator.calls == []


async def test_first_customer_checkout_is_single_flight_across_purchase_types(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    pack = catalog.require_credit_pack("boost-100")

    pack_first = await make_account(subscription=None, customer=None)
    coordinator = CreditPackCoordinator(pool, catalog)
    first = await coordinator.reserve(pack_first, pack, "first-pack")
    assert (await coordinator.reserve(pack_first, pack, "first-pack")).order_id == first.order_id
    with pytest.raises(CreditPackBusyError, match="first Stripe Customer"):
        await coordinator.reserve(pack_first, pack, "different-pack")
    with pytest.raises(CheckoutBusyError, match="first Stripe Customer"):
        await CheckoutCoordinator(pool).reserve(
            pack_first,
            "starter",
            "month",
            request_key="subscription-after-pack",
        )

    subscription_first = await make_account(subscription=None, customer=None)
    await CheckoutCoordinator(pool).reserve(
        subscription_first,
        "starter",
        "month",
        request_key="first-subscription",
    )
    with pytest.raises(CreditPackBusyError, match="first Stripe Customer"):
        await coordinator.reserve(subscription_first, pack, "pack-after-subscription")


async def test_pack_reservation_rechecks_wall_clock_after_account_lock_wait(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    account_id = await make_account(subscription=None, customer=None)
    coordinator = CreditPackCoordinator(pool, catalog)
    pack = catalog.require_credit_pack("boost-100")
    previous = await coordinator.reserve(account_id, pack, "pack-before-lock-wait")

    blocker = await pool.acquire()
    transaction = blocker.transaction()
    reserve_task: asyncio.Task[CreditPackReservation] | None = None
    committed = False
    await transaction.start()
    try:
        await blocker.fetchrow(
            "select id from billing_accounts where id=$1::uuid for update",
            account_id,
        )
        reserve_task = asyncio.create_task(
            coordinator.reserve(account_id, pack, "pack-after-lock-wait")
        )
        await wait_for_account_row_lock_waiter(pool)
        expires_at = await blocker.fetchval(
            """update credit_pack_orders
                  set claim_expires_at=clock_timestamp()+interval '250 milliseconds'
                where id=$1::uuid returning claim_expires_at""",
            previous.order_id,
        )
        await wait_until_database_time_after(pool, expires_at)
        await transaction.commit()
        committed = True

        replacement = await reserve_task
    finally:
        if not committed:
            await transaction.rollback()
        await pool.release(blocker)
        if reserve_task is not None and not reserve_task.done():
            reserve_task.cancel()
            await asyncio.gather(reserve_task, return_exceptions=True)

    async with pool.acquire() as conn:
        database_now = await conn.fetchval("select clock_timestamp()")
        order_count = await conn.fetchval(
            "select count(*) from credit_pack_orders where account_id=$1::uuid",
            account_id,
        )
    assert replacement.order_id != previous.order_id
    assert replacement.claim_expires_at > database_now + timedelta(hours=22, minutes=59)
    assert order_count == 2


async def test_database_provenance_constraints_reject_every_cross_account_join(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    other_account_id = await make_account(
        subscription=None,
        customer="cus_pack_fk_other",
    )
    funded_order_id = await grant_pack(pool, catalog, processor, account_id)
    empty_order_id = await reserve_pack(
        pool,
        catalog,
        account_id,
        request_key="cross-account-empty-order",
    )
    async with pool.acquire() as conn:
        lot_id = await conn.fetchval(
            "select id from credit_funding_lots where order_id=$1::uuid", funded_order_id
        )

        with pytest.raises(asyncpg.ForeignKeyViolationError):
            async with conn.transaction():
                await conn.execute(
                    """insert into credit_funding_lots(
                           id,order_id,account_id,original_credits,remaining_credits,expires_at)
                         values(gen_random_uuid(),$1::uuid,$2::uuid,1,1,now()+interval '1 day')""",
                    empty_order_id,
                    other_account_id,
                )

        with pytest.raises(asyncpg.ForeignKeyViolationError):
            async with conn.transaction():
                await conn.execute(
                    """insert into credit_debits(
                           idempotency_key,account_id,amount,grant_epoch)
                         values('cross-account-pack-allocation',$1::uuid,1,0)""",
                    other_account_id,
                )
                await conn.execute(
                    """insert into credit_debit_allocations(
                           debit_idempotency_key,account_id,source_type,funding_lot_id,amount)
                         values('cross-account-pack-allocation',$1::uuid,
                                'credit_pack',$2::uuid,1)""",
                    other_account_id,
                    lot_id,
                )

        with pytest.raises(asyncpg.ForeignKeyViolationError):
            await conn.execute(
                """insert into credit_pack_clawback_debts(
                       order_id,account_id,target_credits)
                     values($1::uuid,$2::uuid,1)""",
                empty_order_id,
                other_account_id,
            )

        with pytest.raises(asyncpg.CheckViolationError, match="before its funding lot"):
            async with conn.transaction():
                await conn.execute(
                    """insert into credit_pack_clawback_debts(
                           order_id,account_id,target_credits)
                         values($1::uuid,$2::uuid,1)""",
                    empty_order_id,
                    account_id,
                )
                await conn.execute("set constraints credit_pack_debts_state_equation immediate")

        with pytest.raises(asyncpg.ForeignKeyViolationError):
            await conn.execute(
                """insert into credit_debits(
                       idempotency_key,account_id,amount,grant_epoch,kind,clawback_order_id)
                     values('cross-account-pack-debt',$1::uuid,1,0,
                            'credit_pack_debt_collection',$2::uuid)""",
                other_account_id,
                funded_order_id,
            )


async def test_deferred_state_equations_reject_lot_order_and_allocation_drift(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await grant_pack(pool, catalog, processor, account_id)
    await CreditService(pool).charge(account_id, 10, "state-equation-job")

    async with pool.acquire() as conn:
        with pytest.raises(asyncpg.CheckViolationError, match="funding conservation"):
            async with conn.transaction():
                await conn.execute(
                    """update credit_funding_lots
                          set remaining_credits=remaining_credits+1 where order_id=$1::uuid""",
                    order_id,
                )

        with pytest.raises(asyncpg.CheckViolationError, match="cumulative refunded"):
            async with conn.transaction():
                await conn.execute(
                    """update credit_pack_orders set amount_refunded=1,
                           refunded_credits=1,payment_status='partially_refunded'
                         where id=$1::uuid""",
                    order_id,
                )

        with pytest.raises(asyncpg.CheckViolationError, match="funding conservation"):
            async with conn.transaction():
                await conn.execute(
                    """update credit_debit_allocations set refunded_amount=1
                         where debit_idempotency_key='state-equation-job'"""
                )

        state = await conn.fetchrow(
            """select o.refunded_credits,l.remaining_credits,a.refunded_amount
                 from credit_pack_orders o
                 join credit_funding_lots l on l.order_id=o.id
                 join credit_debit_allocations a on a.funding_lot_id=l.id
                where o.id=$1::uuid""",
            order_id,
        )
    assert tuple(state) == (0, 90_000_000, 0)


async def test_deferred_debt_collection_equations_reject_liability_erasure_and_split(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    debt_order = await grant_pack(pool, catalog, processor, account_id)
    await CreditService(pool).charge(account_id, 80, "debt-equation-spend")
    assert (
        await processor.process(
            pack_clawback(
                debt_order,
                account_id,
                event_id="evt_debt_equation_refund",
                amount_refunded=750,
            )
        )
    ).outcome == "handled"
    funding_order = await grant_pack(
        pool,
        catalog,
        processor,
        account_id,
        request_key="debt-equation-funding",
        event_id="evt_debt_equation_funding",
        payment_intent_id="pi_debt_equation_funding",
        charge_id="ch_debt_equation_funding",
    )

    async with pool.acquire() as conn:
        debt = await conn.fetchrow(
            """select target_credits,collected_credits,released_credits
                 from credit_pack_clawback_debts where order_id=$1::uuid""",
            debt_order,
        )
        collection = await conn.fetchrow(
            """select d.idempotency_key,a.id as allocation_id,a.funding_lot_id
                 from credit_debits d
                 join credit_debit_allocations a
                   on a.debit_idempotency_key=d.idempotency_key
                where d.kind='credit_pack_debt_collection'
                  and d.clawback_order_id=$1::uuid""",
            debt_order,
        )
        assert tuple(debt) == (30_000_000, 30_000_000, 0)
        assert collection is not None

        with pytest.raises(asyncpg.CheckViolationError, match="collected debt"):
            async with conn.transaction():
                await conn.execute(
                    """update credit_pack_clawback_debts set collected_credits=0
                         where order_id=$1::uuid""",
                    debt_order,
                )
                await conn.execute("set constraints credit_pack_debts_state_equation immediate")

        with pytest.raises(asyncpg.CheckViolationError, match="collected debt"):
            async with conn.transaction():
                await conn.execute(
                    """update credit_debit_allocations set refunded_amount=1
                         where id=$1""",
                    collection["allocation_id"],
                )
                await conn.execute(
                    "set constraints credit_pack_collection_allocations_state_equation immediate"
                )

        with pytest.raises(asyncpg.CheckViolationError, match="allocations must equal"):
            async with conn.transaction():
                await conn.execute(
                    """insert into credit_debits(
                           idempotency_key,account_id,amount,grant_epoch,kind,
                           clawback_order_id)
                         values('bare-pack-debt-collection',$1::uuid,1,0,
                                'credit_pack_debt_collection',$2::uuid)""",
                    account_id,
                    debt_order,
                )
                await conn.execute("set constraints credit_debits_state_equation immediate")

        with pytest.raises(asyncpg.CheckViolationError, match="exactly one"):
            async with conn.transaction():
                await conn.execute(
                    """update credit_funding_lots
                          set remaining_credits=remaining_credits+15000000
                        where id=$1""",
                    collection["funding_lot_id"],
                )
                await conn.execute(
                    """update credit_debit_allocations set amount=15000000
                         where id=$1""",
                    collection["allocation_id"],
                )
                await conn.execute(
                    """insert into credit_debit_allocations(
                           debit_idempotency_key,account_id,source_type,
                           subscription_grant_epoch,amount)
                         values($1,$2::uuid,'subscription',0,15000000)""",
                    collection["idempotency_key"],
                    account_id,
                )

        final = await conn.fetchrow(
            """select d.collected_credits,l.remaining_credits,a.amount,a.refunded_amount
                 from credit_pack_clawback_debts d
                 join credit_debits c on c.clawback_order_id=d.order_id
                 join credit_debit_allocations a
                   on a.debit_idempotency_key=c.idempotency_key
                 join credit_funding_lots l on l.id=a.funding_lot_id
                where d.order_id=$1::uuid and l.order_id=$2::uuid""",
            debt_order,
            funding_order,
        )
    assert tuple(final) == (30_000_000, 70_000_000, 30_000_000, 0)


async def test_paid_event_grants_once_across_event_and_business_duplicates(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await reserve_pack(pool, catalog, account_id)
    event = payment_succeeded(order_id, account_id)

    first = await processor.process(event)
    duplicate_event = await processor.process(event)
    duplicate_business = await processor.process(
        payment_succeeded(
            order_id,
            account_id,
            event_id="evt_pack_paid_again",
            created=1_800_100_000,
        )
    )

    assert (first.outcome, duplicate_event.outcome, duplicate_business.outcome) == (
        "handled",
        "duplicate",
        "replayed",
    )
    async with pool.acquire() as conn:
        lot = await conn.fetchrow(
            "select original_credits,remaining_credits,status from credit_funding_lots"
        )
        assert tuple(lot) == (100_000_000, 100_000_000, "active")
        assert await conn.fetchval("select count(*) from credit_funding_lots") == 1
        paid_and_expiry = await conn.fetchrow(
            """select extract(epoch from o.paid_at)::bigint,
                      extract(epoch from l.expires_at)::bigint,
                      l.created_at <= e.processed_at as audit_completed_after_lot
                 from credit_pack_orders o
                 join credit_funding_lots l on l.order_id=o.id
                 join stripe_webhook_events e on e.id=$2
                where o.id=$1::uuid""",
            order_id,
            event["id"],
        )
    assert tuple(paid_and_expiry) == (1_800_000_000, 1_831_536_000, True)


async def test_concurrent_distinct_paid_events_create_exactly_one_funding_lot(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await reserve_pack(pool, catalog, account_id)
    events = [
        payment_succeeded(order_id, account_id, event_id=f"evt_pack_paid_race_{index}")
        for index in range(2)
    ]

    outcomes = await asyncio.gather(*(processor.process(event) for event in events))

    assert sorted(result.outcome for result in outcomes) == ["handled", "replayed"]
    async with pool.acquire() as conn:
        lot = await conn.fetchrow(
            """select count(*) as lot_count,min(original_credits) as original_credits,
                      min(remaining_credits) as remaining_credits
                 from credit_funding_lots where order_id=$1::uuid""",
            order_id,
        )
        committed_events = await conn.fetchval(
            """select count(*) from stripe_webhook_events
                 where id = any($1::text[]) and outcome in ('handled','replayed')""",
            [event["id"] for event in events],
        )
    assert tuple(lot) == (1, 100_000_000, 100_000_000)
    assert committed_events == 2


@pytest.mark.parametrize(
    ("mutation", "incident"),
    [
        ({"amount": 1499}, "credit_pack_payment_contract_mismatch"),
        ({"authorized_amount": 1499}, "credit_pack_payment_contract_mismatch"),
        ({"amount_received": 1499}, "credit_pack_payment_contract_mismatch"),
        ({"charge_id": "not_a_charge"}, "credit_pack_payment_contract_mismatch"),
        ({"currency": "eur"}, "credit_pack_payment_contract_mismatch"),
        ({"customer_id": "cus_other"}, "credit_pack_payment_contract_mismatch"),
        (
            {"metadata": {"billing_kind": "credit_pack"}},
            "credit_pack_payment_metadata_invalid",
        ),
    ],
)
async def test_paid_contract_mismatch_fails_closed_without_funding(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
    mutation: dict[str, Any],
    incident: str,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await reserve_pack(pool, catalog, account_id)
    result = await processor.process(payment_succeeded(order_id, account_id, **mutation))
    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        assert await conn.fetchval("select count(*) from credit_funding_lots") == 0
        assert (
            await conn.fetchval("select count(*) from billing_incidents where kind=$1", incident)
            == 1
        )


async def test_payment_customer_must_match_the_immutable_checkout_request(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None, customer="cus_original")
    order_id = await reserve_pack(
        pool,
        catalog,
        account_id,
        request_key="payment-customer-snapshot",
    )
    async with pool.acquire() as conn:
        await conn.execute(
            "update billing_accounts set stripe_customer_id=$2 where id=$1::uuid",
            account_id,
            "cus_later_binding",
        )

    rejected = await processor.process(
        payment_succeeded(
            order_id,
            account_id,
            event_id="evt_pack_payment_later_customer",
            payment_intent_id="pi_pack_payment_later_customer",
            charge_id="ch_pack_payment_later_customer",
            customer_id="cus_later_binding",
        )
    )

    assert rejected.outcome == "ignored"
    async with pool.acquire() as conn:
        order = await conn.fetchrow(
            """select request_customer_id,stripe_customer_id,payment_status
                 from credit_pack_orders where id=$1::uuid""",
            order_id,
        )
        assert tuple(order) == ("cus_original", None, "pending")
        assert await conn.fetchval("select count(*) from credit_funding_lots") == 0
        assert (
            await conn.fetchval(
                """select count(*) from billing_incidents
                     where kind='credit_pack_payment_contract_mismatch'"""
            )
            == 1
        )
        await conn.execute(
            "update billing_accounts set stripe_customer_id=$2 where id=$1::uuid",
            account_id,
            "cus_original",
        )

    accepted = await processor.process(
        payment_succeeded(
            order_id,
            account_id,
            event_id="evt_pack_payment_original_customer",
            payment_intent_id="pi_pack_payment_original_customer",
            charge_id="ch_pack_payment_original_customer",
            customer_id="cus_original",
        )
    )
    assert accepted.outcome == "handled"


@pytest.mark.parametrize(
    "field",
    ["pack_credits", "price_amount", "currency", "expires_days", "lookup_key"],
)
async def test_every_payment_metadata_snapshot_field_is_authoritative(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
    field: str,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await reserve_pack(pool, catalog, account_id, request_key=f"metadata-{field}")
    metadata = _metadata(order_id, account_id)
    metadata[field] = f"wrong-{field}"

    result = await processor.process(
        payment_succeeded(
            order_id,
            account_id,
            event_id=f"evt_wrong_metadata_{field}",
            payment_intent_id=f"pi_wrong_metadata_{field}",
            charge_id=f"ch_wrong_metadata_{field}",
            metadata=metadata,
        )
    )

    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                "select count(*) from credit_funding_lots where order_id=$1::uuid", order_id
            )
            == 0
        )


async def test_checkout_records_only_an_exact_order_snapshot_and_never_grants(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await reserve_pack(pool, catalog, account_id)

    result = await processor.process(pack_checkout_event(order_id, account_id))

    assert result.outcome == "handled"
    async with pool.acquire() as conn:
        order = await conn.fetchrow(
            """select checkout_status,stripe_checkout_session_id,
                      stripe_payment_intent_id,stripe_customer_id
                 from credit_pack_orders where id=$1::uuid""",
            order_id,
        )
        assert tuple(order) == ("completed", "cs_pack", "pi_pack", "cus_test")
        assert await conn.fetchval("select count(*) from credit_funding_lots") == 0


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("mode",), "subscription"),
        (("status",), "open"),
        (("payment_status",), "no_payment_required"),
        (("client_reference_id",), "00000000-0000-0000-0000-000000000000"),
        (("amount_total",), 1499),
        (("currency",), "eur"),
        (("metadata", "pack_credits"), "101"),
    ],
)
async def test_checkout_contract_drift_fails_closed_before_identity_attachment(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
    path: tuple[str, ...],
    value: object,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await reserve_pack(
        pool,
        catalog,
        account_id,
        request_key=f"checkout-drift-{'-'.join(path)}",
    )
    event = pack_checkout_event(
        order_id,
        account_id,
        event_id=f"evt_checkout_drift_{'_'.join(path)}",
        session_id=f"cs_checkout_drift_{'_'.join(path)}",
    )
    obj = event["data"]["object"]
    if len(path) == 1:
        obj[path[0]] = value
    else:
        obj[path[0]][path[1]] = value

    result = await processor.process(event)

    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        order = await conn.fetchrow(
            """select stripe_checkout_session_id,stripe_payment_intent_id,
                      stripe_customer_id,checkout_status
                 from credit_pack_orders where id=$1::uuid""",
            order_id,
        )
        assert tuple(order) == (None, None, None, "reserved")


async def test_checkout_customer_must_match_the_immutable_checkout_request(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None, customer="cus_original")
    order_id = await reserve_pack(
        pool,
        catalog,
        account_id,
        request_key="checkout-customer-snapshot",
    )
    async with pool.acquire() as conn:
        await conn.execute(
            "update billing_accounts set stripe_customer_id=$2 where id=$1::uuid",
            account_id,
            "cus_later_binding",
        )

    rejected = await processor.process(
        pack_checkout_event(
            order_id,
            account_id,
            event_id="evt_pack_checkout_later_customer",
            session_id="cs_pack_checkout_later_customer",
            payment_intent_id="pi_pack_checkout_later_customer",
            customer_id="cus_later_binding",
        )
    )

    assert rejected.outcome == "ignored"
    async with pool.acquire() as conn:
        order = await conn.fetchrow(
            """select request_customer_id,stripe_checkout_session_id,
                      stripe_payment_intent_id,stripe_customer_id,checkout_status
                 from credit_pack_orders where id=$1::uuid""",
            order_id,
        )
        assert tuple(order) == ("cus_original", None, None, None, "reserved")
        assert (
            await conn.fetchval(
                """select count(*) from billing_incidents
                     where kind='credit_pack_checkout_contract_mismatch'"""
            )
            == 1
        )
        await conn.execute(
            "update billing_accounts set stripe_customer_id=$2 where id=$1::uuid",
            account_id,
            "cus_original",
        )

    accepted = await processor.process(
        pack_checkout_event(
            order_id,
            account_id,
            event_id="evt_pack_checkout_original_customer",
            session_id="cs_pack_checkout_original_customer",
            payment_intent_id="pi_pack_checkout_original_customer",
            customer_id="cus_original",
        )
    )
    assert accepted.outcome == "handled"


async def test_clawback_customer_must_match_the_immutable_checkout_request(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None, customer="cus_original")
    order_id = await reserve_pack(
        pool,
        catalog,
        account_id,
        request_key="clawback-customer-snapshot",
    )
    async with pool.acquire() as conn:
        await conn.execute(
            "update billing_accounts set stripe_customer_id=$2 where id=$1::uuid",
            account_id,
            "cus_later_binding",
        )

    rejected = await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_pack_clawback_later_customer",
            payment_intent_id="pi_pack_clawback_later_customer",
            charge_id="ch_pack_clawback_later_customer",
            customer_id="cus_later_binding",
            amount_refunded=375,
        )
    )

    assert rejected.outcome == "ignored"
    async with pool.acquire() as conn:
        order = await conn.fetchrow(
            """select request_customer_id,stripe_payment_intent_id,stripe_charge_id,
                      stripe_customer_id,amount_paid,amount_refunded,payment_status
                 from credit_pack_orders where id=$1::uuid""",
            order_id,
        )
        assert tuple(order) == (
            "cus_original",
            None,
            None,
            None,
            None,
            0,
            "pending",
        )
        assert (
            await conn.fetchval(
                """select count(*) from billing_incidents
                     where kind='credit_pack_clawback_contract_mismatch'"""
            )
            == 1
        )
        await conn.execute(
            "update billing_accounts set stripe_customer_id=$2 where id=$1::uuid",
            account_id,
            "cus_original",
        )

    accepted = await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_pack_clawback_original_customer",
            payment_intent_id="pi_pack_clawback_original_customer",
            charge_id="ch_pack_clawback_original_customer",
            customer_id="cus_original",
            amount_refunded=375,
        )
    )
    assert accepted.outcome == "handled"


async def test_free_account_can_spend_pack_without_receiving_plan_features(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    await grant_pack(pool, catalog, processor, account_id)

    charged = await CreditService(pool).charge(account_id, "0.125", "pack-only-job")
    assert charged.balance == CreditAmount.parse("99.875")
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select plan_key,subscription_status,credits_balance from billing_accounts where id=$1",
            account_id,
        )
        allocation = await conn.fetchrow(
            """select source_type,amount from credit_debit_allocations
                 where debit_idempotency_key='pack-only-job'"""
        )
    assert tuple(account) == ("free", "none", 0)
    assert tuple(allocation) == ("credit_pack", 125_000)


async def test_fefo_charge_spans_pack_then_subscription_with_exact_allocations(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id))
    await grant_pack(pool, catalog, processor, account_id)
    async with pool.acquire() as conn:
        await conn.execute(
            """update credit_funding_lots
                  set expires_at=(select credit_expires_at-interval '1 day'
                                    from billing_accounts where id=$1)
                where account_id=$1""",
            account_id,
        )
    result = await CreditService(pool).charge(account_id, 150, "spanning-job")
    assert result.balance.atoms == 250_000_000
    async with pool.acquire() as conn:
        allocations = await conn.fetch(
            """select source_type,amount from credit_debit_allocations
                 where debit_idempotency_key='spanning-job' order by source_type"""
        )
        sub_balance = await conn.fetchval(
            "select credits_balance from billing_accounts where id=$1", account_id
        )
    assert [tuple(row) for row in allocations] == [
        ("credit_pack", 100_000_000),
        ("subscription", 50_000_000),
    ]
    assert sub_balance == 250_000_000


async def test_concurrent_pack_charges_cannot_overspend_one_lot(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    await grant_pack(pool, catalog, processor, account_id)

    async def charge(index: int) -> str:
        try:
            await CreditService(pool).charge(account_id, 30, f"pack-race-{index}")
            return "charged"
        except InsufficientCreditsError:
            return "insufficient"

    results = await asyncio.gather(*(charge(index) for index in range(10)))
    assert results.count("charged") == 3
    assert results.count("insufficient") == 7
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval("select remaining_credits from credit_funding_lots") == 10_000_000
        )


async def test_pack_charge_rechecks_wall_clock_after_waiting_for_account_lock(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    await grant_pack(pool, catalog, processor, account_id)
    service = CreditService(pool)

    blocker = await pool.acquire()
    transaction = blocker.transaction()
    charge_task: asyncio.Task[CreditResult] | None = None
    committed = False
    await transaction.start()
    try:
        await blocker.fetchrow(
            "select id from billing_accounts where id=$1::uuid for update",
            account_id,
        )
        charge_task = asyncio.create_task(
            service.charge(account_id, 1, "charge-across-pack-expiry-lock")
        )
        await wait_for_account_row_lock_waiter(pool)
        expires_at = await blocker.fetchval(
            """update credit_funding_lots
                  set expires_at=clock_timestamp()+interval '250 milliseconds'
                where account_id=$1::uuid returning expires_at""",
            account_id,
        )
        await wait_until_database_time_after(pool, expires_at)
        await transaction.commit()
        committed = True

        with pytest.raises(CreditsUnavailableError, match="expired"):
            await charge_task
    finally:
        if not committed:
            await transaction.rollback()
        await pool.release(blocker)
        if charge_task is not None and not charge_task.done():
            charge_task.cancel()
            await asyncio.gather(charge_task, return_exceptions=True)

    async with pool.acquire() as conn:
        debit_count = await conn.fetchval(
            """select count(*) from credit_debits
                 where idempotency_key='charge-across-pack-expiry-lock'"""
        )
        spendable_atoms = await conn.fetchval(
            """select coalesce(sum(remaining_credits),0)
                 from credit_funding_lots
                where account_id=$1::uuid and status='active'
                  and expires_at > clock_timestamp()""",
            account_id,
        )
    assert debit_count == 0
    assert spendable_atoms == 0


async def test_pack_refund_rechecks_wall_clock_after_waiting_for_account_lock(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    await grant_pack(pool, catalog, processor, account_id)
    service = CreditService(pool)
    await service.charge(account_id, 10, "refund-across-pack-expiry-source")

    blocker = await pool.acquire()
    transaction = blocker.transaction()
    refund_task: asyncio.Task[CreditResult] | None = None
    committed = False
    await transaction.start()
    try:
        await blocker.fetchrow(
            "select id from billing_accounts where id=$1::uuid for update",
            account_id,
        )
        refund_task = asyncio.create_task(
            service.refund(
                "refund-across-pack-expiry-source",
                expected_account_id=account_id,
            )
        )
        await wait_for_account_row_lock_waiter(pool)
        expires_at = await blocker.fetchval(
            """update credit_funding_lots
                  set expires_at=clock_timestamp()+interval '250 milliseconds'
                where account_id=$1::uuid returning expires_at""",
            account_id,
        )
        await wait_until_database_time_after(pool, expires_at)
        await transaction.commit()
        committed = True

        result = await refund_task
    finally:
        if not committed:
            await transaction.rollback()
        await pool.release(blocker)
        if refund_task is not None and not refund_task.done():
            refund_task.cancel()
            await asyncio.gather(refund_task, return_exceptions=True)

    assert result.outcome == "epoch_expired"
    assert (result.balance_atoms, result.requested_atoms, result.restored_atoms) == (
        0,
        10_000_000,
        0,
    )
    async with pool.acquire() as conn:
        state = await conn.fetchrow(
            """select l.remaining_credits,l.expired_credits,l.status,
                      d.restored_credits,d.refunded_at is not null,a.refunded_amount
                 from credit_funding_lots l
                 join credit_debit_allocations a on a.funding_lot_id=l.id
                 join credit_debits d on d.idempotency_key=a.debit_idempotency_key
                where d.idempotency_key='refund-across-pack-expiry-source'"""
        )
    assert tuple(state) == (0, 100_000_000, "expired", 0, True, 10_000_000)


async def test_subscription_renewal_preserves_pack_lot_and_pack_refund_crosses_epoch(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, invoice_id="in_pack_epoch_1"))
    order_id = await grant_pack(pool, catalog, processor, account_id)
    await CreditService(pool).charge(account_id, 350, "cross-epoch-pack-job")
    await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_pack_epoch_2",
            event_id="evt_pack_epoch_2",
            created=1_800_000_100,
            period_start=1_802_592_000,
        )
    )
    refunded = await CreditService(pool).refund("cross-epoch-pack-job")

    assert refunded.outcome == "refunded"
    async with pool.acquire() as conn:
        lot = await conn.fetchrow(
            """select l.remaining_credits,l.status
                 from credit_funding_lots l join credit_pack_orders o on o.id=l.order_id
                where o.id=$1::uuid""",
            order_id,
        )
        allocation = await conn.fetchrow(
            """select amount,refunded_amount from credit_debit_allocations
                 where debit_idempotency_key='cross-epoch-pack-job'
                   and source_type='credit_pack'"""
        )
    assert tuple(lot) == (100_000_000, "active")
    assert tuple(allocation) == (50_000_000, 50_000_000)


@pytest.mark.parametrize("refund_before_grant", [False, True])
async def test_partial_cash_refund_converges_before_or_after_grant(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
    refund_before_grant: bool,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await reserve_pack(pool, catalog, account_id)
    paid = payment_succeeded(order_id, account_id)
    refunded = pack_clawback(
        order_id,
        account_id,
        event_id="evt_pack_partial_refund",
        amount_refunded=375,
    )
    if refund_before_grant:
        assert (await processor.process(refunded)).outcome == "handled"
        assert (await processor.process(paid)).outcome == "handled"
    else:
        assert (await processor.process(paid)).outcome == "handled"
        assert (await processor.process(refunded)).outcome == "handled"
    async with pool.acquire() as conn:
        evidence = await conn.fetchrow(
            """select o.amount_refunded,o.refunded_credits,o.payment_status,
                      l.remaining_credits,l.status
                 from credit_pack_orders o join credit_funding_lots l on l.order_id=o.id
                where o.id=$1::uuid""",
            order_id,
        )
    assert tuple(evidence) == (
        375,
        25_000_000,
        "partially_refunded",
        75_000_000,
        "active",
    )


@pytest.mark.parametrize("clawback_before_grant", [False, True])
@pytest.mark.parametrize("disputed", [False, True])
async def test_terminal_cash_clawback_converges_before_or_after_grant(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
    clawback_before_grant: bool,
    disputed: bool,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await reserve_pack(pool, catalog, account_id)
    paid = payment_succeeded(order_id, account_id)
    terminal = pack_clawback(
        order_id,
        account_id,
        event_id="evt_pack_terminal_permutation",
        amount_refunded=1500,
        disputed=disputed,
    )

    events = (terminal, paid) if clawback_before_grant else (paid, terminal)
    results = [await processor.process(event) for event in events]

    assert [result.outcome for result in results] == ["handled", "handled"]
    async with pool.acquire() as conn:
        state = await conn.fetchrow(
            """select o.payment_status,o.amount_refunded,o.refunded_credits,
                      l.remaining_credits,l.expired_credits,
                      l.cash_clawed_back_credits,l.status
                 from credit_pack_orders o
                 join credit_funding_lots l on l.order_id=o.id
                where o.id=$1::uuid""",
            order_id,
        )
    assert tuple(state) == (
        "disputed" if disputed else "refunded",
        1500,
        100_000_000,
        0,
        0,
        100_000_000,
        "disputed" if disputed else "refunded",
    )


async def test_refund_before_payment_binds_the_first_customer_and_converges(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None, customer=None)
    order_id = await reserve_pack(
        pool,
        catalog,
        account_id,
        request_key="first-customer-refund-before-payment",
    )
    refunded = pack_clawback(
        order_id,
        account_id,
        event_id="evt_first_customer_refund_before_payment",
        payment_intent_id="pi_first_customer_refund_before_payment",
        charge_id="ch_first_customer_refund_before_payment",
        customer_id="cus_first_customer_refund",
        amount_refunded=375,
    )

    assert (await processor.process(refunded)).outcome == "handled"
    async with pool.acquire() as conn:
        account_and_order = await conn.fetchrow(
            """select a.stripe_customer_id,o.request_customer_id,
                      o.stripe_customer_id,o.payment_status
                 from billing_accounts a join credit_pack_orders o on o.account_id=a.id
                where o.id=$1::uuid""",
            order_id,
        )
    assert tuple(account_and_order) == (
        "cus_first_customer_refund",
        None,
        "cus_first_customer_refund",
        "partially_refunded",
    )

    conflicting = await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_first_customer_refund_conflict",
            payment_intent_id="pi_first_customer_refund_conflict",
            charge_id="ch_first_customer_refund_conflict",
            customer_id="cus_conflicting_customer",
            amount_refunded=750,
        )
    )
    assert conflicting.outcome == "ignored"

    paid = await processor.process(
        payment_succeeded(
            order_id,
            account_id,
            event_id="evt_first_customer_payment_after_refund",
            payment_intent_id="pi_first_customer_refund_before_payment",
            charge_id="ch_first_customer_refund_before_payment",
            customer_id="cus_first_customer_refund",
        )
    )
    assert paid.outcome == "handled"
    async with pool.acquire() as conn:
        evidence = await conn.fetchrow(
            """select a.stripe_customer_id,o.amount_refunded,o.refunded_credits,
                      o.payment_status,l.remaining_credits,l.status
                 from billing_accounts a
                 join credit_pack_orders o on o.account_id=a.id
                 join credit_funding_lots l on l.order_id=o.id
                where o.id=$1::uuid""",
            order_id,
        )
        incidents = await conn.fetchval(
            """select count(*) from billing_incidents
                 where kind='credit_pack_clawback_contract_mismatch'"""
        )
    assert tuple(evidence) == (
        "cus_first_customer_refund",
        375,
        25_000_000,
        "partially_refunded",
        75_000_000,
        "active",
    )
    assert incidents == 1


@pytest.mark.parametrize("refund_before_grant", [False, True])
async def test_partial_cash_remains_reconcilable_when_atom_rounding_exhausts_funding(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
    refund_before_grant: bool,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await reserve_pack(pool, catalog, account_id)
    async with pool.acquire() as conn:
        await conn.execute(
            "update credit_pack_orders set pack_credits=1 where id=$1::uuid", order_id
        )
    metadata = _metadata(order_id, account_id, pack_credits="0.000001")
    paid = payment_succeeded(order_id, account_id, metadata=metadata)
    first_refund = pack_clawback(
        order_id,
        account_id,
        event_id="evt_rounding_cash_one",
        amount_refunded=1,
        metadata=metadata,
    )
    events = (first_refund, paid) if refund_before_grant else (paid, first_refund)
    assert [(await processor.process(event)).outcome for event in events] == ["handled", "handled"]
    advanced = await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_rounding_cash_two",
            amount_refunded=2,
            metadata=metadata,
        )
    )

    assert advanced.outcome == "handled"
    async with pool.acquire() as conn:
        partial = await conn.fetchrow(
            """select o.amount_refunded,o.refunded_credits,o.payment_status,
                      l.remaining_credits,l.cash_clawed_back_credits,l.status
                 from credit_pack_orders o
                 join credit_funding_lots l on l.order_id=o.id
                where o.id=$1::uuid""",
            order_id,
        )
    assert tuple(partial) == (2, 1, "partially_refunded", 0, 1, "refunded")

    terminal = await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_rounding_cash_full",
            amount_refunded=1500,
            metadata=metadata,
        )
    )
    assert terminal.outcome == "handled"
    async with pool.acquire() as conn:
        final = await conn.fetchrow(
            """select amount_refunded,refunded_credits,payment_status
                 from credit_pack_orders where id=$1::uuid""",
            order_id,
        )
    assert tuple(final) == (1500, 1, "refunded")


async def test_refund_after_spend_creates_cross_epoch_debt_collected_by_renewal(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await grant_pack(pool, catalog, processor, account_id)
    await CreditService(pool).charge(account_id, 80, "spent-pack")
    clawback = await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_pack_refund_after_spend",
            amount_refunded=750,
        )
    )
    assert clawback.outcome == "handled"
    async with pool.acquire() as conn:
        debt = await conn.fetchrow(
            "select target_credits,collected_credits from credit_pack_clawback_debts"
        )
        assert tuple(debt) == (30_000_000, 0)
        await conn.execute(
            """update billing_accounts set stripe_subscription_id='sub_test',
                   plan_key='starter',plan_interval='month',subscription_status='active'
                 where id=$1""",
            account_id,
        )
    await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_after_pack_debt",
            event_id="evt_after_pack_debt",
            created=1_800_000_200,
        )
    )
    async with pool.acquire() as conn:
        account = await conn.fetchval(
            "select credits_balance from billing_accounts where id=$1", account_id
        )
        debt = await conn.fetchrow(
            "select target_credits,collected_credits from credit_pack_clawback_debts"
        )
    assert account == 270_000_000
    assert tuple(debt) == (30_000_000, 30_000_000)


async def test_late_payment_projection_creates_expired_lot_without_collecting_debt(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    first_order = await grant_pack(pool, catalog, processor, account_id)
    await CreditService(pool).charge(account_id, 80, "late-projection-debt-source")
    assert (
        await processor.process(
            pack_clawback(
                first_order,
                account_id,
                event_id="evt_late_projection_debt",
                amount_refunded=750,
            )
        )
    ).outcome == "handled"

    expired_order = await reserve_pack(
        pool,
        catalog,
        account_id,
        request_key="late-expired-payment-projection",
    )
    projected = await processor.process(
        payment_succeeded(
            expired_order,
            account_id,
            event_id="evt_late_expired_payment",
            payment_intent_id="pi_late_expired_payment",
            charge_id="ch_late_expired_payment",
            created=1_600_000_000,
        )
    )

    assert projected.outcome == "handled"
    async with pool.acquire() as conn:
        lot = await conn.fetchrow(
            """select remaining_credits,expired_credits,status,closed_at is not null
                 from credit_funding_lots where order_id=$1::uuid""",
            expired_order,
        )
        debt = await conn.fetchrow(
            """select target_credits,collected_credits,released_credits
                 from credit_pack_clawback_debts where order_id=$1::uuid""",
            first_order,
        )
        collection_debits = await conn.fetchval(
            """select count(*) from credit_debits
                 where kind='credit_pack_debt_collection'"""
        )
    assert tuple(lot) == (0, 100_000_000, "expired", True)
    assert tuple(debt) == (30_000_000, 0, 0)
    assert collection_debits == 0


async def test_product_refund_after_partial_cash_clawback_restores_net_pack_value(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    """Cash-first and product-refund-first settlement must not double-claw credits."""

    account_id = await make_account(subscription=None)
    order_id = await grant_pack(pool, catalog, processor, account_id)
    await CreditService(pool).charge(account_id, 80, "cash-then-product-refund")
    assert (
        await processor.process(
            pack_clawback(
                order_id,
                account_id,
                event_id="evt_cash_before_product_refund",
                amount_refunded=750,
            )
        )
    ).outcome == "handled"

    result = await CreditService(pool).refund("cash-then-product-refund")

    assert result.outcome == "refunded"
    assert result.balance == CreditAmount.parse(50)
    assert result.requested == CreditAmount.parse(80)
    assert result.restored == CreditAmount.parse(50)
    async with pool.acquire() as conn:
        lot = await conn.fetchrow("select remaining_credits,status from credit_funding_lots")
        debt = await conn.fetchrow(
            """select target_credits,collected_credits,released_credits
                 from credit_pack_clawback_debts"""
        )
    assert tuple(lot) == (50_000_000, "active")
    assert tuple(debt) == (30_000_000, 0, 30_000_000)


@pytest.mark.parametrize(
    ("container", "field", "value"),
    [
        ("payment", "amount", 1499),
        ("payment", "amount_received", 1499),
        ("payment", "latest_charge", "ch_other"),
        ("payment_metadata", "price_amount", "1499"),
        ("charge", "object", "not_charge"),
        ("charge", "paid", False),
        ("charge", "refunded", True),
    ],
)
async def test_cash_refund_requires_exact_charge_and_payment_contracts(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
    container: str,
    field: str,
    value: object,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await grant_pack(
        pool,
        catalog,
        processor,
        account_id,
        request_key=f"refund-contract-{container}-{field}",
        event_id=f"evt_grant_{container}_{field}",
        payment_intent_id=f"pi_contract_{container}_{field}",
        charge_id=f"ch_contract_{container}_{field}",
    )
    event = pack_clawback(
        order_id,
        account_id,
        event_id=f"evt_refund_contract_{container}_{field}",
        amount_refunded=375,
        payment_intent_id=f"pi_contract_{container}_{field}",
        charge_id=f"ch_contract_{container}_{field}",
    )
    charge = event["data"]["object"]
    payment = charge["_resolved_payment_intent"]
    if container == "payment":
        payment[field] = value
    elif container == "payment_metadata":
        payment["metadata"][field] = value
    else:
        charge[field] = value

    result = await processor.process(event)

    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        order = await conn.fetchrow(
            "select amount_refunded,refunded_credits,payment_status from credit_pack_orders"
        )
        lot = await conn.fetchrow(
            "select remaining_credits,cash_clawed_back_credits from credit_funding_lots"
        )
    assert tuple(order) == (0, 0, "paid")
    assert tuple(lot) == (100_000_000, 0)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("object", "not_dispute"),
        ("charge", "ch_other"),
        ("amount", 0),
        ("currency", "eur"),
    ],
)
async def test_dispute_requires_exact_dispute_contract(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
    field: str,
    value: object,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await grant_pack(
        pool,
        catalog,
        processor,
        account_id,
        request_key=f"dispute-contract-{field}",
        event_id=f"evt_dispute_grant_{field}",
        payment_intent_id=f"pi_dispute_contract_{field}",
        charge_id=f"ch_dispute_contract_{field}",
    )
    event = pack_clawback(
        order_id,
        account_id,
        event_id=f"evt_dispute_contract_{field}",
        amount_refunded=1500,
        disputed=True,
        payment_intent_id=f"pi_dispute_contract_{field}",
        charge_id=f"ch_dispute_contract_{field}",
    )
    event["data"]["object"][field] = value

    result = await processor.process(event)

    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        assert await conn.fetchval("select payment_status from credit_pack_orders") == "paid"
        assert (
            await conn.fetchval("select remaining_credits from credit_funding_lots") == 100_000_000
        )


@pytest.mark.parametrize("disputed", [False, True])
async def test_full_refund_or_dispute_closes_lot_and_is_business_idempotent(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
    disputed: bool,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await grant_pack(pool, catalog, processor, account_id)
    first = await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_pack_terminal",
            amount_refunded=1500,
            disputed=disputed,
        )
    )
    replay = await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_pack_terminal_again",
            amount_refunded=1500,
            disputed=disputed,
        )
    )
    assert (first.outcome, replay.outcome) == ("handled", "replayed")
    async with pool.acquire() as conn:
        lot = await conn.fetchrow(
            """select l.remaining_credits,l.status,l.closed_at is not null,
                      extract(epoch from o.paid_at)::bigint,
                      extract(epoch from l.expires_at)::bigint
                 from credit_funding_lots l
                 join credit_pack_orders o on o.id=l.order_id"""
        )
    assert tuple(lot) == (
        0,
        "disputed" if disputed else "refunded",
        True,
        1_800_000_000,
        1_831_536_000,
    )


async def test_dispute_after_full_refund_advances_status_without_double_effect(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await grant_pack(pool, catalog, processor, account_id)
    assert (
        await processor.process(
            pack_clawback(
                order_id,
                account_id,
                event_id="evt_refund_before_dispute",
                amount_refunded=1500,
            )
        )
    ).outcome == "handled"

    disputed = await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_dispute_after_refund",
            amount_refunded=1500,
            disputed=True,
        )
    )

    assert disputed.outcome == "handled"
    async with pool.acquire() as conn:
        state = await conn.fetchrow(
            """select o.payment_status,o.refunded_credits,l.status,
                      l.cash_clawed_back_credits,
                      coalesce(d.target_credits,0) as debt_target
                 from credit_pack_orders o
                 join credit_funding_lots l on l.order_id=o.id
                 left join credit_pack_clawback_debts d on d.order_id=o.id
                where o.id=$1::uuid""",
            order_id,
        )
    assert tuple(state) == (
        "disputed",
        100_000_000,
        "disputed",
        100_000_000,
        0,
    )


async def test_pack_expiry_is_lazy_and_product_refund_does_not_recreate_it(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await grant_pack(pool, catalog, processor, account_id)
    await CreditService(pool).charge(account_id, 10, "expiring-pack-job")
    async with pool.acquire() as conn:
        await conn.execute("update credit_funding_lots set expires_at=now()-interval '1 second'")
    result = await CreditService(pool).refund("expiring-pack-job")
    assert result.outcome == "epoch_expired"
    assert result.requested == CreditAmount.parse(10)
    assert result.restored == CreditAmount.parse(0)
    async with pool.acquire() as conn:
        lot = await conn.fetchrow(
            "select remaining_credits,expired_credits,status from credit_funding_lots"
        )
    assert tuple(lot) == (0, 100_000_000, "expired")

    cash = await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_cash_after_product_refund_expiry",
            amount_refunded=1500,
        )
    )
    assert cash.outcome == "handled"
    async with pool.acquire() as conn:
        final_lot = await conn.fetchrow(
            """select expired_credits,cash_clawed_back_credits,status
                 from credit_funding_lots"""
        )
        debt_count = await conn.fetchval("select count(*) from credit_pack_clawback_debts")
    assert tuple(final_lot) == (0, 100_000_000, "refunded")
    assert debt_count == 0


@pytest.mark.parametrize(
    ("cash_atoms", "disputed", "cash_first", "renew_between", "expected_restored"),
    [
        (50_000_000, False, False, False, 80_000_000),
        (50_000_000, False, True, False, 50_000_000),
        (50_000_000, False, True, True, 80_000_000),
        (100_000_000, False, False, False, 80_000_000),
        (100_000_000, False, True, False, 0),
        (100_000_000, False, True, True, 80_000_000),
        (100_000_000, True, False, False, 80_000_000),
        (100_000_000, True, True, True, 80_000_000),
    ],
)
async def test_cash_and_product_refund_permutations_converge(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
    cash_atoms: int,
    disputed: bool,
    cash_first: bool,
    renew_between: bool,
    expected_restored: int,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await grant_pack(pool, catalog, processor, account_id)
    service = CreditService(pool)
    await service.charge(account_id, 80, "permuted-pack-job")
    clawback = pack_clawback(
        order_id,
        account_id,
        event_id="evt_permuted_pack_clawback",
        amount_refunded=750 if cash_atoms == 50_000_000 else 1500,
        disputed=disputed,
    )

    if cash_first:
        assert (await processor.process(clawback)).outcome == "handled"
        if renew_between:
            async with pool.acquire() as conn:
                await conn.execute(
                    """update billing_accounts set stripe_subscription_id='sub_test',
                           plan_key='starter',plan_interval='month',
                           subscription_status='active' where id=$1""",
                    account_id,
                )
            assert (
                await processor.process(
                    paid_invoice(
                        account_id,
                        invoice_id="in_permuted_pack_renewal",
                        event_id="evt_permuted_pack_renewal",
                        created=1_800_000_300,
                    )
                )
            ).outcome == "handled"
        refund = await service.refund("permuted-pack-job")
    else:
        refund = await service.refund("permuted-pack-job")
        assert (await processor.process(clawback)).outcome == "handled"

    expected_pack = 100_000_000 - cash_atoms
    assert refund.requested_atoms == 80_000_000
    assert refund.restored_atoms == expected_restored
    assert refund.outcome == ("refunded" if expected_restored else "epoch_expired")
    async with pool.acquire() as conn:
        account_balance = int(
            await conn.fetchval(
                "select credits_balance from billing_accounts where id=$1", account_id
            )
        )
        lot = await conn.fetchrow(
            """select remaining_credits,status,cash_clawed_back_credits
                 from credit_funding_lots where order_id=$1::uuid""",
            order_id,
        )
        debt = await conn.fetchrow(
            """select target_credits,collected_credits,released_credits
                 from credit_pack_clawback_debts where order_id=$1::uuid""",
            order_id,
        )
        debit = await conn.fetchrow(
            """select amount,restored_credits,refunded_at is not null
                 from credit_debits where idempotency_key='permuted-pack-job'"""
        )
    assert account_balance == (300_000_000 if renew_between else 0)
    assert tuple(lot) == (
        expected_pack,
        "active" if cash_atoms < 100_000_000 else ("disputed" if disputed else "refunded"),
        20_000_000 if cash_first else cash_atoms,
    )
    if cash_first:
        expected_debt = cash_atoms - 20_000_000
        assert tuple(debt) == (expected_debt, 0, expected_debt)
    else:
        assert debt is None
    assert tuple(debit) == (80_000_000, expected_restored, True)
    replay = await service.refund("permuted-pack-job")
    assert replay.outcome == "replayed"
    assert (replay.requested_atoms, replay.restored_atoms) == (
        80_000_000,
        expected_restored,
    )


async def test_collected_pack_debt_unwinds_to_the_original_subscription_source(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await grant_pack(pool, catalog, processor, account_id)
    service = CreditService(pool)
    await service.charge(account_id, 80, "renewal-funded-debt-job")
    await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_renewal_funded_debt",
            amount_refunded=750,
        )
    )
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_accounts set stripe_subscription_id='sub_test',
                   plan_key='starter',plan_interval='month',subscription_status='active'
                 where id=$1""",
            account_id,
        )
    await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_debt_then_product_refund",
            event_id="evt_debt_then_product_refund",
            created=1_800_000_400,
        )
    )

    refunded = await service.refund("renewal-funded-debt-job")

    assert (refunded.balance_atoms, refunded.restored_atoms) == (350_000_000, 80_000_000)
    async with pool.acquire() as conn:
        account_balance = await conn.fetchval(
            "select credits_balance from billing_accounts where id=$1", account_id
        )
        lot_balance = await conn.fetchval(
            "select remaining_credits from credit_funding_lots where order_id=$1::uuid",
            order_id,
        )
        debt = await conn.fetchrow(
            """select target_credits,collected_credits,released_credits
                 from credit_pack_clawback_debts where order_id=$1::uuid""",
            order_id,
        )
        synthetic = await conn.fetchrow(
            """select d.amount,d.restored_credits,d.refunded_at is not null,
                      a.source_type,a.amount,a.refunded_amount
                 from credit_debits d join credit_debit_allocations a
                   on a.debit_idempotency_key=d.idempotency_key
                where d.kind='credit_pack_debt_collection'
                  and d.clawback_order_id=$1::uuid""",
            order_id,
        )
    assert (account_balance, lot_balance) == (300_000_000, 50_000_000)
    assert tuple(debt) == (30_000_000, 0, 30_000_000)
    assert tuple(synthetic) == (
        30_000_000,
        30_000_000,
        True,
        "subscription",
        30_000_000,
        30_000_000,
    )


async def test_collected_pack_debt_unwinds_to_the_exact_other_pack_lot(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    first_order = await grant_pack(pool, catalog, processor, account_id)
    service = CreditService(pool)
    await service.charge(account_id, 80, "other-pack-funded-debt-job")
    await processor.process(
        pack_clawback(
            first_order,
            account_id,
            event_id="evt_other_pack_debt",
            amount_refunded=750,
        )
    )
    second_order = await grant_pack(
        pool,
        catalog,
        processor,
        account_id,
        request_key="buy-second-pack",
        event_id="evt_second_pack_paid",
        payment_intent_id="pi_second_pack",
        charge_id="ch_second_pack",
        created=1_800_000_500,
    )

    refunded = await service.refund("other-pack-funded-debt-job")

    assert (refunded.balance_atoms, refunded.restored_atoms) == (150_000_000, 80_000_000)
    async with pool.acquire() as conn:
        lots = await conn.fetch(
            """select order_id,remaining_credits from credit_funding_lots
                 where account_id=$1 order by order_id""",
            account_id,
        )
        debt = await conn.fetchrow(
            """select target_credits,collected_credits,released_credits
                 from credit_pack_clawback_debts where order_id=$1::uuid""",
            first_order,
        )
        synthetic_source = await conn.fetchval(
            """select l.order_id from credit_debits d
                 join credit_debit_allocations a
                   on a.debit_idempotency_key=d.idempotency_key
                 join credit_funding_lots l on l.id=a.funding_lot_id
                where d.kind='credit_pack_debt_collection'
                  and d.clawback_order_id=$1::uuid""",
            first_order,
        )
    balances = {str(row["order_id"]): int(row["remaining_credits"]) for row in lots}
    assert balances == {first_order: 50_000_000, second_order: 100_000_000}
    assert tuple(debt) == (30_000_000, 0, 30_000_000)
    assert str(synthetic_source) == second_order


async def test_expiry_is_financially_retired_before_later_cash_clawback(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await grant_pack(pool, catalog, processor, account_id)
    service = CreditService(pool)
    await service.charge(account_id, 20, "expired-before-cash-job")
    async with pool.acquire() as conn:
        await conn.execute("update credit_funding_lots set expires_at=now()-interval '1 second'")

    await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_cash_after_expiry",
            amount_refunded=1500,
        )
    )
    async with pool.acquire() as conn:
        lot = await conn.fetchrow(
            """select remaining_credits,expired_credits,cash_clawed_back_credits,status
                 from credit_funding_lots"""
        )
        debt_before = await conn.fetchrow(
            """select target_credits,collected_credits,released_credits
                 from credit_pack_clawback_debts"""
        )
    assert tuple(lot) == (0, 0, 80_000_000, "refunded")
    assert tuple(debt_before) == (20_000_000, 0, 0)

    refunded = await service.refund("expired-before-cash-job")
    assert (refunded.outcome, refunded.requested_atoms, refunded.restored_atoms) == (
        "epoch_expired",
        20_000_000,
        0,
    )
    async with pool.acquire() as conn:
        debt_after = await conn.fetchrow(
            """select target_credits,collected_credits,released_credits
                 from credit_pack_clawback_debts"""
        )
    assert tuple(debt_after) == (20_000_000, 0, 20_000_000)


@pytest.mark.parametrize("disputed", [False, True])
async def test_partial_then_terminal_cash_after_product_refund_does_not_reopen_debt(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
    disputed: bool,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await grant_pack(pool, catalog, processor, account_id)
    service = CreditService(pool)
    await service.charge(account_id, 80, "partial-then-terminal-job")
    await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_first_partial_cash",
            amount_refunded=375,
        )
    )
    product_refund = await service.refund("partial-then-terminal-job")
    assert (product_refund.restored_atoms, product_refund.balance_atoms) == (
        75_000_000,
        75_000_000,
    )

    terminal = await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_later_terminal_cash",
            amount_refunded=1500,
            disputed=disputed,
        )
    )

    assert terminal.outcome == "handled"
    async with pool.acquire() as conn:
        lot = await conn.fetchrow(
            """select remaining_credits,cash_clawed_back_credits,status
                 from credit_funding_lots where order_id=$1::uuid""",
            order_id,
        )
        debt = await conn.fetchrow(
            """select target_credits,collected_credits,released_credits
                 from credit_pack_clawback_debts where order_id=$1::uuid""",
            order_id,
        )
    assert tuple(lot) == (0, 95_000_000, "disputed" if disputed else "refunded")
    assert tuple(debt) == (5_000_000, 0, 5_000_000)


async def test_concurrent_cash_and_product_refund_serialize_and_converge(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await grant_pack(pool, catalog, processor, account_id)
    service = CreditService(pool)
    await service.charge(account_id, 80, "concurrent-cash-product-job")
    cash_event = pack_clawback(
        order_id,
        account_id,
        event_id="evt_concurrent_cash_product",
        amount_refunded=750,
    )

    cash_result, product_result = await asyncio.gather(
        processor.process(cash_event),
        service.refund("concurrent-cash-product-job"),
    )

    assert cash_result.outcome == "handled"
    assert product_result.restored_atoms in {50_000_000, 80_000_000}
    async with pool.acquire() as conn:
        lot = await conn.fetchrow(
            "select remaining_credits,cash_clawed_back_credits from credit_funding_lots"
        )
        outstanding = await conn.fetchval(
            """select coalesce(sum(target_credits-collected_credits-released_credits),0)
                 from credit_pack_clawback_debts"""
        )
        debit = await conn.fetchrow(
            """select amount,restored_credits,refunded_at is not null
                 from credit_debits where idempotency_key='concurrent-cash-product-job'"""
        )
    expected_cash_retired = (
        20_000_000 if product_result.restored_atoms == 50_000_000 else 50_000_000
    )
    assert tuple(lot) == (50_000_000, expected_cash_retired)
    assert outstanding == 0
    assert tuple(debit) == (80_000_000, product_result.restored_atoms, True)


async def test_multiple_product_refunds_partially_unwind_one_collection_debit(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await grant_pack(pool, catalog, processor, account_id)
    service = CreditService(pool)
    await service.charge(account_id, 20, "first-split-refund-job")
    await service.charge(account_id, 80, "second-split-refund-job")
    await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_split_refund_cash",
            amount_refunded=750,
        )
    )
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_accounts set stripe_subscription_id='sub_test',
                   plan_key='starter',plan_interval='month',subscription_status='active'
                 where id=$1""",
            account_id,
        )
    await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_split_refund_collection",
            event_id="evt_split_refund_collection",
            created=1_800_000_600,
        )
    )

    first = await service.refund("first-split-refund-job")
    async with pool.acquire() as conn:
        midpoint = await conn.fetchrow(
            """select d.amount,d.restored_credits,d.refunded_at,
                      a.amount,a.refunded_amount
                 from credit_debits d join credit_debit_allocations a
                   on a.debit_idempotency_key=d.idempotency_key
                where d.kind='credit_pack_debt_collection'
                  and d.clawback_order_id=$1::uuid""",
            order_id,
        )
        midpoint_debt = await conn.fetchrow(
            """select target_credits,collected_credits,released_credits
                 from credit_pack_clawback_debts where order_id=$1::uuid""",
            order_id,
        )
    assert (first.requested_atoms, first.restored_atoms) == (20_000_000, 20_000_000)
    assert tuple(midpoint) == (50_000_000, 20_000_000, None, 50_000_000, 20_000_000)
    assert tuple(midpoint_debt) == (50_000_000, 30_000_000, 20_000_000)

    second = await service.refund("second-split-refund-job")
    assert (second.requested_atoms, second.restored_atoms) == (80_000_000, 80_000_000)
    async with pool.acquire() as conn:
        final_balance = await conn.fetchrow(
            """select b.credits_balance,l.remaining_credits
                 from billing_accounts b join credit_funding_lots l on l.account_id=b.id
                where b.id=$1""",
            account_id,
        )
        final_debt = await conn.fetchrow(
            """select target_credits,collected_credits,released_credits
                 from credit_pack_clawback_debts where order_id=$1::uuid""",
            order_id,
        )
        final_collection = await conn.fetchrow(
            """select d.restored_credits,d.refunded_at is not null,a.refunded_amount
                 from credit_debits d join credit_debit_allocations a
                   on a.debit_idempotency_key=d.idempotency_key
                where d.kind='credit_pack_debt_collection'
                  and d.clawback_order_id=$1::uuid""",
            order_id,
        )
    assert tuple(final_balance) == (300_000_000, 50_000_000)
    assert tuple(final_debt) == (50_000_000, 0, 50_000_000)
    assert tuple(final_collection) == (50_000_000, True, 50_000_000)


async def test_concurrent_renewal_collection_and_product_refund_converge(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await grant_pack(pool, catalog, processor, account_id)
    service = CreditService(pool)
    await service.charge(account_id, 80, "concurrent-renewal-refund-job")
    await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_before_concurrent_renewal",
            amount_refunded=750,
        )
    )
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_accounts set stripe_subscription_id='sub_test',
                   plan_key='starter',plan_interval='month',subscription_status='active'
                 where id=$1""",
            account_id,
        )
    renewal = paid_invoice(
        account_id,
        invoice_id="in_concurrent_debt_collection",
        event_id="evt_concurrent_debt_collection",
        created=1_800_000_700,
    )

    renewal_result, refund_result = await asyncio.gather(
        processor.process(renewal),
        service.refund("concurrent-renewal-refund-job"),
    )

    assert renewal_result.outcome == "handled"
    assert refund_result.restored_atoms in {50_000_000, 80_000_000}
    async with pool.acquire() as conn:
        balances = await conn.fetchrow(
            """select b.credits_balance,l.remaining_credits
                 from billing_accounts b join credit_funding_lots l on l.account_id=b.id
                where b.id=$1""",
            account_id,
        )
        debt = await conn.fetchrow(
            """select target_credits,collected_credits,released_credits
                 from credit_pack_clawback_debts where order_id=$1::uuid""",
            order_id,
        )
    assert tuple(balances) == (300_000_000, 50_000_000)
    assert tuple(debt) == (30_000_000, 0, 30_000_000)


async def test_debt_collection_reversal_does_not_cross_subscription_epoch(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await grant_pack(pool, catalog, processor, account_id)
    service = CreditService(pool)
    await service.charge(account_id, 80, "cross-epoch-debt-reversal")
    await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_cross_epoch_debt_cash",
            amount_refunded=750,
        )
    )
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_accounts set stripe_subscription_id='sub_test',
                   plan_key='starter',plan_interval='month',subscription_status='active'
                 where id=$1""",
            account_id,
        )
    await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_debt_collection_epoch_1",
            event_id="evt_debt_collection_epoch_1",
            created=1_800_000_800,
        )
    )
    await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_debt_collection_epoch_2",
            event_id="evt_debt_collection_epoch_2",
            created=1_802_592_100,
            period_start=1_802_592_000,
        )
    )

    refunded = await service.refund("cross-epoch-debt-reversal")

    assert (refunded.balance_atoms, refunded.restored_atoms) == (350_000_000, 50_000_000)
    async with pool.acquire() as conn:
        evidence = await conn.fetchrow(
            """select b.credits_balance,l.remaining_credits,d.restored_credits,
                      a.refunded_amount
                 from billing_accounts b
                 join credit_funding_lots l on l.account_id=b.id
                 join credit_debits d on d.kind='credit_pack_debt_collection'
                                      and d.clawback_order_id=l.order_id
                 join credit_debit_allocations a
                   on a.debit_idempotency_key=d.idempotency_key
                where b.id=$1""",
            account_id,
        )
        debt = await conn.fetchrow(
            """select target_credits,collected_credits,released_credits
                 from credit_pack_clawback_debts where order_id=$1::uuid""",
            order_id,
        )
    assert tuple(evidence) == (300_000_000, 50_000_000, 0, 30_000_000)
    assert tuple(debt) == (30_000_000, 0, 30_000_000)


async def test_debt_collection_reversal_is_scoped_to_its_clawback_order(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    first_order = await grant_pack(pool, catalog, processor, account_id)
    second_order = await grant_pack(
        pool,
        catalog,
        processor,
        account_id,
        request_key="order-scope-second-pack",
        event_id="evt_order_scope_second_paid",
        payment_intent_id="pi_order_scope_second",
        charge_id="ch_order_scope_second",
        created=1_800_000_001,
    )
    async with pool.acquire() as conn:
        await conn.execute(
            """update credit_funding_lots set expires_at=case
                   when order_id=$1::uuid then now()+interval '1 day'
                   else now()+interval '2 days' end
                 where account_id=$2""",
            first_order,
            account_id,
        )
    service = CreditService(pool)
    await service.charge(account_id, 100, "first-order-product-job")
    await service.charge(account_id, 80, "second-order-product-job")
    await processor.process(
        pack_clawback(
            first_order,
            account_id,
            event_id="evt_first_order_full_cash",
            amount_refunded=1500,
        )
    )
    await processor.process(
        pack_clawback(
            second_order,
            account_id,
            event_id="evt_second_order_partial_cash",
            amount_refunded=750,
            payment_intent_id="pi_order_scope_second",
            charge_id="ch_order_scope_second",
        )
    )
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_accounts set stripe_subscription_id='sub_test',
                   plan_key='starter',plan_interval='month',subscription_status='active'
                 where id=$1""",
            account_id,
        )
    await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_order_scoped_collections",
            event_id="evt_order_scoped_collections",
            created=1_800_000_900,
        )
    )

    refunded = await service.refund("first-order-product-job")

    assert refunded.restored_atoms == 100_000_000
    async with pool.acquire() as conn:
        debts = await conn.fetch(
            """select order_id,target_credits,collected_credits,released_credits
                 from credit_pack_clawback_debts order by order_id"""
        )
        account_balance = await conn.fetchval(
            "select credits_balance from billing_accounts where id=$1", account_id
        )
    by_order = {
        str(row["order_id"]): (
            int(row["target_credits"]),
            int(row["collected_credits"]),
            int(row["released_credits"]),
        )
        for row in debts
    }
    assert by_order == {
        first_order: (100_000_000, 0, 100_000_000),
        second_order: (30_000_000, 30_000_000, 0),
    }
    assert account_balance == 270_000_000


async def test_synthetic_debt_collection_debit_is_not_publicly_refundable(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await grant_pack(pool, catalog, processor, account_id)
    service = CreditService(pool)
    await service.charge(account_id, 80, "synthetic-public-refund-guard")
    await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_synthetic_public_refund_cash",
            amount_refunded=750,
        )
    )
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_accounts set stripe_subscription_id='sub_test',
                   plan_key='starter',plan_interval='month',subscription_status='active'
                 where id=$1""",
            account_id,
        )
    await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_synthetic_public_refund",
            event_id="evt_synthetic_public_refund",
            created=1_800_001_000,
        )
    )
    async with pool.acquire() as conn:
        synthetic_key = await conn.fetchval(
            """select idempotency_key from credit_debits
                 where kind='credit_pack_debt_collection' and clawback_order_id=$1::uuid""",
            order_id,
        )

    with pytest.raises(KeyError, match="not a refundable product operation"):
        await service.refund(str(synthetic_key))
    with pytest.raises(ValueError, match="different parameters"):
        await service.charge(account_id, 30, str(synthetic_key))

    async with pool.acquire() as conn:
        synthetic = await conn.fetchrow(
            """select restored_credits,refunded_at from credit_debits
                 where idempotency_key=$1""",
            synthetic_key,
        )
        debt = await conn.fetchrow(
            """select target_credits,collected_credits,released_credits
                 from credit_pack_clawback_debts where order_id=$1::uuid""",
            order_id,
        )
    assert tuple(synthetic) == (0, None)
    assert tuple(debt) == (30_000_000, 30_000_000, 0)


async def test_database_rejects_cross_account_debt_collection_allocation(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    other_account_id = await make_account(
        subscription=None,
        customer="cus_cross_account_debt_other",
    )
    order_id = await grant_pack(pool, catalog, processor, account_id)
    service = CreditService(pool)
    await service.charge(account_id, 80, "cross-account-debt-reversal")
    await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_cross_account_debt_cash",
            amount_refunded=750,
        )
    )
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_accounts set stripe_subscription_id='sub_test',
                   plan_key='starter',plan_interval='month',subscription_status='active'
                 where id=$1""",
            account_id,
        )
    await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_cross_account_debt_collection",
            event_id="evt_cross_account_debt_collection",
            created=1_800_001_050,
        )
    )
    async with pool.acquire() as conn:
        synthetic_key = await conn.fetchval(
            """select idempotency_key from credit_debits
                 where kind='credit_pack_debt_collection' and clawback_order_id=$1::uuid""",
            order_id,
        )
        # Provenance is account-scoped in PostgreSQL, so a corrupted integration
        # cannot even persist a row that would require the runtime fallback check.
        with pytest.raises(asyncpg.ForeignKeyViolationError):
            await conn.execute(
                """update credit_debit_allocations set account_id=$2::uuid
                     where debit_idempotency_key=$1""",
                synthetic_key,
                other_account_id,
            )

    refunded = await service.refund("cross-account-debt-reversal")
    assert refunded.outcome == "refunded"

    async with pool.acquire() as conn:
        debt = await conn.fetchrow(
            """select target_credits,collected_credits,released_credits
                 from credit_pack_clawback_debts where order_id=$1::uuid""",
            order_id,
        )
        main_debit = await conn.fetchrow(
            """select restored_credits,refunded_at from credit_debits
                 where idempotency_key='cross-account-debt-reversal'"""
        )
    assert tuple(debt) == (30_000_000, 0, 30_000_000)
    assert main_debit["restored_credits"] == 80_000_000
    assert main_debit["refunded_at"] is not None


async def test_debt_reversal_bigint_overflow_rolls_back_every_effect(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await grant_pack(pool, catalog, processor, account_id)
    service = CreditService(pool)
    await service.charge(account_id, 80, "overflowing-debt-reversal")
    await processor.process(
        pack_clawback(
            order_id,
            account_id,
            event_id="evt_overflowing_debt_cash",
            amount_refunded=750,
        )
    )
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_accounts set stripe_subscription_id='sub_test',
                   plan_key='starter',plan_interval='month',subscription_status='active'
                 where id=$1""",
            account_id,
        )
    await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_overflowing_debt_collection",
            event_id="evt_overflowing_debt_collection",
            created=1_800_001_100,
        )
    )
    async with pool.acquire() as conn:
        await conn.execute(
            "update billing_accounts set credits_balance=$2 where id=$1",
            account_id,
            MAX_CREDIT_ATOMS,
        )

    with pytest.raises(OverflowError, match="bigint atom range"):
        await service.refund("overflowing-debt-reversal")

    async with pool.acquire() as conn:
        debt = await conn.fetchrow(
            """select target_credits,collected_credits,released_credits
                 from credit_pack_clawback_debts where order_id=$1::uuid""",
            order_id,
        )
        main_debit = await conn.fetchrow(
            """select restored_credits,refunded_at from credit_debits
                 where idempotency_key='overflowing-debt-reversal'"""
        )
        synthetic = await conn.fetchrow(
            """select d.restored_credits,d.refunded_at,a.refunded_amount
                 from credit_debits d join credit_debit_allocations a
                   on a.debit_idempotency_key=d.idempotency_key
                where d.kind='credit_pack_debt_collection'
                  and d.clawback_order_id=$1::uuid""",
            order_id,
        )
        lot_balance = await conn.fetchval(
            "select remaining_credits from credit_funding_lots where order_id=$1::uuid",
            order_id,
        )
    assert tuple(debt) == (30_000_000, 30_000_000, 0)
    assert tuple(main_debit) == (0, None)
    assert tuple(synthetic) == (0, None, 0)
    assert lot_balance == 0
