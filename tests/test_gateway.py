from __future__ import annotations

import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from scripts.bootstrap_stripe import _mode, _safe_portal, ensure_price
from stripe_entitlements.checkout import CheckoutCreationRejected
from stripe_entitlements.plan_changes import PlanChangeContext
from stripe_entitlements.stripe_gateway import StripeGateway
from tests.builders import event, resolved_price


class StripeObject(SimpleNamespace):
    def __str__(self) -> str:
        return json.dumps(vars(self))


def _safe_portal_payload(
    *,
    livemode: bool = False,
    product_line: str = "example-entitlements",
) -> dict[str, object]:
    return {
        "active": True,
        "livemode": livemode,
        "metadata": {"product_line": product_line},
        "features": {
            "customer_update": {
                "enabled": True,
                "allowed_updates": ["email"],
            },
            "invoice_history": {"enabled": True},
            "payment_method_update": {"enabled": True},
            "subscription_update": {"enabled": False},
            "subscription_cancel": {"enabled": True, "mode": "at_period_end"},
        },
    }


@pytest.fixture(autouse=True)
def _single_invoice_payment(monkeypatch: pytest.MonkeyPatch) -> None:
    payment_to_invoice: dict[str, str] = {}

    def list_invoice_payments(**kwargs):  # type: ignore[no-untyped-def]
        invoice_id = kwargs.get("invoice")
        payment_filter = kwargs.get("payment") or {}
        payment_intent = payment_filter.get("payment_intent")
        if invoice_id is not None:
            payment_intent = f"pi_for_{invoice_id}"
            payment_to_invoice[payment_intent] = invoice_id
        else:
            payment_intent = payment_intent or "pi_default"
            invoice_id = payment_to_invoice.get(payment_intent, "in_default")
        return SimpleNamespace(
            data=[
                StripeObject(
                    id=f"inpay_{payment_intent}",
                    invoice=invoice_id,
                    status="paid",
                    payment={
                        "type": "payment_intent",
                        "payment_intent": payment_intent,
                    },
                )
            ],
            has_more=False,
        )

    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.InvoicePayment.list",
        list_invoice_payments,
    )


@pytest.mark.parametrize("value", [None, 123, "", " padded ", "zero\u200bwidth"])
def test_gateway_object_identity_requires_visible_string(value: object) -> None:
    assert StripeGateway._object_id(value) is None
    assert StripeGateway._object_id({"id": value}) is None


def test_construct_event_strips_untrusted_internal_control_fields(monkeypatch) -> None:
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Webhook.construct_event",
        lambda *args, **kwargs: {
            "id": "evt_untrusted_internal",
            "type": "invoice.paid",
            "_remote_verified": True,
            "_expected_account": {"event_created": 999},
            "data": {
                "object": {
                    "id": "in_untrusted_internal",
                    "_unsupported_invoice_payment_shape": False,
                    "lines": {
                        "data": [
                            {
                                "id": "il_untrusted_internal",
                                "_resolved_lookup_key": "ent_ultra_month",
                                "_resolved_price": {"unit_amount": 1},
                                "amount": 1900,
                            }
                        ]
                    },
                }
            },
        },
    )

    event_payload = StripeGateway("sk_test_dummy", "whsec_test").construct_event(b"{}", "sig")
    line = event_payload["data"]["object"]["lines"]["data"][0]
    assert event_payload["id"] == "evt_untrusted_internal"
    assert "_remote_verified" not in event_payload
    assert "_expected_account" not in event_payload
    assert "_unsupported_invoice_payment_shape" not in event_payload["data"]["object"]
    assert "_resolved_lookup_key" not in line
    assert "_resolved_price" not in line
    assert line["amount"] == 1900


def test_gateway_rejects_ambiguous_or_restricted_key() -> None:
    with pytest.raises(ValueError, match="sk_test"):
        StripeGateway("rk_test_not_supported", "whsec_test")
    with pytest.raises(ValueError, match="whsec_"):
        StripeGateway("sk_test_dummy", "not-a-webhook-secret")


@pytest.mark.parametrize(
    ("key", "expected"),
    [("sk_test_value", (False, "test")), ("sk_live_value", (True, "live"))],
)
def test_bootstrap_mode_is_explicit(key: str, expected: tuple[bool, str]) -> None:
    assert _mode(key) == expected


def test_bootstrap_refuses_non_secret_key() -> None:
    with pytest.raises(RuntimeError, match="sk_test"):
        _mode("rk_test_value")


@pytest.mark.parametrize("drift", ["active", "livemode", "metadata"])
def test_portal_policy_rejects_identity_or_mode_drift(drift: str) -> None:
    config = _safe_portal_payload()
    if drift == "active":
        config["active"] = "true"
    elif drift == "livemode":
        config["livemode"] = "false"
    else:
        config["metadata"] = {"product_line": "other-product"}
    assert not _safe_portal(config)


def test_portal_policy_ignores_benign_feature_surface_changes() -> None:
    config = _safe_portal_payload()
    features = config["features"]
    assert isinstance(features, dict)
    features["future_feature"] = {"enabled": True}
    features.pop("invoice_history")
    features["customer_update"] = {
        "enabled": False,
        "allowed_updates": ["email", "address"],
    }
    features["payment_method_update"] = {"enabled": False}
    assert _safe_portal(config)


def test_portal_policy_requires_all_safety_fields() -> None:
    safe = _safe_portal_payload()
    assert _safe_portal(safe)
    update_enabled = _safe_portal_payload()
    update_enabled["features"]["subscription_update"] = {"enabled": True}
    assert not _safe_portal(update_enabled)
    immediate_cancel = _safe_portal_payload()
    immediate_cancel["features"]["subscription_cancel"] = {
        "enabled": True,
        "mode": "immediately",
    }
    assert not _safe_portal(immediate_cancel)


@pytest.mark.parametrize(
    "payload",
    [
        {"id": "evt_bad_data", "type": "invoice.paid", "data": []},
        {"id": "evt_bad_object", "type": "invoice.paid", "data": {"object": []}},
        {
            "id": "evt_missing_object_id",
            "type": "invoice.paid",
            "data": {"object": {"lines": {"data": []}}},
        },
    ],
)
async def test_prepare_event_leaves_invalid_top_level_shape_for_durable_processor_gate(
    monkeypatch, payload: dict[str, object]
) -> None:
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.retrieve",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("network call not expected")),
    )
    prepared = await StripeGateway("sk_test_dummy", "whsec_test").prepare_event(payload)  # type: ignore[arg-type]
    assert prepared == payload


async def test_prepare_subscription_deleted_does_not_fetch_mutable_price_state(
    monkeypatch,
) -> None:
    def unexpected(*args, **kwargs):  # type: ignore[no-untyped-def]
        del args, kwargs
        raise AssertionError("Price lookup not expected for customer.subscription.deleted")

    monkeypatch.setattr("stripe_entitlements.stripe_gateway.stripe.Price.retrieve", unexpected)
    payload = event(
        "customer.subscription.deleted",
        {
            "id": "sub_deleted_without_price_lookup",
            "customer": "cus_test",
            "status": "canceled",
            "metadata": {
                "account_id": "00000000-0000-0000-0000-000000000001",
                "product_line": "example-entitlements",
            },
            "items": {
                "data": [
                    {
                        "id": "si_deleted",
                        "price": {"id": "price_not_retrieved"},
                    }
                ]
            },
        },
    )

    prepared = await StripeGateway("sk_test_dummy", "whsec_test").prepare_event(payload)
    assert prepared == payload


