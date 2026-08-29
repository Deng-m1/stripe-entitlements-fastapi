from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, Literal, cast
from urllib.parse import urlsplit

from .plan_changes import PlanChangeContext
from .transitions import BillingInterval, TransitionPolicy

PLAN_CHANGE_SNAPSHOT_SCHEMA = "stripe.plan_change.request"
PLAN_CHANGE_SNAPSHOT_VERSION = 1
CHECKOUT_SNAPSHOT_SCHEMA = "stripe.checkout.session.create"
CHECKOUT_SNAPSHOT_VERSION = 1
_SECRET_MARKERS = ("sk_test_", "sk_live_", "rk_test_", "rk_live_", "whsec_")
_MAX_STRIPE_AMOUNT = 99_999_999
_UNSET = object()


class StripeRequestSnapshotError(RuntimeError):
    """A persisted remote request is absent, malformed, or unsafe to replay."""


def _http_url(value: Any, field: str) -> str:
    result = _text(value, field, maximum=2048)
    parsed = urlsplit(result)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise StripeRequestSnapshotError(f"{field} is not an origin-safe HTTP(S) URL")
    return result


def build_subscription_checkout_request_snapshot(
    *,
    account_id: str,
    claim_token: str,
    customer_id: str | None,
    price_id: str,
    lookup_key: str,
    currency: str,
    unit_amount: int,
    interval: BillingInterval,
    plan_key: str,
    product_line: str,
    success_url: str,
    cancel_url: str,
    expires_at: int,
    request_api_version: str,
) -> dict[str, Any]:
    metadata = {
        "claim_token": claim_token,
        "account_id": account_id,
        "product_line": product_line,
    }
    params: dict[str, Any] = {
        "mode": "subscription",
        "client_reference_id": account_id,
        "line_items": [{"price": price_id, "quantity": 1}],
        "subscription_data": {"metadata": metadata},
        "success_url": success_url,
        "cancel_url": cancel_url,
        "expires_at": expires_at,
        "metadata": metadata,
    }
    customer_mode = "create"
    if customer_id is not None:
        params["customer"] = customer_id
        customer_mode = "existing"
    return validate_checkout_request_snapshot(
        {
            "schema": CHECKOUT_SNAPSHOT_SCHEMA,
            "version": CHECKOUT_SNAPSHOT_VERSION,
            "kind": "subscription",
            "request_api_version": request_api_version,
            "idempotency_key": f"checkout:{account_id}:{claim_token}",
            "customer_mode": customer_mode,
            "resolved_price": {
                "price_id": price_id,
                "lookup_key": lookup_key,
                "currency": currency,
                "unit_amount": unit_amount,
                "price_type": "recurring",
                "interval": interval,
                "product_line": product_line,
                "offering_key": plan_key,
            },
            "params": params,
        }
    )


def build_credit_pack_checkout_request_snapshot(
    *,
    order_id: str,
    account_id: str,
    customer_id: str | None,
    price_id: str,
    lookup_key: str,
    currency: str,
    unit_amount: int,
    pack_key: str,
    pack_credits: str,
    expires_days: int,
    product_line: str,
    success_url: str,
    cancel_url: str,
    expires_at: int,
    request_api_version: str,
) -> dict[str, Any]:
    metadata = {
        "billing_kind": "credit_pack",
        "pack_schema_version": "1",
        "product_line": product_line,
        "credit_pack_order_id": order_id,
        "account_id": account_id,
        "pack_key": pack_key,
        "pack_credits": pack_credits,
        "price_amount": str(unit_amount),
        "currency": currency,
        "expires_days": str(expires_days),
        "lookup_key": lookup_key,
    }
    params: dict[str, Any] = {
        "mode": "payment",
        "payment_method_types": ["card"],
        "client_reference_id": account_id,
        "line_items": [{"price": price_id, "quantity": 1}],
        "payment_intent_data": {"metadata": metadata},
        "success_url": success_url,
        "cancel_url": cancel_url,
        "expires_at": expires_at,
        "metadata": metadata,
    }
    customer_mode = "create"
    if customer_id is None:
        params["customer_creation"] = "always"
    else:
        params["customer"] = customer_id
        customer_mode = "existing"
    return validate_checkout_request_snapshot(
        {
            "schema": CHECKOUT_SNAPSHOT_SCHEMA,
            "version": CHECKOUT_SNAPSHOT_VERSION,
            "kind": "credit_pack",
            "request_api_version": request_api_version,
            "idempotency_key": f"credit-pack:{order_id}",
            "customer_mode": customer_mode,
            "resolved_price": {
                "price_id": price_id,
                "lookup_key": lookup_key,
                "currency": currency,
                "unit_amount": unit_amount,
                "price_type": "one_time",
                "interval": None,
                "product_line": product_line,
                "offering_key": pack_key,
            },
            "params": params,
        }
    )


