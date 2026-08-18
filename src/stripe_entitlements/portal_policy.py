from __future__ import annotations

from collections.abc import Mapping
from typing import Any


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
    # Only the features that can mutate subscription state are safety-critical.
    # Benign Portal capabilities and newly added Stripe feature keys must not make
    # an otherwise safe dedicated configuration unusable.
    return bool(
        config.get("active") is True
        and config.get("livemode") is expected_livemode
        and metadata.get("product_line") == expected_product_line
        and update.get("enabled") is False
        and cancel.get("enabled") is True
        and cancel.get("mode") == "at_period_end"
    )
