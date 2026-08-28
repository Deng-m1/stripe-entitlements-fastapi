from __future__ import annotations

from typing import Any

import pytest

from stripe_entitlements import stripe_gateway as gateway_module
from stripe_entitlements.stripe_gateway import StripeGateway


async def test_pack_reconcile_retrievers_pin_key_version_and_exact_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str, dict[str, Any]]] = []

    def retrieve_session(identity: str, **options: Any) -> dict[str, Any]:
        calls.append(("session", identity, options))
        return {"id": identity, "object": "checkout.session", "livemode": False}

    def retrieve_payment(identity: str, **options: Any) -> dict[str, Any]:
        calls.append(("payment", identity, options))
        return {"id": identity, "object": "payment_intent", "livemode": False}

    def retrieve_charge(identity: str, **options: Any) -> dict[str, Any]:
        calls.append(("charge", identity, options))
        return {"id": identity, "object": "charge", "livemode": False}

    monkeypatch.setattr(gateway_module.stripe.checkout.Session, "retrieve", retrieve_session)
    monkeypatch.setattr(gateway_module.stripe.PaymentIntent, "retrieve", retrieve_payment)
    monkeypatch.setattr(gateway_module.stripe.Charge, "retrieve", retrieve_charge)
    gateway = StripeGateway("sk_test_dummy", "whsec_test")

    session = await gateway.checkout_session_object("cs_pack")
    payment = await gateway.payment_intent_object("pi_pack")
    charge = await gateway.charge_object("ch_pack")

    assert (session["id"], payment["id"], charge["id"]) == (
        "cs_pack",
        "pi_pack",
        "ch_pack",
    )
    assert calls == [
        (
            "session",
            "cs_pack",
            {"api_key": "sk_test_dummy", "stripe_version": "2026-06-24.dahlia"},
        ),
        (
            "payment",
            "pi_pack",
            {"api_key": "sk_test_dummy", "stripe_version": "2026-06-24.dahlia"},
        ),
        (
            "charge",
            "ch_pack",
            {"api_key": "sk_test_dummy", "stripe_version": "2026-06-24.dahlia"},
        ),
    ]


@pytest.mark.parametrize(
    ("method", "identity"),
    [
        ("checkout_session_object", "pi_wrong_kind"),
        ("payment_intent_object", "ch_wrong_kind"),
        ("charge_object", "cs_wrong_kind"),
    ],
)
async def test_pack_reconcile_retrievers_reject_wrong_identity_kind_before_network(
    method: str,
    identity: str,
) -> None:
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    with pytest.raises(ValueError):
        await getattr(gateway, method)(identity)


@pytest.mark.parametrize(
    ("method", "resource", "identity", "returned"),
    [
        ("checkout_session_object", "session", "cs_expected", "cs_other"),
        ("payment_intent_object", "payment", "pi_expected", "pi_other"),
        ("charge_object", "charge", "ch_expected", "ch_other"),
    ],
)
async def test_pack_reconcile_retrievers_fail_closed_on_remote_identity_conflict(
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    resource: str,
    identity: str,
    returned: str,
) -> None:
    target = {
        "session": gateway_module.stripe.checkout.Session,
        "payment": gateway_module.stripe.PaymentIntent,
        "charge": gateway_module.stripe.Charge,
    }[resource]
    monkeypatch.setattr(
        target,
        "retrieve",
        lambda *_args, **_kwargs: {"id": returned, "livemode": False},
    )

    with pytest.raises(RuntimeError, match="different"):
        await getattr(StripeGateway("sk_test_dummy", "whsec_test"), method)(identity)


async def test_pack_reconcile_retriever_rejects_key_mode_mismatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        gateway_module.stripe.PaymentIntent,
        "retrieve",
        lambda identity, **_options: {"id": identity, "livemode": True},
    )

    with pytest.raises(RuntimeError, match="mode"):
        await StripeGateway("sk_test_dummy", "whsec_test").payment_intent_object("pi_pack")