async def test_prepare_payment_failed_does_not_fetch_price_or_payment_state(monkeypatch) -> None:
    def unexpected(*args, **kwargs):  # type: ignore[no-untyped-def]
        del args, kwargs
        raise AssertionError("network lookup not expected for invoice.payment_failed")

    monkeypatch.setattr("stripe_entitlements.stripe_gateway.stripe.Price.retrieve", unexpected)
    monkeypatch.setattr("stripe_entitlements.stripe_gateway.stripe.InvoicePayment.list", unexpected)
    payload = event(
        "invoice.payment_failed",
        {
            "id": "in_failed_without_remote_expansion",
            "customer": "cus_test",
            "subscription": "sub_test",
            "metadata": {
                "account_id": "00000000-0000-0000-0000-000000000001",
                "product_line": "example-entitlements",
            },
            "lines": {
                "data": [
                    {
                        "id": "il_failed",
                        "price": {"id": "price_not_retrieved"},
                    }
                ]
            },
        },
    )

    prepared = await StripeGateway("sk_test_dummy", "whsec_test").prepare_event(payload)
    assert prepared == payload


async def test_prepare_invoice_skips_network_for_non_object_line(monkeypatch) -> None:
    calls = 0

    def retrieve(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal calls
        calls += 1
        raise AssertionError("network call not expected")

    monkeypatch.setattr("stripe_entitlements.stripe_gateway.stripe.Price.retrieve", retrieve)
    payload = event(
        "invoice.paid",
        {"id": "in_bad_line", "lines": {"data": ["not-an-object"], "has_more": False}},
    )
    prepared = await StripeGateway("sk_test_dummy", "whsec_test").prepare_event(payload)
    assert prepared["data"]["object"]["lines"]["data"] == ["not-an-object"]
    assert calls == 0


async def test_prepare_refund_resolves_invoice_through_invoice_payment(monkeypatch) -> None:
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    page = SimpleNamespace(
        data=[
            json.dumps(
                {
                    "id": "inpay_test",
                    "invoice": "in_resolved",
                    "status": "paid",
                    "payment": {
                        "type": "payment_intent",
                        "payment_intent": "pi_test",
                    },
                }
            )
        ],
        has_more=False,
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


async def test_prepare_refund_rejects_payment_intent_allocated_to_multiple_invoices(
    monkeypatch,
) -> None:
    mappings = SimpleNamespace(
        data=[
            StripeObject(
                id="inpay_a",
                invoice="in_a",
                status="paid",
                payment={"type": "payment_intent", "payment_intent": "pi_shared"},
            ),
            StripeObject(
                id="inpay_b",
                invoice="in_b",
                status="paid",
                payment={"type": "payment_intent", "payment_intent": "pi_shared"},
            ),
        ],
        has_more=False,
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.InvoicePayment.list",
        lambda **kwargs: mappings,
    )
    payload = event(
        "charge.refunded",
        {
            "id": "ch_shared_payment_intent",
            "customer": "cus_test",
            "payment_intent": "pi_shared",
            "amount": 1900,
            "amount_refunded": 950,
            "refunded": False,
        },
    )

    prepared = await StripeGateway("sk_test_dummy", "whsec_test").prepare_event(payload)
    charge = prepared["data"]["object"]
    assert charge["_unsupported_invoice_payment_shape"] is True
    assert "_resolved_invoice_id" not in charge


async def test_prepare_refund_retries_until_payment_intent_invoice_mapping_exists(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.InvoicePayment.list",
        lambda **kwargs: SimpleNamespace(data=[], has_more=False),
    )
    payload = event(
        "charge.refunded",
        {
            "id": "ch_pending_mapping",
            "customer": "cus_test",
            "payment_intent": "pi_pending_mapping",
            "amount": 1900,
            "amount_refunded": 950,
            "refunded": False,
        },
    )
    with pytest.raises(RuntimeError, match="not exposed"):
        await StripeGateway("sk_test_dummy", "whsec_test").prepare_event(payload)


async def test_prepare_refund_retries_on_conflicting_charge_and_invoice_payment_identity(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.InvoicePayment.list",
        lambda **kwargs: SimpleNamespace(
            data=[
                StripeObject(
                    id="inpay_conflict",
                    invoice="in_conflict",
                    status="paid",
                    payment={"type": "payment_intent", "payment_intent": "pi_other"},
                )
            ],
            has_more=False,
        ),
    )
    payload = event(
        "charge.refunded",
        {
            "id": "ch_conflicting_payment_identity",
            "customer": "cus_test",
            "invoice": "in_conflict",
            "payment_intent": "pi_charge",
            "amount": 1900,
            "amount_refunded": 950,
            "refunded": False,
        },
    )

    with pytest.raises(RuntimeError, match="conflicting InvoicePayment payment identity"):
        await StripeGateway("sk_test_dummy", "whsec_test").prepare_event(payload)


async def test_prepare_refund_marks_multi_payment_invoice_unsupported(monkeypatch) -> None:
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    payments = SimpleNamespace(
        data=[
            StripeObject(
                id="inpay_a",
                status="paid",
                payment={"type": "payment_intent", "payment_intent": "pi_a"},
            ),
            StripeObject(
                id="inpay_b",
                status="paid",
                payment={"type": "payment_intent", "payment_intent": "pi_b"},
            ),
        ],
        has_more=False,
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.InvoicePayment.list",
        lambda **kwargs: payments,
    )
    payload = event(
        "charge.refunded",
        {
            "id": "ch_multi",
            "customer": "cus_test",
            "invoice": "in_multi_payment",
            "amount": 1000,
            "amount_refunded": 500,
            "refunded": False,
        },
    )
    prepared = await gateway.prepare_event(payload)
    assert prepared["data"]["object"]["_unsupported_invoice_payment_shape"] is True


async def test_prepare_paid_invoice_uses_one_invoice_scoped_payment_query(
    monkeypatch,
) -> None:
    calls: list[dict[str, object]] = []

    def list_payments(**kwargs):  # type: ignore[no-untyped-def]
        calls.append(dict(kwargs))
        return SimpleNamespace(
            data=[
                StripeObject(
                    id="inpay_single_query",
                    invoice="in_single_query",
                    status="paid",
                    payment={
                        "type": "payment_intent",
                        "payment_intent": "pi_single_query",
                    },
                )
            ],
            has_more=False,
        )

    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.InvoicePayment.list",
        list_payments,
    )
    payload = event(
        "invoice.paid",
        {"id": "in_single_query", "lines": {"data": [], "has_more": False}},
    )
    prepared = await StripeGateway("sk_test_dummy", "whsec_test").prepare_event(payload)
    assert "_unsupported_invoice_payment_shape" not in prepared["data"]["object"]
    assert len(calls) == 1
    assert calls[0]["invoice"] == "in_single_query"
    assert "payment" not in calls[0]


async def test_prepare_paid_invoice_retries_when_invoice_payment_mapping_is_not_visible(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.InvoicePayment.list",
        lambda **kwargs: SimpleNamespace(data=[], has_more=False),
    )
    payload = event(
        "invoice.paid",
        {"id": "in_missing_payment", "lines": {"data": [], "has_more": False}},
    )
    with pytest.raises(RuntimeError, match="not exposed"):
        await StripeGateway("sk_test_dummy", "whsec_test").prepare_event(payload)


@pytest.mark.parametrize(
    "collection",
    [
        SimpleNamespace(data=None, has_more=False),
        SimpleNamespace(data=[], has_more=None),
    ],
)
async def test_prepare_paid_invoice_retries_malformed_invoice_payment_collection(
    monkeypatch, collection: SimpleNamespace
) -> None:
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.InvoicePayment.list",
        lambda **kwargs: collection,
    )
    payload = event(
        "invoice.paid",
        {"id": "in_bad_payment_collection", "lines": {"data": [], "has_more": False}},
    )
    with pytest.raises(RuntimeError, match="invalid InvoicePayment collection"):
        await StripeGateway("sk_test_dummy", "whsec_test").prepare_event(payload)


