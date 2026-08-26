"""CHECKOUT_ALLOW_PROMOTION_CODES is a default-off reserved hook.

The flag only exposes Stripe's promotion-code field on hosted Checkout. It does not
weaken the paid-Invoice policy: a redeemed promo produces a discounted Invoice that
``has_unsupported_invoice_adjustments`` still rejects fail-closed, so no entitlement
is granted and a durable incident is opened. This is not full coupon support.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest

from stripe_entitlements.invoice_policy import has_unsupported_invoice_adjustments
from stripe_entitlements.stripe_gateway import StripeGateway
from tests.builders import paid_invoice, resolved_price


class StripeObject(SimpleNamespace):
    def __str__(self) -> str:
        return json.dumps(vars(self))


async def _create_session(
    monkeypatch: pytest.MonkeyPatch, gateway: StripeGateway
) -> dict[str, Any]:
    captured: dict[str, Any] = {}
    price = StripeObject(**resolved_price("starter", "month"))
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.list",
        lambda **kwargs: SimpleNamespace(data=[price]),
    )

    def create(**kwargs: Any) -> SimpleNamespace:
        captured.update(kwargs)
        return SimpleNamespace(
            id="cs_promo", url="https://checkout.stripe.com/c/pay/promo-session"
        )

    monkeypatch.setattr("stripe_entitlements.stripe_gateway.stripe.checkout.Session.create", create)
    session_id, session_url = await gateway.create_checkout_session(
        account_id="00000000-0000-0000-0000-000000000001",
        customer_id=None,
        lookup_key="ent_starter_month",
        expected_currency="usd",
        expected_unit_amount=1900,
        expected_interval="month",
        claim_token="claim-promo",
        expires_at=datetime(2026, 8, 1, tzinfo=UTC),
        customer_email="user@example.test",
        plan_key="starter",
        interval="month",
    )
    assert session_id == "cs_promo"
    assert session_url == "https://checkout.stripe.com/c/pay/promo-session"
    return captured


async def test_default_checkout_session_omits_promotion_codes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    assert gateway.allow_promotion_codes is False
    captured = await _create_session(monkeypatch, gateway)
    assert "allow_promotion_codes" not in captured


async def test_enabled_flag_sends_allow_promotion_codes_to_stripe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = StripeGateway("sk_test_dummy", "whsec_test", allow_promotion_codes=True)
    captured = await _create_session(monkeypatch, gateway)
    assert captured["allow_promotion_codes"] is True


@pytest.mark.parametrize(
    "adjustment",
    [
        {"total_discount_amounts": [{"amount": 100}]},
        {"discounts": ["promo_code_discount"]},
        {"discount": {}},
    ],
)
def test_discounted_invoice_still_fails_closed_with_flag_enabled(
    adjustment: dict[str, Any],
) -> None:
    invoice = paid_invoice("00000000-0000-0000-0000-000000000001")["data"]["object"]
    assert not has_unsupported_invoice_adjustments(invoice, invoice["lines"]["data"])
    invoice.update(adjustment)
    assert has_unsupported_invoice_adjustments(invoice, invoice["lines"]["data"]) is True
