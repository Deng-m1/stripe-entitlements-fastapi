from __future__ import annotations

import asyncio
import copy
import uuid
from typing import Any

import asyncpg
import pytest

from stripe_entitlements.catalog import PlanCatalog
from stripe_entitlements.credit_packs import CreditPackCoordinator
from stripe_entitlements.database import _init_connection
from stripe_entitlements.pack_reconcile import CreditPackReconciliationService
from stripe_entitlements.processor import EventProcessor
from tests.conftest import TEST_DSN


def _metadata(order_id: str, account_id: str) -> dict[str, str]:
    return {
        "billing_kind": "credit_pack",
        "pack_schema_version": "1",
        "product_line": "example-entitlements",
        "credit_pack_order_id": order_id,
        "account_id": account_id,
        "pack_key": "boost-100",
        "pack_credits": "100",
        "price_amount": "1500",
        "currency": "usd",
        "expires_days": "365",
        "lookup_key": "ent_pack_boost-100",
    }


def _session(
    order_id: str,
    account_id: str,
    *,
    status: str = "complete",
    payment_status: str = "paid",
    payment_intent_id: str | None = "pi_reconcile_pack",
) -> dict[str, Any]:
    return {
        "id": "cs_reconcile_pack",
        "object": "checkout.session",
        "mode": "payment",
        "status": status,
        "payment_status": payment_status,
        "payment_intent": payment_intent_id,
        "customer": "cus_test",
        "client_reference_id": account_id,
        "amount_total": 1500,
        "currency": "usd",
        "livemode": False,
        "created": 1_800_000_000,
        "metadata": _metadata(order_id, account_id),
    }


def _payment_intent(order_id: str, account_id: str) -> dict[str, Any]:
    return {
        "id": "pi_reconcile_pack",
        "object": "payment_intent",
        "status": "succeeded",
        "amount": 1500,
        "amount_received": 1500,
        "currency": "usd",
        "customer": "cus_test",
        "latest_charge": "ch_reconcile_pack",
        "livemode": False,
        "created": 1_800_000_001,
        "metadata": _metadata(order_id, account_id),
    }


def _charge(*, refunded: int = 0, disputed: bool = False) -> dict[str, Any]:
    return {
        "id": "ch_reconcile_pack",
        "object": "charge",
        "payment_intent": "pi_reconcile_pack",
        "customer": "cus_test",
        "amount": 1500,
        "amount_refunded": refunded,
        "currency": "usd",
        "paid": True,
        "refunded": refunded == 1500,
        "disputed": disputed,
        "livemode": False,
        "created": 1_800_000_002,
    }


def _terminal_clawback_event(
    order_id: str,
    account_id: str,
    *,
    disputed: bool,
) -> dict[str, Any]:
    payment_intent = _payment_intent(order_id, account_id)
    charge = _charge(refunded=0 if disputed else 1500, disputed=disputed)
    if disputed:
        obj: dict[str, Any] = {
            "id": "dp_reconcile_pack",
            "object": "dispute",
            "charge": charge["id"],
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
        "id": "evt_terminal_before_pack_payment",
        "object": "event",
        "type": event_type,
        "created": 1_800_000_003,
        "livemode": False,
        "api_version": "2026-06-24.dahlia",
        "data": {"object": obj},
    }


class FakePackGateway:
    def __init__(
        self,
        session: dict[str, Any],
        payment_intent: dict[str, Any] | None,
        charge: dict[str, Any] | None,
        *,
        probe_pool: asyncpg.Pool | None = None,
    ) -> None:
        self.session = session
        self.payment_intent = payment_intent
        self.charge = charge
        self.probe_pool = probe_pool
        self.calls: list[tuple[str, str]] = []
        self.transaction_states: list[bool] = []

    async def _probe(self) -> None:
        if self.probe_pool is None:
            return
        async with self.probe_pool.acquire() as conn:
            self.transaction_states.append(conn.is_in_transaction())
            await conn.fetchval("select 1")

    async def checkout_session_object(self, session_id: str) -> dict[str, Any]:
        await self._probe()
        self.calls.append(("session", session_id))
        return copy.deepcopy(self.session)

    async def payment_intent_object(self, payment_intent_id: str) -> dict[str, Any]:
        await self._probe()
        self.calls.append(("payment_intent", payment_intent_id))
        assert self.payment_intent is not None
        return copy.deepcopy(self.payment_intent)

    async def charge_object(self, charge_id: str) -> dict[str, Any]:
        await self._probe()
        self.calls.append(("charge", charge_id))
        assert self.charge is not None
        return copy.deepcopy(self.charge)