async def test_prepare_paid_invoice_marks_multiple_invoice_payments_unsupported(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.InvoicePayment.list",
        lambda **kwargs: SimpleNamespace(
            data=[
                StripeObject(
                    id="inpay_1",
                    status="paid",
                    payment={"type": "payment_intent", "payment_intent": "pi_1"},
                ),
                StripeObject(
                    id="inpay_2",
                    status="paid",
                    payment={"type": "payment_intent", "payment_intent": "pi_2"},
                ),
            ],
            has_more=False,
        ),
    )
    payload = event(
        "invoice.paid",
        {"id": "in_multiple_payments", "lines": {"data": [], "has_more": False}},
    )
    prepared = await StripeGateway("sk_test_dummy", "whsec_test").prepare_event(payload)
    assert prepared["data"]["object"]["_unsupported_invoice_payment_shape"] is True


async def test_prepare_invoice_resolves_dahlia_price_reference(monkeypatch) -> None:
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.retrieve",
        lambda price_id, **kwargs: StripeObject(
            **{**resolved_price("starter", "month"), "id": price_id}
        ),
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


async def test_prepare_invoice_deduplicates_price_retrievals(monkeypatch) -> None:
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    calls: list[str] = []

    def retrieve(price_id, **kwargs):  # type: ignore[no-untyped-def]
        del kwargs
        calls.append(price_id)
        return StripeObject(**{**resolved_price("starter", "month"), "id": price_id})

    monkeypatch.setattr("stripe_entitlements.stripe_gateway.stripe.Price.retrieve", retrieve)
    payload = event(
        "invoice.paid",
        {
            "id": "in_duplicate_prices",
            "lines": {
                "data": [
                    {"id": "il_1", "price": {"id": "price_same"}},
                    {"id": "il_2", "price": {"id": "price_same"}},
                ]
            },
        },
    )
    prepared = await gateway.prepare_event(payload)
    lines = prepared["data"]["object"]["lines"]["data"]
    assert calls == ["price_same"]
    assert [line["_resolved_lookup_key"] for line in lines] == [
        "ent_starter_month",
        "ent_starter_month",
    ]


async def test_prepare_invoice_materializes_every_paginated_line(monkeypatch) -> None:
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    calls: list[str | None] = []

    def list_lines(invoice_id, **kwargs):  # type: ignore[no-untyped-def]
        calls.append(kwargs.get("starting_after"))
        if len(calls) == 1:
            return SimpleNamespace(
                data=[
                    StripeObject(
                        id="il_source",
                        amount=-950,
                        quantity=1,
                        proration=True,
                        price={"id": "price_source", "lookup_key": "ent_starter_month"},
                    )
                ],
                has_more=True,
            )
        return SimpleNamespace(
            data=[
                StripeObject(
                    id="il_target",
                    amount=2450,
                    quantity=1,
                    proration=True,
                    price={"id": "price_target", "lookup_key": "ent_pro_month"},
                )
            ],
            has_more=False,
        )

    monkeypatch.setattr("stripe_entitlements.stripe_gateway.stripe.Invoice.list_lines", list_lines)

    def retrieve(price_id, **kwargs):  # type: ignore[no-untyped-def]
        del kwargs
        plan = "starter" if price_id == "price_source" else "pro"
        return StripeObject(**{**resolved_price(plan, "month"), "id": price_id})

    monkeypatch.setattr("stripe_entitlements.stripe_gateway.stripe.Price.retrieve", retrieve)
    payload = event(
        "invoice.paid",
        {
            "id": "in_paginated",
            "lines": {"data": [{"id": "il_embedded"}], "has_more": True},
        },
    )
    prepared = await gateway.prepare_event(payload)
    lines = prepared["data"]["object"]["lines"]
    assert [line["id"] for line in lines["data"]] == ["il_source", "il_target"]
    assert lines["has_more"] is False
    assert lines["_all_lines_loaded"] is True
    assert calls == [None, "il_source"]


@pytest.mark.parametrize(
    ("failure", "expected_reason"),
    [
        ("data_not_list", "invalid shape"),
        ("has_more_not_bool", "invalid shape"),
        ("missing_identity", "missing or duplicate identity"),
        ("duplicate_identity", "missing or duplicate identity"),
        ("empty_page", "did not advance"),
        ("too_many", "more than the supported 1000 lines"),
    ],
)
async def test_prepare_paginated_invoice_shape_failures_become_durable_markers(
    monkeypatch, failure: str, expected_reason: str
) -> None:
    calls = 0

    def list_lines(invoice_id, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal calls
        del invoice_id, kwargs
        calls += 1
        if failure == "data_not_list":
            return SimpleNamespace(data=(), has_more=False)
        if failure == "has_more_not_bool":
            return SimpleNamespace(data=[StripeObject(id="il_1")], has_more="false")
        if failure == "missing_identity":
            return SimpleNamespace(data=[StripeObject(amount=1900)], has_more=False)
        if failure == "duplicate_identity":
            return SimpleNamespace(
                data=[StripeObject(id="il_1")],
                has_more=calls == 1,
            )
        if failure == "empty_page":
            return SimpleNamespace(data=[], has_more=True)
        return SimpleNamespace(
            data=[StripeObject(id=f"il_{index}") for index in range(1001)],
            has_more=False,
        )

    monkeypatch.setattr("stripe_entitlements.stripe_gateway.stripe.Invoice.list_lines", list_lines)
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.retrieve",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("Price lookup not expected")),
    )
    payload = event(
        "invoice.paid",
        {
            "id": f"in_bad_pagination_{failure}",
            "lines": {"data": [{"id": "il_embedded"}], "has_more": True},
        },
    )

    prepared = await StripeGateway("sk_test_dummy", "whsec_test").prepare_event(payload)
    invoice = prepared["data"]["object"]
    assert expected_reason in invoice["_preparation_error"]
    assert invoice["lines"]["has_more"] is True
    assert invoice["lines"]["_all_lines_loaded"] is False


async def test_checkout_uses_pinned_version_and_server_built_success_query(
    monkeypatch,
) -> None:
    captured: dict[str, object] = {}
    price_list_kwargs: dict[str, object] = {}

    def list_prices(**kwargs):  # type: ignore[no-untyped-def]
        price_list_kwargs.update(kwargs)
        return SimpleNamespace(
            data=[
                StripeObject(
                    id="price_starter",
                    lookup_key="ent_starter_month",
                    product={
                        "id": "prod_starter",
                        "active": True,
                        "metadata": {
                            "product_line": "example-entitlements",
                            "plan": "starter",
                        },
                    },
                    currency="usd",
                    unit_amount=1900,
                    recurring={"interval": "month"},
                )
            ]
        )

    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.list",
        list_prices,
    )

    def create(**kwargs):  # type: ignore[no-untyped-def]
        captured.update(kwargs)
        return SimpleNamespace(
            id="cs_test",
            url="https://checkout.stripe.com/c/pay/session#stripe-hosted-state",
        )

    monkeypatch.setattr("stripe_entitlements.stripe_gateway.stripe.checkout.Session.create", create)
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    session_id, session_url = await gateway.create_checkout_session(
        account_id="00000000-0000-0000-0000-000000000001",
        customer_id=None,
        lookup_key="ent_starter_month",
        expected_currency="usd",
        expected_unit_amount=1900,
        expected_interval="month",
        claim_token="claim-1",
        expires_at=datetime(2026, 8, 1, tzinfo=UTC),
        customer_email="user@example.test",
        plan_key="starter",
        interval="month",
    )
    assert session_id == "cs_test"
    assert session_url.endswith("#stripe-hosted-state")
    success_url = str(captured["success_url"])
    assert "expected_plan=starter" in success_url
    assert "expected_interval=month" in success_url
    assert "checkout_session_id={CHECKOUT_SESSION_ID}" in success_url
    assert captured["stripe_version"] == "2026-06-24.dahlia"
    assert captured["subscription_data"]["metadata"]["claim_token"] == "claim-1"
    assert captured["metadata"]["product_line"] == "example-entitlements"
    assert "allow_promotion_codes" not in captured
    assert price_list_kwargs["expand"] == ["data.currency_options", "data.product"]


