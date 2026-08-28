from __future__ import annotations

import re
from uuid import UUID

_STRIPE_ACCOUNT_SELECTOR = re.compile(r"^(?:acct|cus|sub)_[A-Za-z0-9_]+$")


class InvalidOwnerReferenceError(ValueError):
    """The host identity is not a safe, stable billing-owner selector."""


def validate_owner_external_ref(value: str) -> str:
    """Validate a host-owned stable selector and reject infrastructure identifiers."""

    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or len(value.encode("utf-8")) > 512
        or any(not character.isprintable() for character in value)
    ):
        raise InvalidOwnerReferenceError("owner_external_ref is invalid")
    if _STRIPE_ACCOUNT_SELECTOR.fullmatch(value) is not None:
        raise InvalidOwnerReferenceError("owner_external_ref cannot be a Stripe identifier")
    try:
        parsed_uuid = UUID(value)
    except ValueError:
        parsed_uuid = None
    if parsed_uuid is not None:
        raise InvalidOwnerReferenceError("owner_external_ref cannot be an internal account ID")
    return value


__all__ = ["InvalidOwnerReferenceError", "validate_owner_external_ref"]
