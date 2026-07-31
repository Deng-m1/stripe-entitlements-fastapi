from __future__ import annotations

import logging
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import asyncpg

from .catalog import Plan, PlanCatalog
from .ordering import event_wins, rank_for
from .types import ProcessResult

logger = logging.getLogger("stripe_entitlements.processor")

_PAID_REASONS = {"subscription_create", "subscription_cycle", "subscription_update"}
_CLAWBACK_REASONS = {"refund_clawback", "dispute_clawback"}


def _as_id(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, Mapping):
        candidate = value.get("id")
        return str(candidate) if candidate else None
    return None


def _uuid_or_none(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value else None
    except (ValueError, TypeError, AttributeError):
        return None


def _subscription_id(obj: Mapping[str, Any]) -> str | None:
    return _as_id(obj.get("subscription")) or _as_id(
        ((obj.get("parent") or {}).get("subscription_details") or {}).get("subscription")
    )


def _subscription_metadata(obj: Mapping[str, Any]) -> Mapping[str, Any]:
    parent = ((obj.get("parent") or {}).get("subscription_details") or {}).get("metadata")
    if isinstance(parent, Mapping) and parent:
        return parent
    legacy = obj.get("subscription_details", {}).get("metadata")
    if isinstance(legacy, Mapping) and legacy:
        return legacy
    metadata = obj.get("metadata")
    return metadata if isinstance(metadata, Mapping) else {}


def _line_lookup(line: Mapping[str, Any]) -> str | None:
    if value := line.get("_resolved_lookup_key"):
        return str(value)
    price = line.get("price")
    if isinstance(price, Mapping) and price.get("lookup_key"):
        return str(price["lookup_key"])
    details = (line.get("pricing") or {}).get("price_details") or {}
    return str(details["lookup_key"]) if details.get("lookup_key") else None


def _line_proration(line: Mapping[str, Any]) -> bool:
    return bool(
        line.get("proration")
        or ((line.get("parent") or {}).get("subscription_item_details") or {}).get("proration")
    )


def _timestamp(value: Any) -> datetime | None:
    if value is None:
        return None
    return datetime.fromtimestamp(int(value), tz=UTC)


def _project_status(status: str | None) -> str:
    if status in {"active", "trialing"}:
        return "active"
    if status in {"past_due", "unpaid", "paused"}:
        return "past_due"
    if status in {"canceled", "incomplete_expired"}:
        return "canceled"
    return "none"


def _ceil_ratio(units: int, numerator: int, denominator: int) -> int:
    if units <= 0 or numerator <= 0:
        return 0
    if denominator <= 0 or numerator >= denominator:
        return units
    return -(-units * numerator // denominator)


def _annual_slots_allowed(amount: int, refunded: int, minimum: int) -> int:
    if amount <= 0:
        return minimum
    remaining = max(amount - min(refunded, amount), 0)
    # round half up: floor(12 * remaining / amount + 0.5)
    rounded = (24 * remaining + amount) // (2 * amount)
    return max(min(int(rounded), 12), minimum)


class EventProcessor:
    """Processes verified Stripe events in one PostgreSQL transaction.

    Event claim and all database side effects commit together. A crash rolls both
    back, so Stripe can retry. Database constraints provide the second, business
    idempotency layer for invoice grant slots.
    """

    def __init__(
        self,
        pool: asyncpg.Pool,
        catalog: PlanCatalog,
        product_line: str,
        *,
        expected_livemode: bool = False,
        expected_api_version: str | None = None,
    ) -> None:
        self.pool = pool
        self.catalog = catalog
        self.product_line = product_line
        self.expected_livemode = expected_livemode
        self.expected_api_version = expected_api_version

    async def process(self, event: dict[str, Any]) -> ProcessResult:
        event_id = str(event.get("id") or "")
        event_type = str(event.get("type") or "")
        if not event_id or not event_type:
            raise ValueError("Stripe event requires id and type")
        async with self.pool.acquire() as conn, conn.transaction():
            claimed = await conn.fetchval(
                """insert into stripe_webhook_events(id,event_type,livemode,payload)
                   values($1,$2,$3,$4::jsonb) on conflict do nothing returning id""",
                event_id,
                event_type,
                bool(event.get("livemode")),
                event,
            )
            if claimed is None:
                return ProcessResult("duplicate", "event id already committed")
            if event.get("_remote_verified") is not True:
                mismatch = None
                if bool(event.get("livemode")) != self.expected_livemode:
                    mismatch = "event livemode does not match the configured Stripe key mode"
                elif (
                    self.expected_api_version
                    and event.get("api_version") != self.expected_api_version
                ):
                    mismatch = "event API version does not match the pinned webhook endpoint"
                if mismatch:
                    await self._incident(
                        conn,
                        "webhook_contract_mismatch",
                        event=event,
                        dedupe_key=event_id,
                        detail={
                            "expected_livemode": self.expected_livemode,
                            "expected_api_version": self.expected_api_version,
                            "event_api_version": event.get("api_version"),
                        },
                    )
                    result = ProcessResult("ignored", mismatch)
                    await conn.execute(
                        """update stripe_webhook_events set outcome='ignored',reason=$2,
                               processed_at=now() where id=$1""",
                        event_id,
                        mismatch,
                    )
                    return result
            result = await self._dispatch(conn, event)
            await conn.execute(
                """update stripe_webhook_events
                      set outcome=$2, reason=$3, processed_at=now() where id=$1""",
                event_id,
                result.outcome,
                result.reason,
            )
            logger.info(
                "stripe.webhook.processed",
                extra={
                    "stripe_event_id": event_id,
                    "stripe_event_type": event_type,
                    "outcome": result.outcome,
                    "reason": result.reason,
                    "account_id": result.account_id,
                },
            )
            return result

    async def _dispatch(self, conn: asyncpg.Connection, event: dict[str, Any]) -> ProcessResult:
        event_type = event["type"]
        if event_type == "invoice.paid":
            return await self._invoice_paid(conn, event)
        if event_type == "invoice.payment_failed":
            return await self._payment_failed(conn, event)
        if event_type == "customer.subscription.updated":
            return await self._subscription_updated(conn, event)
        if event_type == "customer.subscription.deleted":
            return await self._subscription_deleted(conn, event)
        if event_type in {"charge.refunded", "charge.dispute.created"}:
            return await self._clawback(conn, event)
        if event_type == "checkout.session.completed":
            return await self._checkout_completed(conn, event)
        if event_type == "checkout.session.expired":
            return await self._checkout_expired(conn, event)
        return ProcessResult("ignored", "event type is outside the reference contract")

    async def _incident(
        self,
        conn: asyncpg.Connection,
        kind: str,
        *,
        event: Mapping[str, Any],
        dedupe_key: str,
        invoice_id: str | None = None,
        account_id: Any = None,
        detail: Mapping[str, Any] | None = None,
    ) -> None:
        await conn.execute(
            """insert into billing_incidents
                     (kind,dedupe_key,stripe_event_id,invoice_id,account_id,detail)
                   values($1,$2,$3,$4,$5::uuid,$6::jsonb)
                   on conflict(kind,dedupe_key) where resolved_at is null do update set
                     stripe_event_id=excluded.stripe_event_id,
                     invoice_id=coalesce(excluded.invoice_id,billing_incidents.invoice_id),
                     account_id=coalesce(excluded.account_id,billing_incidents.account_id),
                     detail=excluded.detail,
                     seen_count=billing_incidents.seen_count+1,
                     last_seen_at=now()""",
            kind,
            dedupe_key,
            event.get("id"),
            invoice_id,
            str(account_id) if account_id else None,
            dict(detail or {}),
        )

    async def _lock_account(
        self,
        conn: asyncpg.Connection,
        obj: Mapping[str, Any],
        *,
        metadata: Mapping[str, Any] | None = None,
    ) -> asyncpg.Record | None:
        metadata = metadata or obj.get("metadata") or {}
        account_uuid = _uuid_or_none(metadata.get("account_id"))
        if account_uuid:
            return await conn.fetchrow(
                "select * from billing_accounts where id=$1 for update", account_uuid
            )
        external_ref = metadata.get("external_ref") or obj.get("client_reference_id")
        if external_ref:
            row = await conn.fetchrow(
                "select * from billing_accounts where external_ref=$1 for update",
                str(external_ref),
            )
            if row is not None:
                return row
        subscription_id = _subscription_id(obj) or _as_id(obj.get("id"))
        if subscription_id:
            row = await conn.fetchrow(
                "select * from billing_accounts where stripe_subscription_id=$1 for update",
                subscription_id,
            )
            if row is not None:
                return row
        customer_id = _as_id(obj.get("customer"))
        if customer_id:
            return await conn.fetchrow(
                "select * from billing_accounts where stripe_customer_id=$1 for update",
                customer_id,
            )
        return None

    @staticmethod
    def _wins(account: Mapping[str, Any], event: Mapping[str, Any]) -> bool:
        if event.get("_remote_verified") is True:
            expected = event.get("_expected_account")
            if not isinstance(expected, Mapping):
                return False
            return bool(
                account["stripe_subscription_id"] == expected.get("stripe_subscription_id")
                and int(account["event_created"]) == int(expected.get("event_created") or 0)
                and int(account["event_rank"]) == int(expected.get("event_rank") or 0)
            )
        return event_wins(
            current_created=int(account["event_created"]),
            current_rank=int(account["event_rank"]),
            event_created=int(event.get("created") or 0),
            event_rank=rank_for(str(event["type"])),
        )

    async def _invoice_paid(
        self, conn: asyncpg.Connection, event: dict[str, Any]
    ) -> ProcessResult:
        invoice = event["data"]["object"]
        invoice_id = str(invoice["id"])
        metadata = _subscription_metadata(invoice)
        account = await self._lock_account(conn, invoice, metadata=metadata)
        if account is None:
            await self._incident(
                conn,
                "paid_unknown_account",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                detail={"customer": _as_id(invoice.get("customer"))},
            )
            return ProcessResult("ignored", "account not found")
        account_id = str(account["id"])
        if metadata.get("product_line") not in {None, self.product_line}:
            return ProcessResult("ignored", "different product line", account_id)
        if invoice.get("billing_reason") not in _PAID_REASONS:
            await self._incident(
                conn,
                "unexpected_billing_reason",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={"billing_reason": invoice.get("billing_reason")},
            )
            return ProcessResult("ignored", "unexpected billing reason", account_id)
        lines = list((invoice.get("lines") or {}).get("data") or [])
        nonzero_prorations = [
            line for line in lines if _line_proration(line) and int(line.get("amount") or 0) != 0
        ]
        grant_lines = [line for line in lines if not _line_proration(line)]
        if len(grant_lines) != 1:
            await self._incident(
                conn,
                "ambiguous_invoice_lines",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={"grant_line_count": len(grant_lines)},
            )
            return ProcessResult("ignored", "invoice must have exactly one grant line", account_id)
        parsed = self.catalog.parse_lookup_key(_line_lookup(grant_lines[0]))
        if parsed is None:
            await self._incident(
                conn,
                "unknown_price",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={"lookup_key": _line_lookup(grant_lines[0])},
            )
            return ProcessResult("ignored", "price lookup key is not in the catalog", account_id)
        plan, interval = parsed
        line = grant_lines[0]
        expected_amount = (
            plan.month_usd if interval == "month" else plan.year_usd
        ) * 100
        invoice_currency = str(invoice.get("currency") or "").lower()
        line_currency = str(line.get("currency") or invoice_currency).lower()
        amount_paid = max(int(invoice.get("amount_paid") or 0), 0)
        invoice_total = int(invoice.get("total") or 0)
        quantity = int(line.get("quantity") or 0)
        if (
            quantity != 1
            or int(line.get("amount") or 0) != expected_amount
            or amount_paid != expected_amount
            or invoice_total != expected_amount
            or invoice_currency != plan.currency
            or line_currency != plan.currency
        ):
            await self._incident(
                conn,
                "invoice_catalog_amount_mismatch",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={
                    "plan": plan.key,
                    "interval": interval,
                    "expected_amount": expected_amount,
                    "quantity": quantity,
                },
            )
            return ProcessResult(
                "ignored", "invoice amount or currency does not match the catalog", account_id
            )
        period = line.get("period") or {}
        period_start = _timestamp(period.get("start"))
        period_end = _timestamp(period.get("end"))
        if period_start is None or period_end is None or period_end <= period_start:
            await self._incident(
                conn,
                "invalid_entitlement_period",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
            )
            return ProcessResult("ignored", "invoice service period is invalid", account_id)
        subscription_id = _subscription_id(invoice)
        existing = await conn.fetchrow(
            """select id,account_id from credit_ledger
                 where stripe_invoice_id=$1 and grant_slot=1""",
            invoice_id,
        )
        if existing is not None:
            if existing["account_id"] != account["id"]:
                await self._incident(
                    conn,
                    "invoice_grant_identity_conflict",
                    event=event,
                    dedupe_key=invoice_id,
                    invoice_id=invoice_id,
                    account_id=account["id"],
                )
                return ProcessResult("ignored", "invoice grant belongs to another account")
            if self._wins(account, event):
                await conn.execute(
                    """update billing_accounts set event_created=$2,event_rank=$3,
                             subscription_status='active',updated_at=now() where id=$1""",
                    account["id"],
                    int(event.get("created") or 0),
                    rank_for(event["type"]),
                )
            return ProcessResult("replayed", "invoice grant slot already exists", account_id)
        transition = None
        billing_reason = invoice.get("billing_reason")
        entitled_sku = (str(account["plan_key"]), account["plan_interval"])
        incoming_sku = (plan.key, interval)
        needs_intent = billing_reason == "subscription_update" or (
            billing_reason == "subscription_cycle" and incoming_sku != entitled_sku
        )
        if billing_reason == "subscription_create":
            claim = await conn.fetchrow(
                """select * from checkout_claims where account_id=$1 for update""",
                account["id"],
            )
            checkout_authorized = bool(
                (subscription_id
                and account["stripe_subscription_id"] == subscription_id)
                or (
                    claim is not None
                    and subscription_id
                    and claim["plan_key"] == plan.key
                    and claim["plan_interval"] == interval
                    and metadata.get("claim_token")
                    and str(claim["claim_token"]) == str(metadata["claim_token"])
                )
            )
            if not checkout_authorized:
                await self._incident(
                    conn,
                    "subscription_create_without_checkout",
                    event=event,
                    dedupe_key=invoice_id,
                    invoice_id=invoice_id,
                    account_id=account["id"],
                )
                return ProcessResult(
                    "ignored", "subscription create lacks a live Checkout claim", account_id
                )
        if needs_intent:
            transition = await conn.fetchrow(
                """select * from billing_plan_changes
                     where account_id=$1 and stripe_subscription_id=$2
                       and target_plan_key=$3 and target_interval=$4
                       and status in (
                         'previewed','applying','scheduled','applied','requires_action'
                       )
                     order by created_at desc limit 1 for update""",
                account["id"],
                subscription_id,
                plan.key,
                interval,
            )
            wrong_mode = bool(
                transition is not None
                and billing_reason == "subscription_update"
                and transition["effective_mode"] != "immediate"
            )
            if transition is None or wrong_mode:
                await self._incident(
                    conn,
                    "paid_plan_change_without_intent",
                    event=event,
                    dedupe_key=invoice_id,
                    invoice_id=invoice_id,
                    account_id=account["id"],
                    detail={"plan": plan.key, "interval": interval},
                )
                return ProcessResult(
                    "ignored", "paid plan change lacks an authenticated intent", account_id
                )
        if nonzero_prorations:
            # Any proration crosses invoice funding lineages. Until the ledger tracks
            # every contributing invoice, a later refund/dispute of the old invoice
            # cannot be attributed safely, regardless of the proration sign.
            await self._incident(
                conn,
                "unsafe_cross_invoice_proration",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={"line_count": len(nonzero_prorations)},
            )
            return ProcessResult("ignored", "cross-invoice proration is unsafe", account_id)
        if (
            account["stripe_subscription_id"] is not None
            and subscription_id != account["stripe_subscription_id"]
        ):
            await self._incident(
                conn,
                "paid_subscription_identity_conflict",
                event=event,
                dedupe_key=f"{account_id}:{invoice_id}",
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={
                    "bound": account["stripe_subscription_id"],
                    "incoming": subscription_id,
                },
            )
            return ProcessResult(
                "ignored", "invoice belongs to a different subscription", account_id
            )
        remote_cas_failed = event.get("_remote_verified") is True and not self._wins(
            account, event
        )
        stale_period = bool(
            account["entitlement_period_end"]
            and period_end <= account["entitlement_period_end"]
        )
        if remote_cas_failed or stale_period:
            await self._incident(
                conn,
                "stale_paid_event",
                event=event,
                dedupe_key=f"{account_id}:{invoice_id}",
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={"applied_created": account["event_created"]},
            )
            return ProcessResult("ignored", "older than the paid entitlement period", account_id)
        amount_total = amount_paid
        if amount_total <= 0:
            await self._incident(
                conn,
                "invoice_without_new_funding",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={"total": invoice.get("total")},
            )
            return ProcessResult("ignored", "paid invoice has no new cash funding", account_id)
        existing_state = await conn.fetchrow(
            "select * from stripe_invoice_state where invoice_id=$1 for update", invoice_id
        )
        if (
            existing_state is not None
            and existing_state["account_id"] is not None
            and existing_state["account_id"] != account["id"]
        ):
            await self._incident(
                conn,
                "invoice_account_identity_conflict",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
            )
            return ProcessResult("ignored", "invoice is owned by another account", account_id)
        await conn.execute(
            """insert into stripe_invoice_state(invoice_id,account_id,amount_total)
                 values($1,$2,$3) on conflict(invoice_id) do update set
                   account_id=coalesce(stripe_invoice_state.account_id,excluded.account_id),
                   amount_total=greatest(stripe_invoice_state.amount_total,excluded.amount_total),
                   updated_at=now()""",
            invoice_id,
            account["id"],
            amount_total,
        )
        state = await conn.fetchrow(
            "select * from stripe_invoice_state where invoice_id=$1 for update", invoice_id
        )
        assert state is not None
        customer_id = _as_id(invoice.get("customer"))
        closed = bool(state["fully_refunded"] or state["disputed"])
        old_balance = int(account["credits_balance"])
        credits = plan.monthly_credits
        if interval == "year":
            funded_allowed = (
                0
                if closed
                else _annual_slots_allowed(
                    int(state["amount_total"]), int(state["amount_refunded"]), 0
                )
            )
            blocked = funded_allowed < 1
            allowed = max(1, funded_allowed)
            annual_anchor = period_start
            annual_issued = 1
            funding_invoice = invoice_id
        else:
            blocked = closed
            allowed = 12
            annual_anchor = None
            annual_issued = 0
            funding_invoice = None
        if blocked:
            await conn.execute(
                """insert into credit_ledger(
                       account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
                       stripe_event_id,stripe_invoice_id,grant_slot)
                     values($1,0,$2,0,'subscription_grant_blocked',$3,$4,$5,1)""",
                account["id"],
                old_balance,
                account["grant_epoch"],
                event["id"],
                invoice_id,
            )
            await conn.execute(
                """update stripe_invoice_state set grant_units_per_slot=$2,grants_issued=1,
                       updated_at=now() where invoice_id=$1""",
                invoice_id,
                credits,
            )
            if transition is not None:
                await conn.execute(
                    """update billing_plan_changes set status='failed',
                           last_error='invoice_funding_closed',completed_at=now(),
                           lease_token=null,lease_expires_at=null,updated_at=now()
                         where id=$1""",
                    transition["id"],
                )
            return ProcessResult(
                "ignored", "invoice funding does not cover an entitlement slot", account_id
            )
        credit_expires_at = period_end
        if interval == "year" and period_start is not None:
            credit_expires_at = await conn.fetchval(
                "select least($1::timestamptz,$2::timestamptz + interval '1 month')",
                period_end,
                period_start,
            )
        new_balance = credits
        new_epoch = int(account["grant_epoch"]) + 1
        projection_wins = self._wins(account, event)
        projected_status = "active" if projection_wins else str(account["subscription_status"])
        projected_created = (
            int(event.get("created") or 0) if projection_wins else int(account["event_created"])
        )
        projected_rank = rank_for(event["type"]) if projection_wins else int(account["event_rank"])
        await conn.execute(
            """update billing_accounts set
                   stripe_customer_id=coalesce(stripe_customer_id,$2),
                   stripe_subscription_id=coalesce($3,stripe_subscription_id),
                   plan_key=$4,plan_interval=$5,subscription_status=$16,
                   entitlement_revoked=false,
                   credits_balance=$6,grant_epoch=$7,event_created=$8,event_rank=$9,
                   current_period_end=$10,entitlement_period_end=$10,credit_expires_at=$15,
                   annual_anchor=$11,annual_grants_issued=$12,
                   annual_grants_allowed=$13,funding_invoice_id=$14,updated_at=now()
                 where id=$1""",
            account["id"],
            customer_id,
            subscription_id,
            plan.key,
            interval,
            new_balance,
            new_epoch,
            projected_created,
            projected_rank,
            period_end,
            annual_anchor,
            annual_issued,
            allowed,
            funding_invoice,
            credit_expires_at,
            projected_status,
        )
        grant = await conn.fetchrow(
            """insert into credit_ledger
                   (account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
                    stripe_event_id,stripe_invoice_id,grant_slot)
                 values($1,$2,$3,$4,$5,$6,$7,$8,1) returning id""",
            account["id"],
            new_balance - old_balance,
            new_balance,
            credits,
            "subscription_grant",
            new_epoch,
            event["id"],
            invoice_id,
        )
        await conn.execute(
            """update stripe_invoice_state set grant_units_per_slot=$2,grants_issued=1,
                   updated_at=now() where invoice_id=$1""",
            invoice_id,
            credits,
        )
        if interval == "month" and int(state["amount_refunded"]) > 0:
            await self._apply_clawback_to_grant(
                conn,
                account_id=account["id"],
                invoice_id=invoice_id,
                grant_id=int(grant["id"]),
                entitlement_units=credits,
                amount=int(state["amount_total"]),
                amount_refunded=int(state["amount_refunded"]),
                full=False,
                reason="refund_clawback",
                event_id=event["id"],
            )
        if transition is None:
            transition = await conn.fetchrow(
                """select * from billing_plan_changes
                     where account_id=$1 and stripe_subscription_id=$2
                       and target_plan_key=$3 and target_interval=$4
                       and status in ('scheduled','applied','requires_action')
                     order by created_at desc limit 1 for update""",
                account["id"],
                subscription_id,
                plan.key,
                interval,
            )
        if transition is not None:
            await conn.execute(
                """update billing_plan_changes set status='completed',completed_at=now(),
                       lease_token=null,lease_expires_at=null,updated_at=now()
                     where id=$1""",
                transition["id"],
            )
        return ProcessResult("handled", account_id=account_id)

    async def _apply_clawback_to_grant(
        self,
        conn: asyncpg.Connection,
        *,
        account_id: Any,
        invoice_id: str,
        grant_id: int,
        entitlement_units: int,
        amount: int,
        amount_refunded: int,
        full: bool,
        reason: str,
        event_id: str,
    ) -> int:
        target = entitlement_units if full else _ceil_ratio(
            entitlement_units, amount_refunded, amount
        )
        already = int(
            await conn.fetchval(
                """select coalesce(sum(-delta),0) from credit_ledger
                     where stripe_invoice_id=$1 and id>$2 and reason=any($3::text[])""",
                invoice_id,
                grant_id,
                list(_CLAWBACK_REASONS),
            )
            or 0
        )
        row = await conn.fetchrow(
            "select credits_balance,grant_epoch from billing_accounts where id=$1 for update",
            account_id,
        )
        assert row is not None
        removed = min(max(target - already, 0), int(row["credits_balance"]))
        if removed:
            balance = int(row["credits_balance"]) - removed
            await conn.execute(
                "update billing_accounts set credits_balance=$2,updated_at=now() where id=$1",
                account_id,
                balance,
            )
            await conn.execute(
                """insert into credit_ledger
                     (account_id,delta,balance_after,reason,grant_epoch,stripe_event_id,
                      stripe_invoice_id)
                   values($1,$2,$3,$4,$5,$6,$7)""",
                account_id,
                -removed,
                balance,
                reason,
                row["grant_epoch"],
                event_id,
                invoice_id,
            )
        return removed

    async def _clawback(
        self, conn: asyncpg.Connection, event: dict[str, Any]
    ) -> ProcessResult:
        raw = event["data"]["object"]
        dispute = event["type"] == "charge.dispute.created"
        charge = raw.get("_resolved_charge") if dispute else raw
        if not isinstance(charge, Mapping):
            charge = raw
        invoice_id = _as_id(raw.get("_resolved_invoice_id")) or _as_id(charge.get("invoice"))
        charge_id = _as_id(charge.get("id")) or str(raw.get("id") or event["id"])
        if not invoice_id:
            await self._incident(
                conn,
                "clawback_without_invoice",
                event=event,
                dedupe_key=charge_id,
                detail={"charge": charge_id},
            )
            return ProcessResult("ignored", "charge cannot be attributed to an invoice")
        customer_id = _as_id(charge.get("customer"))
        account = None
        if customer_id:
            account = await conn.fetchrow(
                "select * from billing_accounts where stripe_customer_id=$1 for update",
                customer_id,
            )
        if account is None:
            known_id = await conn.fetchval(
                "select account_id from stripe_invoice_state where invoice_id=$1", invoice_id
            )
            if known_id:
                account = await conn.fetchrow(
                    "select * from billing_accounts where id=$1 for update", known_id
                )
        amount = max(int(charge.get("amount") or 0), 0)
        amount_refunded = amount if dispute else max(int(charge.get("amount_refunded") or 0), 0)
        full = dispute or bool(charge.get("refunded")) or (amount > 0 and amount_refunded >= amount)
        if account is None:
            await conn.execute(
                """insert into stripe_invoice_state
                       (invoice_id,amount_total,amount_refunded,fully_refunded,disputed)
                     values($1,$2,$3,$4,$5) on conflict(invoice_id) do update set
                       amount_total=greatest(stripe_invoice_state.amount_total,excluded.amount_total),
                       amount_refunded=greatest(stripe_invoice_state.amount_refunded,
                                                excluded.amount_refunded),
                       fully_refunded=stripe_invoice_state.fully_refunded
                                      or excluded.fully_refunded,
                       disputed=stripe_invoice_state.disputed or excluded.disputed,
                       updated_at=now()""",
                invoice_id,
                amount,
                min(amount_refunded, amount) if amount else amount_refunded,
                full,
                dispute,
            )
            await self._incident(
                conn,
                "clawback_unknown_account",
                event=event,
                dedupe_key=f"{customer_id}:{invoice_id}",
                invoice_id=invoice_id,
                detail={"customer": customer_id},
            )
            return ProcessResult("ignored", "account not found; invoice flag retained")
        account_id = str(account["id"])
        await conn.execute(
            """insert into stripe_invoice_state
                   (invoice_id,account_id,amount_total,amount_refunded,fully_refunded,disputed)
                 values($1,$2,$3,$4,$5,$6) on conflict(invoice_id) do update set
                   account_id=coalesce(stripe_invoice_state.account_id,excluded.account_id),
                   amount_total=greatest(stripe_invoice_state.amount_total,excluded.amount_total),
                   amount_refunded=greatest(stripe_invoice_state.amount_refunded,
                                            excluded.amount_refunded),
                   fully_refunded=stripe_invoice_state.fully_refunded or excluded.fully_refunded,
                   disputed=stripe_invoice_state.disputed or excluded.disputed,
                   updated_at=now()""",
            invoice_id,
            account["id"],
            amount,
            min(amount_refunded, amount) if amount else amount_refunded,
            full,
            dispute,
        )
        state = await conn.fetchrow(
            "select * from stripe_invoice_state where invoice_id=$1 for update", invoice_id
        )
        assert state is not None
        grant = await conn.fetchrow(
            """select id,entitlement_units from credit_ledger
                 where stripe_invoice_id=$1 and grant_slot is not null
                 order by id desc limit 1""",
            invoice_id,
        )
        if grant is None:
            return ProcessResult("ignored", "clawback stored before grant", account_id)
        latest_invoice = await conn.fetchval(
            """select stripe_invoice_id from credit_ledger
                 where account_id=$1 and grant_slot is not null order by id desc limit 1""",
            account["id"],
        )
        if latest_invoice != invoice_id and account["funding_invoice_id"] != invoice_id:
            return ProcessResult(
                "ignored",
                "the refunded invoice no longer owns the active pool",
                account_id,
            )
        annual_funding = account["funding_invoice_id"] == invoice_id
        closed = bool(state["fully_refunded"] or state["disputed"])
        if annual_funding and not closed:
            allowed = _annual_slots_allowed(
                int(state["amount_total"]), int(state["amount_refunded"]), 0
            )
            issued = int(account["annual_grants_issued"])
            target = max(issued - allowed, 0) * int(state["grant_units_per_slot"])
            already = int(
                await conn.fetchval(
                    """select coalesce(sum(-delta),0) from credit_ledger
                         where stripe_invoice_id=$1 and reason='annual_refund_overgrant'""",
                    invoice_id,
                )
                or 0
            )
            removed = min(max(target - already, 0), int(account["credits_balance"]))
            if removed:
                balance = int(account["credits_balance"]) - removed
                await conn.execute(
                    """update billing_accounts set credits_balance=$2,updated_at=now()
                         where id=$1""",
                    account["id"],
                    balance,
                )
                await conn.execute(
                    """insert into credit_ledger(
                           account_id,delta,balance_after,reason,grant_epoch,
                           stripe_event_id,stripe_invoice_id)
                         values($1,$2,$3,'annual_refund_overgrant',$4,$5,$6)""",
                    account["id"],
                    -removed,
                    balance,
                    account["grant_epoch"],
                    event["id"],
                    invoice_id,
                )
        else:
            removed = await self._apply_clawback_to_grant(
                conn,
                account_id=account["id"],
                invoice_id=invoice_id,
                grant_id=int(grant["id"]),
                entitlement_units=int(grant["entitlement_units"]),
                amount=int(state["amount_total"]),
                amount_refunded=int(state["amount_refunded"]),
                full=closed,
                reason="dispute_clawback" if dispute else "refund_clawback",
                event_id=event["id"],
            )
        if account["funding_invoice_id"] == invoice_id:
            funded_allowed = (
                int(account["annual_grants_issued"])
                if closed
                else _annual_slots_allowed(
                    int(state["amount_total"]),
                    int(state["amount_refunded"]),
                    0,
                )
            )
            allowed = max(int(account["annual_grants_issued"]), funded_allowed)
            await conn.execute(
                """update billing_accounts set
                     annual_grants_allowed=least(annual_grants_allowed,$2),
                     updated_at=now() where id=$1""",
                account["id"],
                allowed,
            )
        annual_overgrant = bool(
            annual_funding
            and not closed
            and _annual_slots_allowed(
                int(state["amount_total"]), int(state["amount_refunded"]), 0
            )
            < int(account["annual_grants_issued"])
        )
        revoke_entitlement = closed or annual_overgrant
        if revoke_entitlement and not account["entitlement_revoked"]:
            await conn.execute(
                """update billing_accounts set grant_epoch=grant_epoch+1,
                     entitlement_revoked=true,
                     credit_expires_at=least(coalesce(credit_expires_at,now()),now()),
                     updated_at=now() where id=$1""",
                account["id"],
            )
        return ProcessResult("handled", f"removed {removed} credits", account_id)

    async def _payment_failed(
        self, conn: asyncpg.Connection, event: dict[str, Any]
    ) -> ProcessResult:
        invoice = event["data"]["object"]
        account = await self._lock_account(conn, invoice, metadata=_subscription_metadata(invoice))
        if account is None:
            return ProcessResult("ignored", "account not found")
        account_id = str(account["id"])
        subscription_id = _subscription_id(invoice)
        if invoice.get("billing_reason") == "subscription_update" and subscription_id:
            pending = await conn.fetchrow(
                """select * from billing_plan_changes
                     where account_id=$1 and stripe_subscription_id=$2
                       and effective_mode='immediate'
                       and status in ('previewed','applying','applied','requires_action')
                     order by created_at desc limit 1 for update""",
                account["id"],
                subscription_id,
            )
            if pending is not None:
                await conn.execute(
                    """update billing_plan_changes set status='requires_action',updated_at=now()
                         where id=$1""",
                    pending["id"],
                )
                await self._incident(
                    conn,
                    "plan_change_payment_failed",
                    event=event,
                    dedupe_key=str(invoice.get("id") or event["id"]),
                    invoice_id=_as_id(invoice.get("id")),
                    account_id=account["id"],
                    detail={"subscription": subscription_id},
                )
                return ProcessResult(
                    "ignored",
                    "optional plan change payment failed; paid entitlement retained",
                    account_id,
                )
        if not self._wins(account, event):
            return ProcessResult("ignored", "older or weaker than the applied state", account_id)
        await conn.execute(
            """update billing_accounts set subscription_status='past_due',event_created=$2,
                 event_rank=$3,updated_at=now() where id=$1""",
            account["id"],
            int(event.get("created") or 0),
            rank_for(event["type"]),
        )
        return ProcessResult("handled", account_id=account_id)

    def _subscription_plan(self, subscription: Mapping[str, Any]) -> tuple[Plan, str] | None:
        items = list((subscription.get("items") or {}).get("data") or [])
        if len(items) != 1:
            return None
        return self.catalog.parse_lookup_key(_line_lookup(items[0]))

    @staticmethod
    def _subscription_period_end(subscription: Mapping[str, Any]) -> datetime | None:
        items = list((subscription.get("items") or {}).get("data") or [])
        item_end = items[0].get("current_period_end") if len(items) == 1 else None
        return _timestamp(item_end or subscription.get("current_period_end"))

    async def _subscription_updated(
        self, conn: asyncpg.Connection, event: dict[str, Any]
    ) -> ProcessResult:
        subscription = event["data"]["object"]
        account = await self._lock_account(conn, subscription)
        if account is None:
            return ProcessResult("ignored", "account not found")
        account_id = str(account["id"])
        current_sub = account["stripe_subscription_id"]
        incoming_sub = str(subscription["id"])
        if current_sub and current_sub != incoming_sub:
            await self._incident(
                conn,
                "subscription_identity_conflict",
                event=event,
                dedupe_key=f"{account_id}:{incoming_sub}",
                account_id=account["id"],
                detail={"bound": current_sub, "incoming": incoming_sub},
            )
            return ProcessResult("ignored", "a different subscription is already bound", account_id)
        parsed = self._subscription_plan(subscription)
        if parsed is None:
            await self._incident(
                conn,
                "ambiguous_subscription_items",
                event=event,
                dedupe_key=f"{account_id}:{incoming_sub}",
                account_id=account["id"],
            )
            return ProcessResult(
                "ignored", "subscription must contain one catalog item", account_id
            )
        if not self._wins(account, event):
            return ProcessResult("ignored", "older or weaker than the applied state", account_id)
        await conn.execute(
            """update billing_accounts set stripe_customer_id=coalesce(stripe_customer_id,$2),
                 stripe_subscription_id=$3,
                 subscription_status=$4,current_period_end=$5::timestamptz,
                 cancel_at_period_end=$6,
                 pending_free_at=case when $6 then $5::timestamptz else null end,
                 event_created=$7,event_rank=$8,
                 updated_at=now() where id=$1""",
            account["id"],
            _as_id(subscription.get("customer")),
            incoming_sub,
            _project_status(subscription.get("status")),
            self._subscription_period_end(subscription),
            bool(subscription.get("cancel_at_period_end")),
            int(event.get("created") or 0),
            rank_for(event["type"]),
        )
        return ProcessResult("handled", account_id=account_id)

    async def _subscription_deleted(
        self, conn: asyncpg.Connection, event: dict[str, Any]
    ) -> ProcessResult:
        subscription = event["data"]["object"]
        account = await self._lock_account(conn, subscription)
        if account is None:
            return ProcessResult("ignored", "account not found")
        account_id = str(account["id"])
        if account["stripe_subscription_id"] not in {None, subscription.get("id")}:
            return ProcessResult(
                "ignored", "deleted event belongs to an older subscription", account_id
            )
        if not self._wins(account, event):
            return ProcessResult("ignored", "older than the applied state", account_id)
        old_balance = int(account["credits_balance"])
        new_epoch = int(account["grant_epoch"]) + 1
        await conn.execute(
            """update billing_accounts set stripe_subscription_id=null,plan_key='free',
                 plan_interval=null,subscription_status='canceled',credits_balance=0,
                 grant_epoch=$2,event_created=$3,event_rank=$4,current_period_end=null,
                 credit_expires_at=null,entitlement_revoked=true,
                 cancel_at_period_end=false,pending_free_at=null,
                 annual_anchor=null,annual_grants_issued=0,annual_grants_allowed=12,
                 funding_invoice_id=null,updated_at=now() where id=$1""",
            account["id"],
            new_epoch,
            int(event.get("created") or 0),
            rank_for(event["type"]),
        )
        if old_balance:
            await conn.execute(
                """insert into credit_ledger
                     (account_id,delta,balance_after,reason,grant_epoch,stripe_event_id)
                   values($1,$2,0,'subscription_ended',$3,$4)""",
                account["id"],
                -old_balance,
                new_epoch,
                event["id"],
            )
        await conn.execute(
            """update billing_plan_changes set status='failed',last_error='subscription_deleted',
                   lease_token=null,lease_expires_at=null,updated_at=now()
                 where account_id=$1 and status in (
                   'reserved','previewed','applying','scheduled','applied','requires_action'
                 )""",
            account["id"],
        )
        return ProcessResult("handled", account_id=account_id)

    async def _checkout_completed(
        self, conn: asyncpg.Connection, event: dict[str, Any]
    ) -> ProcessResult:
        session = event["data"]["object"]
        account = await self._lock_account(conn, session)
        if account is None:
            return ProcessResult("ignored", "account not found")
        account_id = str(account["id"])
        claim = await conn.fetchrow(
            "select * from checkout_claims where account_id=$1 for update", account["id"]
        )
        session_id = str(session["id"])
        incoming_sub = _as_id(session.get("subscription"))
        metadata = session.get("metadata") or {}
        if not incoming_sub:
            await self._incident(
                conn,
                "checkout_completed_without_subscription",
                event=event,
                dedupe_key=f"{account_id}:{session_id}",
                account_id=account["id"],
            )
            return ProcessResult(
                "ignored", "completed Checkout has no subscription", account_id
            )
        if claim is None:
            if incoming_sub and incoming_sub == account["stripe_subscription_id"]:
                return ProcessResult("replayed", "subscription is already bound", account_id)
            await self._incident(
                conn,
                "checkout_completed_without_claim",
                event=event,
                dedupe_key=f"{account_id}:{session_id}",
                account_id=account["id"],
            )
            return ProcessResult("ignored", "checkout claim is missing", account_id)
        matching_unattached_claim = bool(
            claim["session_id"] is None
            and isinstance(metadata, Mapping)
            and metadata.get("claim_token")
            and str(claim["claim_token"]) == str(metadata["claim_token"])
        )
        if claim["session_id"] != session_id and not matching_unattached_claim:
            await self._incident(
                conn,
                "stale_checkout_completion",
                event=event,
                dedupe_key=f"{account_id}:{session_id}",
                account_id=account["id"],
                detail={"active_session": claim["session_id"]},
            )
            return ProcessResult("ignored", "another checkout owns the active claim", account_id)
        if account["stripe_subscription_id"] not in {None, incoming_sub}:
            await self._incident(
                conn,
                "multiple_subscriptions",
                event=event,
                dedupe_key=f"{account_id}:{incoming_sub}",
                account_id=account["id"],
            )
            return ProcessResult("ignored", "a different subscription is already bound", account_id)
        await conn.execute(
            """update billing_accounts set stripe_customer_id=coalesce(stripe_customer_id,$2),
                 stripe_subscription_id=coalesce($3,stripe_subscription_id),updated_at=now()
                 where id=$1""",
            account["id"],
            _as_id(session.get("customer")),
            incoming_sub,
        )
        await conn.execute(
            """delete from checkout_claims
                 where account_id=$1 and (session_id=$2 or claim_token=$3::uuid)""",
            account["id"],
            session_id,
            claim["claim_token"],
        )
        return ProcessResult("handled", account_id=account_id)

    async def _checkout_expired(
        self, conn: asyncpg.Connection, event: dict[str, Any]
    ) -> ProcessResult:
        session = event["data"]["object"]
        deleted = await conn.fetchval(
            "delete from checkout_claims where session_id=$1 returning account_id",
            str(session["id"]),
        )
        if deleted is None:
            return ProcessResult("ignored", "session no longer owns a claim")
        return ProcessResult("handled", account_id=str(deleted))


__all__ = [
    "EventProcessor",
    "_annual_slots_allowed",
    "_ceil_ratio",
    "_project_status",
]