@pytest.mark.parametrize(
    ("session_id", "session_url"),
    [
        (None, "https://checkout.test/session"),
        ("cs_test", None),
        ("cs_test", "http://checkout.test/session"),
        (" padded ", "https://checkout.test/session"),
    ],
)
async def test_checkout_rejects_invalid_stripe_session_identity(
    monkeypatch, session_id: object, session_url: object
) -> None:
    price = StripeObject(**resolved_price("starter", "month"))
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.list",
        lambda **kwargs: SimpleNamespace(data=[price]),
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.checkout.Session.create",
        lambda **kwargs: SimpleNamespace(id=session_id, url=session_url),
    )
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    with pytest.raises(RuntimeError, match="Stripe returned"):
        await gateway.create_checkout_session(
            account_id="00000000-0000-0000-0000-000000000001",
            customer_id=None,
            lookup_key="ent_starter_month",
            expected_currency="usd",
            expected_unit_amount=1900,
            expected_interval="month",
            claim_token="claim-invalid-return",
            expires_at=datetime(2026, 8, 1, tzinfo=UTC),
            customer_email="user@example.test",
            plan_key="starter",
            interval="month",
        )


async def test_checkout_rejects_catalog_price_drift_before_session_creation(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.list",
        lambda **kwargs: SimpleNamespace(
            data=[
                StripeObject(
                    id="price_drifted",
                    lookup_key="ent_starter_month",
                    product={
                        "id": "prod_starter",
                        "active": True,
                        "metadata": {
                            "product_line": "example-entitlements",
                            "plan": "starter",
                        },
                    },
                    currency="usd",
                    unit_amount=1,
                    recurring={"interval": "month"},
                )
            ]
        ),
    )
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    with pytest.raises(CheckoutCreationRejected, match="drifted"):
        await gateway.create_checkout_session(
            account_id="00000000-0000-0000-0000-000000000001",
            customer_id=None,
            lookup_key="ent_starter_month",
            expected_currency="usd",
            expected_unit_amount=1900,
            expected_interval="month",
            claim_token="claim-drift",
            expires_at=datetime(2026, 8, 1, tzinfo=UTC),
            customer_email="user@example.test",
            plan_key="starter",
            interval="month",
        )


@pytest.mark.parametrize(
    ("drift", "value"),
    [
        ("interval_count", 2),
        ("usage_type", "metered"),
        ("billing_scheme", "tiered"),
        ("transform_quantity", {"divide_by": 10, "round": "up"}),
        ("type", "one_time"),
        ("tax_behavior", "exclusive"),
        ("currency_options", {"eur": {"unit_amount": 1900}}),
        ("product_plan", "ultra"),
        ("product_line", "other-product"),
        ("product_active", False),
    ],
)
async def test_checkout_rejects_unsupported_recurring_price_shape(
    monkeypatch, drift: str, value: object
) -> None:
    price: dict[str, object] = {
        "id": "price_starter",
        "lookup_key": "ent_starter_month",
        "product": {
            "id": "prod_starter",
            "active": True,
            "metadata": {
                "product_line": "example-entitlements",
                "plan": "starter",
            },
        },
        "active": True,
        "type": "recurring",
        "currency": "usd",
        "unit_amount": 1900,
        "billing_scheme": "per_unit",
        "recurring": {
            "interval": "month",
            "interval_count": 1,
            "usage_type": "licensed",
        },
        "tax_behavior": "unspecified",
        "tiers_mode": None,
        "transform_quantity": None,
        "custom_unit_amount": None,
        "currency_options": None,
    }
    if drift in {"interval_count", "usage_type"}:
        price["recurring"][drift] = value  # type: ignore[index]
    elif drift == "product_plan":
        price["product"]["metadata"]["plan"] = value  # type: ignore[index]
    elif drift == "product_line":
        price["product"]["metadata"]["product_line"] = value  # type: ignore[index]
    elif drift == "product_active":
        price["product"]["active"] = value  # type: ignore[index]
    else:
        price[drift] = value
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.list",
        lambda **kwargs: SimpleNamespace(data=[StripeObject(**price)]),
    )

    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    with pytest.raises(CheckoutCreationRejected, match="drifted"):
        await gateway.create_checkout_session(
            account_id="00000000-0000-0000-0000-000000000001",
            customer_id=None,
            lookup_key="ent_starter_month",
            expected_currency="usd",
            expected_unit_amount=1900,
            expected_interval="month",
            claim_token="claim-shape-drift",
            expires_at=datetime(2026, 8, 1, tzinfo=UTC),
            customer_email="user@example.test",
            plan_key="starter",
            interval="month",
        )


def test_bootstrap_replaces_price_outside_runtime_policy(monkeypatch, catalog) -> None:  # type: ignore[no-untyped-def]
    plan = catalog.require("starter")
    product = StripeObject(
        id="prod_starter",
        metadata={"product_line": "example-entitlements", "plan": "starter"},
    )
    old = StripeObject(
        id="price_metered",
        lookup_key="ent_starter_month",
        product={
            "id": product.id,
            "active": True,
            "metadata": product.metadata,
        },
        active=True,
        type="recurring",
        currency="usd",
        unit_amount=1900,
        billing_scheme="per_unit",
        recurring={
            "interval": "month",
            "interval_count": 1,
            "usage_type": "metered",
        },
        tax_behavior="unspecified",
        tiers_mode=None,
        transform_quantity=None,
        custom_unit_amount=None,
        currency_options=None,
    )
    created: dict[str, object] = {}
    deactivated: list[str] = []

    monkeypatch.setattr(
        "scripts.bootstrap_stripe.stripe.Price.list",
        lambda **kwargs: SimpleNamespace(data=[old]),
    )

    def create(**kwargs):  # type: ignore[no-untyped-def]
        created.update(kwargs)
        return StripeObject(id="price_replacement")

    def modify(price_id, **kwargs):  # type: ignore[no-untyped-def]
        assert kwargs["active"] is False
        deactivated.append(price_id)
        return StripeObject(id=price_id)

    monkeypatch.setattr("scripts.bootstrap_stripe.stripe.Price.create", create)
    monkeypatch.setattr("scripts.bootstrap_stripe.stripe.Price.modify", modify)

    replacement = ensure_price("sk_test_dummy", catalog, product, plan, "month")
    assert replacement.id == "price_replacement"
    assert created["recurring"] == {
        "interval": "month",
        "interval_count": 1,
        "usage_type": "licensed",
    }
    assert deactivated == ["price_metered"]


async def test_runtime_portal_rejects_dashboard_policy_drift(monkeypatch) -> None:
    gateway = StripeGateway("sk_test_dummy", "whsec_test", portal_configuration_id="bpc_test")
    unsafe = StripeObject(
        active=True,
        livemode=False,
        features={
            "subscription_update": {"enabled": True},
            "subscription_cancel": {"enabled": True, "mode": "at_period_end"},
        },
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.billing_portal.Configuration.retrieve",
        lambda *args, **kwargs: unsafe,
    )
    with pytest.raises(RuntimeError, match="drifted"):
        await gateway.create_portal_session(customer_id="cus_test", idempotency_key="portal:1")


@pytest.mark.parametrize(
    ("session_id", "session_url"),
    [
        (None, "https://billing.stripe.test/session"),
        ("bps_test", None),
        ("bps_test", "http://billing.stripe.test/session"),
    ],
)
async def test_portal_rejects_invalid_stripe_session_identity(
    monkeypatch, session_id: object, session_url: object
) -> None:
    gateway = StripeGateway("sk_test_dummy", "whsec_test", portal_configuration_id="bpc_test")
    safe = StripeObject(**_safe_portal_payload())
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.billing_portal.Configuration.retrieve",
        lambda *args, **kwargs: safe,
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.billing_portal.Session.create",
        lambda **kwargs: SimpleNamespace(id=session_id, url=session_url),
    )
    with pytest.raises(RuntimeError, match="Stripe returned"):
        await gateway.create_portal_session(customer_id="cus_test", idempotency_key="portal:1")


