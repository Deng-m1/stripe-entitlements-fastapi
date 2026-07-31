from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest

from stripe_entitlements.catalog import PlanCatalog
from stripe_entitlements.plan_changes import (
    PlanChangeBusyError,
    PlanChangeConflictError,
    PlanChangeContext,
    PlanChangeCoordinator,
    PlanChangeEstimate,
    PlanChangeUnavailableError,
    RemotePlanChange,
)

PERIOD_START = datetime(2026, 7, 1, tzinfo=UTC)
PERIOD_END = datetime(2026, 8, 1, tzinfo=UTC)


class FakePlanGateway:
    def __init__(self, current_lookup: str = "ent_starter_month") -> None:
        self.current_lookup = current_lookup
        self.preview_calls = 0
        self.apply_calls: list[str] = []
        self.schedule_calls: list[str] = []
        self.amount_due = 4900
        self.proration_credit = 0
        self.customer_balance_credit = 0
        self.safe_shape = True
        self.pending = False
        self.before_preview_return = None

    async def prepare_plan_change(
        self,
        subscription_id: str,
        target_lookup_key: str,
        **kwargs,  # type: ignore[no-untyped-def]
    ) -> PlanChangeContext:
        del kwargs
        return PlanChangeContext(
            subscription_id,
            "si_test",
            "price_current",
            self.current_lookup,
            f"price_{target_lookup_key}",
            "year" if target_lookup_key.endswith("_year") else "month",
            PERIOD_START,
            PERIOD_END,
            None,
        )

    async def preview_immediate_plan_change(
        self, context: PlanChangeContext
    ) -> PlanChangeEstimate:
        del context
        self.preview_calls += 1
        if self.before_preview_return is not None:
            await self.before_preview_return()
        return PlanChangeEstimate(
            self.amount_due,
            self.proration_credit,
            self.customer_balance_credit,
            "usd",
            self.safe_shape,
        )

    async def apply_immediate_plan_change(
        self,
        context: PlanChangeContext,
        *,
        idempotency_key: str,
    ) -> RemotePlanChange:
        del context
        self.apply_calls.append(idempotency_key)
        return RemotePlanChange(
            "sub_test",
            self.pending,
            datetime.now(UTC) + timedelta(hours=1) if self.pending else None,
            "https://invoice.test/recover" if self.pending else None,
            "ephemeral-client-secret" if self.pending else None,
        )

    async def schedule_plan_change(
        self, context: PlanChangeContext, *, idempotency_key: str
    ) -> RemotePlanChange:
        del context
        self.schedule_calls.append(idempotency_key)
        return RemotePlanChange("sub_sched_test")


async def _seed_paid_account(
    pool: asyncpg.Pool,
    make_account,
    *,
    plan: str = "starter",
    interval: str = "month",
) -> str:
    account_id = await make_account()
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_accounts set plan_key=$2,plan_interval=$3,
                 subscription_status='active',current_period_end=$4,
                 entitlement_period_end=$4,credit_expires_at=$4,
                 entitlement_revoked=false where id=$1::uuid""",
            account_id,
            plan,
            interval,
            PERIOD_END,
        )
    return account_id


async def test_preview_confirm_is_full_price_and_request_idempotent(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()
    service = PlanChangeCoordinator(pool, catalog, gateway)

    preview = await service.preview_remote(account_id, "pro", "month", "upgrade-1")
    duplicate_preview = await service.preview_remote(
        account_id, "pro", "month", "upgrade-1"
    )
    assert preview.change_id == duplicate_preview.change_id
    assert preview.estimated_amount_due == 4900
    assert preview.estimated_credit_applied == 0

    confirmed = await service.confirm(account_id, preview.change_id)
    duplicate_confirm = await service.confirm(account_id, preview.change_id)
    assert confirmed.status == "applied"
    assert duplicate_confirm.status == "applied"
    assert len(gateway.apply_calls) == 1
    assert gateway.preview_calls == 1


async def test_pending_update_returns_recovery_without_persisting_client_secret(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()
    gateway.pending = True
    service = PlanChangeCoordinator(pool, catalog, gateway)
    preview = await service.preview_remote(account_id, "pro", "month", "sca-1")
    result = await service.confirm(account_id, preview.change_id)
    assert result.status == "requires_action"
    assert result.recovery_url == "https://invoice.test/recover"
    assert result.client_secret == "ephemeral-client-secret"
    async with pool.acquire() as conn:
        stored = await conn.fetchrow(
            "select * from billing_plan_changes where id=$1::uuid", result.change_id
        )
    assert stored is not None
    assert "ephemeral-client-secret" not in str(dict(stored))


async def test_period_end_change_uses_schedule_and_different_request_is_blocked(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(
        pool, make_account, plan="pro", interval="year"
    )
    gateway = FakePlanGateway("ent_pro_year")
    service = PlanChangeCoordinator(pool, catalog, gateway)
    preview = await service.preview_remote(account_id, "ultra", "month", "defer-1")
    assert preview.decision.timing == "period_end"
    with pytest.raises(PlanChangeBusyError):
        await service.preview_remote(account_id, "starter", "month", "other-request")
    result = await service.confirm(account_id, preview.change_id)
    assert result.status == "scheduled"
    assert result.effective_at == PERIOD_END
    assert len(gateway.schedule_calls) == 1


async def test_cross_invoice_proration_credit_forces_period_end(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()
    gateway.proration_credit = 1
    service = PlanChangeCoordinator(pool, catalog, gateway)

    preview = await service.preview_remote(account_id, "pro", "month", "cross-funded")
    confirmed = await service.confirm(account_id, preview.change_id)

    assert preview.decision.timing == "period_end"
    assert confirmed.status == "scheduled"
    assert gateway.apply_calls == []
    assert len(gateway.schedule_calls) == 1


async def test_discounted_or_underfunded_preview_forces_period_end(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()
    gateway.amount_due = 1
    service = PlanChangeCoordinator(pool, catalog, gateway)

    preview = await service.preview_remote(account_id, "pro", "month", "underfunded")
    assert preview.decision.timing == "period_end"


async def test_expired_preview_lease_can_be_reacquired_with_same_request(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()
    service = PlanChangeCoordinator(pool, catalog, gateway, lease_ttl=timedelta(seconds=1))
    row, _ = await service._reserve(account_id, "pro", "month", "crashed-preview")
    token = __import__("uuid").uuid4()
    assert await service._acquire_lease(str(row["id"]), token, "reserved") is not None
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_plan_changes set lease_expires_at=now()-interval '1 second'
                 where id=$1""",
            row["id"],
        )
    recovered = await service.preview_remote(
        account_id, "pro", "month", "crashed-preview"
    )
    assert recovered.status == "previewed"
    assert gateway.preview_calls == 1


