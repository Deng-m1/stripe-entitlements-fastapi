from __future__ import annotations

from datetime import datetime
from typing import Any

import asyncpg

from .catalog import PlanCatalog
from .processor import EventProcessor, _annual_slots_allowed
from .types import ProcessResult, SubscriptionSnapshot


class AnnualGrantService:
    """Distributed-safe annual-plan monthly grant worker.

    Stripe retrieval must happen before this method. Multiple workers may call it
    concurrently: the account row lock and invoice/slot unique index converge them.
    """

    def __init__(
        self, pool: asyncpg.Pool, catalog: PlanCatalog, processor: EventProcessor
    ) -> None:
        self.pool = pool
        self.catalog = catalog
        self.processor = processor

    async def due_accounts(self, now: datetime, *, limit: int = 100) -> list[dict[str, Any]]:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """select id,stripe_subscription_id from billing_accounts
                     where plan_interval='year' and subscription_status='active'
                       and annual_anchor is not null and funding_invoice_id is not null
                       and annual_grants_issued < annual_grants_allowed
                       and annual_anchor + make_interval(months => annual_grants_issued)
                           <= $1::timestamptz
                     order by updated_at limit $2""",
                now,
                limit,
            )
        return [dict(row) for row in rows]

    async def grant_due(
        self,
        account_id: str,
        now: datetime,
        snapshot: SubscriptionSnapshot,
    ) -> ProcessResult:
        async with self.pool.acquire() as conn, conn.transaction():
            account = await conn.fetchrow(
                "select * from billing_accounts where id=$1::uuid for update", account_id
            )
            if account is None:
                return ProcessResult("ignored", "account not found")
            if account["subscription_status"] != "active" or account["plan_interval"] != "year":
                return ProcessResult("ignored", "account is not an active annual plan", account_id)
            if snapshot.subscription_id != account["stripe_subscription_id"]:
                return ProcessResult(
                    "ignored", "subscription changed during remote verification", account_id
                )
            if snapshot.status not in {"active", "trialing"}:
                return ProcessResult("ignored", "Stripe subscription is not active", account_id)
            parsed = self.catalog.parse_lookup_key(snapshot.lookup_key)
            if parsed is None or parsed[0].key != account["plan_key"] or parsed[1] != "year":
                await conn.execute(
                    """insert into billing_incidents
                         (kind,dedupe_key,account_id,invoice_id,detail)
                       values('annual_plan_mismatch',$1,$2,$3,$4::jsonb)
                       on conflict(kind,dedupe_key) where resolved_at is null do update set
                         detail=excluded.detail,seen_count=billing_incidents.seen_count+1,
                         last_seen_at=now()""",
                    f"{account_id}:{account['stripe_subscription_id']}",
                    account["id"],
                    account["funding_invoice_id"],
                    {"remote_lookup_key": snapshot.lookup_key, "local_plan": account["plan_key"]},
                )
                return ProcessResult("ignored", "remote and local annual plans differ", account_id)
            boundaries = int(
                await conn.fetchval(
                    """select coalesce(max(slot),0) from generate_series(1,12) slot
                         where $1::timestamptz + make_interval(months => slot)
                           <= $2::timestamptz""",
                    account["annual_anchor"],
                    now,
                )
                or 0
            )
            target_slot = min(boundaries + 1, int(account["annual_grants_allowed"]), 12)
            if target_slot <= int(account["annual_grants_issued"]):
                return ProcessResult(
                    "replayed", "the current annual slot was already granted", account_id
                )
            invoice_id = str(account["funding_invoice_id"])
            state = await conn.fetchrow(
                "select * from stripe_invoice_state where invoice_id=$1 for update", invoice_id
            )
            if state is None:
                return ProcessResult("ignored", "funding invoice state is missing", account_id)
            if state["fully_refunded"] or state["disputed"]:
                await conn.execute(
                    """update billing_accounts set annual_grants_allowed=annual_grants_issued,
                         updated_at=now() where id=$1""",
                    account["id"],
                )
                return ProcessResult("ignored", "funding invoice is closed", account_id)
            plan = parsed[0]
            old_balance = int(account["credits_balance"])
            new_epoch = int(account["grant_epoch"]) + 1
            event_id = f"annual:{invoice_id}:{target_slot}"
            await conn.execute(
                """update billing_accounts set credits_balance=$2,grant_epoch=$3,
                     annual_grants_issued=$4,updated_at=now() where id=$1""",
                account["id"],
                plan.monthly_credits,
                new_epoch,
                target_slot,
            )
            grant = await conn.fetchrow(
                """insert into credit_ledger
                     (account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
                      stripe_event_id,stripe_invoice_id,grant_slot)
                   values($1,$2,$3,$4,'subscription_grant',$5,$6,$7,$8)
                   returning id""",
                account["id"],
                plan.monthly_credits - old_balance,
                plan.monthly_credits,
                plan.monthly_credits,
                new_epoch,
                event_id,
                invoice_id,
                target_slot,
            )
            await conn.execute(
                """update stripe_invoice_state set grants_issued=greatest(grants_issued,$2),
                     updated_at=now() where invoice_id=$1""",
                invoice_id,
                target_slot,
            )
            if int(state["amount_refunded"]) > 0:
                await self.processor._apply_clawback_to_grant(
                    conn,
                    account_id=account["id"],
                    invoice_id=invoice_id,
                    grant_id=int(grant["id"]),
                    entitlement_units=plan.monthly_credits,
                    amount=int(state["amount_total"]),
                    amount_refunded=int(state["amount_refunded"]),
                    full=False,
                    reason="refund_clawback",
                    event_id=event_id,
                )
                allowed = _annual_slots_allowed(
                    int(state["amount_total"]), int(state["amount_refunded"]), target_slot
                )
                await conn.execute(
                    """update billing_accounts set
                         annual_grants_allowed=least(annual_grants_allowed,$2)
                         where id=$1""",
                    account["id"],
                    allowed,
                )
            return ProcessResult("handled", f"granted annual slot {target_slot}", account_id)