def validate_checkout_request_snapshot(
    value: Any,
    *,
    expected_kind: Literal["subscription", "credit_pack"] | None = None,
    expected_account_id: str | None = None,
    expected_request_identity: str | None = None,
    expected_lookup_key: str | None = None,
    expected_currency: str | None = None,
    expected_unit_amount: int | None = None,
    expected_interval: BillingInterval | None = None,
    expected_offering_key: str | None = None,
    expected_expires_at: int | None = None,
    expected_customer_id: Any = _UNSET,
    expected_pack_credits: str | None = None,
    expected_expires_days: int | None = None,
    expected_product_line: str | None = None,
) -> dict[str, Any]:
    _safe_json(value)
    root = _exact_mapping(
        value,
        {
            "schema",
            "version",
            "kind",
            "request_api_version",
            "idempotency_key",
            "customer_mode",
            "resolved_price",
            "params",
        },
        "Checkout request snapshot",
    )
    if root["schema"] != CHECKOUT_SNAPSHOT_SCHEMA or root["version"] != 1:
        raise StripeRequestSnapshotError("unsupported Checkout request snapshot version")
    kind = root["kind"]
    if kind not in {"subscription", "credit_pack"}:
        raise StripeRequestSnapshotError("unsupported Checkout request snapshot kind")
    _text(root["request_api_version"], "request API version", maximum=64)
    idempotency_key = _text(root["idempotency_key"], "Stripe idempotency key", maximum=255)
    customer_mode = root["customer_mode"]
    if customer_mode not in {"existing", "create"}:
        raise StripeRequestSnapshotError("Checkout customer mode is invalid")
    evidence = _exact_mapping(
        root["resolved_price"],
        {
            "price_id",
            "lookup_key",
            "currency",
            "unit_amount",
            "price_type",
            "interval",
            "product_line",
            "offering_key",
        },
        "Checkout resolved Price evidence",
    )
    price_id = _stripe_id(evidence["price_id"], "price_", "Checkout Price id")
    lookup_key = _text(evidence["lookup_key"], "Checkout lookup key", maximum=200)
    currency = _text(evidence["currency"], "Checkout currency", maximum=3)
    if len(currency) != 3 or currency != currency.lower():
        raise StripeRequestSnapshotError("Checkout currency is invalid")
    unit_amount = evidence["unit_amount"]
    if type(unit_amount) is not int or unit_amount < 0 or unit_amount > _MAX_STRIPE_AMOUNT:
        raise StripeRequestSnapshotError("Checkout unit amount is invalid")
    product_line = _text(evidence["product_line"], "product line", maximum=200)
    offering_key = _text(evidence["offering_key"], "offering key", maximum=64)
    interval = evidence["interval"]
    if kind == "subscription":
        if evidence["price_type"] != "recurring" or interval not in {"month", "year"}:
            raise StripeRequestSnapshotError("subscription Price evidence is invalid")
    elif evidence["price_type"] != "one_time" or interval is not None:
        raise StripeRequestSnapshotError("credit-pack Price evidence is invalid")
    common_keys = {
        "mode",
        "client_reference_id",
        "line_items",
        "success_url",
        "cancel_url",
        "expires_at",
        "metadata",
    }
    branch_key = "subscription_data" if kind == "subscription" else "payment_intent_data"
    keys = common_keys | {branch_key}
    if kind == "credit_pack":
        keys.add("payment_method_types")
    keys.add("customer" if customer_mode == "existing" else "customer_creation")
    if kind == "subscription" and customer_mode == "create":
        keys.remove("customer_creation")
    params = _exact_mapping(root["params"], keys, "Checkout Session create params")
    account_id = _text(params["client_reference_id"], "Checkout account id", maximum=64)
    if params["line_items"] != [{"price": price_id, "quantity": 1}]:
        raise StripeRequestSnapshotError("Checkout line item drifted")
    _http_url(params["success_url"], "Checkout success URL")
    _http_url(params["cancel_url"], "Checkout cancel URL")
    expires_at = _integer(params["expires_at"], "Checkout expiry")
    customer_id: str | None = None
    if customer_mode == "existing":
        customer_id = _stripe_id(params["customer"], "cus_", "Checkout Customer id")
    elif kind == "credit_pack" and params["customer_creation"] != "always":
        raise StripeRequestSnapshotError("credit-pack Customer create mode drifted")
    metadata_wrapper = _exact_mapping(params[branch_key], {"metadata"}, f"{branch_key}")
    if params["metadata"] != metadata_wrapper["metadata"]:
        raise StripeRequestSnapshotError("Checkout metadata copies drifted")
    metadata = params["metadata"]
    if kind == "subscription":
        expected_metadata = {
            "claim_token": expected_request_identity
            or idempotency_key.removeprefix(f"checkout:{account_id}:"),
            "account_id": account_id,
            "product_line": product_line,
        }
        if params["mode"] != "subscription" or metadata != expected_metadata:
            raise StripeRequestSnapshotError("subscription Checkout metadata drifted")
        request_identity = str(expected_metadata["claim_token"])
        derived_key = f"checkout:{account_id}:{request_identity}"
    else:
        if params["mode"] != "payment" or params["payment_method_types"] != ["card"]:
            raise StripeRequestSnapshotError("credit-pack Checkout payment policy drifted")
        if not isinstance(metadata, Mapping):
            raise StripeRequestSnapshotError("credit-pack Checkout metadata is invalid")
        request_identity = _text(
            metadata.get("credit_pack_order_id"), "credit-pack order id", maximum=64
        )
        expected_metadata = {
            "billing_kind": "credit_pack",
            "pack_schema_version": "1",
            "product_line": product_line,
            "credit_pack_order_id": request_identity,
            "account_id": account_id,
            "pack_key": offering_key,
            "pack_credits": _text(metadata.get("pack_credits"), "pack credits", maximum=64),
            "price_amount": str(unit_amount),
            "currency": currency,
            "expires_days": _text(metadata.get("expires_days"), "pack expiry", maximum=16),
            "lookup_key": lookup_key,
        }
        if dict(metadata) != expected_metadata:
            raise StripeRequestSnapshotError("credit-pack Checkout metadata drifted")
        derived_key = f"credit-pack:{request_identity}"
    if idempotency_key != derived_key:
        raise StripeRequestSnapshotError("Checkout Stripe idempotency identity drifted")
    expectations = (
        (expected_kind, kind, "kind"),
        (expected_account_id, account_id, "account"),
        (expected_request_identity, request_identity, "request identity"),
        (expected_lookup_key, lookup_key, "lookup key"),
        (expected_currency, currency, "currency"),
        (expected_unit_amount, unit_amount, "unit amount"),
        (expected_interval, interval, "interval"),
        (expected_offering_key, offering_key, "offering key"),
        (expected_product_line, product_line, "product line"),
        (expected_expires_at, expires_at, "expiry"),
    )
    for expected, observed, field in expectations:
        if expected is not None and expected != observed:
            raise StripeRequestSnapshotError(f"Checkout {field} drifted")
    if expected_customer_id is not _UNSET:
        if expected_customer_id != customer_id:
            raise StripeRequestSnapshotError("Checkout Customer drifted")
        if expected_customer_id is None and customer_mode != "create":
            raise StripeRequestSnapshotError("Checkout Customer mode drifted")
    if expected_pack_credits is not None:
        if kind != "credit_pack" or not isinstance(metadata, Mapping):
            raise StripeRequestSnapshotError("Checkout pack credits drifted")
        observed_credits = _text(metadata.get("pack_credits"), "pack credits", maximum=64)
        if observed_credits != expected_pack_credits:
            raise StripeRequestSnapshotError("Checkout pack credits drifted")
    if expected_expires_days is not None:
        if (
            kind != "credit_pack"
            or type(expected_expires_days) is not int
            or expected_expires_days <= 0
            or not isinstance(metadata, Mapping)
            or metadata.get("expires_days") != str(expected_expires_days)
        ):
            raise StripeRequestSnapshotError("Checkout pack expiry drifted")
    normalized = json.loads(json.dumps(root, ensure_ascii=False))
    assert isinstance(normalized, dict)
    return normalized


