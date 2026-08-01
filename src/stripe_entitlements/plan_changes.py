from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Protocol, cast

import asyncpg

from .catalog import PlanCatalog
from .transitions import (
    BillingInterval,
    TransitionDecision,
    TransitionPolicy,
    decide_transition,
)

PlanChangeStatus = Literal[
    "reserved",
    "previewed",
    "applying",
    "scheduled",
    "applied",
    "requires_action",
    "completed",
    "failed",
]


class PlanChangeError(RuntimeError):
    pass


class PlanChangeBusyError(PlanChangeError):
    pass


class PlanChangeConflictError(PlanChangeError):
    pass


class PlanChangeUnavailableError(PlanChangeError):
    pass


@dataclass(frozen=True, slots=True)
class PlanChangeContext:
    subscription_id: str
    subscription_item_id: str
    current_price_id: str
    current_lookup_key: str
    target_price_id: str
    target_interval: BillingInterval
    current_period_start: datetime
    current_period_end: datetime
    schedule_id: str | None
    subscription_status: str = "active"
    cancel_at_period_end: bool = False
    pending_update: bool = False
    pending_expires_at: datetime | None = None
    recovery_url: str | None = None
    client_secret: str | None = None


@dataclass(frozen=True, slots=True)
class RemotePlanChange:
    remote_id: str
    pending_update: bool = False
    pending_expires_at: datetime | None = None
    recovery_url: str | None = None
    client_secret: str | None = None
    settlement_invoice_id: str | None = None


@dataclass(frozen=True, slots=True)
class PlanChangeEstimate:
    amount_due: int
    proration_credit: int
    customer_balance_credit: int
    currency: str
    safe_invoice_shape: bool
    source_proration_amount: int = 0
    target_proration_amount: int = 0
    tax_amount: int = 0
    discount_amount: int = 0
    period_start: datetime | None = None
    period_end: datetime | None = None


class PlanChangeGateway(Protocol):
    async def prepare_plan_change(
        self,
        subscription_id: str,
        target_lookup_key: str,
        *,
        expected_currency: str,
        expected_unit_amount: int,
        target_interval: BillingInterval,
    ) -> PlanChangeContext: ...

    async def apply_immediate_plan_change(
        self,
        context: PlanChangeContext,
        *,
        idempotency_key: str,
        policy: TransitionPolicy,
        proration_date: int | None,
    ) -> RemotePlanChange: ...

    async def preview_immediate_plan_change(
        self,
        context: PlanChangeContext,
        *,
        policy: TransitionPolicy,
        proration_date: int | None,
    ) -> PlanChangeEstimate: ...

    async def schedule_plan_change(
        self,
        context: PlanChangeContext,
        *,
        idempotency_key: str,
    ) -> RemotePlanChange: ...


@dataclass(frozen=True, slots=True)
class PlanChangeResult:
    change_id: str
    decision: TransitionDecision
    status: PlanChangeStatus
    effective_at: datetime | None
    recovery_url: str | None = None
    client_secret: str | None = None
    replayed: bool = False
    estimated_amount_due: int | None = None
    estimated_credit_applied: int | None = None
    estimated_customer_balance_credit: int | None = None
    estimate_currency: str | None = None
    transition_policy: TransitionPolicy = "full_period_reset"
    entitlement_credit_delta: int | None = None


