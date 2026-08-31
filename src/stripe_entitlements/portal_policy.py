from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

_PORTAL_PLACEHOLDER_MARKERS = (
    "replace_me",
    "replace-with",
    "replace_with",
    "changeme",
    "change_me",
    "dummy",
    "your_key",
    "your_secret",
)
_PORTAL_CONFIGURATION_ID = re.compile(r"^bpc_[A-Za-z0-9]+$")


def portal_configuration_id_is_usable(configuration_id: str | None) -> bool:
    """Return whether an ID is safe to send to the Stripe Portal API."""

    if configuration_id is None or _PORTAL_CONFIGURATION_ID.fullmatch(configuration_id) is None:
        return False
    normalized = configuration_id.casefold().replace(" ", "_")
    return not any(marker in normalized for marker in _PORTAL_PLACEHOLDER_MARKERS)


def portal_configuration_is_safe(
    config: Mapping[str, Any],
    *,
    expected_livemode: bool,
    expected_product_line: str,
) -> bool:
    features = config.get("features")
    metadata = config.get("metadata")
    if not isinstance(features, Mapping) or not isinstance(metadata, Mapping):
        return False
    cancel = features.get("subscription_cancel")
    update = features.get("subscription_update")
    if not isinstance(cancel, Mapping) or not isinstance(update, Mapping):
        return False
    cancel_enabled = cancel.get("enabled")
    cancellation_is_safe = cancel_enabled is False or bool(
        cancel_enabled is True and cancel.get("mode") == "at_period_end"
    )
    # Only the features that can mutate subscription state are safety-critical.
    # Benign Portal capabilities and newly added Stripe feature keys must not make
    # an otherwise safe dedicated configuration unusable.
    return bool(
        config.get("active") is True
        and config.get("livemode") is expected_livemode
        and metadata.get("product_line") == expected_product_line
        and update.get("enabled") is False
        and cancellation_is_safe
    )
