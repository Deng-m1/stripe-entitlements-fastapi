from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def portal_configuration_is_safe(
    config: Mapping[str, Any], *, expected_livemode: bool
) -> bool:
    features = config.get("features") or {}
    update = features.get("subscription_update") or {}
    cancel = features.get("subscription_cancel") or {}
    return bool(
        config.get("active") is True
        and bool(config.get("livemode")) is expected_livemode
        and update.get("enabled") is False
        and cancel.get("enabled") is True
        and cancel.get("mode") == "at_period_end"
    )