class PlanChangeCoordinator:
    """Persist intent, lease the operation, call Stripe, then persist the result.

    No Stripe call occurs while a database transaction is open. A short lease prevents
    concurrent duplicate calls; an expired lease lets the same idempotency key resume.
    Stripe receives a stable internal request key, so crash recovery is remote-idempotent.
    """

    def __init__(
        self,
        pool: asyncpg.Pool,
        catalog: PlanCatalog,
        gateway: PlanChangeGateway,
        *,
        lease_ttl: timedelta = timedelta(minutes=2),
        transition_policy: TransitionPolicy = "full_period_reset",
    ) -> None:
        self.pool = pool
        self.catalog = catalog
        self.gateway = gateway
        self.lease_ttl = lease_ttl
        if transition_policy not in {"full_period_reset", "prorated_delta"}:
            raise ValueError(f"unknown transition policy {transition_policy!r}")
        self.transition_policy = transition_policy

    def preview(self, account: Mapping[str, Any], plan: str, interval: str) -> TransitionDecision:
        target = self.catalog.require(plan)
        current_key = str(account["plan_key"])
        if current_key == "free" or account.get("plan_interval") not in {"month", "year"}:
            raise PlanChangeUnavailableError("free accounts must start through Checkout")
        current = self.catalog.require(current_key)
        target_interval = self._interval(interval)
        current_interval = self._interval(str(account["plan_interval"]))
        return decide_transition(
            current,
            current_interval,
            target,
            target_interval,
            self.transition_policy,
        )

    async def preview_remote(
        self,
        account_id: str,
        plan: str,
        interval: str,
        idempotency_key: str,
    ) -> PlanChangeResult:
        if not idempotency_key or len(idempotency_key) > 200:
            raise PlanChangeConflictError("Idempotency-Key must contain 1 to 200 characters")
        row, replayed = await self._reserve(account_id, plan, interval, idempotency_key)
        decision = self._decision_from_row(row)
        status = cast(PlanChangeStatus, row["status"])
        if status == "failed":
            raise PlanChangeUnavailableError(
                "this plan-change intent is no longer reusable; start a new intent"
            )
        if status != "reserved":
            return self._result(row, decision, replayed=True)
        lease_token = uuid.uuid4()
        leased = await self._acquire_lease(str(row["id"]), lease_token, "reserved")
        if leased is None:
            return self._result(await self._get(str(row["id"])), decision, replayed=True)
        try:
            target_lookup = self.catalog.lookup_key(decision.target_plan, decision.target_interval)
            target_plan = self.catalog.require(decision.target_plan)
            source_plan = self.catalog.require(decision.from_plan)
            context = await self.gateway.prepare_plan_change(
                str(row["stripe_subscription_id"]),
                target_lookup,
                expected_currency=target_plan.currency,
                expected_unit_amount=(
                    target_plan.month_usd
                    if decision.target_interval == "month"
                    else target_plan.year_usd
                )
                * 100,
                target_interval=decision.target_interval,
            )
            await self._revalidate_before_remote(row, context, target_lookup)
            estimate: PlanChangeEstimate | None = None
            proration_date: int | None = None
            if decision.timing == "immediate":
                expected_amount = (
                    target_plan.month_usd
                    if decision.target_interval == "month"
                    else target_plan.year_usd
                ) * 100
                if decision.policy == "prorated_delta":
                    proration_date = int(datetime.now(UTC).timestamp())
                estimate = await self.gateway.preview_immediate_plan_change(
                    context,
                    policy=decision.policy,
                    proration_date=proration_date,
                )
                if decision.policy == "prorated_delta":
                    source_catalog_amount = source_plan.month_usd * 100
                    target_catalog_amount = target_plan.month_usd * 100
                    ratio_error = abs(
                        estimate.source_proration_amount * target_catalog_amount
                        - estimate.target_proration_amount * source_catalog_amount
                    )
                    safe = (
                        estimate.safe_invoice_shape
                        and estimate.amount_due > 0
                        and estimate.source_proration_amount > 0
                        and estimate.target_proration_amount > estimate.source_proration_amount
                        and estimate.amount_due
                        == estimate.target_proration_amount - estimate.source_proration_amount
                        and estimate.customer_balance_credit == 0
                        and estimate.tax_amount == 0
                        and estimate.discount_amount == 0
                        and estimate.currency.lower() == target_plan.currency
                        and ratio_error <= max(source_catalog_amount, target_catalog_amount)
                        and estimate.period_start is not None
                        and int(estimate.period_start.timestamp()) == proration_date
                        and estimate.period_end == context.current_period_end
                    )
                else:
                    safe = (
                        estimate.safe_invoice_shape
                        and estimate.amount_due == expected_amount
                        and estimate.proration_credit == 0
                        and estimate.customer_balance_credit == 0
                        and estimate.tax_amount == 0
                        and estimate.discount_amount == 0
                        and estimate.currency.lower() == target_plan.currency
                    )
                if not safe:
                    # A zero/credit invoice provides no new-money proof for replacing the
                    # active entitlement. Defer safely instead of presenting it as a charge.
                    decision = TransitionDecision(
                        decision.from_plan,
                        decision.from_interval,
                        decision.target_plan,
                        decision.target_interval,
                        "period_end",
                        "immediate preview lacked a positive safely-attributed amount due",
                        decision.policy,
                    )
            await self._assert_account_snapshot(row)
            final = await self._store_preview(
                str(row["id"]),
                lease_token,
                decision,
                context,
                estimate,
                proration_date,
            )
            return self._result(final, decision, replayed=replayed)
        except Exception as exc:
            await self._release_after_error(str(row["id"]), lease_token, type(exc).__name__)
            raise

    async def confirm(
        self,
        account_id: str,
        preview_id: str,
    ) -> PlanChangeResult:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """select * from billing_plan_changes
                     where id=$1::uuid and account_id=$2::uuid""",
                preview_id,
                account_id,
            )
        if row is None:
            raise PlanChangeUnavailableError("plan-change preview not found")
        replayed = False
        decision = self._decision_from_row(row)
        status = cast(PlanChangeStatus, row["status"])
        if status == "failed":
            raise PlanChangeUnavailableError(
                "this plan-change intent failed; request a new preview"
            )
        if status in {"scheduled", "applied", "requires_action", "completed"}:
            return self._result(row, decision, replayed=True)
        if decision.timing == "noop":
            return self._result(row, decision, replayed=replayed)

        if status not in {"previewed", "applying"}:
            raise PlanChangeConflictError("preview this exact change before confirming it")
        lease_token = uuid.uuid4()
        leased = await self._acquire_confirmation_lease(str(row["id"]), lease_token)
        if leased is None:
            refreshed = await self._get(str(row["id"]))
            if await self._expire_preview_if_idle(refreshed):
                raise PlanChangeUnavailableError(
                    "plan-change preview expired; request a new preview"
                )
            if refreshed["status"] == "failed":
                raise PlanChangeUnavailableError(
                    "this plan-change intent failed; request a new preview"
                )
            return self._result(refreshed, decision, replayed=True)
        row = leased
        decision = self._decision_from_row(row)

        try:
            target_lookup = self.catalog.lookup_key(decision.target_plan, decision.target_interval)
            target_plan = self.catalog.require(decision.target_plan)
            context = await self.gateway.prepare_plan_change(
                str(row["stripe_subscription_id"]),
                target_lookup,
                expected_currency=target_plan.currency,
                expected_unit_amount=(
                    target_plan.month_usd
                    if decision.target_interval == "month"
                    else target_plan.year_usd
                )
                * 100,
                target_interval=decision.target_interval,
            )
            await self._revalidate_before_remote(row, context, target_lookup)
            request_key = str(row["stripe_request_key"])
            if decision.timing == "immediate":
                self._assert_remote_retry_window(row)
                row = await self._mark_remote_started(str(row["id"]), lease_token)
                remote = await self.gateway.apply_immediate_plan_change(
                    context,
                    idempotency_key=f"{request_key}:apply",
                    policy=decision.policy,
                    proration_date=(
                        int(row["proration_date"]) if row["proration_date"] is not None else None
                    ),
                )
                final_status: PlanChangeStatus = (
                    "requires_action" if remote.pending_update else "applied"
                )
                effective_at = None
            else:
                self._assert_remote_retry_window(row)
                row = await self._mark_remote_started(str(row["id"]), lease_token)
                remote = await self.gateway.schedule_plan_change(
                    context, idempotency_key=f"{request_key}:schedule"
                )
                final_status = "scheduled"
                effective_at = context.current_period_end
            await self._assert_account_snapshot(row)
            final = await self._finish(
                str(row["id"]),
                lease_token,
                status=final_status,
                effective_at=effective_at,
                schedule_id=remote.remote_id if final_status == "scheduled" else None,
                pending_expires_at=remote.pending_expires_at,
                recovery_url=remote.recovery_url,
                settlement_invoice_id=remote.settlement_invoice_id,
            )
            if final["status"] == "failed":
                raise PlanChangeUnavailableError(
                    "the settlement Invoice could not fund the target entitlement"
                )
            result = self._result(final, decision, replayed=replayed)
            return PlanChangeResult(
                result.change_id,
                result.decision,
                result.status,
                result.effective_at,
                result.recovery_url,
                remote.client_secret,
                result.replayed,
                result.estimated_amount_due,
                result.estimated_credit_applied,
                result.estimated_customer_balance_credit,
                result.estimate_currency,
                result.transition_policy,
                result.entitlement_credit_delta,
            )
        except Exception as exc:
            await self._release_after_error(str(row["id"]), lease_token, type(exc).__name__)
            raise

    async def _reserve(
        self, account_id: str, plan: str, interval: str, idempotency_key: str
    ) -> tuple[asyncpg.Record, bool]:
        target = self.catalog.require(plan)
        target_interval = self._interval(interval)
        async with self.pool.acquire() as conn, conn.transaction():
            account = await conn.fetchrow(
                "select * from billing_accounts where id=$1::uuid for update", account_id
            )
            if account is None:
                raise PlanChangeUnavailableError("billing account not found")
            await conn.execute(
                """update billing_plan_changes set status='failed',
                         last_error='pending_update_expired',updated_at=now()
                     where account_id=$1::uuid and status='requires_action'
                       and remote_pending_expires_at <= now()""",
                account_id,
            )
            await conn.execute(
                """update billing_plan_changes set status='failed',
                         last_error='preview_expired',updated_at=now()
                     where account_id=$1::uuid and status='previewed'
                       and preview_expires_at <= now()
                       and (lease_expires_at is null or lease_expires_at <= now())""",
                account_id,
            )
            existing = await conn.fetchrow(
                """select * from billing_plan_changes
                     where account_id=$1::uuid and idempotency_key=$2""",
                account_id,
                idempotency_key,
            )
            if existing is not None:
                if (
                    existing["target_plan_key"] != target.key
                    or existing["target_interval"] != target_interval
                ):
                    raise PlanChangeConflictError(
                        "Idempotency-Key was already used with a different target"
                    )
                return existing, True
            if account["subscription_status"] != "active" or not account["stripe_subscription_id"]:
                raise PlanChangeUnavailableError("an active paid subscription is required")
            if account["cancel_at_period_end"]:
                raise PlanChangeUnavailableError(
                    "cancel the pending subscription cancellation before changing plans"
                )
            current_key = str(account["plan_key"])
            current_interval = self._interval(str(account["plan_interval"]))
            current = self.catalog.require(current_key)
            decision = decide_transition(
                current,
                current_interval,
                target,
                target_interval,
                self.transition_policy,
            )
            if decision.timing == "period_end" and account["current_period_end"] is None:
                raise PlanChangeUnavailableError("current period end is not known yet")
            pending = await conn.fetchrow(
                """select id from billing_plan_changes where account_id=$1::uuid
                     and status in (
                       'reserved','previewed','applying','scheduled','applied','requires_action'
                     )""",
                account_id,
            )
            if pending is not None:
                raise PlanChangeBusyError("another plan change is still pending")
            change_id = uuid.uuid4()
            status: PlanChangeStatus = "completed" if decision.timing == "noop" else "reserved"
            expected_source_invoice_id: str | None = None
            expected_credit_delta: int | None = None
            if decision.policy == "prorated_delta" and decision.timing == "immediate":
                if account["entitlement_period_end"] is None or not await conn.fetchval(
                    "select $1::timestamptz > now()", account["entitlement_period_end"]
                ):
                    raise PlanChangeUnavailableError(
                        "the active entitlement has no current funded period boundary"
                    )
                expected_source_invoice_id = await self._latest_funding_invoice(
                    conn, account["id"], int(account["grant_epoch"])
                )
                if expected_source_invoice_id is None:
                    raise PlanChangeUnavailableError(
                        "the active entitlement has no immutable funding invoice"
                    )
                expected_credit_delta = target.monthly_credits - current.monthly_credits
                if expected_credit_delta <= 0:
                    raise PlanChangeConflictError(
                        "a prorated upgrade requires a positive entitlement delta"
                    )
            row = await conn.fetchrow(
                """insert into billing_plan_changes(
                       id,account_id,idempotency_key,stripe_subscription_id,
                       from_plan_key,from_interval,target_plan_key,target_interval,
                       effective_mode,status,effective_at,stripe_request_key,completed_at,
                       expected_grant_epoch,expected_entitlement_period_end,
                       expected_subscription_status,expected_cancel_at_period_end,
                       transition_policy,expected_source_invoice_id,
                       expected_credit_delta,expected_entitlement_revoked)
                     values($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                            $12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
                     returning *""",
                change_id,
                account_id,
                idempotency_key,
                account["stripe_subscription_id"],
                current.key,
                current_interval,
                target.key,
                target_interval,
                decision.timing,
                status,
                account["current_period_end"] if decision.timing == "period_end" else None,
                f"plan-change:{change_id}",
                datetime.now().astimezone() if status == "completed" else None,
                account["grant_epoch"],
                account["entitlement_period_end"],
                account["subscription_status"],
                account["cancel_at_period_end"],
                decision.policy,
                expected_source_invoice_id,
                expected_credit_delta,
                account["entitlement_revoked"],
            )
            assert row is not None
            return row, False

    async def _acquire_lease(
        self, change_id: str, lease_token: uuid.UUID, expected_status: PlanChangeStatus
    ) -> asyncpg.Record | None:
        async with self.pool.acquire() as conn:
            return await conn.fetchrow(
                """update billing_plan_changes set lease_token=$2,
                         lease_expires_at=now()+$3::interval,updated_at=now()
                     where id=$1::uuid and status=$4
                       and (lease_expires_at is null or lease_expires_at <= now())
                       and ($4::text <> 'previewed' or
                            (preview_expires_at is not null and preview_expires_at > now()))
                     returning *""",
                change_id,
                lease_token,
                self.lease_ttl,
                expected_status,
            )

    async def _acquire_confirmation_lease(
        self, change_id: str, lease_token: uuid.UUID
    ) -> asyncpg.Record | None:
        async with self.pool.acquire() as conn:
            return await conn.fetchrow(
                """update billing_plan_changes set status='applying',lease_token=$2,
                         lease_expires_at=now()+$3::interval,updated_at=now()
                     where id=$1::uuid and status in ('previewed','applying')
                       and (lease_expires_at is null or lease_expires_at <= now())
                       and (status='applying' or
                            (preview_expires_at is not null and preview_expires_at > now()))
                     returning *""",
                change_id,
                lease_token,
                self.lease_ttl,
            )

    async def _mark_remote_started(self, change_id: str, lease_token: uuid.UUID) -> asyncpg.Record:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """update billing_plan_changes set
                         remote_started_at=coalesce(remote_started_at,now()),updated_at=now()
                     where id=$1::uuid and status='applying' and lease_token=$2
                     returning *""",
                change_id,
                lease_token,
            )
        if row is None:
            raise PlanChangeConflictError("plan-change confirmation lease was lost")
        return row

    async def _expire_preview_if_idle(self, row: Mapping[str, Any]) -> bool:
        if row["status"] != "previewed" or row["preview_expires_at"] is None:
            return False
        async with self.pool.acquire() as conn:
            expired = await conn.fetchval(
                """update billing_plan_changes set status='failed',
                         last_error='preview_expired',lease_token=null,
                         lease_expires_at=null,updated_at=now()
                     where id=$1::uuid and status='previewed'
                       and preview_expires_at <= now()
                       and (lease_expires_at is null or lease_expires_at <= now())
                     returning id""",
                row["id"],
            )
        return expired is not None

    async def _store_preview(
        self,
        change_id: str,
        lease_token: uuid.UUID,
        decision: TransitionDecision,
        context: PlanChangeContext,
        estimate: PlanChangeEstimate | None,
        proration_date: int | None,
    ) -> asyncpg.Record:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """update billing_plan_changes set status='previewed',effective_mode=$3,
                       effective_at=case when $3::text='period_end'
                                         then $4::timestamptz else null end,
                       proration_date=$5,estimated_amount_due=$6,
                       estimated_credit_applied=$7,
                       estimated_customer_balance_credit=$8,estimate_currency=$9,
                       estimated_source_proration=$10,
                       estimated_target_proration=$11,
                       estimated_period_start=$12,estimated_period_end=$13,
                       preview_expires_at=now()+interval '10 minutes',
                       lease_token=null,lease_expires_at=null,last_error=null,updated_at=now()
                     where id=$1::uuid and lease_token=$2 returning *""",
                change_id,
                lease_token,
                decision.timing,
                context.current_period_end,
                proration_date,
                estimate.amount_due if estimate else None,
                estimate.proration_credit if estimate else None,
                estimate.customer_balance_credit if estimate else None,
                estimate.currency if estimate else None,
                estimate.source_proration_amount if estimate else None,
                estimate.target_proration_amount if estimate else None,
                estimate.period_start if estimate else None,
                estimate.period_end if estimate else None,
            )
        if row is None:
            return await self._get(change_id)
        return row

    async def _revalidate_before_remote(
        self,
        reserved: Mapping[str, Any],
        context: PlanChangeContext,
        target_lookup: str,
    ) -> None:
        expected_lookup = self.catalog.lookup_key(
            str(reserved["from_plan_key"]), str(reserved["from_interval"])
        )
        if context.subscription_id != reserved["stripe_subscription_id"]:
            raise PlanChangeConflictError("Stripe subscription identity changed")
        remote_started = reserved.get("remote_started_at") is not None
        allowed_lookups = {expected_lookup, target_lookup} if remote_started else {expected_lookup}
        if context.current_lookup_key not in allowed_lookups:
            raise PlanChangeConflictError("Stripe price drifted outside this transition")
        expected_active = reserved["expected_subscription_status"] == "active"
        observed_active = context.subscription_status in {"active", "trialing"}
        if observed_active != expected_active:
            raise PlanChangeConflictError("Stripe subscription status drifted")
        if context.cancel_at_period_end != reserved["expected_cancel_at_period_end"]:
            raise PlanChangeConflictError("Stripe cancellation state drifted")
        remote_target_recovery = bool(
            remote_started
            and reserved["transition_policy"] == "full_period_reset"
            and context.current_lookup_key == target_lookup
        )
        if (
            reserved["expected_entitlement_period_end"] is not None
            and context.current_period_end != reserved["expected_entitlement_period_end"]
            and not remote_target_recovery
        ):
            raise PlanChangeConflictError(
                "Stripe billing period drifted; reconcile before changing plans"
            )
        if not remote_started and (context.pending_update or context.schedule_id):
            raise PlanChangeConflictError("Stripe already has an unrelated pending change")
        async with self.pool.acquire() as conn, conn.transaction():
            account = await conn.fetchrow(
                "select * from billing_accounts where id=$1 for update", reserved["account_id"]
            )
            change = await conn.fetchrow(
                "select * from billing_plan_changes where id=$1 for update", reserved["id"]
            )
            if account is None or change is None:
                raise PlanChangeUnavailableError("plan change state disappeared")
            if not self._account_matches_snapshot(account, reserved):
                raise PlanChangeConflictError("local billing state changed")
            if (
                reserved["transition_policy"] == "prorated_delta"
                and reserved["effective_mode"] == "immediate"
            ):
                latest = await self._latest_funding_invoice(
                    conn, account["id"], int(account["grant_epoch"])
                )
                if latest != reserved["expected_source_invoice_id"]:
                    raise PlanChangeConflictError("entitlement funding lineage changed")
            if change["status"] == "completed":
                return

    async def _finish(
        self,
        change_id: str,
        lease_token: uuid.UUID,
        *,
        status: PlanChangeStatus,
        effective_at: datetime | None,
        schedule_id: str | None,
        pending_expires_at: datetime | None,
        recovery_url: str | None,
        settlement_invoice_id: str | None,
    ) -> asyncpg.Record:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """update billing_plan_changes set
                       status=case when status='completed' then status else $3 end,
                       effective_at=coalesce($4,effective_at),
                       stripe_schedule_id=coalesce($5,stripe_schedule_id),
                       remote_pending_expires_at=$6,recovery_url=$7,
                       settlement_invoice_id=coalesce(settlement_invoice_id,$8),
                       lease_token=null,lease_expires_at=null,last_error=null,updated_at=now()
                     where id=$1::uuid and lease_token=$2
                       and ($8::text is null or settlement_invoice_id is null
                            or settlement_invoice_id=$8)
                     returning *""",
                change_id,
                lease_token,
                status,
                effective_at,
                schedule_id,
                pending_expires_at,
                recovery_url,
                settlement_invoice_id,
            )
        if row is None:
            row = await self._get(change_id)
            if (
                settlement_invoice_id is not None
                and row["settlement_invoice_id"] is not None
                and row["settlement_invoice_id"] != settlement_invoice_id
            ):
                raise PlanChangeConflictError(
                    "Stripe returned a different settlement Invoice for this plan change"
                )
        return row

    async def _release_after_error(
        self, change_id: str, lease_token: uuid.UUID, error_name: str
    ) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                """update billing_plan_changes set
                       status=case when status='applying' and remote_started_at is null
                                   then 'previewed' else status end,
                       lease_token=null,
                       lease_expires_at=null,last_error=$3,updated_at=now()
                     where id=$1::uuid and lease_token=$2""",
                change_id,
                lease_token,
                error_name,
            )

    @staticmethod
    def _assert_remote_retry_window(row: Mapping[str, Any]) -> None:
        started = row.get("remote_started_at")
        if started is not None and datetime.now(UTC) - started >= timedelta(hours=23):
            raise PlanChangeUnavailableError(
                "Stripe call outcome is too old to retry safely; reconcile it manually"
            )

    async def _assert_account_snapshot(self, reserved: Mapping[str, Any]) -> None:
        mismatch = False
        async with self.pool.acquire() as conn, conn.transaction():
            account = await conn.fetchrow(
                "select * from billing_accounts where id=$1 for update", reserved["account_id"]
            )
            change = await conn.fetchrow(
                "select status from billing_plan_changes where id=$1 for update", reserved["id"]
            )
            if account is None:
                raise PlanChangeUnavailableError("billing account disappeared")
            if change is not None and change["status"] == "completed":
                return
            lineage_matches = True
            if (
                reserved["transition_policy"] == "prorated_delta"
                and reserved["effective_mode"] == "immediate"
            ):
                latest = await self._latest_funding_invoice(
                    conn, account["id"], int(account["grant_epoch"])
                )
                lineage_matches = latest == reserved["expected_source_invoice_id"]
            if self._account_matches_snapshot(account, reserved) and lineage_matches:
                return
            mismatch = True
            await conn.execute(
                """insert into billing_incidents(kind,dedupe_key,account_id,detail)
                     values('plan_change_account_race',$1,$2,$3::jsonb)
                     on conflict(kind,dedupe_key) where resolved_at is null do update set
                       detail=excluded.detail,seen_count=billing_incidents.seen_count+1,
                       last_seen_at=now()""",
                str(reserved["id"]),
                account["id"],
                {"expected_subscription": reserved["stripe_subscription_id"]},
            )
        if mismatch:
            raise PlanChangeConflictError("billing account changed during the Stripe call")

    @staticmethod
    def _account_matches_snapshot(account: Mapping[str, Any], reserved: Mapping[str, Any]) -> bool:
        return bool(
            account["stripe_subscription_id"] == reserved["stripe_subscription_id"]
            and account["plan_key"] == reserved["from_plan_key"]
            and account["plan_interval"] == reserved["from_interval"]
            and int(account["grant_epoch"]) == int(reserved["expected_grant_epoch"])
            and account["entitlement_period_end"] == reserved["expected_entitlement_period_end"]
            and account["subscription_status"] == reserved["expected_subscription_status"]
            and account["cancel_at_period_end"] == reserved["expected_cancel_at_period_end"]
            and account["entitlement_revoked"] == reserved["expected_entitlement_revoked"]
        )

    @staticmethod
    async def _latest_funding_invoice(
        conn: asyncpg.Connection, account_id: Any, grant_epoch: int
    ) -> str | None:
        value = await conn.fetchval(
            """select stripe_invoice_id from credit_ledger
                 where account_id=$1 and grant_epoch=$2 and grant_slot is not null
                   and entitlement_units > 0
                   and reason in ('subscription_grant','upgrade_delta_grant')
                 order by id desc limit 1""",
            account_id,
            grant_epoch,
        )
        if not value:
            value = await conn.fetchval(
                """select source_invoice_id from billing_funding_allocations
                     where account_id=$1 and grant_epoch=$2
                       and status in ('closed','disputed')
                     order by id desc limit 1""",
                account_id,
                grant_epoch,
            )
        return str(value) if value else None

    async def _get(self, change_id: str) -> asyncpg.Record:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                "select * from billing_plan_changes where id=$1::uuid", change_id
            )
        if row is None:
            raise PlanChangeUnavailableError("plan change not found")
        return row

    @staticmethod
    def _interval(value: str) -> BillingInterval:
        if value not in {"month", "year"}:
            raise PlanChangeConflictError("interval must be month or year")
        return cast(BillingInterval, value)

    @staticmethod
    def _decision_from_row(row: Mapping[str, Any]) -> TransitionDecision:
        return TransitionDecision(
            str(row["from_plan_key"]),
            cast(BillingInterval, row["from_interval"]),
            str(row["target_plan_key"]),
            cast(BillingInterval, row["target_interval"]),
            cast(Any, row["effective_mode"]),
            "persisted transition policy",
            cast(TransitionPolicy, row["transition_policy"]),
        )

    @staticmethod
    def _result(
        row: Mapping[str, Any], decision: TransitionDecision, *, replayed: bool
    ) -> PlanChangeResult:
        return PlanChangeResult(
            str(row["id"]),
            decision,
            cast(PlanChangeStatus, row["status"]),
            row["effective_at"],
            row["recovery_url"],
            None,
            replayed,
            row.get("estimated_amount_due"),
            row.get("estimated_credit_applied"),
            row.get("estimated_customer_balance_credit"),
            row.get("estimate_currency"),
            cast(TransitionPolicy, row.get("transition_policy", "full_period_reset")),
            row.get("expected_credit_delta"),
        )