def _exact_mapping(value: Any, keys: set[str], field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or set(value) != keys:
        raise StripeRequestSnapshotError(f"{field} has an unsupported shape")
    return value


def _text(value: Any, field: str, *, maximum: int = 512) -> str:
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or len(value.encode("utf-8")) > maximum
        or any(not character.isprintable() for character in value)
    ):
        raise StripeRequestSnapshotError(f"{field} is invalid")
    if any(marker in value for marker in _SECRET_MARKERS):
        raise StripeRequestSnapshotError(f"{field} contains a prohibited secret marker")
    return value


def _stripe_id(value: Any, prefix: str, field: str) -> str:
    result = _text(value, field, maximum=255)
    if not result.startswith(prefix):
        raise StripeRequestSnapshotError(f"{field} is invalid")
    return result


def _integer(value: Any, field: str) -> int:
    if type(value) is not int or value < 0 or value > 253_402_300_799:
        raise StripeRequestSnapshotError(f"{field} is invalid")
    return value


def _safe_json(value: Any) -> None:
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError, OverflowError) as exc:
        raise StripeRequestSnapshotError("request snapshot is not JSON serializable") from exc
    if len(encoded.encode("utf-8")) > 32 * 1024:
        raise StripeRequestSnapshotError("request snapshot exceeds 32 KiB")
    if any(marker in encoded for marker in _SECRET_MARKERS):
        raise StripeRequestSnapshotError("request snapshot contains a prohibited secret marker")


