from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

_REDACTED = "[redacted]"
_SAFE_METADATA_KEYS = {
    "account_id",
    "plan",
    "plan_key",
    "plan_interval",
    "product_line",
    "transition_policy",
}
_SENSITIVE_KEYS = {
    "address",
    "billing_details",
    "card",
    "client_secret",
    "confirmation_secret",
    "customer_address",
    "customer_email",
    "customer_name",
    "customer_phone",
    "customer_shipping",
    "email",
    "hosted_invoice_url",
    "idempotency_key",
    "invoice_pdf",
    "name",
    "payment_method_details",
    "phone",
    "receipt_email",
    "receipt_url",
    "secret",
    "shipping",
    "shipping_details",
}
_SECRET_VALUE = re.compile(
    r"(?<![A-Za-z0-9])(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+"
    r"|(?<![A-Za-z0-9])whsec_[A-Za-z0-9]+"
    r"|[A-Za-z0-9]+_secret_[A-Za-z0-9]+"
)
_EMAIL_VALUE = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
_URL_VALUE = re.compile(r"https?://[^\s]+", re.IGNORECASE)


def _sensitive_field(field: str | None) -> bool:
    if field is None:
        return False
    normalized = field.lower()
    return bool(
        normalized in _SENSITIVE_KEYS
        or "secret" in normalized
        or normalized.endswith(("_address", "_email", "_phone", "_url"))
    )


def _redact(value: Any, *, field: str | None = None) -> Any:
    if _sensitive_field(field):
        return _REDACTED
    if isinstance(value, Mapping):
        if field == "metadata":
            return {
                str(key): (
                    _redact(item, field=str(key)) if str(key) in _SAFE_METADATA_KEYS else _REDACTED
                )
                for key, item in value.items()
                if not str(key).startswith("_")
            }
        return {
            str(key): _redact(item, field=str(key))
            for key, item in value.items()
            if not str(key).startswith("_")
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_redact(item) for item in value]
    if isinstance(value, str):
        if _SECRET_VALUE.search(value) or _EMAIL_VALUE.search(value) or _URL_VALUE.search(value):
            return _REDACTED
    return value


def redacted_event_snapshot(event: Mapping[str, Any]) -> dict[str, Any]:
    snapshot = _redact(event)
    if not isinstance(snapshot, dict):
        raise TypeError("Stripe event audit snapshot must be a JSON object")
    return snapshot