async def test_latest_paid_invoice_event_validates_identity_and_uses_paid_timestamp(
    monkeypatch,
) -> None:
    invoice = StripeObject(
        id="in_latest_paid",
        subscription="sub_latest_paid",
        status="paid",
        livemode=False,
        created=100,
        status_transitions={"paid_at": 120},
        lines={"data": [], "has_more": False},
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Invoice.list",
        lambda **kwargs: SimpleNamespace(data=[invoice]),
    )

    prepared = await StripeGateway("sk_test_dummy", "whsec_test").latest_paid_invoice_event(
        "sub_latest_paid"
    )
    assert prepared is not None
    assert prepared["id"] == "reconcile:in_latest_paid"
    assert prepared["created"] == 120
    assert prepared["livemode"] is False
    assert prepared["_remote_verified"] is True


@pytest.mark.parametrize(
    ("malformation", "message"),
    [
        ("collection", "invalid Invoice collection"),
        ("invoice_id", "without stable identity"),
        ("subscription", "different Subscription"),
        ("status", "not paid"),
        ("livemode_type", "mode does not match"),
        ("livemode_value", "mode does not match"),
        ("created", "invalid creation timestamp"),
    ],
)
async def test_latest_paid_invoice_event_rejects_remote_contract_drift(
    monkeypatch, malformation: str, message: str
) -> None:
    invoice: dict[str, object] = {
        "id": "in_latest_drift",
        "subscription": "sub_latest_drift",
        "status": "paid",
        "livemode": False,
        "created": 100,
        "status_transitions": {"paid_at": 120},
        "lines": {"data": [], "has_more": False},
    }
    collection: object = [StripeObject(**invoice)]
    if malformation == "collection":
        collection = None
    elif malformation == "invoice_id":
        invoice["id"] = None
        collection = [StripeObject(**invoice)]
    elif malformation == "subscription":
        invoice["subscription"] = "sub_other"
        collection = [StripeObject(**invoice)]
    elif malformation == "status":
        invoice["status"] = "open"
        collection = [StripeObject(**invoice)]
    elif malformation == "livemode_type":
        invoice["livemode"] = "false"
        collection = [StripeObject(**invoice)]
    elif malformation == "livemode_value":
        invoice["livemode"] = True
        collection = [StripeObject(**invoice)]
    else:
        invoice["status_transitions"] = {"paid_at": "120"}
        invoice["created"] = "100"
        collection = [StripeObject(**invoice)]
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Invoice.list",
        lambda **kwargs: SimpleNamespace(data=collection),
    )

    with pytest.raises(RuntimeError, match=message):
        await StripeGateway("sk_test_dummy", "whsec_test").latest_paid_invoice_event(
            "sub_latest_drift"
        )


async def test_latest_paid_invoice_event_returns_none_when_no_paid_invoice(monkeypatch) -> None:
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Invoice.list",
        lambda **kwargs: SimpleNamespace(data=[]),
    )
    result = await StripeGateway("sk_test_dummy", "whsec_test").latest_paid_invoice_event(
        "sub_without_paid_invoice"
    )
    assert result is None


async def test_subscription_snapshot_marks_paginated_items_incomplete(monkeypatch) -> None:
    subscription = StripeObject(
        id="sub_paginated_items",
        livemode=False,
        status="active",
        items={
            "has_more": True,
            "data": [
                {
                    "id": "si_first_only",
                    "quantity": 1,
                    "current_period_end": 1_802_592_000,
                    "price": {
                        "id": "price_starter_year",
                        "lookup_key": "ent_starter_year",
                    },
                }
            ],
        },
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Subscription.retrieve",
        lambda *args, **kwargs: subscription,
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.retrieve",
        lambda price_id, **kwargs: StripeObject(
            **{**resolved_price("starter", "year"), "id": price_id}
        ),
    )

    snapshot = await StripeGateway("sk_test_dummy", "whsec_test").subscription_snapshot(
        "sub_paginated_items"
    )
    assert snapshot.items_complete is False
    assert snapshot.lookup_key is None
    assert snapshot.quantity is None
    assert snapshot.resolved_price is None


async def test_dahlia_item_period_and_immediate_preview_shape(monkeypatch) -> None:
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.list",
        lambda **kwargs: SimpleNamespace(
            data=[
                StripeObject(
                    id="price_pro_month",
                    lookup_key="ent_pro_month",
                    product={
                        "id": "prod_pro",
                        "active": True,
                        "metadata": {
                            "product_line": "example-entitlements",
                            "plan": "pro",
                        },
                    },
                    currency="usd",
                    unit_amount=4900,
                    recurring={"interval": "month"},
                )
            ]
        ),
    )
    subscription = StripeObject(
        id="sub_test",
        livemode=False,
        status="active",
        cancel_at_period_end=False,
        schedule=None,
        items={
            "data": [
                {
                    "id": "si_test",
                    "quantity": 1,
                    "current_period_start": 1_800_000_000,
                    "current_period_end": 1_802_592_000,
                    "price": {
                        "id": "price_starter_month",
                        "lookup_key": "ent_starter_month",
                    },
                }
            ]
        },
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Subscription.retrieve",
        lambda *args, **kwargs: subscription,
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.retrieve",
        lambda price_id, **kwargs: StripeObject(
            **{**resolved_price("starter", "month"), "id": price_id}
        ),
    )
    context = await gateway.prepare_plan_change(
        "sub_test",
        "ent_pro_month",
        expected_currency="usd",
        expected_unit_amount=4900,
        expected_plan_key="pro",
        target_interval="month",
        expected_source_lookup_key="ent_starter_month",
        expected_source_currency="usd",
        expected_source_unit_amount=1900,
        expected_source_plan_key="starter",
        source_interval="month",
    )
    assert context.current_period_end == datetime.fromtimestamp(1_802_592_000, tz=UTC)
    preview = StripeObject(
        amount_due=4900,
        subtotal=4900,
        total=4900,
        starting_balance=0,
        ending_balance=0,
        pre_payment_credit_notes_amount=0,
        post_payment_credit_notes_amount=0,
        currency="usd",
        total_tax_amounts=[],
        total_discount_amounts=[],
        lines={
            "has_more": False,
            "data": [
                {
                    "id": "il_target",
                    "amount": 4900,
                    "quantity": 1,
                    "currency": "usd",
                    "proration": False,
                    "price": {"id": "price_pro_month"},
                    "period": {"start": 1_801_000_000, "end": 1_803_592_000},
                },
            ],
        },
    )
    captured_preview: dict[str, object] = {}

    def create_preview(**kwargs):  # type: ignore[no-untyped-def]
        captured_preview.update(kwargs)
        return preview

    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Invoice.create_preview",
        create_preview,
    )
    estimate = await gateway.preview_immediate_plan_change(context)
    assert estimate.safe_invoice_shape
    assert estimate.amount_due == 4900
    assert estimate.proration_credit == 0
    assert estimate.customer_balance_credit == 0
    details = captured_preview["subscription_details"]
    assert details["billing_cycle_anchor"] == "now"  # type: ignore[index]
    assert details["proration_behavior"] == "none"  # type: ignore[index]
    assert "proration_date" not in details  # type: ignore[operator]