def _epoch(value: datetime) -> int:
    if value.tzinfo is None:
        raise StripeRequestSnapshotError("plan-change timestamp must be timezone aware")
    result = int(value.astimezone(UTC).timestamp())
    return _integer(result, "plan-change timestamp")


def build_plan_change_request_snapshot(
    context: PlanChangeContext,
    *,
    timing: Literal["immediate", "period_end"],
    policy: TransitionPolicy,
    proration_date: int | None,
    idempotency_key: str,
    request_api_version: str,
    product_line: str,
    source_lookup_key: str,
    target_lookup_key: str,
    source_plan_key: str,
    target_plan_key: str,
    source_currency: str,
    target_currency: str,
    source_unit_amount: int,
    target_unit_amount: int,
) -> dict[str, Any]:
    if timing == "immediate":
        settlement: dict[str, Any]
        if policy == "full_period_reset":
            settlement = {"billing_cycle_anchor": "now", "proration_behavior": "none"}
        elif proration_date is not None:
            settlement = {
                "proration_behavior": "always_invoice",
                "proration_date": proration_date,
            }
        else:
            raise StripeRequestSnapshotError("prorated_delta requires a proration date")
        params: dict[str, Any] = {
            "items": [{"id": context.subscription_item_id, "price": context.target_price_id}],
            **settlement,
            "payment_behavior": "pending_if_incomplete",
            "expand": ["latest_invoice.confirmation_secret"],
        }
        kind = "plan_change_immediate"
    else:
        params = {
            "create": {"from_subscription": context.subscription_id},
            "configure": {
                "boundary": _epoch(context.current_period_end),
                "target_price_id": context.target_price_id,
                "target_interval": context.target_interval,
                "end_behavior": "release",
                "proration_behavior": "none",
                "metadata": {
                    "product_line": product_line,
                    "plan_change_key": idempotency_key,
                },
            },
        }
        kind = "plan_change_schedule"
    snapshot = {
        "schema": PLAN_CHANGE_SNAPSHOT_SCHEMA,
        "version": PLAN_CHANGE_SNAPSHOT_VERSION,
        "kind": kind,
        "request_api_version": request_api_version,
        "idempotency_key": idempotency_key,
        "product_line": product_line,
        "context": {
            "subscription_id": context.subscription_id,
            "subscription_item_id": context.subscription_item_id,
            "current_price_id": context.current_price_id,
            "current_lookup_key": context.current_lookup_key,
            "target_price_id": context.target_price_id,
            "target_interval": context.target_interval,
            "current_period_start": _epoch(context.current_period_start),
            "current_period_end": _epoch(context.current_period_end),
            "schedule_id": context.schedule_id,
            "subscription_status": context.subscription_status,
            "cancel_at_period_end": context.cancel_at_period_end,
            "pending_update": context.pending_update,
        },
        "price_evidence": {
            "source_price_id": context.current_price_id,
            "source_lookup_key": source_lookup_key,
            "source_plan_key": source_plan_key,
            "source_currency": source_currency,
            "source_unit_amount": source_unit_amount,
            "target_price_id": context.target_price_id,
            "target_lookup_key": target_lookup_key,
            "target_plan_key": target_plan_key,
            "target_currency": target_currency,
            "target_unit_amount": target_unit_amount,
        },
        "policy": policy,
        "params": params,
    }
    return validate_plan_change_request_snapshot(snapshot)