async def test_account_entitlement_race_aborts_preview_and_records_incident(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()

    async def mutate_paid_state() -> None:
        async with pool.acquire() as conn:
            await conn.execute(
                "update billing_accounts set grant_epoch=grant_epoch+1 where id=$1::uuid",
                account_id,
            )

    gateway.before_preview_return = mutate_paid_state
    service = PlanChangeCoordinator(pool, catalog, gateway)
    with pytest.raises(PlanChangeConflictError):
        await service.preview_remote(account_id, "pro", "month", "race-preview")
    async with pool.acquire() as conn:
        count = await conn.fetchval(
            "select count(*) from billing_incidents where kind='plan_change_account_race'"
        )
    assert count == 1


async def test_concurrent_different_previews_leave_one_durable_pending_change(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    service = PlanChangeCoordinator(pool, catalog, FakePlanGateway())

    async def attempt(target: str, key: str) -> str:
        try:
            return (await service.preview_remote(account_id, target, "month", key)).change_id
        except PlanChangeBusyError:
            return "busy"

    results = await asyncio.gather(
        attempt("pro", "concurrent-a"), attempt("ultra", "concurrent-b")
    )
    assert results.count("busy") == 1
    async with pool.acquire() as conn:
        assert await conn.fetchval(
            """select count(*) from billing_plan_changes where status in (
                 'reserved','previewed','applying','scheduled','applied','requires_action')"""
        ) == 1


async def test_expired_preview_cannot_confirm_or_reuse_its_intent_key(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()
    service = PlanChangeCoordinator(pool, catalog, gateway)
    preview = await service.preview_remote(account_id, "pro", "month", "expired-preview")
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_plan_changes
                 set preview_expires_at=now()-interval '1 second'
                 where id=$1::uuid""",
            preview.change_id,
        )

    with pytest.raises(PlanChangeUnavailableError, match="preview expired"):
        await service.confirm(account_id, preview.change_id)
    with pytest.raises(PlanChangeUnavailableError, match="no longer reusable"):
        await service.preview_remote(account_id, "pro", "month", "expired-preview")

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "select status,last_error from billing_plan_changes where id=$1::uuid",
            preview.change_id,
        )
    assert row is not None and tuple(row) == ("failed", "preview_expired")
    assert gateway.apply_calls == []


async def test_pending_cancellation_blocks_new_plan_change(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    async with pool.acquire() as conn:
        await conn.execute(
            "update billing_accounts set cancel_at_period_end=true where id=$1::uuid",
            account_id,
        )
    gateway = FakePlanGateway()
    service = PlanChangeCoordinator(pool, catalog, gateway)

    with pytest.raises(PlanChangeUnavailableError, match="pending subscription cancellation"):
        await service.preview_remote(account_id, "pro", "month", "cancel-pending")
    assert gateway.preview_calls == 0