async def test_plan_change_rejects_drifted_source_price_product(monkeypatch) -> None:
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    target = StripeObject(**resolved_price("pro", "month"))
    subscription = StripeObject(
        id="sub_test",
        livemode=False,
        status="active",
        schedule=None,
        items={
            "data": [
                {
                    "id": "si_test",
                    "quantity": 1,
                    "current_period_start": 1_800_000_000,
                    "current_period_end": 1_802_592_000,
                    "price": {
                        "id": "price_starter_month",
                        "lookup_key": "ent_starter_month",
                    },
                }
            ]
        },
    )
    drifted_source = resolved_price("starter", "month")
    drifted_source["product"]["metadata"]["plan"] = "ultra"
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.list",
        lambda **kwargs: SimpleNamespace(data=[target]),
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Subscription.retrieve",
        lambda *args, **kwargs: subscription,
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.retrieve",
        lambda price_id, **kwargs: StripeObject(**{**drifted_source, "id": price_id}),
    )

    with pytest.raises(RuntimeError, match="authorized source plan"):
        await gateway.prepare_plan_change(
            "sub_test",
            "ent_pro_month",
            expected_currency="usd",
            expected_unit_amount=4900,
            expected_plan_key="pro",
            target_interval="month",
            expected_source_lookup_key="ent_starter_month",
            expected_source_currency="usd",
            expected_source_unit_amount=1900,
            expected_source_plan_key="starter",
            source_interval="month",
        )


@pytest.mark.parametrize(
    "quantity",
    [None, 2, "1"],
)
async def test_plan_change_requires_exactly_one_source_subscription_item(
    monkeypatch, quantity: object
) -> None:
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    target = StripeObject(**resolved_price("pro", "month"))
    source = resolved_price("starter", "month")
    subscription = StripeObject(
        id="sub_test",
        livemode=False,
        status="active",
        schedule=None,
        items={
            "data": [
                {
                    "id": "si_test",
                    "quantity": quantity,
                    "current_period_start": 1_800_000_000,
                    "current_period_end": 1_802_592_000,
                    "price": {
                        "id": "price_starter_month",
                        "lookup_key": "ent_starter_month",
                    },
                }
            ]
        },
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.list",
        lambda **kwargs: SimpleNamespace(data=[target]),
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Subscription.retrieve",
        lambda *args, **kwargs: subscription,
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.retrieve",
        lambda price_id, **kwargs: StripeObject(**{**source, "id": price_id}),
    )
    with pytest.raises(RuntimeError, match="quantity"):
        await gateway.prepare_plan_change(
            "sub_test",
            "ent_pro_month",
            expected_currency="usd",
            expected_unit_amount=4900,
            expected_plan_key="pro",
            target_interval="month",
            expected_source_lookup_key="ent_starter_month",
            expected_source_currency="usd",
            expected_source_unit_amount=1900,
            expected_source_plan_key="starter",
            source_interval="month",
        )


@pytest.mark.parametrize(
    ("malformation", "message"),
    [
        ("subscription_id", "different Subscription identity"),
        ("items_pagination", "exactly one item object"),
        ("item_id", "Subscription item id"),
        ("period_type", "integer timestamps"),
        ("period_order", "period is invalid"),
        ("schedule", "Schedule identity"),
        ("status", "Subscription status"),
        ("cancel", "cancel_at_period_end"),
        ("pending_shape", "pending_update shape"),
        ("pending_expiry", "integer expiry"),
        ("latest_invoice", "expand the latest Invoice"),
        ("confirmation", "confirmation_secret shape"),
        ("client_secret", "payment client secret"),
        ("recovery_url", "non-HTTPS"),
        ("target_price_id", "target Price id"),
    ],
)
async def test_prepare_plan_change_rejects_malformed_subscription_contract(
    monkeypatch, malformation: str, message: str
) -> None:
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    target = resolved_price("pro", "month")
    source = resolved_price("starter", "month")
    subscription: dict[str, object] = {
        "id": "sub_test",
        "livemode": False,
        "status": "active",
        "cancel_at_period_end": False,
        "schedule": None,
        "pending_update": None,
        "latest_invoice": None,
        "items": {
            "data": [
                {
                    "id": "si_test",
                    "quantity": 1,
                    "current_period_start": 1_800_000_000,
                    "current_period_end": 1_802_592_000,
                    "price": {
                        "id": "price_starter_month",
                        "lookup_key": "ent_starter_month",
                    },
                }
            ]
        },
    }
    if malformation == "subscription_id":
        subscription["id"] = "sub_other"
    elif malformation == "items_pagination":
        subscription["items"]["has_more"] = True  # type: ignore[index]
    elif malformation == "item_id":
        subscription["items"]["data"][0]["id"] = None  # type: ignore[index]
    elif malformation == "period_type":
        subscription["items"]["data"][0]["current_period_start"] = "1800000000"  # type: ignore[index]
    elif malformation == "period_order":
        subscription["items"]["data"][0]["current_period_end"] = 1_700_000_000  # type: ignore[index]
    elif malformation == "schedule":
        subscription["schedule"] = {}
    elif malformation == "status":
        subscription["status"] = "future_status"
    elif malformation == "cancel":
        subscription["cancel_at_period_end"] = "false"
    elif malformation == "pending_shape":
        subscription["pending_update"] = "invalid"
    elif malformation == "pending_expiry":
        subscription["pending_update"] = {"expires_at": "1800000100"}
    elif malformation == "latest_invoice":
        subscription["latest_invoice"] = "in_latest"
    elif malformation == "confirmation":
        subscription["latest_invoice"] = {
            "id": "in_latest",
            "confirmation_secret": "invalid",
        }
    elif malformation == "client_secret":
        subscription["latest_invoice"] = {
            "id": "in_latest",
            "confirmation_secret": {"client_secret": 123},
        }
    elif malformation == "recovery_url":
        subscription["latest_invoice"] = {
            "id": "in_latest",
            "hosted_invoice_url": "http://invoice.invalid/recover",
        }
    else:
        target["id"] = None
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.list",
        lambda **kwargs: SimpleNamespace(data=[StripeObject(**target)]),
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Subscription.retrieve",
        lambda *args, **kwargs: StripeObject(**subscription),
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.retrieve",
        lambda price_id, **kwargs: StripeObject(**{**source, "id": price_id}),
    )
    with pytest.raises(RuntimeError, match=message):
        await gateway.prepare_plan_change(
            "sub_test",
            "ent_pro_month",
            expected_currency="usd",
            expected_unit_amount=4900,
            expected_plan_key="pro",
            target_interval="month",
            expected_source_lookup_key="ent_starter_month",
            expected_source_currency="usd",
            expected_source_unit_amount=1900,
            expected_source_plan_key="starter",
            source_interval="month",
        )


