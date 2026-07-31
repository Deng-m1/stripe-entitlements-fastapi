from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from scripts.bootstrap_stripe import _mode, _safe_portal
from stripe_entitlements.stripe_gateway import StripeGateway
from tests.builders import event


def test_gateway_rejects_ambiguous_or_restricted_key() -> None:
    with pytest.raises(ValueError, match="sk_test"):
        StripeGateway("rk_test_not_supported", "whsec_test")


@pytest.mark.parametrize(
    ("key", "expected"),
    [("sk_test_value", (False, "test")), ("sk_live_value", (True, "live"))],
)
def test_bootstrap_mode_is_explicit(key: str, expected: tuple[bool, str]) -> None:
    assert _mode(key) == expected


def test_bootstrap_refuses_non_secret_key() -> None:
    with pytest.raises(RuntimeError, match="sk_test"):
        _mode("rk_test_value")


def test_portal_policy_requires_all_safety_fields() -> None:
    safe = {
        "enabled": True,
        "proration_behavior": "always_invoice",
        "billing_cycle_anchor": "now",
        "schedule_at_period_end": {
            "conditions": [
                {"type": "decreasing_item_amount"},
                {"type": "shortening_interval"},
            ]
        },
    }
    assert _safe_portal(safe)
    for field in ("enabled", "proration_behavior", "billing_cycle_anchor"):
        drifted = dict(safe)
        drifted.pop(field)
        assert not _safe_portal(drifted)


async def test_prepare_refund_resolves_invoice_through_invoice_payment(monkeypatch) -> None:
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    page = SimpleNamespace(
        data=[
            json.dumps(
                {
                    "id": "inpay_test",
                    "invoice": "in_resolved",
                    "payment": {
                        "type": "payment_intent",
                        "payment_intent": "pi_test",
                    },
                }
            )
        ]
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.InvoicePayment.list",
        lambda **kwargs: page,
    )
    payload = event(
        "charge.refunded",
        {
            "id": "ch_test",
            "customer": "cus_test",
            "payment_intent": "pi_test",
            "amount": 100,
            "amount_refunded": 50,
            "refunded": False,
        },
    )
    prepared = await gateway.prepare_event(payload)
    assert prepared["data"]["object"]["_resolved_invoice_id"] == "in_resolved"


async def test_prepare_invoice_resolves_dahlia_price_reference(monkeypatch) -> None:
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.retrieve",
        lambda price_id, **kwargs: SimpleNamespace(lookup_key="ent_starter_month"),
    )
    payload = event(
        "invoice.paid",
        {
            "id": "in_test",
            "lines": {
                "data": [
                    {
                        "pricing": {"price_details": {"price": "price_dahlia"}},
                        "period": {"start": 1, "end": 2},
                    }
                ]
            },
        },
    )
    prepared = await gateway.prepare_event(payload)
    line = prepared["data"]["object"]["lines"]["data"][0]
    assert line["_resolved_lookup_key"] == "ent_starter_month"
