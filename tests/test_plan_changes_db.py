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
from tests.credit_helpers import PRO_CREDITS, STARTER_CREDITS, ULTRA_CREDITS

PERIOD_START = datetime(2026, 7, 1, tzinfo=UTC)
PERIOD_END = datetime(2030, 8, 1, tzinfo=UTC)


class FakePlanGateway:
    def __init__(self, current_lookup: str = "ent_starter_month") -> None:
        self.current_lookup = current_lookup
        self.prepare_calls = 0
        self.preview_calls = 0
        self.apply_calls: list[str] = []
        self.remote_apply_mutations = 0
        self._applied_keys: set[str] = set()
        self.schedule_calls: list[str] = []
        self.amount_due = 4900
        self.proration_credit = 0
        self.customer_balance_credit = 0
        self.safe_shape = True
        self.source_proration_amount = 0
        self.target_proration_amount = 0
        self.tax_amount = 0
        self.discount_amount = 0
        self.pending = False
        self.observed_pending = False
        self.remote_period_end = PERIOD_END
        self.remote_status = "active"
        self.remote_cancel_at_period_end = False
        self.remote_schedule_id = None
        self.before_preview_return = None
        self.preview_policy = None
        self.preview_proration_date = None
        self.apply_policy = None
        self.apply_proration_date = None
        self.settlement_invoice_id = "in_fake_plan_change"

    async def prepare_plan_change(
        self,
        subscription_id: str,
        target_lookup_key: str,
        **kwargs,  # type: ignore[no-untyped-def]
    ) -> PlanChangeContext:
        del kwargs
        self.prepare_calls += 1
        return PlanChangeContext(
            subscription_id,
            "si_test",
            "price_current",
            self.current_lookup,
            f"price_{target_lookup_key}",
            "year" if target_lookup_key.endswith("_year") else "month",
            PERIOD_START,
            self.remote_period_end,
            self.remote_schedule_id,
            self.remote_status,
            self.remote_cancel_at_period_end,
            self.observed_pending,
            datetime.now(UTC) + timedelta(hours=1) if self.observed_pending else None,
            "https://invoice.test/recover" if self.observed_pending else None,
            "ephemeral-client-secret" if self.observed_pending else None,
        )

    async def preview_immediate_plan_change(
        self,
        context: PlanChangeContext,
        *,
        policy="full_period_reset",  # type: ignore[no-untyped-def]
        proration_date=None,  # type: ignore[no-untyped-def]
    ) -> PlanChangeEstimate:
        self.preview_policy = policy
        self.preview_proration_date = proration_date
        self.preview_calls += 1
        if self.before_preview_return is not None:
            await self.before_preview_return()
        return PlanChangeEstimate(
            self.amount_due,
            self.proration_credit,
            self.customer_balance_credit,
            "usd",
            self.safe_shape,
            self.source_proration_amount,
            self.target_proration_amount,
            self.tax_amount,
            self.discount_amount,
            datetime.fromtimestamp(proration_date, tz=UTC)
            if policy == "prorated_delta" and proration_date is not None
            else None,
            context.current_period_end if policy == "prorated_delta" else None,
        )

    async def apply_immediate_plan_change(
        self,
        context: PlanChangeContext,
        *,
        idempotency_key: str,
        policy="full_period_reset",  # type: ignore[no-untyped-def]
        proration_date=None,  # type: ignore[no-untyped-def]
    ) -> RemotePlanChange:
        del context
        self.apply_policy = policy
        self.apply_proration_date = proration_date
        self.apply_calls.append(idempotency_key)
        if idempotency_key not in self._applied_keys:
            self._applied_keys.add(idempotency_key)
            self.remote_apply_mutations += 1
        return RemotePlanChange(
            "sub_test",
            self.pending,
            datetime.now(UTC) + timedelta(hours=1) if self.pending else None,
            "https://invoice.test/recover" if self.pending else None,
            "ephemeral-client-secret" if self.pending else None,
            self.settlement_invoice_id,
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
        credits = {
            "starter": STARTER_CREDITS,
            "pro": PRO_CREDITS,
            "ultra": ULTRA_CREDITS,
        }[plan]
        await conn.execute(
            """update billing_accounts set plan_key=$2,plan_interval=$3,
                 subscription_status='active',current_period_end=$4,
                 entitlement_period_end=$4,credit_expires_at=$4,
                 credits_balance=$5,grant_epoch=1,
                 entitlement_revoked=false where id=$1::uuid""",
            account_id,
            plan,
            interval,
            PERIOD_END,
            credits,
        )
        await conn.execute(
            """insert into credit_ledger(
                   account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
                   stripe_invoice_id,grant_slot)
                 values($1::uuid,$2,$2,$2,'subscription_grant',1,$3,1)""",
            account_id,
            credits,
            f"in_seed_{account_id}",
        )
    return account_id


@pytest.mark.parametrize("key", ["", " padded ", "line\nbreak", "x" * 201, "💳" * 51])
async def test_plan_change_idempotency_keys_have_bounded_visible_shape(
    key: str, pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    service = PlanChangeCoordinator(pool, catalog, FakePlanGateway())
    with pytest.raises(PlanChangeConflictError, match="1 to 200"):
        await service.preview_remote(account_id, "pro", "month", key)


def test_plan_change_lease_ttl_must_be_positive(pool: asyncpg.Pool, catalog: PlanCatalog) -> None:
    with pytest.raises(ValueError, match="positive"):
        PlanChangeCoordinator(
            pool,
            catalog,
            FakePlanGateway(),
            lease_ttl=timedelta(0),
        )


async def test_preview_confirm_is_full_price_and_request_idempotent(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()
    service = PlanChangeCoordinator(pool, catalog, gateway)

    preview = await service.preview_remote(account_id, "pro", "month", "upgrade-1")
    duplicate_preview = await service.preview_remote(account_id, "pro", "month", "upgrade-1")
    async with pool.acquire() as conn:
        await conn.execute(
            """insert into billing_incidents(
                   kind,dedupe_key,account_id,invoice_id,detail)
                 values('unbound_plan_change_payment_failed','in_fake_plan_change',
                        $1::uuid,'in_fake_plan_change','{}'::jsonb)""",
            account_id,
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
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """select p.settlement_invoice_id,
                      (select resolved_at from billing_incidents
                        where kind='unbound_plan_change_payment_failed'
                          and invoice_id='in_fake_plan_change') as incident_resolved_at
                 from billing_plan_changes p where p.id=$1::uuid""",
            preview.change_id,
        )
    assert row is not None
    assert row["settlement_invoice_id"] == "in_fake_plan_change"
    assert row["incident_resolved_at"] is not None


async def test_finish_and_incident_resolution_commit_atomically(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()
    service = PlanChangeCoordinator(pool, catalog, gateway)
    preview = await service.preview_remote(account_id, "pro", "month", "atomic-finish")
    async with pool.acquire() as conn:
        await conn.execute(
            """insert into billing_incidents(
                   kind,dedupe_key,account_id,invoice_id,detail)
                 values('unbound_plan_change_payment_failed','in_fake_plan_change',
                        $1::uuid,'in_fake_plan_change','{}'::jsonb)""",
            account_id,
        )
        await conn.execute(
            """create or replace function fail_plan_change_incident_resolution()
                 returns trigger language plpgsql as $$
                 begin
                   raise exception 'injected incident resolution failure';
                 end
                 $$"""
        )
        await conn.execute(
            """create trigger fail_plan_change_incident_resolution_trigger
                 before update on billing_incidents
                 for each row when (old.kind='unbound_plan_change_payment_failed')
                 execute function fail_plan_change_incident_resolution()"""
        )
    try:
        with pytest.raises(asyncpg.PostgresError, match="injected incident resolution failure"):
            await service.confirm(account_id, preview.change_id)
    finally:
        async with pool.acquire() as conn:
            await conn.execute(
                "drop trigger if exists fail_plan_change_incident_resolution_trigger "
                "on billing_incidents"
            )
            await conn.execute("drop function if exists fail_plan_change_incident_resolution()")

    async with pool.acquire() as conn:
        state = await conn.fetchrow(
            """select status,settlement_invoice_id,lease_token,last_error
                 from billing_plan_changes where id=$1::uuid""",
            preview.change_id,
        )
        unresolved = await conn.fetchval(
            """select count(*) from billing_incidents
                 where kind='unbound_plan_change_payment_failed'
                   and invoice_id='in_fake_plan_change' and resolved_at is null"""
        )
    assert state is not None
    assert tuple(state)[:3] == ("applying", None, None)
    assert state["last_error"] == "RaiseError"
    assert unresolved == 1

    recovered = await service.confirm(account_id, preview.change_id)
    async with pool.acquire() as conn:
        resolved = await conn.fetchval(
            """select resolved_at is not null from billing_incidents
                 where kind='unbound_plan_change_payment_failed'
                   and invoice_id='in_fake_plan_change'"""
        )
    assert recovered.status == "applied"
    assert gateway.remote_apply_mutations == 1
    assert resolved is True


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


async def test_paid_webhook_failure_wins_before_confirm_finish(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()
    service = PlanChangeCoordinator(pool, catalog, gateway)
    preview = await service.preview_remote(account_id, "pro", "month", "webhook-wins")
    original_finish = service._finish

    async def finish_after_webhook(
        change_id: str,
        lease_token,
        **kwargs,  # type: ignore[no-untyped-def]
    ):
        async with pool.acquire() as conn:
            await conn.execute(
                """update billing_plan_changes set status='failed',
                         settlement_invoice_id=$2,last_error='invoice_funding_closed',
                         lease_token=null,lease_expires_at=null,updated_at=now()
                     where id=$1::uuid""",
                change_id,
                kwargs["settlement_invoice_id"],
            )
        return await original_finish(change_id, lease_token, **kwargs)

    monkeypatch.setattr(service, "_finish", finish_after_webhook)
    with pytest.raises(PlanChangeUnavailableError, match="could not fund"):
        await service.confirm(account_id, preview.change_id)

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "select status,settlement_invoice_id from billing_plan_changes where id=$1::uuid",
            preview.change_id,
        )
    assert row is not None and tuple(row) == ("failed", "in_fake_plan_change")


async def test_period_end_change_uses_schedule_and_different_request_is_blocked(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account, plan="pro", interval="year")
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


async def test_legacy_reserved_preview_is_retired_before_any_gateway_io(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()
    service = PlanChangeCoordinator(pool, catalog, gateway)
    row, _ = await service._reserve(account_id, "pro", "month", "legacy-preview")
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_plan_changes set request_snapshot_version=null
                 where id=$1""",
            row["id"],
        )

    with pytest.raises(PlanChangeUnavailableError, match="new Idempotency-Key"):
        await service.preview_remote(account_id, "pro", "month", "legacy-preview")

    async with pool.acquire() as conn:
        retired = await conn.fetchrow(
            """select status,last_error,request_snapshot_version,
                      stripe_request_snapshot,remote_started_at
                 from billing_plan_changes where id=$1""",
            row["id"],
        )
    assert gateway.prepare_calls == 0
    assert gateway.preview_calls == 0
    assert retired is not None
    assert tuple(retired) == (
        "failed",
        "missing_remote_request_snapshot",
        None,
        None,
        None,
    )


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
    recovered = await service.preview_remote(account_id, "pro", "month", "crashed-preview")
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


async def test_concurrent_same_preview_returns_busy_instead_of_incomplete_quote(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()
    started = asyncio.Event()
    release = asyncio.Event()

    async def block_preview() -> None:
        started.set()
        await release.wait()

    gateway.before_preview_return = block_preview
    service = PlanChangeCoordinator(pool, catalog, gateway)
    first = asyncio.create_task(
        service.preview_remote(account_id, "pro", "month", "concurrent-same-preview")
    )
    await asyncio.wait_for(started.wait(), timeout=2)
    try:
        with pytest.raises(PlanChangeBusyError, match="still being calculated"):
            await service.preview_remote(
                account_id,
                "pro",
                "month",
                "concurrent-same-preview",
            )
    finally:
        release.set()
    completed = await first
    assert completed.status == "previewed"
    assert gateway.preview_calls == 1


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

    results = await asyncio.gather(attempt("pro", "concurrent-a"), attempt("ultra", "concurrent-b"))
    assert results.count("busy") == 1
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                """select count(*) from billing_plan_changes where status in (
                 'reserved','previewed','applying','scheduled','applied','requires_action')"""
            )
            == 1
        )


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


async def test_unknown_remote_success_recovers_after_preview_ttl_without_second_charge(
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()
    service = PlanChangeCoordinator(pool, catalog, gateway)
    preview = await service.preview_remote(account_id, "pro", "month", "unknown-apply")
    original_finish = service._finish

    async def lose_finish(*args, **kwargs):  # type: ignore[no-untyped-def]
        del args, kwargs
        raise RuntimeError("simulated response loss after Stripe apply")

    monkeypatch.setattr(service, "_finish", lose_finish)
    with pytest.raises(RuntimeError, match="response loss"):
        await service.confirm(account_id, preview.change_id)

    gateway.current_lookup = "ent_pro_month"
    gateway.remote_period_end = PERIOD_END + timedelta(days=30)
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_plan_changes set
                     preview_expires_at=now()-interval '1 hour',
                     lease_expires_at=now()-interval '1 second'
                 where id=$1::uuid""",
            preview.change_id,
        )
    monkeypatch.setattr(service, "_finish", original_finish)

    recovered = await service.confirm(account_id, preview.change_id)
    assert recovered.status == "applied"
    assert gateway.apply_calls == [
        f"plan-change:{preview.change_id}:apply",
        f"plan-change:{preview.change_id}:apply",
    ]
    assert gateway.remote_apply_mutations == 1
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "select status,remote_started_at from billing_plan_changes where id=$1::uuid",
            preview.change_id,
        )
    assert row is not None and row["status"] == "applied"
    assert row["remote_started_at"] is not None


async def test_remote_period_drift_blocks_mutation_before_stripe_apply(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()
    service = PlanChangeCoordinator(pool, catalog, gateway)
    preview = await service.preview_remote(account_id, "pro", "month", "remote-period")
    gateway.remote_period_end = PERIOD_END + timedelta(days=31)

    with pytest.raises(PlanChangeConflictError, match="billing period drifted"):
        await service.confirm(account_id, preview.change_id)

    assert gateway.apply_calls == []
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "select status,remote_started_at from billing_plan_changes where id=$1::uuid",
            preview.change_id,
        )
    assert row is not None and tuple(row) == ("previewed", None)


async def test_unknown_remote_outcome_older_than_retry_window_stays_blocked(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()
    service = PlanChangeCoordinator(pool, catalog, gateway)
    preview = await service.preview_remote(account_id, "pro", "month", "old-unknown")
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_plan_changes set status='applying',
                   remote_started_at=now()-interval '24 hours',
                   preview_expires_at=now()-interval '23 hours',
                   lease_token=null,lease_expires_at=null
                 where id=$1::uuid""",
            preview.change_id,
        )
    with pytest.raises(PlanChangeUnavailableError, match="too old to retry safely"):
        await service.confirm(account_id, preview.change_id)
    assert gateway.apply_calls == []
    async with pool.acquire() as conn:
        status = await conn.fetchval(
            "select status from billing_plan_changes where id=$1::uuid",
            preview.change_id,
        )
    assert status == "applying"


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


async def test_prorated_delta_preview_and_confirm_persist_one_settlement_contract(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()
    gateway.amount_due = 1500
    gateway.proration_credit = 950
    gateway.source_proration_amount = 950
    gateway.target_proration_amount = 2450
    service = PlanChangeCoordinator(pool, catalog, gateway, transition_policy="prorated_delta")
    async with pool.acquire() as conn:
        before = int(await conn.fetchval("select extract(epoch from now())::bigint"))

    preview = await service.preview_remote(account_id, "pro", "month", "delta-1")
    async with pool.acquire() as conn:
        after = int(await conn.fetchval("select extract(epoch from now())::bigint"))
    assert preview.decision.timing == "immediate"
    assert preview.transition_policy == "prorated_delta"
    assert preview.entitlement_credit_delta == PRO_CREDITS - STARTER_CREDITS
    assert preview.estimated_amount_due == 1500
    assert preview.estimated_credit_applied == 950
    assert gateway.preview_policy == "prorated_delta"
    assert isinstance(gateway.preview_proration_date, int)
    assert before <= gateway.preview_proration_date <= after

    confirmed = await service.confirm(account_id, preview.change_id)
    assert confirmed.status == "applied"
    assert gateway.apply_policy == "prorated_delta"
    assert gateway.apply_proration_date == gateway.preview_proration_date
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "select * from billing_plan_changes where id=$1::uuid", preview.change_id
        )
    assert row is not None
    assert row["expected_source_invoice_id"] == f"in_seed_{account_id}"
    assert row["expected_credit_delta"] == PRO_CREDITS - STARTER_CREDITS
    assert row["proration_date"] == gateway.preview_proration_date


async def test_prorated_delta_tax_or_discount_preview_defers_to_period_end(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()
    gateway.amount_due = 1500
    gateway.source_proration_amount = 950
    gateway.target_proration_amount = 2450
    gateway.tax_amount = 1
    service = PlanChangeCoordinator(pool, catalog, gateway, transition_policy="prorated_delta")
    preview = await service.preview_remote(account_id, "pro", "month", "delta-tax")
    assert preview.decision.timing == "period_end"
    confirmed = await service.confirm(account_id, preview.change_id)
    assert confirmed.status == "scheduled"
    assert gateway.apply_calls == []


async def test_prorated_delta_inconsistent_catalog_fraction_defers_before_apply(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()
    gateway.amount_due = 1450
    gateway.proration_credit = 1000
    gateway.source_proration_amount = 1000
    gateway.target_proration_amount = 2450
    service = PlanChangeCoordinator(pool, catalog, gateway, transition_policy="prorated_delta")
    preview = await service.preview_remote(account_id, "pro", "month", "delta-bad-fraction")
    assert preview.decision.timing == "period_end"
    await service.confirm(account_id, preview.change_id)
    assert gateway.apply_calls == []


async def test_prorated_delta_overfull_period_fraction_defers_before_apply(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    gateway = FakePlanGateway()
    gateway.amount_due = 6000
    gateway.proration_credit = 3800
    gateway.source_proration_amount = 3800
    gateway.target_proration_amount = 9800
    service = PlanChangeCoordinator(pool, catalog, gateway, transition_policy="prorated_delta")

    preview = await service.preview_remote(account_id, "pro", "month", "delta-overfull-period")
    confirmed = await service.confirm(account_id, preview.change_id)

    assert preview.decision.timing == "period_end"
    assert confirmed.status == "scheduled"
    assert gateway.apply_calls == []


async def test_prorated_delta_requires_an_immutable_source_invoice(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await make_account()
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_accounts set subscription_status='active',
                   current_period_end=$2,entitlement_period_end=$2,
                   credit_expires_at=$2,entitlement_revoked=false
                 where id=$1::uuid""",
            account_id,
            PERIOD_END,
        )
    service = PlanChangeCoordinator(
        pool, catalog, FakePlanGateway(), transition_policy="prorated_delta"
    )
    with pytest.raises(PlanChangeUnavailableError, match="funding invoice"):
        await service.preview_remote(account_id, "pro", "month", "delta-no-source")


async def test_prorated_delta_rejects_expired_local_funding_boundary(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account)
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_accounts set entitlement_period_end='2020-01-01 UTC',
                   credit_expires_at='2020-01-01 UTC' where id=$1::uuid""",
            account_id,
        )
    service = PlanChangeCoordinator(
        pool, catalog, FakePlanGateway(), transition_policy="prorated_delta"
    )
    with pytest.raises(PlanChangeUnavailableError, match="funded period boundary"):
        await service.preview_remote(account_id, "pro", "month", "delta-expired")


async def test_prorated_delta_downgrade_and_interval_changes_are_explicit_period_end(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    account_id = await _seed_paid_account(pool, make_account, plan="pro", interval="month")
    service = PlanChangeCoordinator(
        pool,
        catalog,
        FakePlanGateway("ent_pro_month"),
        transition_policy="prorated_delta",
    )
    assert (
        service.preview({"plan_key": "pro", "plan_interval": "month"}, "starter", "month").timing
        == "period_end"
    )
    assert (
        service.preview({"plan_key": "pro", "plan_interval": "month"}, "ultra", "year").timing
        == "period_end"
    )
    preview = await service.preview_remote(account_id, "starter", "month", "delta-down")
    assert preview.decision.timing == "period_end"