class BlockingSessionGateway(FakePackGateway):
    def __init__(
        self,
        session: dict[str, Any],
        payment_intent: dict[str, Any],
        charge: dict[str, Any],
    ) -> None:
        super().__init__(session, payment_intent, charge)
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def checkout_session_object(self, session_id: str) -> dict[str, Any]:
        self.calls.append(("session", session_id))
        self.started.set()
        await self.release.wait()
        return copy.deepcopy(self.session)


async def _session_order(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    account_id: str,
    *,
    request_key: str = "pack-reconcile",
) -> str:
    reservation = await CreditPackCoordinator(pool, catalog).reserve(
        account_id,
        catalog.require_credit_pack("boost-100"),
        request_key,
    )
    async with pool.acquire() as conn:
        await conn.execute(
            """update credit_pack_orders
                  set stripe_checkout_session_id='cs_reconcile_pack',
                      checkout_status='session_created',updated_at=clock_timestamp()
                where id=$1::uuid""",
            reservation.order_id,
        )
    return reservation.order_id


async def test_reconcile_recovers_checkout_payment_and_partial_refund_in_causal_order(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await _session_order(pool, catalog, account_id)
    gateway = FakePackGateway(
        _session(order_id, account_id),
        _payment_intent(order_id, account_id),
        _charge(refunded=375),
    )

    results = await CreditPackReconciliationService(pool, processor, gateway).reconcile_due()

    assert [result.outcome for result in results] == ["reconciled"]
    assert [result.outcome for result in results[0].projections] == [
        "handled",
        "handled",
        "handled",
    ]
    assert gateway.calls == [
        ("session", "cs_reconcile_pack"),
        ("payment_intent", "pi_reconcile_pack"),
        ("charge", "ch_reconcile_pack"),
    ]
    async with pool.acquire() as conn:
        order = await conn.fetchrow(
            """select checkout_status,payment_status,amount_paid,amount_refunded,
                      refunded_credits,last_reconciled_at is not null as reconciled,
                      reconcile_claim_token,last_reconcile_error
                 from credit_pack_orders where id=$1::uuid""",
            order_id,
        )
        lot = await conn.fetchrow(
            """select original_credits,remaining_credits,status
                 from credit_funding_lots where order_id=$1::uuid""",
            order_id,
        )
        events = await conn.fetch(
            """select event_type,outcome,payload::text as payload
                 from stripe_webhook_events order by received_at,id"""
        )
    assert tuple(order) == (
        "completed",
        "partially_refunded",
        1500,
        375,
        25_000_000,
        True,
        None,
        None,
    )
    assert tuple(lot) == (100_000_000, 75_000_000, "active")
    assert [row["event_type"] for row in events] == [
        "checkout.session.completed",
        "payment_intent.succeeded",
        "charge.refunded",
    ]
    assert all(row["outcome"] == "handled" for row in events)
    assert all("reconcile_claim" not in row["payload"] for row in events)


@pytest.mark.parametrize("disputed", [False, True])
async def test_terminal_clawback_before_payment_is_reconciled_into_one_closed_lot(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
    disputed: bool,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await _session_order(pool, catalog, account_id)
    terminal_event = _terminal_clawback_event(
        order_id,
        account_id,
        disputed=disputed,
    )
    assert (await processor.process(terminal_event)).outcome == "handled"
    async with pool.acquire() as conn:
        assert await conn.fetchval("select count(*) from credit_funding_lots") == 0

    gateway = FakePackGateway(
        _session(order_id, account_id),
        _payment_intent(order_id, account_id),
        _charge(refunded=0 if disputed else 1500, disputed=disputed),
    )
    service = CreditPackReconciliationService(pool, processor, gateway)
    result = await service.reconcile_order(order_id)

    assert result.outcome == "reconciled"
    assert [projection.outcome for projection in result.projections] == [
        "handled",
        "handled",
        "replayed",
    ]
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


async def test_reconcile_unknown_open_checkout_is_idle_then_recovers_expiry(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await _session_order(pool, catalog, account_id)
    gateway = FakePackGateway(
        _session(
            order_id,
            account_id,
            status="open",
            payment_status="unpaid",
            payment_intent_id=None,
        ),
        None,
        None,
    )
    service = CreditPackReconciliationService(pool, processor, gateway)

    first = await service.reconcile_order(order_id)
    gateway.session = _session(
        order_id,
        account_id,
        status="expired",
        payment_status="unpaid",
        payment_intent_id=None,
    )
    second = await service.reconcile_order(order_id)

    assert (first.outcome, second.outcome) == ("idle", "reconciled")
    assert len(second.projections) == 1
    async with pool.acquire() as conn:
        order = await conn.fetchrow(
            """select checkout_status,payment_status,session_url,
                      reconcile_claim_token,last_reconcile_error
                 from credit_pack_orders where id=$1::uuid""",
            order_id,
        )
        event_type = await conn.fetchval("select event_type from stripe_webhook_events")
    assert tuple(order) == ("expired", "pending", None, None, None)
    assert event_type == "checkout.session.expired"


async def test_reserved_order_requires_original_idempotent_checkout_replay_without_guessing(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    reservation = await CreditPackCoordinator(pool, catalog).reserve(
        account_id,
        catalog.require_credit_pack("boost-100"),
        "unknown-create-outcome",
    )
    gateway = FakePackGateway(
        _session(reservation.order_id, account_id),
        _payment_intent(reservation.order_id, account_id),
        _charge(),
    )

    result = await CreditPackReconciliationService(pool, processor, gateway).reconcile_order(
        reservation.order_id
    )

    assert (result.outcome, result.error_code) == ("idle", "checkout_replay_required")
    assert gateway.calls == []
    async with pool.acquire() as conn:
        order = await conn.fetchrow(
            """select checkout_status,payment_status,last_reconcile_error,
                      last_reconciled_at is not null,reconcile_claim_token
                 from credit_pack_orders where id=$1::uuid""",
            reservation.order_id,
        )
        assert await conn.fetchval("select count(*) from stripe_webhook_events") == 0
    assert tuple(order) == (
        "reserved",
        "pending",
        "checkout_replay_required",
        True,
        None,
    )


async def test_paid_order_reconciliation_recovers_missed_dispute(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await _session_order(pool, catalog, account_id)
    gateway = FakePackGateway(
        _session(order_id, account_id),
        _payment_intent(order_id, account_id),
        _charge(),
    )
    service = CreditPackReconciliationService(pool, processor, gateway)
    assert (await service.reconcile_order(order_id)).outcome == "reconciled"

    gateway.charge = _charge(disputed=True)
    disputed = await service.reconcile_order(order_id)

    assert disputed.outcome == "reconciled"
    assert disputed.projections[-1].outcome == "handled"
    async with pool.acquire() as conn:
        order = await conn.fetchrow(
            """select payment_status,amount_refunded,refunded_credits
                 from credit_pack_orders where id=$1::uuid""",
            order_id,
        )
        lot = await conn.fetchrow(
            "select remaining_credits,status from credit_funding_lots where order_id=$1::uuid",
            order_id,
        )
        dispute_events = await conn.fetchval(
            """select count(*) from stripe_webhook_events
                 where event_type='charge.dispute.created'"""
        )
    assert tuple(order) == ("disputed", 1500, 100_000_000)
    assert tuple(lot) == (0, "disputed")
    assert dispute_events == 1


async def test_explicit_reconcile_recovers_dispute_after_full_refund(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await _session_order(pool, catalog, account_id)
    gateway = FakePackGateway(
        _session(order_id, account_id),
        _payment_intent(order_id, account_id),
        _charge(),
    )
    service = CreditPackReconciliationService(pool, processor, gateway)
    assert (await service.reconcile_order(order_id)).outcome == "reconciled"
    assert (
        await processor.process(_terminal_clawback_event(order_id, account_id, disputed=False))
    ).outcome == "handled"

    gateway.charge = _charge(refunded=1500, disputed=True)
    result = await service.reconcile_order(order_id)

    assert result.outcome == "reconciled"
    assert result.projections[-1].outcome == "handled"
    async with pool.acquire() as conn:
        state = await conn.fetchrow(
            """select o.payment_status,l.status,l.cash_clawed_back_credits
                 from credit_pack_orders o
                 join credit_funding_lots l on l.order_id=o.id
                where o.id=$1::uuid""",
            order_id,
        )
    assert tuple(state) == ("disputed", "disputed", 100_000_000)


async def test_remote_contract_mismatch_fails_closed_and_persists_only_safe_code(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await _session_order(pool, catalog, account_id)
    wrong_charge = _charge()
    wrong_charge["customer"] = "cus_conflicting"
    gateway = FakePackGateway(
        _session(order_id, account_id),
        _payment_intent(order_id, account_id),
        wrong_charge,
    )

    result = await CreditPackReconciliationService(pool, processor, gateway).reconcile_order(
        order_id
    )

    assert (result.outcome, result.error_code) == ("failed", "charge_contract_mismatch")
    async with pool.acquire() as conn:
        order = await conn.fetchrow(
            """select payment_status,reconcile_claim_token,
                      last_reconciled_at is not null,last_reconcile_error
                 from credit_pack_orders where id=$1::uuid""",
            order_id,
        )
        assert await conn.fetchval("select count(*) from stripe_webhook_events") == 0
        assert await conn.fetchval("select count(*) from credit_funding_lots") == 0
    assert tuple(order) == ("pending", None, True, "charge_contract_mismatch")


async def test_many_replicas_claim_one_due_order_only_once(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await _session_order(pool, catalog, account_id)
    gateway = BlockingSessionGateway(
        _session(order_id, account_id),
        _payment_intent(order_id, account_id),
        _charge(),
    )
    service = CreditPackReconciliationService(pool, processor, gateway)

    owner = asyncio.create_task(service.reconcile_due(limit=1))
    await asyncio.wait_for(gateway.started.wait(), timeout=5)
    competitors = await asyncio.gather(*(service.reconcile_due(limit=1) for _ in range(20)))
    gateway.release.set()
    owner_result = await asyncio.wait_for(owner, timeout=5)

    assert competitors == [[] for _ in range(20)]
    assert len(owner_result) == 1 and owner_result[0].outcome == "reconciled"
    assert gateway.calls.count(("session", "cs_reconcile_pack")) == 1
    async with pool.acquire() as conn:
        assert await conn.fetchval("select count(*) from credit_funding_lots") == 1


async def test_expired_worker_cannot_project_or_release_replacement_claim(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await _session_order(pool, catalog, account_id)
    blocked_gateway = BlockingSessionGateway(
        _session(order_id, account_id),
        _payment_intent(order_id, account_id),
        _charge(),
    )
    stale_service = CreditPackReconciliationService(pool, processor, blocked_gateway)
    replacement_gateway = FakePackGateway(
        _session(order_id, account_id),
        _payment_intent(order_id, account_id),
        _charge(),
    )
    replacement_service = CreditPackReconciliationService(pool, processor, replacement_gateway)

    stale_task = asyncio.create_task(stale_service.reconcile_due(limit=1))
    await asyncio.wait_for(blocked_gateway.started.wait(), timeout=5)
    async with pool.acquire() as conn:
        stale_token = await conn.fetchval(
            "select reconcile_claim_token from credit_pack_orders where id=$1::uuid", order_id
        )
        await conn.execute(
            """update credit_pack_orders
                  set reconcile_claim_expires_at=clock_timestamp()-interval '1 second'
                where id=$1::uuid""",
            order_id,
        )
    replacement_claim = await replacement_service._claim_order(order_id)
    assert replacement_claim is not None and replacement_claim.token != str(stale_token)

    blocked_gateway.release.set()
    stale_result = await asyncio.wait_for(stale_task, timeout=5)

    assert stale_result[0].outcome == "lost_lease"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """select reconcile_claim_token,last_reconciled_at,last_reconcile_error
                 from credit_pack_orders where id=$1::uuid""",
            order_id,
        )
        assert await conn.fetchval("select count(*) from stripe_webhook_events") == 0
    assert str(row["reconcile_claim_token"]) == replacement_claim.token
    assert row["last_reconciled_at"] is None
    assert row["last_reconcile_error"] is None

    recovered = await replacement_service._reconcile_claim(replacement_claim)
    assert recovered.outcome == "reconciled"
    async with pool.acquire() as conn:
        assert await conn.fetchval("select count(*) from credit_funding_lots") == 1


async def test_event_processor_rechecks_reconcile_token_before_event_inbox_claim(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await _session_order(pool, catalog, account_id)
    gateway = FakePackGateway(
        _session(order_id, account_id),
        _payment_intent(order_id, account_id),
        _charge(),
    )
    service = CreditPackReconciliationService(pool, processor, gateway)
    claim = await service._claim_order(order_id)
    assert claim is not None
    event = service._event(
        claim,
        event_id="reconcile:credit-pack:stale-guard-test",
        event_type="payment_intent.succeeded",
        created=1_800_000_002,
        obj=_payment_intent(order_id, account_id),
    )
    replacement_token = uuid.uuid4()
    async with pool.acquire() as conn:
        await conn.execute(
            """update credit_pack_orders
                  set reconcile_claim_token=$2,
                      reconcile_claim_expires_at=clock_timestamp()+interval '5 minutes'
                where id=$1::uuid""",
            order_id,
            replacement_token,
        )

    result = await processor.process(event)

    assert (result.outcome, result.reason) == (
        "ignored",
        "credit-pack reconciliation lease lost",
    )
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "select reconcile_claim_token from credit_pack_orders where id=$1::uuid", order_id
        )
        assert await conn.fetchval("select count(*) from stripe_webhook_events") == 0
        assert await conn.fetchval("select count(*) from credit_funding_lots") == 0
    assert row["reconcile_claim_token"] == replacement_token


async def test_every_gateway_call_runs_without_a_held_database_transaction(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await _session_order(pool, catalog, account_id)
    single_connection_pool = await asyncpg.create_pool(
        TEST_DSN,
        min_size=1,
        max_size=1,
        init=_init_connection,
    )
    try:
        processor = EventProcessor(
            single_connection_pool,
            catalog,
            "example-entitlements",
            expected_api_version="2026-06-24.dahlia",
        )
        gateway = FakePackGateway(
            _session(order_id, account_id),
            _payment_intent(order_id, account_id),
            _charge(),
            probe_pool=single_connection_pool,
        )
        result = await asyncio.wait_for(
            CreditPackReconciliationService(
                single_connection_pool, processor, gateway
            ).reconcile_order(order_id),
            timeout=5,
        )
    finally:
        await single_connection_pool.close()

    assert result.outcome == "reconciled"
    assert gateway.transaction_states == [False, False, False]


async def test_reconcile_claim_columns_enforce_token_expiry_pair(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    account_id = await make_account(subscription=None)
    order_id = await _session_order(pool, catalog, account_id)
    async with pool.acquire() as conn:
        try:
            await conn.execute(
                """update credit_pack_orders set reconcile_claim_token=gen_random_uuid()
                     where id=$1::uuid""",
                order_id,
            )
        except asyncpg.CheckViolationError:
            pass
        else:
            raise AssertionError("claim token without an expiry must violate the schema")
