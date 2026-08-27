"""Checkout Session creation must never expose Stripe promotion codes.

``has_unsupported_invoice_adjustments`` fails closed on every discounted Invoice. If
Checkout ever sent ``allow_promotion_codes``, a customer could redeem a promo code,
pay a discounted amount, and receive no entitlement: Stripe collected money while the
grant path opened an incident. The parameter is therefore prohibited as a standalone
option at every layer: no Settings field, no gateway argument, no Session parameter.
It stays reserved until coupon support ships an explicit funding policy.
"""

from __future__ import annotations

import inspect
import json
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest

from stripe_entitlements.config import Settings
from stripe_entitlements.invoice_policy import has_unsupported_invoice_adjustments
from stripe_entitlements.stripe_gateway import StripeGateway
from tests.builders import paid_invoice, resolved_price


class StripeObject(SimpleNamespace):
    def __str__(self) -> str:
        return json.dumps(vars(self))


def _valid_settings(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "database_url": "postgresql://user:password@127.0.0.1:5432/billing",
        "stripe_secret_key": "sk_test_dummy",
        "stripe_webhook_secret": "whsec_dummy",
        "stripe_webhook_api_version": "2026-06-24.dahlia",
    }
    values.update(overrides)
    return values


async def _captured_session_params(
    monkeypatch: pytest.MonkeyPatch,
    *,
    plan_key: str,
    interval: str,
    unit_amount: int,
    customer_id: str | None,
) -> dict[str, Any]:
    captured: dict[str, Any] = {}
    price = StripeObject(**resolved_price(plan_key, interval))
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.list",
        lambda **kwargs: SimpleNamespace(data=[price]),
    )

    def create(**kwargs: Any) -> SimpleNamespace:
        captured.update(kwargs)
        return SimpleNamespace(id="cs_no_promo", url="https://checkout.stripe.com/c/pay/no-promo")

    monkeypatch.setattr("stripe_entitlements.stripe_gateway.stripe.checkout.Session.create", create)
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    session_id, session_url = await gateway.create_checkout_session(
        account_id="00000000-0000-0000-0000-000000000001",
        customer_id=customer_id,
        lookup_key=f"ent_{plan_key}_{interval}",
        expected_currency="usd",
        expected_unit_amount=unit_amount,
        expected_interval=interval,
        claim_token="claim-no-promo",
        expires_at=datetime(2026, 8, 1, tzinfo=UTC),
        customer_email=None if customer_id else "user@example.test",
        plan_key=plan_key,
        interval=interval,
    )
    assert session_id == "cs_no_promo"
    assert session_url == "https://checkout.stripe.com/c/pay/no-promo"
    return captured


@pytest.mark.parametrize(
    ("plan_key", "interval", "unit_amount", "customer_id"),
    [
        ("starter", "month", 1900, None),
        ("starter", "year", 13_700, None),
        ("pro", "month", 4900, "cus_existing"),
        ("ultra", "year", 107_300, "cus_existing"),
    ],
)
async def test_checkout_session_params_never_include_promotion_codes(
    monkeypatch: pytest.MonkeyPatch,
    plan_key: str,
    interval: str,
    unit_amount: int,
    customer_id: str | None,
) -> None:
    captured = await _captured_session_params(
        monkeypatch,
        plan_key=plan_key,
        interval=interval,
        unit_amount=unit_amount,
        customer_id=customer_id,
    )
    assert captured["mode"] == "subscription"
    assert "allow_promotion_codes" not in captured
    assert "discounts" not in captured


def test_no_layer_accepts_a_promotion_code_switch() -> None:
    assert "allow_promotion_codes" not in inspect.signature(StripeGateway.__init__).parameters
    assert (
        "allow_promotion_codes"
        not in inspect.signature(StripeGateway.create_checkout_session).parameters
    )
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    assert not hasattr(gateway, "allow_promotion_codes")
    assert "checkout_allow_promotion_codes" not in Settings.model_fields


def test_settings_ignore_a_promotion_code_environment_variable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CHECKOUT_ALLOW_PROMOTION_CODES", "true")
    settings = Settings(**_valid_settings())  # type: ignore[arg-type]
    assert not hasattr(settings, "checkout_allow_promotion_codes")
    ignored = Settings(**_valid_settings(checkout_allow_promotion_codes=True))  # type: ignore[arg-type]
    assert not hasattr(ignored, "checkout_allow_promotion_codes")


@pytest.mark.parametrize(
    "adjustment",
    [
        pytest.param({"discount": {}}, id="discount-object"),
        pytest.param({"discounts": ["di_promo"]}, id="discounts-list"),
        pytest.param({"total_discount_amounts": [{"amount": 100}]}, id="discount-amount"),
        pytest.param({"total_discount_amounts": [{"amount": 0}]}, id="zero-amount-discount"),
    ],
)
def test_discounted_invoice_still_fails_closed(adjustment: dict[str, Any]) -> None:
    invoice = paid_invoice("00000000-0000-0000-0000-000000000001")["data"]["object"]
    lines = invoice["lines"]["data"]
    assert has_unsupported_invoice_adjustments(invoice, lines) is False
    invoice.update(adjustment)
    assert has_unsupported_invoice_adjustments(invoice, lines) is True
