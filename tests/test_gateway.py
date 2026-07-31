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

    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.checkout.Session.create", create
    )
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
    gateway = StripeGateway(
        "sk_test_dummy", "whsec_test", portal_configuration_id="bpc_test"
    )
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
        starting_balance=0,
        ending_balance=0,
        currency="usd",
        lines={
            "data": [
                {
                    "amount": 4900,
                    "proration": False,
                    "price": {"id": "price_pro_month"},
                },
            ]
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

    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.Subscription.modify", modify
    )
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
    assert captured["billing_cycle_anchor"] == "now"
    assert captured["proration_behavior"] == "none"
    assert "proration_date" not in captured


async def test_schedule_is_two_step_preserves_phase_and_sets_target_duration(
    monkeypatch,
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

    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.SubscriptionSchedule.create", create
    )
    monkeypatch.setattr(
        "stripe_entitlements.stripe_gateway.stripe.SubscriptionSchedule.modify", modify
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
        None,
    )
    result = await gateway.schedule_plan_change(context, idempotency_key="change:1")
    assert result.remote_id == "sub_sched_test"
    assert "metadata" not in captured["create"]
    phases = captured["modify"]["phases"]
    assert phases[0]["metadata"] == {"keep": "yes"}  # type: ignore[index]
    assert phases[0]["end_date"] == phases[1]["start_date"]  # type: ignore[index]
    assert phases[1]["duration"] == {"interval": "month", "interval_count": 1}  # type: ignore[index]
    assert captured["modify"]["proration_behavior"] == "none"
