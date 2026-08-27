from __future__ import annotations

import hashlib
from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any, Protocol

import asyncpg

from .processor import EventProcessor
from .types import ProcessResult

_PAID_CAS_RETRY_LIMIT = 3


class ReconciliationGateway(Protocol):
    async def subscription_object(self, subscription_id: str) -> dict[str, Any]: ...

    async def latest_paid_invoice_event(self, subscription_id: str) -> dict[str, Any] | None: ...


def _projection_committed(result: ProcessResult) -> bool:
    return result.outcome in {"handled", "replayed"}


def _customer_fact_fingerprint(subscription: dict[str, Any]) -> str:
    """Hash only the customer identity fact used by cancellation projection.

    A remote correction from a missing/conflicting customer must produce a new
    deterministic synthetic Event ID. The raw Stripe identity is deliberately not
    copied into that ID or logs.
    """

    customer: object = subscription.get("customer")
    if isinstance(customer, dict):
        customer = customer.get("id")
    if not isinstance(customer, (str, int, bool, type(None))):
        customer = type(customer).__name__
    payload = f"{type(customer).__name__}:{customer}".encode()
    return hashlib.sha256(payload).hexdigest()[:16]


class ReconciliationService:
    """Repairs webhook loss by comparing stale local accounts with Stripe truth."""

    def __init__(
        self,
        pool: asyncpg.Pool,
        processor: EventProcessor,
        gateway: ReconciliationGateway,
    ) -> None:
        self.pool = pool
        self.processor = processor
        self.gateway = gateway

    async def database_now(self) -> datetime:
        async with self.pool.acquire() as conn:
            value = await conn.fetchval("select now()")
        assert isinstance(value, datetime)
        return value

    async def _account_projection_snapshot(
        self, account_id: str, subscription_id: str
    ) -> dict[str, object] | None:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """select stripe_subscription_id,event_created,event_rank
                     from billing_accounts where id=$1::uuid""",
                account_id,
            )
        if row is None or str(row["stripe_subscription_id"]) != subscription_id:
            return None
        return {
            "stripe_subscription_id": subscription_id,
            "event_created": int(row["event_created"]),
            "event_rank": int(row["event_rank"]),
        }

    async def candidates(
        self,
        now: datetime | None,
        *,
        limit: int = 100,
        attempted_before: datetime | None = None,
        exclude_account_ids: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        if limit <= 0:
            raise ValueError("reconciliation candidate limit must be positive")
        for value in (now, attempted_before):
            if value is not None and value.tzinfo is None:
                raise ValueError("reconciliation times must be timezone-aware")
        excluded = list(exclude_account_ids or ())
        async with self.pool.acquire() as conn:
            database_now = await conn.fetchval("select now()")
            assert isinstance(database_now, datetime)
            effective_now = now or database_now
            effective_attempted_before = attempted_before or effective_now
            stale_before = effective_now - timedelta(days=3)
            pending_before = effective_now - timedelta(minutes=5)
            rows = await conn.fetch(
                """select distinct a.id,a.stripe_subscription_id,a.last_reconciled_at
                     from billing_accounts a
                     left join billing_incidents i on i.account_id=a.id and i.resolved_at is null
                     where a.stripe_subscription_id is not null
                       and (a.last_reconciled_at is null or a.last_reconciled_at < $4)
                       and not (a.id=any($6::uuid[]))
                       and (
                       a.subscription_status='past_due'
                       or (a.subscription_status='active' and a.current_period_end < $1)
                       or (a.subscription_status='active'
                           and a.entitlement_period_end < $2)
                       or i.kind in ('stale_paid_event','annual_plan_mismatch',
                                     'reconciliation_failed','event_order_tie')
                       or exists(
                         select 1 from billing_plan_changes p
                          where p.account_id=a.id
                            and p.status in ('applying','applied','requires_action')
                            and p.updated_at < $3
                       )
                     ) order by a.last_reconciled_at nulls first,a.id limit $5""",
                stale_before,
                effective_now,
                pending_before,
                effective_attempted_before,
                limit,
                excluded,
            )
        return [dict(row) for row in rows]

    async def reconcile_account(self, account_id: str) -> ProcessResult:
        async with self.pool.acquire() as conn:
            account = await conn.fetchrow(
                "select * from billing_accounts where id=$1::uuid", account_id
            )
        if account is None or not account["stripe_subscription_id"]:
            return ProcessResult("ignored", "account has no subscription", account_id)
        async with self.pool.acquire() as conn:
            attempt = await conn.fetchrow(
                """update billing_accounts set last_reconciled_at=clock_timestamp()
                     where id=$1::uuid
                     returning last_reconciled_at as started_at,
                               extract(epoch from last_reconciled_at)::bigint as database_epoch,
                               txid_current() as transaction_id""",
                account_id,
            )
        assert attempt is not None
        attempt_started_at = attempt["started_at"]
        database_epoch = int(attempt["database_epoch"])
        attempt_fingerprint = hashlib.sha256(
            (
                f"{attempt_started_at.isoformat(timespec='microseconds')}:"
                f"{attempt['transaction_id']}"
            ).encode()
        ).hexdigest()[:16]
        expected_subscription = str(account["stripe_subscription_id"])
        expected_account = {
            "stripe_subscription_id": expected_subscription,
            "event_created": int(account["event_created"]),
            "event_rank": int(account["event_rank"]),
        }
        try:
            subscription = await self.gateway.subscription_object(expected_subscription)
        except Exception as exc:
            await self._incident(
                account_id,
                expected_subscription,
                f"subscription retrieval failed: {type(exc).__name__}",
            )
            raise
        remote_subscription_id = subscription.get("id")
        status = subscription.get("status")
        livemode = subscription.get("livemode")
        if remote_subscription_id != expected_subscription:
            await self._incident(
                account_id,
                expected_subscription,
                "Stripe returned a different subscription",
            )
            return ProcessResult("ignored", "Stripe returned a different subscription", account_id)
        if not isinstance(status, str) or not status:
            await self._incident(
                account_id,
                expected_subscription,
                "Stripe returned an invalid subscription status",
            )
            return ProcessResult(
                "ignored", "Stripe returned an invalid subscription status", account_id
            )
        if not isinstance(livemode, bool):
            await self._incident(
                account_id,
                expected_subscription,
                "Stripe returned an invalid subscription mode",
            )
            return ProcessResult(
                "ignored", "Stripe returned an invalid subscription mode", account_id
            )
        if status in {"canceled", "incomplete_expired"}:
            canceled_at = subscription.get("canceled_at")
            if canceled_at is not None and (type(canceled_at) is not int or canceled_at < 0):
                await self._incident(
                    account_id,
                    expected_subscription,
                    "Stripe returned an invalid cancellation timestamp",
                )
                return ProcessResult(
                    "ignored", "Stripe returned an invalid cancellation timestamp", account_id
                )
            deleted_created = canceled_at if canceled_at is not None else database_epoch
            customer_fingerprint = _customer_fact_fingerprint(subscription)
            event = {
                "id": (
                    f"reconcile:{expected_subscription}:deleted:{deleted_created}:"
                    f"{expected_account['event_created']}:{expected_account['event_rank']}:"
                    f"{attempt_fingerprint}:{customer_fingerprint}"
                ),
                "object": "event",
                "type": "customer.subscription.deleted",
                "created": deleted_created,
                "livemode": livemode,
                "_remote_verified": True,
                "_expected_account": expected_account,
                "data": {"object": subscription},
            }
            result = await self._process(event, account_id, expected_subscription)
            if (
                not _projection_committed(result)
                and result.reason == "older than the applied state"
            ):
                refreshed_snapshot = await self._account_projection_snapshot(
                    account_id, expected_subscription
                )
                if refreshed_snapshot is not None:
                    event = {
                        **event,
                        "id": (
                            f"reconcile:{expected_subscription}:deleted:{deleted_created}:"
                            f"{refreshed_snapshot['event_created']}:"
                            f"{refreshed_snapshot['event_rank']}:{attempt_fingerprint}:"
                            f"{customer_fingerprint}"
                        ),
                        "_expected_account": refreshed_snapshot,
                    }
                    result = await self._process(event, account_id, expected_subscription)
            if _projection_committed(result):
                await self._resolve_incidents(account_id, attempt_started_at)
            else:
                await self._incident(
                    account_id,
                    expected_subscription,
                    f"cancellation projection did not commit: {result.reason or result.outcome}",
                )
            return result

        status_event = {
            "id": (
                f"reconcile:{expected_subscription}:status:{status}:{database_epoch}:"
                f"{expected_account['event_created']}:{expected_account['event_rank']}"
            ),
            "object": "event",
            "type": "customer.subscription.updated",
            "created": database_epoch,
            "livemode": livemode,
            "_remote_verified": True,
            "_expected_account": expected_account,
            "data": {"object": subscription},
        }
        status_result = await self._process(status_event, account_id, expected_subscription)
        if (
            not _projection_committed(status_result)
            and status_result.reason == "older or weaker than the applied state"
        ):
            refreshed_snapshot = await self._account_projection_snapshot(
                account_id, expected_subscription
            )
            if refreshed_snapshot is not None:
                expected_account = refreshed_snapshot
                status_event = {
                    **status_event,
                    "id": (
                        f"reconcile:{expected_subscription}:status:{status}:{database_epoch}:"
                        f"{expected_account['event_created']}:{expected_account['event_rank']}"
                    ),
                    "_expected_account": expected_account,
                }
                status_result = await self._process(status_event, account_id, expected_subscription)
        if not _projection_committed(status_result):
            await self._incident(
                account_id,
                expected_subscription,
                (
                    "status projection did not commit: "
                    f"{status_result.reason or status_result.outcome}"
                ),
            )
            return status_result
        await self._resolve_status_incidents(account_id, attempt_started_at)

        if status in {"active", "trialing"}:
            refreshed_snapshot = await self._account_projection_snapshot(
                account_id, expected_subscription
            )
            if refreshed_snapshot is None:
                await self._incident(
                    account_id,
                    expected_subscription,
                    "local subscription changed during status reconciliation",
                )
                return ProcessResult(
                    "ignored", "local subscription changed during reconciliation", account_id
                )
            expected_account = refreshed_snapshot
            try:
                paid = await self.gateway.latest_paid_invoice_event(expected_subscription)
            except Exception as exc:
                await self._incident(
                    account_id,
                    expected_subscription,
                    f"paid Invoice retrieval failed: {type(exc).__name__}",
                )
                raise
            if paid is None:
                await self._incident(account_id, expected_subscription, "no paid invoice")
                return ProcessResult(
                    "ignored", "active subscription has no paid invoice", account_id
                )
            paid_data = paid.get("data")
            paid_object = paid_data.get("object") if isinstance(paid_data, dict) else None
            invoice_id = (
                str(paid_object.get("id"))
                if isinstance(paid_object, dict) and paid_object.get("id")
                else "unknown"
            )
            failed_paid_event_ids: list[str] = []
            for retry_index in range(_PAID_CAS_RETRY_LIMIT + 1):
                paid_event_id = (
                    f"reconcile:{invoice_id}:{expected_subscription}:"
                    f"{expected_account['event_created']}:{expected_account['event_rank']}"
                )
                paid["id"] = paid_event_id
                paid["_expected_account"] = expected_account
                result = await self._process(paid, account_id, expected_subscription)
                if (
                    _projection_committed(result)
                    or result.reason != "older than the paid entitlement period"
                    or retry_index == _PAID_CAS_RETRY_LIMIT
                ):
                    break
                refreshed_snapshot = await self._account_projection_snapshot(
                    account_id, expected_subscription
                )
                if refreshed_snapshot is None or self._same_projection_snapshot(
                    refreshed_snapshot, expected_account
                ):
                    break
                failed_paid_event_ids.append(paid_event_id)
                expected_account = refreshed_snapshot
            if _projection_committed(result) and failed_paid_event_ids:
                # A competing reconciler may advance the account status cursor after
                # this attempt snapshots it but before its paid projection locks the
                # account. Retrying against the refreshed cursor linearizes the same
                # Invoice. Resolve only stale observations written by this attempt's
                # failed synthetic Event IDs; the broad causal cutoff remains intact.
                await self._resolve_stale_paid_attempts(
                    account_id,
                    invoice_id,
                    failed_paid_event_ids,
                )
            pending = await self._pending_plan_change(account_id)
            if pending is not None:
                await self._plan_change_recovery_incident(
                    account_id, expected_subscription, pending
                )
            elif _projection_committed(result):
                await self._resolve_incidents(account_id, attempt_started_at)
            elif result.reason == "older than the paid entitlement period":
                # EventProcessor committed an invoice-scoped stale_paid_event. A
                # second shared reconciliation_failed row adds no recovery signal
                # and can outlive a concurrent successful grant's causal cutoff.
                pass
            else:
                await self._incident(
                    account_id,
                    expected_subscription,
                    f"paid projection did not commit: {result.reason or result.outcome}",
                )
            return result
        return status_result

    @staticmethod
    def _same_projection_snapshot(left: Mapping[str, object], right: Mapping[str, object]) -> bool:
        return bool(
            left.get("stripe_subscription_id") == right.get("stripe_subscription_id")
            and left.get("event_created") == right.get("event_created")
            and left.get("event_rank") == right.get("event_rank")
        )

    async def _process(
        self,
        event: dict[str, Any],
        account_id: str,
        subscription_id: str,
    ) -> ProcessResult:
        try:
            result = await self.processor.process(event)
            if not (
                result.outcome == "duplicate" and result.reason == "event id already committed"
            ):
                return result
            event_id = event.get("id")
            async with self.pool.acquire() as conn:
                committed = await conn.fetchrow(
                    "select outcome,reason from stripe_webhook_events where id=$1",
                    event_id,
                )
            if committed is None:
                raise RuntimeError("committed reconciliation Event audit row disappeared")
            if committed["outcome"] in {"handled", "replayed"}:
                return ProcessResult(
                    "replayed",
                    "synthetic Event already committed a projection",
                    account_id,
                )
            prior_reason = str(committed["reason"] or committed["outcome"] or "incomplete")
            return ProcessResult(
                "ignored",
                prior_reason,
                account_id,
            )
        except Exception as exc:
            await self._incident(
                account_id,
                subscription_id,
                f"projection failed: {type(exc).__name__}",
            )
            raise

    async def _pending_plan_change(self, account_id: str) -> asyncpg.Record | None:
        async with self.pool.acquire() as conn:
            return await conn.fetchrow(
                """select id,status,settlement_invoice_id,updated_at
                     from billing_plan_changes
                    where account_id=$1::uuid
                      and status in ('applying','applied','requires_action')
                    order by updated_at,id limit 1""",
                account_id,
            )

    async def _plan_change_recovery_incident(
        self,
        account_id: str,
        subscription_id: str,
        change: asyncpg.Record,
    ) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                """insert into billing_incidents(kind,dedupe_key,account_id,invoice_id,detail)
                     values('plan_change_recovery_required',$1,$2::uuid,$3,$4::jsonb)
                     on conflict(kind,dedupe_key) where resolved_at is null do update set
                       invoice_id=coalesce(excluded.invoice_id,billing_incidents.invoice_id),
                       detail=excluded.detail,seen_count=billing_incidents.seen_count+1,
                       last_seen_at=clock_timestamp()""",
                f"{account_id}:{change['id']}",
                account_id,
                change["settlement_invoice_id"],
                {
                    "subscription_id": subscription_id,
                    "plan_change_id": str(change["id"]),
                    "status": change["status"],
                    "updated_at": change["updated_at"].isoformat(),
                    "recovery": "retry the same preview id or inspect its exact settlement invoice",
                },
            )

    async def _incident(self, account_id: str, subscription_id: str, reason: str) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                """insert into billing_incidents(kind,dedupe_key,account_id,detail)
                     values('reconciliation_failed',$1,$2::uuid,$3::jsonb)
                     on conflict(kind,dedupe_key) where resolved_at is null do update set
                       detail=excluded.detail,seen_count=billing_incidents.seen_count+1,
                       last_seen_at=clock_timestamp()""",
                f"{account_id}:{subscription_id}",
                account_id,
                {"reason": reason},
            )

    async def _resolve_stale_paid_attempts(
        self,
        account_id: str,
        invoice_id: str,
        failed_event_ids: list[str],
    ) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                """update billing_incidents set resolved_at=clock_timestamp()
                     where account_id=$1::uuid and invoice_id=$2
                       and kind='stale_paid_event' and resolved_at is null
                       and stripe_event_id=any($3::text[])""",
                account_id,
                invoice_id,
                failed_event_ids,
            )

    async def _resolve_status_incidents(
        self, account_id: str, attempt_started_at: datetime
    ) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                """update billing_incidents set resolved_at=now()
                     where account_id=$1::uuid and resolved_at is null
                       and last_seen_at < $2
                       and kind in ('reconciliation_failed','event_order_tie')""",
                account_id,
                attempt_started_at,
            )

    async def _resolve_incidents(self, account_id: str, attempt_started_at: datetime) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                """update billing_incidents set resolved_at=now()
                     where account_id=$1::uuid and resolved_at is null
                       and last_seen_at < $2
                       and kind in ('stale_paid_event','annual_plan_mismatch',
                                    'reconciliation_failed','event_order_tie',
                                    'plan_change_recovery_required')""",
                account_id,
                attempt_started_at,
            )
