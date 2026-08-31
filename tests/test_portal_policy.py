from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest

from stripe_entitlements.portal_policy import portal_configuration_is_safe


def _safe_portal() -> dict[str, Any]:
    return {
        "active": True,
        "livemode": False,
        "metadata": {"product_line": "example-entitlements"},
        "features": {
            "subscription_update": {"enabled": False},
            "subscription_cancel": {"enabled": True, "mode": "at_period_end"},
        },
    }


def _is_safe(config: dict[str, Any]) -> bool:
    return portal_configuration_is_safe(
        config,
        expected_livemode=False,
        expected_product_line="example-entitlements",
    )


def test_portal_policy_allows_cancellation_to_be_disabled() -> None:
    config = _safe_portal()
    config["features"]["subscription_cancel"] = {"enabled": False}

    assert _is_safe(config)


@pytest.mark.parametrize(
    ("cancel", "update", "expected"),
    [
        ({"enabled": True, "mode": "at_period_end"}, {"enabled": False}, True),
        ({"enabled": False, "mode": "immediately"}, {"enabled": False}, True),
        ({"enabled": True, "mode": "immediately"}, {"enabled": False}, False),
        ({"enabled": True}, {"enabled": False}, False),
        ({"enabled": "false"}, {"enabled": False}, False),
        ({"enabled": False}, {"enabled": True}, False),
    ],
)
def test_portal_policy_enforces_only_safe_subscription_mutations(
    cancel: dict[str, Any],
    update: dict[str, Any],
    expected: bool,
) -> None:
    config = deepcopy(_safe_portal())
    config["features"]["subscription_cancel"] = cancel
    config["features"]["subscription_update"] = update

    assert _is_safe(config) is expected