async def test_immediate_apply_resets_anchor_without_proration_date(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def modify(subscription_id, **kwargs):  # type: ignore[no-untyped-def]
        captured.update({"subscription_id": subscription_id, **kwargs})
        return StripeObject(
            id=subscription_id,
            livemode=False,
            status="active",
            pending_update=None,
            latest_invoice={
                "id": "in_full_target",
                "hosted_invoice_url": "https://invoice.test/paid",
                "confirmation_secret": {"client_secret": "pi_paid_secret_test"},
            },
        )

    monkeypatch.setattr("stripe_entitlements.stripe_gateway.stripe.Subscription.modify", modify)
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    context = PlanChangeContext(
        "sub_test",
        "si_test",
        "price_starter_month",
        "ent_starter_month",
        "price_pro_month",
        "month",
        datetime.fromtimestamp(1_800_000_000, tz=UTC),
        datetime.fromtimestamp(1_802_592_000, tz=UTC),
        None,
    )

    result = await gateway.apply_immediate_plan_change(
        context, idempotency_key="change:full-target"
    )
    assert result.pending_update is False
    assert result.pending_expires_at is None
    assert result.recovery_url is None
    assert result.client_secret is None
    assert result.settlement_invoice_id == "in_full_target"
    assert captured["billing_cycle_anchor"] == "now"
    assert captured["proration_behavior"] == "none"
    assert "proration_date" not in captured


@pytest.mark.parametrize(
    ("malformation", "message"),
    [
        ("subscription_id", "different Subscription"),
        ("livemode", "mode does not match"),
        ("status", "unsupported Subscription status"),
        ("pending_shape", "pending_update shape"),
        ("pending_missing_expiry", "missing an integer expiry"),
        ("latest_invoice_shape", "expanded latest Invoice"),
        ("invoice_id", "without identity"),
        ("confirmation_shape", "confirmation_secret shape"),
        ("pending_expiry", "pending_update expiry"),
        ("recovery_url", "non-HTTPS"),
        ("client_secret", "payment client secret"),
    ],
)
async def test_immediate_apply_rejects_ambiguous_remote_result(
    monkeypatch, malformation: str, message: str
) -> None:
    subscription: dict[str, object] = {
        "id": "sub_test",
        "livemode": False,
        "status": "active",
        "pending_update": None,
        "latest_invoice": {"id": "in_result"},
    }
    if malformation == "subscription_id":
        subscription["id"] = "sub_other"
    elif malformation == "livemode":
        subscription["livemode"] = "false"
    elif malformation == "status":
        subscription["status"] = "future_status"
    elif malformation == "pending_shape":
        subscription["pending_update"] = "invalid"
    elif malformation == "pending_missing_expiry":
        subscription["pending_update"] = {"subscription_items": []}
    elif malformation == "latest_invoice_shape":
        subscription["latest_invoice"] = "in_result"
    elif malformation == "invoice_id":
        subscription["latest_invoice"] = {}
    elif malformation == "confirmation_shape":
        subscription["latest_invoice"] = {
            "id": "in_result",
            "confirmation_secret": "invalid",
        }
    elif malformation == "pending_expiry":
        subscription["pending_update"] = {"expires_at": "123"}
    elif malformation == "recovery_url":
        subscription["latest_invoice"] = {
            "id": "in_result",
            "hosted_invoice_url": "http://invoice.invalid/recover",
        }
    else:
        subscription["latest_invoice"] = {
            "id": "in_result",
            "confirmation_secret": {"client_secret": 123},
        }
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Subscription.modify",
        lambda *args, **kwargs: StripeObject(**subscription),
    )
    context = PlanChangeContext(
        "sub_test",
        "si_test",
        "price_starter_month",
        "ent_starter_month",
        "price_pro_month",
        "month",
        datetime.fromtimestamp(1_800_000_000, tz=UTC),
        datetime.fromtimestamp(1_802_592_000, tz=UTC),
        None,
    )
    with pytest.raises(RuntimeError, match=message):
        await StripeGateway("sk_test_dummy", "whsec_test").apply_immediate_plan_change(
            context,
            idempotency_key=f"change:{malformation}",
        )


@pytest.mark.parametrize(
    "malformation",
    [
        "line_collection",
        "line_object",
        "total",
        "quantity",
        "period",
        "balance",
        "tax_amount",
    ],
)
async def test_immediate_preview_malformed_types_defer_without_exception(
    monkeypatch, malformation: str
) -> None:
    line: object = {
        "id": "il_target",
        "amount": 4900,
        "quantity": 1,
        "currency": "usd",
        "proration": False,
        "price": {"id": "price_pro_month"},
        "period": {"start": 1_801_000_000, "end": 1_803_592_000},
    }
    preview = StripeObject(
        amount_due=4900,
        subtotal=4900,
        total=4900,
        starting_balance=0,
        ending_balance=0,
        pre_payment_credit_notes_amount=0,
        post_payment_credit_notes_amount=0,
        currency="usd",
        total_tax_amounts=[],
        total_discount_amounts=[],
        lines={"has_more": False, "data": [line]},
    )
    if malformation == "line_collection":
        preview.lines["data"] = "invalid"
    elif malformation == "line_object":
        preview.lines["data"] = ["invalid"]
    elif malformation == "total":
        preview.total = "4900"
    elif malformation == "quantity":
        line["quantity"] = "1"  # type: ignore[index]
    elif malformation == "period":
        line["period"] = [1_801_000_000, 1_803_592_000]  # type: ignore[index]
    elif malformation == "balance":
        preview.starting_balance = "0"
    else:
        line["tax_amounts"] = [{"amount": "0"}]  # type: ignore[index]
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Invoice.create_preview",
        lambda **kwargs: preview,
    )
    context = PlanChangeContext(
        "sub_test",
        "si_test",
        "price_starter_month",
        "ent_starter_month",
        "price_pro_month",
        "month",
        datetime.fromtimestamp(1_800_000_000, tz=UTC),
        datetime.fromtimestamp(1_802_592_000, tz=UTC),
        None,
    )
    estimate = await StripeGateway("sk_test_dummy", "whsec_test").preview_immediate_plan_change(
        context
    )
    assert estimate.safe_invoice_shape is False


@pytest.mark.parametrize(
    "drift",
    [
        "pagination",
        "line_tax",
        "zero_line_tax",
        "zero_line_discount",
        "automatic_tax",
        "malformed_automatic_tax",
        "malformed_tax_collection",
        "singular_discount",
        "credit_note",
    ],
)
async def test_full_period_preview_rejects_final_invoice_shape_drift(
    monkeypatch, drift: str
) -> None:
    line = {
        "id": "il_target",
        "amount": 4900,
        "quantity": 1,
        "currency": "usd",
        "proration": False,
        "price": {"id": "price_pro_month"},
        "period": {"start": 1_801_000_000, "end": 1_803_592_000},
    }
    preview = StripeObject(
        amount_due=4900,
        subtotal=4900,
        total=4900,
        starting_balance=0,
        ending_balance=0,
        pre_payment_credit_notes_amount=0,
        post_payment_credit_notes_amount=0,
        currency="usd",
        total_tax_amounts=[],
        total_discount_amounts=[],
        lines={"has_more": False, "data": [line]},
    )
    if drift == "pagination":
        preview.lines["has_more"] = True
    elif drift == "line_tax":
        line["tax_amounts"] = [{"amount": 1}]
    elif drift == "zero_line_tax":
        line["tax_amounts"] = [{"amount": 0}]
    elif drift == "zero_line_discount":
        line["discount_amounts"] = [{"amount": 0}]
    elif drift == "automatic_tax":
        preview.automatic_tax = {"enabled": True}
    elif drift == "malformed_automatic_tax":
        preview.automatic_tax = {}
    elif drift == "malformed_tax_collection":
        preview.total_tax_amounts = {}
    elif drift == "singular_discount":
        preview.discount = {}
    else:
        preview.pre_payment_credit_notes_amount = 1
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Invoice.create_preview",
        lambda **kwargs: preview,
    )
    context = PlanChangeContext(
        "sub_test",
        "si_test",
        "price_starter_month",
        "ent_starter_month",
        "price_pro_month",
        "month",
        datetime.fromtimestamp(1_800_000_000, tz=UTC),
        datetime.fromtimestamp(1_802_592_000, tz=UTC),
        None,
    )
    estimate = await StripeGateway("sk_test_dummy", "whsec_test").preview_immediate_plan_change(
        context
    )
    assert estimate.safe_invoice_shape is False


