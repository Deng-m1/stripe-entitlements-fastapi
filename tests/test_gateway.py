from __future__ import annotations

import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from scripts.bootstrap_stripe import _mode, _safe_portal
from stripe_entitlements.checkout import CheckoutCreationRejected
from stripe_entitlements.plan_changes import PlanChangeContext
from stripe_entitlements.stripe_gateway import StripeGateway
from tests.builders import event


class StripeObject(SimpleNamespace):
    def __str__(self) -> str:
        return json.dumps(vars(self))


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
        "active": True,
        "livemode": False,
        "features": {
            "subscription_update": {"enabled": False},
            "subscription_cancel": {"enabled": True, "mode": "at_period_end"},
        },
    }
    assert _safe_portal(safe)
    update_enabled = {**safe, "features": {**safe["features"]}}
    update_enabled["features"]["subscription_update"] = {"enabled": True}
    assert not _safe_portal(update_enabled)
    immediate_cancel = {**safe, "features": {**safe["features"]}}
    immediate_cancel["features"]["subscription_cancel"] = {
        "enabled": True,
        "mode": "immediately",
    }
    assert not _safe_portal(immediate_cancel)


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


async def test_checkout_uses_pinned_version_and_server_built_success_query(
    monkeypatch,
) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.list",
        lambda **kwargs: SimpleNamespace(
            data=[
                StripeObject(
                    id="price_starter",
                    currency="usd",
                    unit_amount=1900,
                    recurring={"interval": "month"},
                )
            ]
        ),
    )

    def create(**kwargs):  # type: ignore[no-untyped-def]
        captured.update(kwargs)
        return SimpleNamespace(id="cs_test", url="https://checkout.test/session")

    monkeypatch.setattr("stripe_entitlements.stripe_gateway.stripe.checkout.Session.create", create)
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    await gateway.create_checkout_session(
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
    success_url = str(captured["success_url"])
    assert "expected_plan=starter" in success_url
    assert "expected_interval=month" in success_url
    assert "checkout_session_id={CHECKOUT_SESSION_ID}" in success_url
    assert captured["stripe_version"] == "2026-06-24.dahlia"
    assert captured["subscription_data"]["metadata"]["claim_token"] == "claim-1"


async def test_checkout_rejects_catalog_price_drift_before_session_creation(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.list",
        lambda **kwargs: SimpleNamespace(
            data=[
                StripeObject(
                    id="price_drifted",
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


async def test_dahlia_item_period_and_immediate_preview_shape(monkeypatch) -> None:
    gateway = StripeGateway("sk_test_dummy", "whsec_test")
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Price.list",
        lambda **kwargs: SimpleNamespace(
            data=[
                StripeObject(
                    id="price_pro_month",
                    currency="usd",
                    unit_amount=4900,
                    recurring={"interval": "month"},
                )
            ]
        ),
    )
    subscription = StripeObject(
        id="sub_test",
        status="active",
        schedule=None,
        items={
            "data": [
                {
                    "id": "si_test",
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
    context = await gateway.prepare_plan_change(
        "sub_test",
        "ent_pro_month",
        expected_currency="usd",
        expected_unit_amount=4900,
        target_interval="month",
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


async def test_immediate_apply_resets_anchor_without_proration_date(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def modify(subscription_id, **kwargs):  # type: ignore[no-untyped-def]
        captured.update({"subscription_id": subscription_id, **kwargs})
        return StripeObject(
            id=subscription_id,
            pending_update=None,
            latest_invoice={"id": "in_full_target"},
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
    assert result.settlement_invoice_id == "in_full_target"
    assert captured["billing_cycle_anchor"] == "now"
    assert captured["proration_behavior"] == "none"
    assert "proration_date" not in captured


@pytest.mark.parametrize("drift", ["pagination", "line_tax", "credit_note"])
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
