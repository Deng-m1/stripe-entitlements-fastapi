from __future__ import annotations

import logging
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import asyncpg

from .bounds import POSTGRES_BIGINT_MAX
from .catalog import Plan, PlanCatalog
from .clawbacks import collect_clawback_debts
from .event_audit import redacted_event_snapshot
from .invoice_policy import (
    has_unsupported_invoice_adjustments,
    has_unsupported_invoice_payment_shape,
)
from .ordering import event_wins, rank_for
from .price_policy import catalog_price_matches
from .types import ProcessResult

logger = logging.getLogger("stripe_entitlements.processor")

_PAID_REASONS = {"subscription_create", "subscription_cycle", "subscription_update"}
_CLAWBACK_REASONS = {
    "refund_clawback",
    "dispute_clawback",
    "clawback_debt_collection",
}
_SUBSCRIPTION_STATUSES = {
    "active",
    "canceled",
    "incomplete",
    "incomplete_expired",
    "past_due",
    "paused",
    "trialing",
    "unpaid",
}
_SUPPORTED_EVENT_TYPES = {
    "checkout.session.completed",
    "checkout.session.expired",
    "invoice.paid",
    "invoice.payment_failed",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "charge.refunded",
    "charge.dispute.created",
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
    candidate = value.get("id") if isinstance(value, Mapping) else value
    if (
        not isinstance(candidate, str)
        or not candidate
        or candidate != candidate.strip()
        or len(candidate.encode("utf-8")) > 512
        or any(not character.isprintable() for character in candidate)
    ):
        return None
    return candidate


def _uuid_or_none(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value else None
    except (ValueError, TypeError, AttributeError):
        return None


def _subscription_id(obj: Mapping[str, Any]) -> str | None:
    direct = _as_id(obj.get("subscription"))
    if direct:
        return direct
    parent = obj.get("parent")
    if not isinstance(parent, Mapping):
        return None
    details = parent.get("subscription_details")
    return _as_id(details.get("subscription")) if isinstance(details, Mapping) else None


def _subscription_metadata(obj: Mapping[str, Any]) -> Mapping[str, Any]:
    parent = obj.get("parent")
    if isinstance(parent, Mapping):
        details = parent.get("subscription_details")
        if isinstance(details, Mapping):
            metadata = details.get("metadata")
            if isinstance(metadata, Mapping) and metadata:
                return metadata
    legacy = obj.get("subscription_details")
    if isinstance(legacy, Mapping):
        metadata = legacy.get("metadata")
        if isinstance(metadata, Mapping) and metadata:
            return metadata
    metadata = obj.get("metadata")
    return metadata if isinstance(metadata, Mapping) else {}


def _line_lookup(line: Mapping[str, Any]) -> str | None:
    if value := line.get("_resolved_lookup_key"):
        return str(value)
    price = line.get("price")
    if isinstance(price, Mapping) and price.get("lookup_key"):
        return str(price["lookup_key"])
    pricing = line.get("pricing")
    details = pricing.get("price_details") if isinstance(pricing, Mapping) else None
    if isinstance(details, Mapping) and details.get("lookup_key"):
        return str(details["lookup_key"])
    return None


def _line_price_id(line: Mapping[str, Any]) -> str | None:
    price_id = _as_id(line.get("price"))
    if price_id:
        return price_id
    pricing = line.get("pricing")
    details = pricing.get("price_details") if isinstance(pricing, Mapping) else None
    return _as_id(details.get("price")) if isinstance(details, Mapping) else None


def _line_proration(line: Mapping[str, Any]) -> bool:
    if line.get("proration"):
        return True
    parent = line.get("parent")
    if not isinstance(parent, Mapping):
        return False
    details = parent.get("subscription_item_details")
    return bool(details.get("proration")) if isinstance(details, Mapping) else False


def _stripe_integer(value: Any) -> int | None:
    return value if type(value) is int else None


def _timestamp(value: Any) -> datetime | None:
    if type(value) is not int:
        return None
    try:
        return datetime.fromtimestamp(value, tz=UTC)
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _valid_event_identifier(value: Any, *, max_bytes: int) -> bool:
    return bool(
        isinstance(value, str)
        and value
        and value == value.strip()
        and len(value.encode("utf-8")) <= max_bytes
        and all(character.isprintable() for character in value)
    )


def _event_shape_error(event: Mapping[str, Any]) -> str | None:
    event_id = event.get("id")
    if not _valid_event_identifier(event_id, max_bytes=512):
        return "Stripe Event requires a stable visible string id"
    event_type = event.get("type")
    if not _valid_event_identifier(event_type, max_bytes=255):
        return "Stripe Event requires a stable visible string type"
    if event_type not in _SUPPORTED_EVENT_TYPES:
        return None
    created = event.get("created")
    if type(created) is not int or created < 0 or created > POSTGRES_BIGINT_MAX:
        return "supported Stripe Event requires a PostgreSQL-bigint created timestamp"
    if not isinstance(event.get("livemode"), bool):
        return "supported Stripe Event requires a boolean livemode value"
    data = event.get("data")
    if not isinstance(data, Mapping):
        return "supported Stripe Event requires a data object"
    obj = data.get("object")
    if not isinstance(obj, Mapping):
        return "supported Stripe Event requires data.object to be an object"
    object_id = obj.get("id")
    if not isinstance(object_id, str) or not object_id:
        return "supported Stripe Event object requires a stable string id"
    return None


def _project_status(status: str | None) -> str:
    if status in {"active", "trialing"}:
        return "active"
    if status in {"past_due", "unpaid", "paused"}:
        return "past_due"
    if status in {"canceled", "incomplete_expired"}:
        return "canceled"
    return "none"


def _projection_order(account: Mapping[str, Any], event: Mapping[str, Any]) -> tuple[int, int]:
    """Advance, but never rewind, the account-global Event ordering cursor."""
    current = (int(account["event_created"]), int(account["event_rank"]))
    incoming = (int(event.get("created") or 0), rank_for(str(event["type"])))
    return max(current, incoming)


def _ordering_tie(account: Mapping[str, Any], event: Mapping[str, Any]) -> bool:
    if event.get("_remote_verified") is True:
        return False
    current = (int(account["event_created"]), int(account["event_rank"]))
    incoming = (int(event.get("created") or 0), rank_for(str(event["type"])))
    return current == incoming


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

    async def has_committed_event(self, event_id: object) -> bool:
        if not _valid_event_identifier(event_id, max_bytes=512):
            return False
        assert isinstance(event_id, str)
        async with self.pool.acquire() as conn:
            return bool(
                await conn.fetchval(
                    "select exists(select 1 from stripe_webhook_events where id=$1)",
                    event_id,
                )
            )

    def _catalog_line_matches(self, line: Mapping[str, Any], plan: Plan, interval: str) -> bool:
        resolved_price = line.get("_resolved_price")
        price_id = _line_price_id(line)
        if not isinstance(resolved_price, Mapping) or not price_id:
            return False
        expected_amount = (plan.month_usd if interval == "month" else plan.year_usd) * 100
        return catalog_price_matches(
            resolved_price,
            expected_currency=plan.currency,
            expected_unit_amount=expected_amount,
            expected_interval=interval,
            expected_product_line=self.product_line,
            expected_plan_key=plan.key,
            expected_lookup_key=self.catalog.lookup_key(plan.key, interval),
            expected_price_id=price_id,
            require_active=False,
        )

    async def process(self, event: dict[str, Any]) -> ProcessResult:
        raw_event_id = event.get("id")
        if not _valid_event_identifier(raw_event_id, max_bytes=512):
            reason = "Stripe Event requires a stable visible string id"
            logger.warning("stripe.webhook.invalid_identity", extra={"reason": reason})
            return ProcessResult("ignored", reason)
        raw_event_type = event.get("type")
        if not _valid_event_identifier(raw_event_type, max_bytes=255):
            reason = "Stripe Event requires a stable visible string type"
            logger.warning(
                "stripe.webhook.invalid_identity",
                extra={"stripe_event_id": raw_event_id, "reason": reason},
            )
            return ProcessResult("ignored", reason)
        assert isinstance(raw_event_id, str)
        assert isinstance(raw_event_type, str)
        event_id = raw_event_id
        event_type = raw_event_type
        audit_payload = redacted_event_snapshot(event)
        async with self.pool.acquire() as conn, conn.transaction():
            claimed = await conn.fetchval(
                """insert into stripe_webhook_events(id,event_type,livemode,payload)
                     values($1,$2,$3,$4::jsonb)
                     on conflict do nothing returning id""",
                event_id,
                event_type,
                event.get("livemode") if isinstance(event.get("livemode"), bool) else False,
                audit_payload,
            )
            if claimed is None:
                return ProcessResult("duplicate", "event id already committed")
            shape_error = _event_shape_error(event)
            if shape_error:
                await self._incident(
                    conn,
                    "invalid_event_shape",
                    event=event,
                    dedupe_key=event_id,
                    detail={"event_type": event_type, "reason": shape_error},
                )
                await conn.execute(
                    """update stripe_webhook_events set outcome='ignored',reason=$2,
                           processed_at=now() where id=$1""",
                    event_id,
                    shape_error,
                )
                return ProcessResult("ignored", shape_error)
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
        candidate_metadata = metadata if metadata is not None else obj.get("metadata")
        safe_metadata = candidate_metadata if isinstance(candidate_metadata, Mapping) else {}
        account_uuid = _uuid_or_none(safe_metadata.get("account_id"))
        if account_uuid:
            return await conn.fetchrow(
                "select * from billing_accounts where id=$1 for update", account_uuid
            )
        external_ref = safe_metadata.get("external_ref") or obj.get("client_reference_id")
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
        customer_id = _as_id(invoice.get("customer"))
        if customer_id is None or (
            account["stripe_customer_id"] is not None
            and str(account["stripe_customer_id"]) != customer_id
        ):
            await self._incident(
                conn,
                "paid_customer_identity_conflict",
                event=event,
                dedupe_key=f"{account_id}:{invoice_id}",
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={
                    "bound": account["stripe_customer_id"],
                    "incoming": customer_id,
                },
            )
            return ProcessResult(
                "ignored", "invoice customer identity is missing or conflicting", account_id
            )
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
        if invoice.get(
            "_unsupported_invoice_payment_shape"
        ) is True or has_unsupported_invoice_payment_shape(invoice):
            await self._incident(
                conn,
                "unsupported_invoice_payment_shape",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
            )
            return ProcessResult(
                "ignored",
                "Invoice payment collection is outside the single-payment model",
                account_id,
            )
        preparation_error = invoice.get("_preparation_error")
        if preparation_error is not None:
            detail = (
                preparation_error[:500]
                if isinstance(preparation_error, str)
                else "invalid preparation error marker"
            )
            await self._incident(
                conn,
                "invoice_preparation_failed",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={"reason": detail},
            )
            return ProcessResult("ignored", "Invoice could not be materialized safely", account_id)
        lines_container = invoice.get("lines") or {}
        if not isinstance(lines_container, Mapping) or lines_container.get("has_more"):
            await self._incident(
                conn,
                "incomplete_invoice_lines",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
            )
            return ProcessResult("ignored", "Invoice line pagination is incomplete", account_id)
        raw_lines = lines_container.get("data")
        if not isinstance(raw_lines, list) or any(
            not isinstance(line, Mapping) for line in raw_lines
        ):
            await self._incident(
                conn,
                "invalid_invoice_line_shape",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
            )
            return ProcessResult("ignored", "Invoice lines must be an array of objects", account_id)
        lines = list(raw_lines)
        line_ids = [_as_id(line.get("id")) for line in lines]
        if any(line_id is None for line_id in line_ids) or len(set(line_ids)) != len(line_ids):
            await self._incident(
                conn,
                "invalid_invoice_line_shape",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={"reason": "line ids must be stable and unique"},
            )
            return ProcessResult(
                "ignored", "Invoice lines require stable unique identities", account_id
            )
        line_amounts = [_stripe_integer(line.get("amount")) for line in lines]
        if any(amount is None for amount in line_amounts):
            await self._incident(
                conn,
                "invalid_invoice_line_shape",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={"reason": "line amount must be an integer"},
            )
            return ProcessResult("ignored", "Invoice line amounts must be integers", account_id)
        nonzero_prorations = [
            line
            for line, amount in zip(lines, line_amounts, strict=True)
            if _line_proration(line) and amount != 0
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
        if not self._catalog_line_matches(line, plan, interval):
            await self._incident(
                conn,
                "invoice_price_identity_mismatch",
                event=event,
                dedupe_key=invoice_id,
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={
                    "lookup_key": _line_lookup(line),
                    "price_id": _line_price_id(line),
                    "plan": plan.key,
                    "interval": interval,
                },
            )
            return ProcessResult(
                "ignored",
                "Invoice Price or Product identity does not match the catalog",
                account_id,
            )
        expected_amount = (plan.month_usd if interval == "month" else plan.year_usd) * 100
        invoice_currency = str(invoice.get("currency") or "").lower()
        line_currency = str(line.get("currency") or invoice_currency).lower()
        amount_paid = _stripe_integer(invoice.get("amount_paid"))
        invoice_total = _stripe_integer(invoice.get("total"))
        amount_due = (
            invoice_total
            if "amount_due" not in invoice
            else _stripe_integer(invoice.get("amount_due"))
        )
        subtotal = (
            invoice_total if "subtotal" not in invoice else _stripe_integer(invoice.get("subtotal"))
        )
        quantity = _stripe_integer(line.get("quantity"))
        line_amount = _stripe_integer(line.get("amount"))
        unsupported_adjustments = has_unsupported_invoice_adjustments(invoice, lines)
        if (
            quantity != 1
            or line_amount != expected_amount
            or amount_paid != expected_amount
            or invoice_total != expected_amount
            or amount_due != expected_amount
            or subtotal != expected_amount
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
        period = line.get("period")
        period_start = _timestamp(period.get("start")) if isinstance(period, Mapping) else None
        period_end = _timestamp(period.get("end")) if isinstance(period, Mapping) else None
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
                projected_created, projected_rank = _projection_order(account, event)
                await conn.execute(
                    """update billing_accounts set event_created=$2,event_rank=$3,
                             subscription_status='active',updated_at=now() where id=$1""",
                    account["id"],
                    projected_created,
                    projected_rank,
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
        projected_created, projected_rank = (
            _projection_order(account, event)
            if projection_wins
            else (int(account["event_created"]), int(account["event_rank"]))
        )
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
                     where account_id=$1 and resolved_at is null and (
                       (invoice_id=$2 and kind in ('plan_change_payment_failed',
                                                  'unbound_plan_change_payment_failed'))
                       or (kind='plan_change_recovery_required'
                           and detail->>'plan_change_id'=$3)
                     )""",
                account["id"],
                invoice_id,
                str(transition["id"]),
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
        projected_created, projected_rank = (
            _projection_order(account, event)
            if projection_wins
            else (int(account["event_created"]), int(account["event_rank"]))
        )
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
            projected_created,
            projected_rank,
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
                 where account_id=$1 and resolved_at is null and (
                   (invoice_id=$2 and kind in ('plan_change_payment_failed',
                                              'unbound_plan_change_payment_failed'))
                   or (kind='plan_change_recovery_required'
                       and detail->>'plan_change_id'=$3)
                 )""",
            account["id"],
            invoice_id,
            str(transition["id"]),
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
            if _stripe_integer(line.get("quantity")) != 1 or not isinstance(line.get("id"), str):
                raise ValueError("prorated delta lines require identity and quantity one")
            parsed = self.catalog.parse_lookup_key(_line_lookup(line))
            if parsed is None:
                raise ValueError("every prorated delta line must use a catalog Price")
            plan, interval = parsed
            if interval != "month":
                raise ValueError("prorated delta is supported only for monthly Prices")
            if not self._catalog_line_matches(line, plan, interval):
                raise ValueError("Invoice Price or Product identity differs from the catalog")
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
        source_amount = _stripe_integer(source_line.get("amount"))
        target_amount = _stripe_integer(target_line.get("amount"))
        if source_amount is None or target_amount is None:
            raise ValueError("prorated delta amounts must be integers")
        if source_amount >= 0 or target_amount <= 0 or target_amount <= -source_amount:
            raise ValueError("Invoice does not contain a positive net upgrade difference")
        source_catalog_amount = source_plan.month_usd * 100
        target_catalog_amount = target_plan.month_usd * 100
        if -source_amount > source_catalog_amount or target_amount > target_catalog_amount:
            raise ValueError("proration amounts cannot exceed one complete monthly Price")
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
        total = _stripe_integer(invoice.get("total"))
        amount_paid = _stripe_integer(invoice.get("amount_paid"))
        amount_due = (
            total if "amount_due" not in invoice else _stripe_integer(invoice.get("amount_due"))
        )
        subtotal = total if "subtotal" not in invoice else _stripe_integer(invoice.get("subtotal"))
        if (
            total is None
            or amount_paid is None
            or amount_due is None
            or subtotal is None
            or amount_paid <= 0
            or total != amount_paid
            or amount_due != amount_paid
            or subtotal != total
            or source_amount + target_amount != total
        ):
            raise ValueError("Invoice net total must be fully paid by new cash")
        if has_unsupported_invoice_adjustments(invoice, lines):
            raise ValueError("balance, credit notes, taxes and discounts are not supported")
        source_period = source_line.get("period")
        target_period = target_line.get("period")
        if (
            not isinstance(source_period, Mapping)
            or not isinstance(target_period, Mapping)
            or source_period != target_period
        ):
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
        if raw.get("_unsupported_invoice_payment_shape"):
            await self._incident(
                conn,
                "unsupported_invoice_payment_shape",
                event=event,
                dedupe_key=invoice_id or charge_id,
                invoice_id=invoice_id,
                detail={"charge": charge_id, "operation": "clawback"},
            )
            return ProcessResult(
                "ignored", "Invoice payment collection is outside the single-payment model"
            )
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
        amount = _stripe_integer(charge.get("amount"))
        amount_refunded = amount if dispute else _stripe_integer(charge.get("amount_refunded"))
        refunded_flag = charge.get("refunded")
        invalid_shape = bool(
            customer_id is None
            or amount is None
            or amount <= 0
            or amount_refunded is None
            or amount_refunded < 0
            or amount_refunded > amount
            or (refunded_flag is not None and not isinstance(refunded_flag, bool))
        )
        if invalid_shape:
            await self._incident(
                conn,
                "invalid_clawback_shape",
                event=event,
                dedupe_key=charge_id,
                invoice_id=invoice_id,
                detail={
                    "customer_present": customer_id is not None,
                    "amount_is_integer": amount is not None,
                    "amount_refunded_is_integer": amount_refunded is not None,
                },
            )
            return ProcessResult("ignored", "clawback Charge shape is invalid")
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
        assert amount is not None and amount_refunded is not None and customer_id is not None
        full = dispute or refunded_flag is True or amount_refunded == amount
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
        if account["stripe_customer_id"] != customer_id:
            await self._incident(
                conn,
                "clawback_customer_identity_conflict",
                event=event,
                dedupe_key=f"{account_id}:{invoice_id}",
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={
                    "bound": account["stripe_customer_id"],
                    "incoming": customer_id,
                },
            )
            return ProcessResult("ignored", "clawback belongs to a different customer", account_id)
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
        metadata = _subscription_metadata(invoice)
        account = await self._lock_account(conn, invoice, metadata=metadata)
        if account is None:
            return ProcessResult("ignored", "account not found")
        account_id = str(account["id"])
        subscription_id = _subscription_id(invoice)
        customer_id = _as_id(invoice.get("customer"))
        if customer_id is None or (
            account["stripe_customer_id"] is not None
            and str(account["stripe_customer_id"]) != customer_id
        ):
            await self._incident(
                conn,
                "payment_failed_customer_identity_conflict",
                event=event,
                dedupe_key=f"{account_id}:{invoice.get('id') or event['id']}",
                invoice_id=_as_id(invoice.get("id")),
                account_id=account["id"],
                detail={
                    "bound": account["stripe_customer_id"],
                    "incoming": customer_id,
                },
            )
            return ProcessResult(
                "ignored", "failed invoice customer identity is missing or conflicting", account_id
            )
        if not subscription_id or subscription_id != account["stripe_subscription_id"]:
            await self._incident(
                conn,
                "payment_failed_subscription_identity_conflict",
                event=event,
                dedupe_key=f"{account_id}:{invoice.get('id') or event['id']}",
                invoice_id=_as_id(invoice.get("id")),
                account_id=account["id"],
                detail={
                    "bound": account["stripe_subscription_id"],
                    "incoming": subscription_id,
                },
            )
            return ProcessResult(
                "ignored", "failed invoice belongs to a different subscription", account_id
            )
        billing_reason = invoice.get("billing_reason")
        if billing_reason not in _PAID_REASONS:
            invoice_id = _as_id(invoice.get("id"))
            await self._incident(
                conn,
                "unexpected_payment_failed_reason",
                event=event,
                dedupe_key=str(invoice_id or event["id"]),
                invoice_id=invoice_id,
                account_id=account["id"],
                detail={
                    "billing_reason": billing_reason if isinstance(billing_reason, str) else None
                },
            )
            return ProcessResult(
                "ignored", "failed Invoice has an unsupported billing reason", account_id
            )
        if billing_reason == "subscription_update":
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
        projected_created, projected_rank = _projection_order(account, event)
        await conn.execute(
            """update billing_accounts set subscription_status='past_due',event_created=$2,
                 event_rank=$3,updated_at=now() where id=$1""",
            account["id"],
            projected_created,
            projected_rank,
        )
        return ProcessResult("handled", account_id=account_id)

    def _subscription_plan(self, subscription: Mapping[str, Any]) -> tuple[Plan, str] | None:
        container = subscription.get("items")
        raw_items = container.get("data") if isinstance(container, Mapping) else None
        if (
            not isinstance(container, Mapping)
            or container.get("has_more") not in {None, False}
            or not isinstance(raw_items, list)
            or len(raw_items) != 1
        ):
            return None
        item = raw_items[0]
        if not isinstance(item, Mapping) or _stripe_integer(item.get("quantity")) != 1:
            return None
        parsed = self.catalog.parse_lookup_key(_line_lookup(item))
        if parsed is None or not self._catalog_line_matches(item, parsed[0], parsed[1]):
            return None
        return parsed

    @staticmethod
    def _subscription_period_end(subscription: Mapping[str, Any]) -> datetime | None:
        container = subscription.get("items")
        raw_items = container.get("data") if isinstance(container, Mapping) else None
        item = (
            raw_items[0]
            if isinstance(container, Mapping)
            and container.get("has_more") in {None, False}
            and isinstance(raw_items, list)
            and len(raw_items) == 1
            else None
        )
        item_end = item.get("current_period_end") if isinstance(item, Mapping) else None
        return _timestamp(
            item_end if item_end is not None else subscription.get("current_period_end")
        )

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
        customer_id = _as_id(subscription.get("customer"))
        metadata_raw = subscription.get("metadata")
        metadata = metadata_raw if isinstance(metadata_raw, Mapping) else {}
        if customer_id is None or (
            account["stripe_customer_id"] is not None
            and str(account["stripe_customer_id"]) != customer_id
        ):
            await self._incident(
                conn,
                "subscription_customer_identity_conflict",
                event=event,
                dedupe_key=f"{account_id}:{incoming_sub}",
                account_id=account["id"],
                detail={
                    "bound": account["stripe_customer_id"],
                    "incoming": customer_id,
                },
            )
            return ProcessResult(
                "ignored", "subscription customer identity is missing or conflicting", account_id
            )
        status = subscription.get("status")
        cancel_at_period_end = subscription.get("cancel_at_period_end")
        period_end = self._subscription_period_end(subscription)
        if (
            not isinstance(status, str)
            or status not in _SUBSCRIPTION_STATUSES
            or not isinstance(cancel_at_period_end, bool)
            or period_end is None
        ):
            await self._incident(
                conn,
                "invalid_subscription_projection",
                event=event,
                dedupe_key=f"{account_id}:{incoming_sub}",
                account_id=account["id"],
                detail={
                    "status": status if isinstance(status, str) else None,
                    "cancel_at_period_end_is_boolean": isinstance(cancel_at_period_end, bool),
                    "period_end_present": period_end is not None,
                },
            )
            return ProcessResult("ignored", "Subscription projection shape is invalid", account_id)
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
        if current_sub is None:
            claim = await conn.fetchrow(
                "select * from checkout_claims where account_id=$1 for update",
                account["id"],
            )
            claim_authorized = bool(
                claim is not None
                and metadata.get("claim_token")
                and str(claim["claim_token"]) == str(metadata["claim_token"])
                and claim["plan_key"] == parsed[0].key
                and claim["plan_interval"] == parsed[1]
            )
            if not claim_authorized:
                await self._incident(
                    conn,
                    "subscription_update_without_authority",
                    event=event,
                    dedupe_key=f"{account_id}:{incoming_sub}",
                    account_id=account["id"],
                )
                return ProcessResult(
                    "ignored", "unbound subscription lacks a live Checkout claim", account_id
                )
        if not self._wins(account, event):
            if _ordering_tie(account, event):
                await self._incident(
                    conn,
                    "event_order_tie",
                    event=event,
                    dedupe_key=(
                        f"{account_id}:{event['type']}:{event['created']}:{account['event_rank']}"
                    ),
                    account_id=account["id"],
                    detail={
                        "subscription_id": incoming_sub,
                        "status": status,
                        "cancel_at_period_end": cancel_at_period_end,
                    },
                )
            return ProcessResult("ignored", "older or weaker than the applied state", account_id)
        projected_created, projected_rank = _projection_order(account, event)
        await conn.execute(
            """update billing_accounts set stripe_customer_id=coalesce(stripe_customer_id,$2),
                 stripe_subscription_id=$3,
                 subscription_status=$4,current_period_end=$5::timestamptz,
                 cancel_at_period_end=$6,
                 pending_free_at=case when $6 then $5::timestamptz else null end,
                 event_created=$7,event_rank=$8,
                 updated_at=now() where id=$1""",
            account["id"],
            customer_id,
            incoming_sub,
            _project_status(status),
            period_end,
            cancel_at_period_end,
            projected_created,
            projected_rank,
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
        incoming_sub = _as_id(subscription.get("id"))
        customer_id = _as_id(subscription.get("customer"))
        if incoming_sub is None or account["stripe_subscription_id"] != incoming_sub:
            await self._incident(
                conn,
                "subscription_deleted_identity_conflict",
                event=event,
                dedupe_key=f"{account_id}:{incoming_sub or event['id']}",
                account_id=account["id"],
                detail={
                    "bound": account["stripe_subscription_id"],
                    "incoming": incoming_sub,
                },
            )
            return ProcessResult(
                "ignored", "deleted event belongs to an unbound subscription", account_id
            )
        if customer_id is None or (
            account["stripe_customer_id"] is not None
            and str(account["stripe_customer_id"]) != customer_id
        ):
            await self._incident(
                conn,
                "subscription_customer_identity_conflict",
                event=event,
                dedupe_key=f"{account_id}:{incoming_sub}",
                account_id=account["id"],
                detail={
                    "bound": account["stripe_customer_id"],
                    "incoming": customer_id,
                },
            )
            return ProcessResult(
                "ignored",
                "deleted subscription customer identity is missing or conflicting",
                account_id,
            )
        if not self._wins(account, event):
            return ProcessResult("ignored", "older than the applied state", account_id)
        old_balance = int(account["credits_balance"])
        new_epoch = int(account["grant_epoch"]) + 1
        projected_created, projected_rank = _projection_order(account, event)
        await conn.execute(
            """update billing_accounts set stripe_subscription_id=null,plan_key='free',
                 plan_interval=null,subscription_status='canceled',credits_balance=0,
                 grant_epoch=$2,event_created=$3,event_rank=$4,current_period_end=null,
                 entitlement_period_end=null,credit_expires_at=null,entitlement_revoked=true,
                 cancel_at_period_end=false,pending_free_at=null,
                 annual_anchor=null,annual_grants_issued=0,annual_grants_allowed=12,
                 funding_invoice_id=null,updated_at=now() where id=$1""",
            account["id"],
            new_epoch,
            projected_created,
            projected_rank,
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
                   completed_at=coalesce(completed_at,now()),
                   lease_token=null,lease_expires_at=null,updated_at=now()
                 where account_id=$1 and stripe_subscription_id=$2 and status in (
                   'reserved','previewed','applying','scheduled','applied','requires_action'
                 )""",
            account["id"],
            incoming_sub,
        )
        await conn.execute(
            """update billing_incidents set resolved_at=now(),last_seen_at=now()
                 where account_id=$1 and resolved_at is null
                   and kind in ('plan_change_payment_failed',
                                'unbound_plan_change_payment_failed',
                                'plan_change_recovery_required')""",
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
        incoming_customer = _as_id(session.get("customer"))
        metadata_raw = session.get("metadata")
        metadata = metadata_raw if isinstance(metadata_raw, Mapping) else {}
        if not incoming_sub:
            await self._incident(
                conn,
                "checkout_completed_without_subscription",
                event=event,
                dedupe_key=f"{account_id}:{session_id}",
                account_id=account["id"],
            )
            return ProcessResult("ignored", "completed Checkout has no subscription", account_id)
        if incoming_customer is None or (
            account["stripe_customer_id"] is not None
            and str(account["stripe_customer_id"]) != incoming_customer
        ):
            await self._incident(
                conn,
                "checkout_customer_identity_conflict",
                event=event,
                dedupe_key=f"{account_id}:{session_id}",
                account_id=account["id"],
                detail={
                    "bound": account["stripe_customer_id"],
                    "incoming": incoming_customer,
                },
            )
            return ProcessResult(
                "ignored", "Checkout customer identity is missing or conflicting", account_id
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
                 event_created=case when stripe_subscription_id is null then 0
                                    else event_created end,
                 event_rank=case when stripe_subscription_id is null then 0
                                 else event_rank end,
                 stripe_subscription_id=coalesce($3,stripe_subscription_id),updated_at=now()
                 where id=$1""",
            account["id"],
            incoming_customer,
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
