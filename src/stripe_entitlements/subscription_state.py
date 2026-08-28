from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any


def subscription_credits_are_spendable(
    account: Mapping[str, Any], *, as_of: datetime | None
) -> bool:
    """Return whether the stored subscription funding is spendable at ``as_of``.

    This is deliberately independent from plan-feature enforcement: a credit pack
    can remain spendable while subscription features are paused, and an unknown
    catalog plan must not make balance reporting disagree with atomic charging.
    """

    expires_at = account.get("credit_expires_at")
    if (
        account.get("subscription_status") != "active"
        or bool(account.get("entitlement_revoked"))
        or not isinstance(as_of, datetime)
        or not isinstance(expires_at, datetime)
    ):
        return False
    try:
        return expires_at > as_of
    except TypeError:
        # Naive/aware timestamp drift is an invalid integration state. Fail closed.
        return False


def spendable_subscription_atoms(account: Mapping[str, Any], *, as_of: datetime | None) -> int:
    if not subscription_credits_are_spendable(account, as_of=as_of):
        return 0
    return int(account["credits_balance"])


__all__ = ["spendable_subscription_atoms", "subscription_credits_are_spendable"]
