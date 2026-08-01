from __future__ import annotations

import logging
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import asyncpg

from .catalog import Plan, PlanCatalog
from .clawbacks import collect_clawback_debts
from .ordering import event_wins, rank_for
from .types import ProcessResult

logger = logging.getLogger("stripe_entitlements.processor")

_PAID_REASONS = {"subscription_create", "subscription_cycle", "subscription_update"}
_CLAWBACK_REASONS = {
    "refund_clawback",
    "dispute_clawback",
    "clawback_debt_collection",
}


@dataclass(frozen=True, slots=True)
class _ProratedDeltaShape:
    source_plan: Plan
    target_plan: Plan
    source_line_id: str
    target_line_id: str
    source_credit_amount: int
    target_charge_amount: int
    amount_paid: int
    currency: str
    period_start: datetime
    period_end: datetime


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


def _has_unsupported_invoice_adjustments(
    invoice: Mapping[str, Any], lines: list[Mapping[str, Any]]
) -> bool:
    balance_fields = (
        "starting_balance",
        "ending_balance",
        "pre_payment_credit_notes_amount",
        "post_payment_credit_notes_amount",
    )
    if any(int(invoice.get(field) or 0) != 0 for field in balance_fields):
        return True
    adjustments = (
        list(invoice.get("total_tax_amounts") or [])
        + list(invoice.get("total_taxes") or [])
        + list(invoice.get("total_discount_amounts") or [])
    )
    for line in lines:
        adjustments.extend(line.get("tax_amounts") or [])
        adjustments.extend(line.get("taxes") or [])
        adjustments.extend(line.get("discount_amounts") or [])
        adjustments.extend(line.get("pretax_credit_amounts") or [])
    return bool(
        invoice.get("discounts")
        or any(
            int(item.get("amount") or 0) != 0 for item in adjustments if isinstance(item, Mapping)
        )
    )


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

    async def _invoice_paid(self, conn: asyncpg.Connection, event: dict[str, Any]) -> ProcessResult:
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
        subscription_id = _subscription_id(invoice)
        billing_reason = invoice.get("billing_reason")
        prorated_transition = None
        if billing_reason == "subscription_update" and subscription_id:
            prorated_transition = await conn.fetchrow(
                """select * from billing_plan_changes
                     where account_id=$1 and stripe_subscription_id=$2
                       and transition_policy='prorated_delta'
                       and (
                         settlement_invoice_id=$3
                         or (
                           settlement_invoice_id is null and effective_mode='immediate'
                           and status in (
                             'applying','applied','requires_action'
                           )
                         )
                       )
                     order by created_at desc limit 1 for update""",
                account["id"],
                subscription_id,
                invoice_id,
            )
        if prorated_transition is not None:
            return await self._invoice_paid_prorated_delta(
                conn,
                event,
                invoice,
                account,
                prorated_transition,
                lines,
            )
        grant_lines = [line for line in lines if not _line_proration(line)]
        if len(grant_lines) != 1:
            await self._incident(
                conn,
                "ambiguous_invoice_lines",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={"grant_line_count": len(grant_lines), "line_count": len(lines)},
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
        expected_amount = (plan.month_usd if interval == "month" else plan.year_usd) * 100
        invoice_currency = str(invoice.get("currency") or "").lower()
        line_currency = str(line.get("currency") or invoice_currency).lower()
        amount_paid = max(int(invoice.get("amount_paid") or 0), 0)
        invoice_total = int(invoice.get("total") or 0)
        quantity = int(line.get("quantity") or 0)
        unsupported_adjustments = _has_unsupported_invoice_adjustments(invoice, lines)
        if (
            quantity != 1
            or int(line.get("amount") or 0) != expected_amount
            or amount_paid != expected_amount
            or invoice_total != expected_amount
            or int(invoice.get("amount_due", invoice_total) or 0) != expected_amount
            or int(invoice.get("subtotal", invoice_total) or 0) != expected_amount
            or invoice_currency != plan.currency
            or line_currency != plan.currency
            or unsupported_adjustments
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
                    "unsupported_adjustments": unsupported_adjustments,
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
                (subscription_id and account["stripe_subscription_id"] == subscription_id)
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
                       and (settlement_invoice_id is null or settlement_invoice_id=$5)
                       and status in (
                         'applying','scheduled','applied','requires_action'
                       )
                     order by created_at desc limit 1 for update""",
                account["id"],
                subscription_id,
                plan.key,
                interval,
                invoice_id,
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
        if len(lines) != 1:
            await self._incident(
                conn,
                "ambiguous_invoice_lines",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={"grant_line_count": len(grant_lines), "line_count": len(lines)},
            )
            return ProcessResult("ignored", "invoice must have exactly one grant line", account_id)
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
        remote_cas_failed = event.get("_remote_verified") is True and not self._wins(account, event)
        stale_period = bool(
            account["entitlement_period_end"] and period_end <= account["entitlement_period_end"]
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
                       closure_applied=true,updated_at=now() where invoice_id=$1""",
                invoice_id,
                credits,
            )
            if transition is not None:
                bound = await conn.fetchval(
                    """update billing_plan_changes set status='failed',
                           settlement_invoice_id=coalesce(settlement_invoice_id,$2),
                           last_error='invoice_funding_closed',completed_at=now(),
                           lease_token=null,lease_expires_at=null,updated_at=now()
                         where id=$1
                           and (settlement_invoice_id is null or settlement_invoice_id=$2)
                         returning id""",
                    transition["id"],
                    invoice_id,
                )
                if bound is None:
                    raise RuntimeError("plan-change settlement Invoice binding changed")
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
                       and (settlement_invoice_id is null or settlement_invoice_id=$5)
                       and status in ('scheduled','applied','requires_action')
                     order by created_at desc limit 1 for update""",
                account["id"],
                subscription_id,
                plan.key,
                interval,
                invoice_id,
            )
        if transition is not None:
            bound = await conn.fetchval(
                """update billing_plan_changes set status='completed',completed_at=now(),
                       settlement_invoice_id=coalesce(settlement_invoice_id,$2),
                       lease_token=null,lease_expires_at=null,updated_at=now()
                     where id=$1
                       and (settlement_invoice_id is null or settlement_invoice_id=$2)
                     returning id""",
                transition["id"],
                invoice_id,
            )
            if bound is None:
                raise RuntimeError("plan-change settlement Invoice binding changed")
            await conn.execute(
                """update billing_incidents set resolved_at=now(),last_seen_at=now()
                     where account_id=$1 and invoice_id=$2 and resolved_at is null
                       and kind in ('plan_change_payment_failed',
                                    'unbound_plan_change_payment_failed')""",
                account["id"],
                invoice_id,
            )
        return ProcessResult("handled", account_id=account_id)

    async def _invoice_paid_prorated_delta(
        self,
        conn: asyncpg.Connection,
        event: dict[str, Any],
        invoice: Mapping[str, Any],
        account: asyncpg.Record,
        transition: asyncpg.Record,
        lines: list[Mapping[str, Any]],
    ) -> ProcessResult:
        invoice_id = str(invoice["id"])
        account_id = str(account["id"])
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
            return ProcessResult("replayed", "invoice grant slot already exists", account_id)

        snapshot_matches = bool(
            account["stripe_subscription_id"] == transition["stripe_subscription_id"]
            and account["plan_key"] == transition["from_plan_key"]
            and account["plan_interval"] == transition["from_interval"]
            and int(account["grant_epoch"]) == int(transition["expected_grant_epoch"])
            and account["entitlement_period_end"] == transition["expected_entitlement_period_end"]
            and not account["entitlement_revoked"]
            and not transition["expected_entitlement_revoked"]
        )
        latest_funding = await self._latest_funding_invoice(
            conn, account["id"], int(account["grant_epoch"])
        )
        if not snapshot_matches or latest_funding != transition["expected_source_invoice_id"]:
            await self._incident(
                conn,
                "stale_prorated_delta_invoice",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={
                    "expected_source_invoice": transition["expected_source_invoice_id"],
                    "observed_source_invoice": latest_funding,
                },
            )
            return ProcessResult(
                "ignored", "entitlement snapshot or funding lineage changed", account_id
            )

        try:
            shape = self._parse_prorated_delta_shape(invoice, transition, lines)
        except ValueError as exc:
            await self._incident(
                conn,
                "invalid_prorated_delta_invoice",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={"reason": str(exc)},
            )
            return ProcessResult("ignored", str(exc), account_id)

        expected_delta = int(transition["expected_credit_delta"] or 0)
        actual_delta = shape.target_plan.monthly_credits - shape.source_plan.monthly_credits
        if expected_delta <= 0 or actual_delta != expected_delta:
            await self._incident(
                conn,
                "prorated_delta_entitlement_mismatch",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={"expected_delta": expected_delta, "actual_delta": actual_delta},
            )
            return ProcessResult("ignored", "entitlement delta does not match intent", account_id)

        state_before = await conn.fetchrow(
            "select * from stripe_invoice_state where invoice_id=$1 for update", invoice_id
        )
        if (
            state_before is not None
            and state_before["account_id"] is not None
            and state_before["account_id"] != account["id"]
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
            shape.amount_paid,
        )
        state = await conn.fetchrow(
            "select * from stripe_invoice_state where invoice_id=$1 for update", invoice_id
        )
        assert state is not None
        closed = bool(state["fully_refunded"] or state["disputed"])
        refund_units = (
            expected_delta
            if closed
            else _ceil_ratio(
                expected_delta,
                int(state["amount_refunded"]),
                int(state["amount_total"]),
            )
        )
        allocation_status = (
            "disputed"
            if state["disputed"]
            else (
                "closed"
                if state["fully_refunded"]
                else ("partially_refunded" if refund_units else "active")
            )
        )
        allocation_id = await conn.fetchval(
            """insert into billing_funding_allocations(
                   account_id,plan_change_id,stripe_invoice_id,source_invoice_id,
                   stripe_event_id,transition_policy,source_plan_key,source_interval,
                   target_plan_key,target_interval,source_line_id,target_line_id,
                   entitlement_delta,refunded_units,source_credit_amount,
                   target_charge_amount,amount_paid,currency,period_start,period_end,
                   grant_epoch,status)
                 values($1,$2,$3,$4,$5,'prorated_delta',$6,'month',$7,'month',
                        $8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
                 on conflict(stripe_invoice_id) do nothing returning id""",
            account["id"],
            transition["id"],
            invoice_id,
            transition["expected_source_invoice_id"],
            event["id"],
            shape.source_plan.key,
            shape.target_plan.key,
            shape.source_line_id,
            shape.target_line_id,
            expected_delta,
            refund_units,
            shape.source_credit_amount,
            shape.target_charge_amount,
            shape.amount_paid,
            shape.currency,
            shape.period_start,
            shape.period_end,
            account["grant_epoch"],
            allocation_status,
        )
        if allocation_id is None:
            await self._incident(
                conn,
                "funding_allocation_conflict",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
            )
            return ProcessResult("ignored", "funding allocation already exists", account_id)

        old_balance = int(account["credits_balance"])
        if closed:
            await conn.execute(
                """insert into credit_ledger(
                       account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
                       stripe_event_id,stripe_invoice_id,grant_slot)
                     values($1,0,$2,0,'upgrade_delta_blocked',$3,$4,$5,1)""",
                account["id"],
                old_balance,
                account["grant_epoch"],
                event["id"],
                invoice_id,
            )
            await conn.execute(
                """update stripe_invoice_state set grant_units_per_slot=$2,
                       grants_issued=1,closure_applied=true,updated_at=now()
                     where invoice_id=$1""",
                invoice_id,
                expected_delta,
            )
            await conn.execute(
                """update billing_plan_changes set status='failed',
                       settlement_invoice_id=$2,last_error='invoice_funding_closed',
                       completed_at=now(),lease_token=null,lease_expires_at=null,
                       updated_at=now() where id=$1""",
                transition["id"],
                invoice_id,
            )
            await self._incident(
                conn,
                "prorated_delta_funding_closed",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
            )
            return ProcessResult(
                "ignored", "upgrade invoice funding was already closed", account_id
            )

        projection_wins = self._wins(account, event)
        new_balance = old_balance + expected_delta
        await conn.execute(
            """update billing_accounts set
                   stripe_customer_id=coalesce(stripe_customer_id,$2),
                   plan_key=$3,plan_interval='month',subscription_status=$4,
                   credits_balance=$5,entitlement_revoked=false,
                   event_created=$6,event_rank=$7,updated_at=now()
                 where id=$1""",
            account["id"],
            _as_id(invoice.get("customer")),
            shape.target_plan.key,
            "active" if projection_wins else account["subscription_status"],
            new_balance,
            int(event.get("created") or 0) if projection_wins else int(account["event_created"]),
            rank_for(event["type"]) if projection_wins else int(account["event_rank"]),
        )
        grant = await conn.fetchrow(
            """insert into credit_ledger(
                   account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
                   stripe_event_id,stripe_invoice_id,grant_slot)
                 values($1,$2,$3,$2,'upgrade_delta_grant',$4,$5,$6,1)
                 returning id""",
            account["id"],
            expected_delta,
            new_balance,
            account["grant_epoch"],
            event["id"],
            invoice_id,
        )
        await conn.execute(
            """update stripe_invoice_state set grant_units_per_slot=$2,
                   grants_issued=1,updated_at=now() where invoice_id=$1""",
            invoice_id,
            expected_delta,
        )
        await collect_clawback_debts(
            conn,
            account_id=account["id"],
            grant_epoch=int(account["grant_epoch"]),
            event_id=str(event["id"]),
        )
        if refund_units:
            assert grant is not None
            await self._apply_clawback_to_grant(
                conn,
                account_id=account["id"],
                invoice_id=invoice_id,
                grant_id=int(grant["id"]),
                entitlement_units=expected_delta,
                amount=int(state["amount_total"]),
                amount_refunded=int(state["amount_refunded"]),
                full=False,
                reason="refund_clawback",
                event_id=event["id"],
            )
        await conn.execute(
            """update billing_plan_changes set status='completed',
                   settlement_invoice_id=$2,completed_at=now(),lease_token=null,
                   lease_expires_at=null,updated_at=now() where id=$1""",
            transition["id"],
            invoice_id,
        )
        await conn.execute(
            """update billing_incidents set resolved_at=now(),last_seen_at=now()
                 where account_id=$1 and invoice_id=$2 and resolved_at is null
                   and kind in ('plan_change_payment_failed',
                                'unbound_plan_change_payment_failed')""",
            account["id"],
            invoice_id,
        )
        return ProcessResult("handled", account_id=account_id)

    def _parse_prorated_delta_shape(
        self,
        invoice: Mapping[str, Any],
        transition: Mapping[str, Any],
        lines: list[Mapping[str, Any]],
    ) -> _ProratedDeltaShape:
        container = invoice.get("lines") or {}
        if isinstance(container, Mapping) and container.get("has_more"):
            raise ValueError("Invoice line pagination was not completed")
        if len(lines) != 2:
            raise ValueError("prorated delta requires exactly two Invoice lines")
        source_line: Mapping[str, Any] | None = None
        target_line: Mapping[str, Any] | None = None
        source_plan: Plan | None = None
        target_plan: Plan | None = None
        for line in lines:
            if not _line_proration(line):
                raise ValueError("both prorated delta lines must be prorations")
            if int(line.get("quantity") or 0) != 1 or not line.get("id"):
                raise ValueError("prorated delta lines require identity and quantity one")
            parsed = self.catalog.parse_lookup_key(_line_lookup(line))
            if parsed is None:
                raise ValueError("every prorated delta line must use a catalog Price")
            plan, interval = parsed
            if interval != "month":
                raise ValueError("prorated delta is supported only for monthly Prices")
            if plan.key == transition["from_plan_key"]:
                if source_line is not None:
                    raise ValueError("multiple source Price lines are ambiguous")
                source_line, source_plan = line, plan
            elif plan.key == transition["target_plan_key"]:
                if target_line is not None:
                    raise ValueError("multiple target Price lines are ambiguous")
                target_line, target_plan = line, plan
            else:
                raise ValueError("Invoice contains a Price outside the authorized transition")
        if source_line is None or target_line is None or source_plan is None or target_plan is None:
            raise ValueError("Invoice is missing the authorized source or target Price line")
        if (
            transition["from_interval"] != "month"
            or transition["target_interval"] != "month"
            or target_plan.rank <= source_plan.rank
        ):
            raise ValueError("intent is not a supported monthly tier upgrade")
        source_amount = int(source_line.get("amount") or 0)
        target_amount = int(target_line.get("amount") or 0)
        if source_amount >= 0 or target_amount <= 0 or target_amount <= -source_amount:
            raise ValueError("Invoice does not contain a positive net upgrade difference")
        source_catalog_amount = source_plan.month_usd * 100
        target_catalog_amount = target_plan.month_usd * 100
        ratio_error = abs(
            (-source_amount * target_catalog_amount) - (target_amount * source_catalog_amount)
        )
        if ratio_error > max(source_catalog_amount, target_catalog_amount):
            raise ValueError("source and target prorations use inconsistent period fractions")
        invoice_currency = str(invoice.get("currency") or "").lower()
        if not invoice_currency or source_plan.currency != target_plan.currency:
            raise ValueError("source and target Prices must use one currency")
        if (
            any(
                str(line.get("currency") or invoice_currency).lower() != invoice_currency
                for line in lines
            )
            or invoice_currency != target_plan.currency
        ):
            raise ValueError("Invoice and line currencies do not match the catalog")
        total = int(invoice.get("total") or 0)
        amount_paid = int(invoice.get("amount_paid") or 0)
        amount_due = int(invoice.get("amount_due", total) or 0)
        subtotal = int(invoice.get("subtotal", total) or 0)
        if (
            amount_paid <= 0
            or total != amount_paid
            or amount_due != amount_paid
            or subtotal != total
            or source_amount + target_amount != total
        ):
            raise ValueError("Invoice net total must be fully paid by new cash")
        if _has_unsupported_invoice_adjustments(invoice, lines):
            raise ValueError("balance, credit notes, taxes and discounts are not supported")
        source_period = source_line.get("period") or {}
        target_period = target_line.get("period") or {}
        if source_period != target_period:
            raise ValueError("source and target proration periods must match")
        period_start = _timestamp(target_period.get("start"))
        period_end = _timestamp(target_period.get("end"))
        if period_start is None or period_end is None or period_end <= period_start:
            raise ValueError("proration service period is invalid")
        proration_date = transition.get("proration_date")
        if proration_date is None or int(period_start.timestamp()) != int(proration_date):
            raise ValueError("Invoice proration date differs from the durable preview")
        if period_end != transition["expected_entitlement_period_end"]:
            raise ValueError("Invoice period end differs from the funded entitlement period")
        preview_facts = (
            transition.get("estimated_source_proration"),
            transition.get("estimated_target_proration"),
            transition.get("estimated_amount_due"),
            transition.get("estimated_period_start"),
            transition.get("estimated_period_end"),
            transition.get("estimate_currency"),
        )
        if any(value is None for value in preview_facts):
            raise ValueError("durable prorated preview facts are incomplete")
        if (
            int(transition["estimated_source_proration"]) != -source_amount
            or int(transition["estimated_target_proration"]) != target_amount
            or int(transition["estimated_amount_due"]) != amount_paid
            or transition["estimated_period_start"] != period_start
            or transition["estimated_period_end"] != period_end
            or str(transition["estimate_currency"]).lower() != invoice_currency
        ):
            raise ValueError("paid Invoice differs from the durable prorated preview")
        return _ProratedDeltaShape(
            source_plan,
            target_plan,
            str(source_line["id"]),
            str(target_line["id"]),
            -source_amount,
            target_amount,
            amount_paid,
            invoice_currency,
            period_start,
            period_end,
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
        target = (
            entitlement_units if full else _ceil_ratio(entitlement_units, amount_refunded, amount)
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
        if target:
            await conn.execute(
                """insert into billing_clawback_debts(
                       account_id,grant_epoch,stripe_invoice_id,
                       target_units,collected_units)
                     values($1,$2,$3,$4,$5)
                     on conflict(account_id,grant_epoch,stripe_invoice_id) do update set
                       target_units=greatest(
                         billing_clawback_debts.target_units,excluded.target_units
                       ),
                       collected_units=greatest(
                         billing_clawback_debts.collected_units,excluded.collected_units
                       ),
                       updated_at=now()""",
                account_id,
                row["grant_epoch"],
                invoice_id,
                target,
                min(target, already + removed),
            )
        return removed

    async def _clawback(self, conn: asyncpg.Connection, event: dict[str, Any]) -> ProcessResult:
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
        known_state = await conn.fetchrow(
            "select account_id from stripe_invoice_state where invoice_id=$1 for update",
            invoice_id,
        )
        if (
            known_state is not None
            and known_state["account_id"] is not None
            and known_state["account_id"] != account["id"]
        ):
            await self._incident(
                conn,
                "clawback_invoice_identity_conflict",
                event=event,
                dedupe_key=f"{account_id}:{invoice_id}",
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={"invoice_account_id": str(known_state["account_id"])},
            )
            return ProcessResult("ignored", "invoice belongs to a different account", account_id)
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
        if state["account_id"] is not None and state["account_id"] != account["id"]:
            await self._incident(
                conn,
                "clawback_invoice_identity_conflict",
                event=event,
                dedupe_key=f"{account_id}:{invoice_id}",
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={"invoice_account_id": str(state["account_id"])},
            )
            return ProcessResult("ignored", "invoice belongs to a different account", account_id)
        closed = bool(state["fully_refunded"] or state["disputed"])
        if closed and state["closure_applied"]:
            return ProcessResult("replayed", "invoice closure was already applied", account_id)
        grant = await conn.fetchrow(
            """select id,account_id,entitlement_units,grant_epoch,reason from credit_ledger
                 where stripe_invoice_id=$1 and grant_slot is not null
                 order by id desc limit 1""",
            invoice_id,
        )
        if grant is None:
            return ProcessResult("ignored", "clawback stored before grant", account_id)
        if grant["account_id"] != account["id"]:
            await self._incident(
                conn,
                "clawback_grant_identity_conflict",
                event=event,
                dedupe_key=f"{account_id}:{invoice_id}",
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={"grant_account_id": str(grant["account_id"])},
            )
            return ProcessResult(
                "ignored", "invoice grant belongs to a different account", account_id
            )
        allocation = await conn.fetchrow(
            """select * from billing_funding_allocations
                 where stripe_invoice_id=$1 for update""",
            invoice_id,
        )
        allocation_already_closed = False
        if allocation is not None:
            if allocation["account_id"] != account["id"]:
                await self._incident(
                    conn,
                    "clawback_allocation_identity_conflict",
                    event=event,
                    dedupe_key=f"{account_id}:{invoice_id}",
                    invoice_id=invoice_id,
                    account_id=account["id"],
                    detail={"allocation_account_id": str(allocation["account_id"])},
                )
                return ProcessResult(
                    "ignored", "funding allocation belongs to a different account", account_id
                )
            allocation_already_closed = allocation["status"] in {"closed", "disputed"}
            refunded_units = (
                int(allocation["entitlement_delta"])
                if closed
                else _ceil_ratio(
                    int(allocation["entitlement_delta"]),
                    int(state["amount_refunded"]),
                    int(state["amount_total"]),
                )
            )
            allocation_status = (
                "disputed"
                if state["disputed"]
                else (
                    "closed"
                    if state["fully_refunded"]
                    else ("partially_refunded" if refunded_units else "active")
                )
            )
            await conn.execute(
                """update billing_funding_allocations set
                       refunded_units=greatest(refunded_units,$2),status=$3,
                       updated_at=now() where id=$1""",
                allocation["id"],
                refunded_units,
                allocation_status,
            )
            # A second Event ID can carry the same cumulative full refund/dispute.
            # The first closure and its epoch transition committed atomically, so
            # replaying the clawback would incorrectly recreate any old-epoch debt
            # in the account's new epoch. Keep the monotonic Invoice/allocation facts
            # above, then stop before touching the current credit pool.
            if closed and allocation_already_closed:
                return ProcessResult("replayed", "clawback was already applied", account_id)
        active_lineage = await self._invoice_in_active_lineage(
            conn,
            account["id"],
            int(account["grant_epoch"]),
            invoice_id,
        )
        if (
            int(grant["grant_epoch"]) != int(account["grant_epoch"])
            and account["funding_invoice_id"] != invoice_id
            and not active_lineage
        ):
            return ProcessResult(
                "ignored",
                "the refunded invoice belongs to an older entitlement epoch",
                account_id,
            )
        annual_funding = account["funding_invoice_id"] == invoice_id
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
        downstream = 0
        leaf_delta_revert = False
        if allocation is not None:
            if closed:
                downstream = int(
                    await conn.fetchval(
                        """select count(*) from billing_funding_allocations
                             where account_id=$1
                               and source_invoice_id=$2 and stripe_invoice_id<>$2""",
                        account["id"],
                        invoice_id,
                    )
                    or 0
                )
                leaf_delta_revert = bool(
                    downstream == 0
                    and account["plan_key"] == allocation["target_plan_key"]
                    and account["plan_interval"] == allocation["target_interval"]
                    and int(account["grant_epoch"]) == int(allocation["grant_epoch"])
                )
                if leaf_delta_revert:
                    new_epoch = int(account["grant_epoch"]) + 1
                    current_balance = int(
                        await conn.fetchval(
                            "select credits_balance from billing_accounts where id=$1",
                            account["id"],
                        )
                        or 0
                    )
                    await conn.execute(
                        """update billing_accounts set plan_key=$2,plan_interval=$3,
                               grant_epoch=$4,entitlement_revoked=false,updated_at=now()
                             where id=$1""",
                        account["id"],
                        allocation["source_plan_key"],
                        allocation["source_interval"],
                        new_epoch,
                    )
                    await conn.execute(
                        """update billing_funding_allocations set grant_epoch=$2,
                               updated_at=now() where id=$1""",
                        allocation["id"],
                        new_epoch,
                    )
                    await conn.execute(
                        """insert into credit_ledger(
                               account_id,delta,balance_after,entitlement_units,reason,
                               grant_epoch,stripe_event_id,stripe_invoice_id)
                             values($1,0,$2,0,'upgrade_funding_reverted',$3,$4,$5)""",
                        account["id"],
                        current_balance,
                        new_epoch,
                        event["id"],
                        invoice_id,
                    )
                    await conn.execute(
                        """update billing_plan_changes set status='failed',
                               last_error='settlement_funding_closed',updated_at=now()
                             where id=$1""",
                        allocation["plan_change_id"],
                    )
                    await self._incident(
                        conn,
                        "upgrade_funding_closed_reverted",
                        event=event,
                        dedupe_key=invoice_id,
                        invoice_id=invoice_id,
                        account_id=account["id"],
                        detail={
                            "reverted_to": allocation["source_plan_key"],
                            "disputed": bool(state["disputed"]),
                        },
                    )
        if closed and downstream == 0:
            downstream = int(
                await conn.fetchval(
                    """select count(*) from billing_funding_allocations
                         where account_id=$1
                           and source_invoice_id=$2 and stripe_invoice_id<>$2""",
                    account["id"],
                    invoice_id,
                )
                or 0
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
            and _annual_slots_allowed(int(state["amount_total"]), int(state["amount_refunded"]), 0)
            < int(account["annual_grants_issued"])
        )
        revoke_entitlement = (closed and not leaf_delta_revert) or annual_overgrant
        if revoke_entitlement and not account["entitlement_revoked"]:
            await conn.execute(
                """update billing_accounts set grant_epoch=grant_epoch+1,
                     entitlement_revoked=true,
                     credit_expires_at=least(coalesce(credit_expires_at,now()),now()),
                     updated_at=now() where id=$1""",
                account["id"],
            )
            if downstream:
                await self._incident(
                    conn,
                    "funding_lineage_closed",
                    event=event,
                    dedupe_key=f"{invoice_id}:{grant['grant_epoch']}",
                    invoice_id=invoice_id,
                    account_id=account["id"],
                    detail={"downstream_allocations": downstream},
                )
        if closed:
            await conn.execute(
                """update stripe_invoice_state set closure_applied=true,updated_at=now()
                     where invoice_id=$1""",
                invoice_id,
            )
        return ProcessResult("handled", f"removed {removed} credits", account_id)

    @staticmethod
    async def _invoice_in_active_lineage(
        conn: asyncpg.Connection,
        account_id: Any,
        grant_epoch: int,
        invoice_id: str,
    ) -> bool:
        return bool(
            await conn.fetchval(
                """with recursive funding_chain as (
                       select stripe_invoice_id,source_invoice_id
                         from billing_funding_allocations
                        where account_id=$1 and grant_epoch=$2
                       union
                       select parent.stripe_invoice_id,parent.source_invoice_id
                         from billing_funding_allocations parent
                         join funding_chain child
                           on parent.stripe_invoice_id=child.source_invoice_id
                        where parent.account_id=$1
                     )
                     select exists(
                       select 1 from funding_chain
                        where stripe_invoice_id=$3 or source_invoice_id=$3
                     )""",
                account_id,
                grant_epoch,
                invoice_id,
            )
        )

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
            invoice_id = _as_id(invoice.get("id"))
            pending = await conn.fetchrow(
                """select * from billing_plan_changes
                     where account_id=$1 and stripe_subscription_id=$2
                       and settlement_invoice_id=$3
                       and effective_mode='immediate'
                       and status in ('applying','applied','requires_action')
                     order by created_at desc limit 1 for update""",
                account["id"],
                subscription_id,
                invoice_id,
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
            unbound = await conn.fetchrow(
                """select id from billing_plan_changes
                     where account_id=$1 and stripe_subscription_id=$2
                       and effective_mode='immediate'
                       and status in ('applying','applied','requires_action')
                     order by created_at desc limit 1 for update""",
                account["id"],
                subscription_id,
            )
            await self._incident(
                conn,
                "unbound_plan_change_payment_failed",
                event=event,
                dedupe_key=str(invoice_id or event["id"]),
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={
                    "subscription": subscription_id,
                    "pending_change_id": str(unbound["id"]) if unbound is not None else None,
                },
            )
            return ProcessResult(
                "ignored",
                "subscription-update failure is not bound to the current plan change",
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
            return ProcessResult("ignored", "completed Checkout has no subscription", account_id)
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