def validate_plan_change_request_snapshot(
    value: Any,
    *,
    expected_idempotency_key: str | None = None,
    expected_subscription_id: str | None = None,
    expected_timing: Literal["immediate", "period_end"] | None = None,
    expected_policy: TransitionPolicy | None = None,
) -> dict[str, Any]:
    _safe_json(value)
    root = _exact_mapping(
        value,
        {
            "schema",
            "version",
            "kind",
            "request_api_version",
            "idempotency_key",
            "product_line",
            "context",
            "price_evidence",
            "policy",
            "params",
        },
        "plan-change request snapshot",
    )
    if root["schema"] != PLAN_CHANGE_SNAPSHOT_SCHEMA or root["version"] != 1:
        raise StripeRequestSnapshotError("unsupported plan-change request snapshot version")
    kind = root["kind"]
    if kind not in {"plan_change_immediate", "plan_change_schedule"}:
        raise StripeRequestSnapshotError("unsupported plan-change request snapshot kind")
    timing: Literal["immediate", "period_end"] = (
        "immediate" if kind == "plan_change_immediate" else "period_end"
    )
    api_version = _text(root["request_api_version"], "request API version", maximum=64)
    idempotency_key = _text(root["idempotency_key"], "Stripe idempotency key", maximum=255)
    product_line = _text(root["product_line"], "product line", maximum=200)
    policy = root["policy"]
    if policy not in {"full_period_reset", "prorated_delta"}:
        raise StripeRequestSnapshotError("plan-change policy is invalid")
    context = _exact_mapping(
        root["context"],
        {
            "subscription_id",
            "subscription_item_id",
            "current_price_id",
            "current_lookup_key",
            "target_price_id",
            "target_interval",
            "current_period_start",
            "current_period_end",
            "schedule_id",
            "subscription_status",
            "cancel_at_period_end",
            "pending_update",
        },
        "plan-change context",
    )
    subscription_id = _stripe_id(context["subscription_id"], "sub_", "Subscription id")
    subscription_item_id = _stripe_id(
        context["subscription_item_id"], "si_", "Subscription item id"
    )
    current_price_id = _stripe_id(context["current_price_id"], "price_", "source Price id")
    target_price_id = _stripe_id(context["target_price_id"], "price_", "target Price id")
    current_lookup = _text(context["current_lookup_key"], "source lookup key", maximum=200)
    target_interval = context["target_interval"]
    if target_interval not in {"month", "year"}:
        raise StripeRequestSnapshotError("target interval is invalid")
    period_start = _integer(context["current_period_start"], "current period start")
    period_end = _integer(context["current_period_end"], "current period end")
    if period_end <= period_start:
        raise StripeRequestSnapshotError("plan-change period is invalid")
    schedule_id_raw = context["schedule_id"]
    schedule_id = (
        None
        if schedule_id_raw is None
        else _stripe_id(schedule_id_raw, "sub_sched_", "Subscription Schedule id")
    )
    subscription_status = _text(context["subscription_status"], "Subscription status", maximum=64)
    if (
        type(context["cancel_at_period_end"]) is not bool
        or type(context["pending_update"]) is not bool
    ):
        raise StripeRequestSnapshotError("plan-change boolean context is invalid")
    evidence = _exact_mapping(
        root["price_evidence"],
        {
            "source_price_id",
            "source_lookup_key",
            "source_plan_key",
            "source_currency",
            "source_unit_amount",
            "target_price_id",
            "target_lookup_key",
            "target_plan_key",
            "target_currency",
            "target_unit_amount",
        },
        "plan-change price evidence",
    )
    if (
        _stripe_id(evidence["source_price_id"], "price_", "evidence source Price id")
        != current_price_id
        or _stripe_id(evidence["target_price_id"], "price_", "evidence target Price id")
        != target_price_id
        or _text(evidence["source_lookup_key"], "evidence source lookup", maximum=200)
        != current_lookup
    ):
        raise StripeRequestSnapshotError("plan-change price evidence conflicts with context")
    for field in ("source_plan_key", "target_plan_key"):
        _text(evidence[field], field, maximum=64)
    for field in ("source_currency", "target_currency"):
        currency = _text(evidence[field], field, maximum=3)
        if len(currency) != 3 or currency != currency.lower():
            raise StripeRequestSnapshotError(f"{field} is invalid")
    for field in ("source_unit_amount", "target_unit_amount"):
        amount = evidence[field]
        if type(amount) is not int or amount < 0 or amount > _MAX_STRIPE_AMOUNT:
            raise StripeRequestSnapshotError(f"{field} is invalid")
    target_lookup = _text(evidence["target_lookup_key"], "target lookup key", maximum=200)
    if expected_idempotency_key is not None and idempotency_key != expected_idempotency_key:
        raise StripeRequestSnapshotError("plan-change Stripe idempotency identity drifted")
    if expected_subscription_id is not None and subscription_id != expected_subscription_id:
        raise StripeRequestSnapshotError("plan-change Subscription identity drifted")
    if expected_timing is not None and timing != expected_timing:
        raise StripeRequestSnapshotError("plan-change timing drifted")
    if expected_policy is not None and policy != expected_policy:
        raise StripeRequestSnapshotError("plan-change policy drifted")
    if timing == "immediate":
        allowed = {
            "items",
            "payment_behavior",
            "expand",
            "billing_cycle_anchor",
            "proration_behavior",
        }
        if policy == "prorated_delta":
            allowed.remove("billing_cycle_anchor")
            allowed.add("proration_date")
        params = _exact_mapping(root["params"], allowed, "immediate mutation params")
        if params["items"] != [{"id": subscription_item_id, "price": target_price_id}]:
            raise StripeRequestSnapshotError("immediate mutation items drifted")
        if params["payment_behavior"] != "pending_if_incomplete" or params["expand"] != [
            "latest_invoice.confirmation_secret"
        ]:
            raise StripeRequestSnapshotError("immediate mutation policy drifted")
        if policy == "full_period_reset":
            if params["billing_cycle_anchor"] != "now" or params["proration_behavior"] != "none":
                raise StripeRequestSnapshotError("full-period mutation policy drifted")
        elif params["proration_behavior"] != "always_invoice":
            raise StripeRequestSnapshotError("prorated mutation policy drifted")
        else:
            _integer(params["proration_date"], "proration date")
    else:
        params = _exact_mapping(root["params"], {"create", "configure"}, "schedule params")
        if params["create"] != {"from_subscription": subscription_id}:
            raise StripeRequestSnapshotError("Schedule create params drifted")
        configure = _exact_mapping(
            params["configure"],
            {
                "boundary",
                "target_price_id",
                "target_interval",
                "end_behavior",
                "proration_behavior",
                "metadata",
            },
            "Schedule configure params",
        )
        if (
            _integer(configure["boundary"], "Schedule boundary") != period_end
            or configure["target_price_id"] != target_price_id
            or configure["target_interval"] != target_interval
            or configure["end_behavior"] != "release"
            or configure["proration_behavior"] != "none"
            or configure["metadata"]
            != {"product_line": product_line, "plan_change_key": idempotency_key}
        ):
            raise StripeRequestSnapshotError("Schedule configure policy drifted")
    normalized = json.loads(json.dumps(root, ensure_ascii=False))
    assert isinstance(normalized, dict)
    # Keep these locals intentionally exercised by validation before returning JSON.
    cast(BillingInterval, target_interval)
    del api_version, schedule_id, subscription_status, target_lookup
    return normalized


def plan_change_context_from_snapshot(snapshot: Mapping[str, Any]) -> PlanChangeContext:
    validated = validate_plan_change_request_snapshot(snapshot)
    raw = cast(Mapping[str, Any], validated["context"])
    return PlanChangeContext(
        subscription_id=str(raw["subscription_id"]),
        subscription_item_id=str(raw["subscription_item_id"]),
        current_price_id=str(raw["current_price_id"]),
        current_lookup_key=str(raw["current_lookup_key"]),
        target_price_id=str(raw["target_price_id"]),
        target_interval=cast(BillingInterval, raw["target_interval"]),
        current_period_start=datetime.fromtimestamp(int(raw["current_period_start"]), tz=UTC),
        current_period_end=datetime.fromtimestamp(int(raw["current_period_end"]), tz=UTC),
        schedule_id=cast(str | None, raw["schedule_id"]),
        subscription_status=str(raw["subscription_status"]),
        cancel_at_period_end=bool(raw["cancel_at_period_end"]),
        pending_update=bool(raw["pending_update"]),
    )
