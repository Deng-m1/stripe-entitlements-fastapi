from __future__ import annotations

import time
from datetime import datetime, timedelta
from typing import Any, Protocol

import asyncpg

from .processor import EventProcessor
from .types import ProcessResult


class ReconciliationGateway(Protocol):
    async def subscription_object(self, subscription_id: str) -> dict[str, Any]: ...

    async def latest_paid_invoice_event(
        self, subscription_id: str
    ) -> dict[str, Any] | None: ...


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

    async def candidates(self, now: datetime, *, limit: int = 100) -> list[dict[str, Any]]:
        stale_before = now - timedelta(days=3)
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """select distinct a.id,a.stripe_subscription_id
                     from billing_accounts a
                     left join billing_incidents i on i.account_id=a.id and i.resolved_at is null
                     where a.stripe_subscription_id is not null and (
                       a.subscription_status='past_due'
                       or (a.subscription_status='active' and a.current_period_end < $1)
                       or i.kind in ('stale_paid_event','annual_plan_mismatch')
                     ) order by a.id limit $2""",
                stale_before,
                limit,
            )
        return [dict(row) for row in rows]

    async def reconcile_account(self, account_id: str) -> ProcessResult:
        async with self.pool.acquire() as conn:
            account = await conn.fetchrow(
                "select * from billing_accounts where id=$1::uuid", account_id
            )
        if account is None or not account["stripe_subscription_id"]:
            return ProcessResult("ignored", "account has no subscription", account_id)
        expected_subscription = str(account["stripe_subscription_id"])
        expected_account = {
            "stripe_subscription_id": expected_subscription,
            "event_created": int(account["event_created"]),
            "event_rank": int(account["event_rank"]),
        }
        subscription = await self.gateway.subscription_object(expected_subscription)
        if str(subscription.get("id")) != expected_subscription:
            return ProcessResult("ignored", "Stripe returned a different subscription", account_id)
        status = str(subscription.get("status") or "")
        if status in {"canceled", "incomplete_expired"}:
            event = {
                "id": (
                    f"reconcile:{expected_subscription}:deleted:"
                    f"{subscription.get('canceled_at') or 0}"
                ),
                "object": "event",
                "type": "customer.subscription.deleted",
                "created": int(subscription.get("canceled_at") or time.time()),
                "livemode": bool(subscription.get("livemode")),
                "_remote_verified": True,
                "_expected_account": expected_account,
                "data": {"object": subscription},
            }
            return await self.processor.process(event)
        if status in {"active", "trialing"}:
            paid = await self.gateway.latest_paid_invoice_event(expected_subscription)
            if paid is None:
                await self._incident(account_id, expected_subscription, "no paid invoice")
                return ProcessResult(
                    "ignored", "active subscription has no paid invoice", account_id
                )
            invoice_id = str((paid.get("data") or {}).get("object", {}).get("id") or "unknown")
            paid["id"] = (
                f"reconcile:{invoice_id}:{expected_subscription}:"
                f"{expected_account['event_created']}:{expected_account['event_rank']}"
            )
            paid["_expected_account"] = expected_account
            result = await self.processor.process(paid)
            if result.outcome in {"handled", "replayed"}:
                await self._resolve_incidents(account_id)
            return result
        event = {
            "id": f"reconcile:{expected_subscription}:status:{status}:{int(time.time())}",
            "object": "event",
            "type": "customer.subscription.updated",
            "created": int(time.time()),
            "livemode": bool(subscription.get("livemode")),
            "_remote_verified": True,
            "_expected_account": expected_account,
            "data": {"object": subscription},
        }
        return await self.processor.process(event)

    async def _incident(self, account_id: str, subscription_id: str, reason: str) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                """insert into billing_incidents(kind,dedupe_key,account_id,detail)
                     values('reconciliation_failed',$1,$2::uuid,$3::jsonb)
                     on conflict(kind,dedupe_key) where resolved_at is null do update set
                       detail=excluded.detail,seen_count=billing_incidents.seen_count+1,
                       last_seen_at=now()""",
                f"{account_id}:{subscription_id}",
                account_id,
                {"reason": reason},
            )

    async def _resolve_incidents(self, account_id: str) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                """update billing_incidents set resolved_at=now()
                     where account_id=$1::uuid and resolved_at is null
                       and kind in ('stale_paid_event','annual_plan_mismatch',
                                    'reconciliation_failed')""",
                account_id,
            )