async def test_prorated_delta_preview_and_apply_share_fixed_proration_date(
    monkeypatch,
) -> None:
    preview_capture: dict[str, object] = {}
    apply_capture: dict[str, object] = {}
    preview = StripeObject(
        amount_due=1500,
        subtotal=1500,
        total=1500,
        starting_balance=0,
        ending_balance=0,
        pre_payment_credit_notes_amount=0,
        post_payment_credit_notes_amount=0,
        currency="usd",
        total_tax_amounts=[],
        total_discount_amounts=[],
        lines={
            "has_more": False,
            "data": [
                {
                    "id": "il_source",
                    "amount": -950,
                    "quantity": 1,
                    "proration": True,
                    "currency": "usd",
                    "price": {"id": "price_starter_month"},
                    "period": {"start": 1_801_000_000, "end": 1_802_592_000},
                },
                {
                    "id": "il_target",
                    "amount": 2450,
                    "quantity": 1,
                    "proration": True,
                    "currency": "usd",
                    "price": {"id": "price_pro_month"},
                    "period": {"start": 1_801_000_000, "end": 1_802_592_000},
                },
            ],
        },
    )

    def create_preview(**kwargs):  # type: ignore[no-untyped-def]
        preview_capture.update(kwargs)
        return preview

    def modify(subscription_id, **kwargs):  # type: ignore[no-untyped-def]
        apply_capture.update({"subscription_id": subscription_id, **kwargs})
        return StripeObject(
            id=subscription_id,
            livemode=False,
            status="active",
            pending_update=None,
            latest_invoice={"id": "in_delta"},
        )

    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Invoice.create_preview",
        create_preview,
    )
    monkeypatch.setattr("stripe_entitlements.stripe_gateway.stripe.Subscription.modify", modify)
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    context = PlanChangeContext(
        "sub_test",
        "si_test",
        "price_starter_month",
        "ent_starter_month",
        "price_pro_month",
        "month",
        datetime.fromtimestamp(1_800_000_000, tz=UTC),
        datetime.fromtimestamp(1_802_592_000, tz=UTC),
        None,
    )
    estimate = await gateway.preview_immediate_plan_change(
        context, policy="prorated_delta", proration_date=1_801_000_000
    )
    result = await gateway.apply_immediate_plan_change(
        context,
        idempotency_key="change:delta",
        policy="prorated_delta",
        proration_date=1_801_000_000,
    )
    assert estimate.safe_invoice_shape
    assert (
        estimate.source_proration_amount,
        estimate.target_proration_amount,
        estimate.amount_due,
    ) == (950, 2450, 1500)
    assert result.pending_update is False
    assert result.settlement_invoice_id == "in_delta"
    preview_details = preview_capture["subscription_details"]
    assert preview_details["proration_behavior"] == "always_invoice"  # type: ignore[index]
    assert preview_details["proration_date"] == 1_801_000_000  # type: ignore[index]
    assert "billing_cycle_anchor" not in preview_details  # type: ignore[operator]
    assert apply_capture["proration_behavior"] == "always_invoice"
    assert apply_capture["proration_date"] == 1_801_000_000
    assert "billing_cycle_anchor" not in apply_capture


@pytest.mark.parametrize("quantity", [None, 2, "1"])
async def test_schedule_creation_requires_one_current_phase_item_quantity(
    monkeypatch, quantity: object
) -> None:
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.SubscriptionSchedule.create",
        lambda **kwargs: StripeObject(
            id="sub_sched_quantity",
            phases=[
                {
                    "start_date": 1_800_000_000,
                    "end_date": 1_802_592_000,
                    "items": [{"price": "price_pro_year", "quantity": quantity}],
                }
            ],
        ),
    )
    context = PlanChangeContext(
        "sub_test",
        "si_test",
        "price_pro_year",
        "ent_pro_year",
        "price_starter_month",
        "month",
        datetime.fromtimestamp(1_800_000_000, tz=UTC),
        datetime.fromtimestamp(1_802_592_000, tz=UTC),
        None,
    )
    with pytest.raises(RuntimeError, match="one resolvable Price"):
        await StripeGateway("sk_test_dummy", "whsec_test").schedule_plan_change(
            context, idempotency_key="change:quantity"
        )


@pytest.mark.parametrize("existing_schedule", [None, "sub_sched_test"])
async def test_schedule_is_two_step_preserves_phase_and_recovers_create_only_state(
    monkeypatch, existing_schedule: str | None
) -> None:
    captured: dict[str, dict[str, object]] = {}
    schedule = StripeObject(
        id="sub_sched_test",
        phases=[
            {
                "start_date": 1_800_000_000,
                "end_date": 1_802_592_000,
                "collection_method": "charge_automatically",
                "metadata": {"keep": "yes"},
                "items": [{"price": {"id": "price_pro_year"}, "quantity": 1}],
            }
        ],
    )

    def create(**kwargs):  # type: ignore[no-untyped-def]
        captured["create"] = kwargs
        return schedule

    def modify(schedule_id, **kwargs):  # type: ignore[no-untyped-def]
        captured["modify"] = {"schedule_id": schedule_id, **kwargs}
        return SimpleNamespace(id=schedule_id)

    def retrieve(schedule_id, **kwargs):  # type: ignore[no-untyped-def]
        del kwargs
        configured = captured["modify"]
        return StripeObject(
            id=schedule_id,
            subscription="sub_test",
            end_behavior=configured["end_behavior"],
            metadata=configured["metadata"],
            phases=configured["phases"],
        )

    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.SubscriptionSchedule.create", create
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.SubscriptionSchedule.modify", modify
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.SubscriptionSchedule.retrieve",
        retrieve,
    )
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    context = PlanChangeContext(
        "sub_test",
        "si_test",
        "price_pro_year",
        "ent_pro_year",
        "price_starter_month",
        "month",
        datetime.fromtimestamp(1_800_000_000, tz=UTC),
        datetime.fromtimestamp(1_802_592_000, tz=UTC),
        existing_schedule,
    )
    result = await gateway.schedule_plan_change(context, idempotency_key="change:1")
    assert result.remote_id == "sub_sched_test"
    assert "metadata" not in captured["create"]
    phases = captured["modify"]["phases"]
    assert phases[0]["metadata"] == {"keep": "yes"}  # type: ignore[index]
    assert phases[0]["end_date"] == phases[1]["start_date"]  # type: ignore[index]
    assert phases[1]["duration"] == {"interval": "month", "interval_count": 1}  # type: ignore[index]
    assert captured["modify"]["proration_behavior"] == "none"
    configured = {
        "subscription": "sub_test",
        "end_behavior": "release",
        "metadata": {
            "product_line": "example-entitlements",
            "plan_change_key": "change:1",
        },
        "phases": phases,
    }
    assert gateway._configured_schedule_matches(configured, context, "change:1")
    phases[1]["duration"] = {"interval": "month", "interval_count": 2}  # type: ignore[index]
    assert not gateway._configured_schedule_matches(configured, context, "change:1")


@pytest.mark.parametrize(
    "malformation",
    ["phases_not_array", "phase_not_object", "metadata", "items", "quantity", "end_date"],
)
def test_schedule_verification_rejects_malformed_shape_without_exception(
    malformation: str,
) -> None:
    context = PlanChangeContext(
        "sub_test",
        "si_test",
        "price_starter_month",
        "ent_starter_month",
        "price_pro_month",
        "month",
        datetime.fromtimestamp(1_800_000_000, tz=UTC),
        datetime.fromtimestamp(1_802_592_000, tz=UTC),
        None,
    )
    boundary = int(context.current_period_end.timestamp())
    schedule: dict[str, object] = {
        "subscription": "sub_test",
        "end_behavior": "release",
        "metadata": {
            "product_line": "example-entitlements",
            "plan_change_key": "change:shape",
        },
        "phases": [
            {
                "end_date": boundary,
                "proration_behavior": "none",
                "items": [{"price": "price_starter_month", "quantity": 1}],
            },
            {
                "start_date": boundary,
                "duration": {"interval": "month", "interval_count": 1},
                "proration_behavior": "none",
                "items": [{"price": "price_pro_month", "quantity": 1}],
            },
        ],
    }
    if malformation == "phases_not_array":
        schedule["phases"] = "invalid"
    elif malformation == "phase_not_object":
        schedule["phases"] = ["invalid", {}]
    elif malformation == "metadata":
        schedule["metadata"] = "invalid"
    elif malformation == "items":
        schedule["phases"][0]["items"] = "invalid"  # type: ignore[index]
    elif malformation == "quantity":
        schedule["phases"][0]["items"][0]["quantity"] = "1"  # type: ignore[index]
    else:
        schedule["phases"][1]["duration"] = None  # type: ignore[index]
        schedule["phases"][1]["end_date"] = "invalid"  # type: ignore[index]
    assert not StripeGateway("sk_test_dummy", "whsec_test")._configured_schedule_matches(
        schedule, context, "change:shape"
    )
