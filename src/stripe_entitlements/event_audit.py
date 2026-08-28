from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

_SECRET_VALUE = re.compile(
    r"(?<![A-Za-z0-9])(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+"
    r"|(?<![A-Za-z0-9])whsec_[A-Za-z0-9]+"
    r"|[A-Za-z0-9]+_secret_[A-Za-z0-9]+"
)
_AUDIT_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}")
_UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.IGNORECASE,
)
_SLUG = re.compile(r"[a-z][a-z0-9_-]{0,127}")
_CANONICAL_CREDITS = re.compile(r"(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?")
_POSITIVE_INTEGER = re.compile(r"[1-9][0-9]{0,18}")
_METADATA_PATTERNS: dict[str, re.Pattern[str]] = {
    "account_id": _UUID,
    "billing_kind": re.compile(r"credit_pack"),
    "credit_pack_order_id": _UUID,
    "currency": re.compile(r"[a-z]{3}"),
    "expires_days": re.compile(r"[1-9][0-9]{0,3}"),
    "lookup_key": _SLUG,
    "pack_credits": _CANONICAL_CREDITS,
    "pack_key": _SLUG,
    "pack_schema_version": re.compile(r"[1-9][0-9]{0,3}"),
    "plan": _SLUG,
    "plan_key": _SLUG,
    "plan_interval": re.compile(r"(?:month|year)"),
    "price_amount": _POSITIVE_INTEGER,
    "product_line": _SLUG,
    "transition_policy": re.compile(r"(?:full_period_reset|prorated_delta)"),
}
_OBJECT_ID_FIELDS = (
    "customer",
    "subscription",
    "invoice",
    "payment_intent",
    "charge",
    "latest_charge",
)
_OBJECT_TOKEN_FIELDS = ("object", "status", "payment_status", "mode", "billing_reason")
_OBJECT_BOOLEAN_FIELDS = ("livemode", "paid", "refunded")
_OBJECT_INTEGER_FIELDS = (
    "created",
    "amount",
    "amount_due",
    "amount_paid",
    "amount_received",
    "amount_refunded",
)


def _audit_token(value: Any) -> str | None:
    if type(value) is not str or not _AUDIT_TOKEN.fullmatch(value) or _SECRET_VALUE.search(value):
        return None
    return value


def _object_id(value: Any) -> str | None:
    if isinstance(value, Mapping):
        value = value.get("id")
    return _audit_token(value)


def _safe_metadata(value: Any) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    safe: dict[str, str] = {}
    for key, pattern in _METADATA_PATTERNS.items():
        candidate = value.get(key)
        if (
            type(candidate) is str
            and pattern.fullmatch(candidate)
            and not _SECRET_VALUE.search(candidate)
        ):
            safe[key] = candidate
    return safe


def _audit_object(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    audit: dict[str, Any] = {}
    object_id = _object_id(value.get("id"))
    if object_id is not None:
        audit["id"] = object_id
    for field in _OBJECT_ID_FIELDS:
        identifier = _object_id(value.get(field))
        if identifier is not None:
            audit[field] = identifier
    for field in _OBJECT_TOKEN_FIELDS:
        token = _audit_token(value.get(field))
        if token is not None:
            audit[field] = token
    client_reference_id = value.get("client_reference_id")
    if type(client_reference_id) is str and _UUID.fullmatch(client_reference_id):
        audit["client_reference_id"] = client_reference_id
    currency = value.get("currency")
    if type(currency) is str and re.fullmatch(r"[a-z]{3}", currency):
        audit["currency"] = currency
    for field in _OBJECT_BOOLEAN_FIELDS:
        candidate = value.get(field)
        if type(candidate) is bool:
            audit[field] = candidate
    for field in _OBJECT_INTEGER_FIELDS:
        candidate = value.get(field)
        if type(candidate) is int:
            audit[field] = candidate
    metadata = _safe_metadata(value.get("metadata"))
    if metadata:
        audit["metadata"] = metadata
    return audit


def redacted_event_snapshot(event: Mapping[str, Any]) -> dict[str, Any]:
    """Return a minimal operational allowlist, never a recursively copied Event."""

    snapshot: dict[str, Any] = {}
    for field in ("id", "object", "type", "api_version"):
        token = _audit_token(event.get(field))
        if token is not None:
            snapshot[field] = token
    livemode = event.get("livemode")
    if type(livemode) is bool:
        snapshot["livemode"] = livemode
    created = event.get("created")
    if type(created) is int:
        snapshot["created"] = created
    data = event.get("data")
    if isinstance(data, Mapping):
        audit_object = _audit_object(data.get("object"))
        if audit_object:
            snapshot["data"] = {"object": audit_object}
    return snapshot
