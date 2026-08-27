from __future__ import annotations

from datetime import datetime
from typing import Any

import asyncpg

from .catalog import PlanCatalog
from .price_policy import catalog_price_matches
from .processor import EventProcessor
from .types import ProcessResult, SubscriptionSnapshot


class AnnualGrantService:
    """Distributed-safe annual-plan monthly grant worker.

    Stripe retrieval must happen before this method. Multiple workers may call it
    concurrently: the account row lock and invoice/slot unique index converge them.
    """

    def __init__(self, pool: asyncpg.Pool, catalog: PlanCatalog, processor: EventProcessor) -> None:
        self.pool = pool
        self.catalog = catalog
        self.processor = processor

    async def record_failure(self, account_id: str, subscription_id: str, reason: str) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                """insert into billing_incidents(kind,dedupe_key,account_id,detail)
                     values('annual_grant_failed',$1,$2::uuid,$3::jsonb)
                     on conflict(kind,dedupe_key) where resolved_at is null do update set
                       detail=excluded.detail,seen_count=billing_incidents.seen_count+1,
                       last_seen_at=clock_timestamp()""",
                f"{account_id}:{subscription_id}",
                account_id,
                {"subscription_id": subscription_id, "reason": reason},
            )

    async def due_accounts(
        self,
        now: datetime | None,
        *,
        limit: int = 100,
        exclude_account_ids: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        if now is not None and now.tzinfo is None:
            raise ValueError("annual worker time must be timezone-aware")
        if limit <= 0:
            raise ValueError("annual worker candidate limit must be positive")
        excluded = list(exclude_account_ids or ())
        async with self.pool.acquire() as conn:
            effective_now = now or await conn.fetchval("select now()")
            rows = await conn.fetch(
                """select id,stripe_subscription_id from billing_accounts
                     where plan_interval='year' and subscription_status='active'
                       and not entitlement_revoked
                       and entitlement_period_end > $1::timestamptz
                       and annual_anchor is not null and funding_invoice_id is not null
                       and annual_grants_issued < annual_grants_allowed
                       and annual_anchor + make_interval(months => annual_grants_issued)
                           <= $1::timestamptz
                       and not (id=any($3::uuid[]))
                     order by updated_at,id limit $2""",
                effective_now,
                limit,
                excluded,
            )
        return [dict(row) for row in rows]

    async def grant_due(
        self,
        account_id: str,
        now: datetime | None,
        snapshot: SubscriptionSnapshot,
    ) -> ProcessResult:
        if now is not None and now.tzinfo is None:
            raise ValueError("annual worker time must be timezone-aware")
        async with self.pool.acquire() as conn, conn.transaction():
            effective_now = now or await conn.fetchval("select now()")
            assert isinstance(effective_now, datetime)
            account = await conn.fetchrow(
                "select * from billing_accounts where id=$1::uuid for update", account_id
            )
            if account is None:
                return ProcessResult("ignored", "account not found")
            if account["subscription_status"] != "active" or account["plan_interval"] != "year":
                return ProcessResult("ignored", "account is not an active annual plan", account_id)
            if account["entitlement_revoked"]:
                return ProcessResult("ignored", "annual entitlement is revoked", account_id)
            if (
                account["entitlement_period_end"] is None
                or account["entitlement_period_end"] <= effective_now
            ):
                return ProcessResult("ignored", "annual entitlement period has ended", account_id)
            if snapshot.subscription_id != account["stripe_subscription_id"]:
                return ProcessResult(
                    "ignored", "subscription changed during remote verification", account_id
                )
            if snapshot.status not in {"active", "trialing"}:
                return ProcessResult("ignored", "Stripe subscription is not active", account_id)
            parsed = self.catalog.parse_lookup_key(snapshot.lookup_key)
            period_matches = bool(
                snapshot.current_period_end is not None
                and snapshot.current_period_end == account["entitlement_period_end"]
                and snapshot.current_period_end == account["current_period_end"]
            )
            price_matches = bool(
                snapshot.items_complete
                and parsed is not None
                and snapshot.quantity == 1
                and snapshot.resolved_price is not None
                and catalog_price_matches(
                    snapshot.resolved_price,
                    expected_currency=parsed[0].currency,
                    expected_unit_amount=parsed[0].year_usd * 100,
                    expected_interval="year",
                    expected_product_line=self.processor.product_line,
                    expected_plan_key=parsed[0].key,
                    expected_lookup_key=self.catalog.lookup_key(parsed[0].key, "year"),
                    require_active=False,
                )
            )
            if (
                parsed is None
                or parsed[0].key != account["plan_key"]
                or parsed[1] != "year"
                or not period_matches
                or not price_matches
            ):
                await conn.execute(
                    """insert into billing_incidents
                         (kind,dedupe_key,account_id,invoice_id,detail)
                       values('annual_plan_mismatch',$1,$2,$3,$4::jsonb)
                       on conflict(kind,dedupe_key) where resolved_at is null do update set
                         detail=excluded.detail,seen_count=billing_incidents.seen_count+1,
                         last_seen_at=clock_timestamp()""",
                    f"{account_id}:{account['stripe_subscription_id']}",
                    account["id"],
                    account["funding_invoice_id"],
                    {
                        "remote_lookup_key": snapshot.lookup_key,
                        "remote_price_id": (
                            snapshot.resolved_price.get("id") if snapshot.resolved_price else None
                        ),
                        "remote_quantity": snapshot.quantity,
                        "remote_items_complete": snapshot.items_complete,
                        "remote_period_end": (
                            snapshot.current_period_end.isoformat()
                            if snapshot.current_period_end
                            else None
                        ),
                        "local_plan": account["plan_key"],
                        "local_period_end": (
                            account["entitlement_period_end"].isoformat()
                            if account["entitlement_period_end"]
                            else None
                        ),
                    },
                )
                return ProcessResult("ignored", "remote and local annual plans differ", account_id)
            await conn.execute(
                """update billing_incidents set resolved_at=clock_timestamp(),
                       last_seen_at=clock_timestamp()
                     where kind='annual_plan_mismatch'
                       and dedupe_key=$1 and resolved_at is null""",
                f"{account_id}:{account['stripe_subscription_id']}",
            )
            boundaries = int(
                await conn.fetchval(
                    """select coalesce(max(slot),0) from generate_series(1,12) slot
                         where $1::timestamptz + make_interval(months => slot)
                           <= $2::timestamptz""",
                    account["annual_anchor"],
                    effective_now,
                )
                or 0
            )
            target_slot = min(boundaries + 1, int(account["annual_grants_allowed"]), 12)
            if target_slot <= int(account["annual_grants_issued"]):
                await self._resolve_failure(conn, account_id)
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
                     annual_grants_issued=$4::smallint,
                     credit_expires_at=least(entitlement_period_end,
                       annual_anchor + make_interval(months => ($4::smallint)::integer)),
                     updated_at=now() where id=$1""",
                account["id"],
                plan.monthly_credits,
                new_epoch,
                target_slot,
            )
            await conn.execute(
                """insert into credit_ledger
                     (account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
                      stripe_event_id,stripe_invoice_id,grant_slot)
                   values($1,$2,$3,$4,'subscription_grant',$5,$6,$7,$8)
                   """,
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
            # Partial annual refunds shrink the number of funded slots only. Every
            # still-allowed slot remains a full monthly grant; applying the refund
            # ratio again here would double-claw entitlement.
            await self._resolve_failure(conn, account_id)
            return ProcessResult("handled", f"granted annual slot {target_slot}", account_id)

    @staticmethod
    async def _resolve_failure(conn: asyncpg.Connection, account_id: str) -> None:
        await conn.execute(
            """update billing_incidents set resolved_at=clock_timestamp(),
                   last_seen_at=clock_timestamp()
                 where account_id=$1::uuid and resolved_at is null
                   and kind='annual_grant_failed'""",
            account_id,
        )
