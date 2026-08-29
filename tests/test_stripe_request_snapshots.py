from __future__ import annotations

import copy
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import pytest

from stripe_entitlements.plan_changes import PlanChangeContext
from stripe_entitlements.stripe_request_snapshots import (
    StripeRequestSnapshotError,
    build_credit_pack_checkout_request_snapshot,
    build_plan_change_request_snapshot,
    build_subscription_checkout_request_snapshot,
    validate_checkout_request_snapshot,
    validate_plan_change_request_snapshot,
)

GOLDEN = Path(__file__).parent / "golden" / "stripe-request-snapshots.json"


def golden() -> dict[str, dict[str, object]]:
    value = json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert isinstance(value, dict)
    return value


def test_python_builders_and_validator_replay_cross_runtime_golden() -> None:
    vectors = golden()
    subscription = build_subscription_checkout_request_snapshot(
        account_id="00000000-0000-4000-8000-000000000001",
        claim_token="11111111-1111-4111-8111-111111111111",
        customer_id="cus_golden",
        price_id="price_golden_subscription",
        lookup_key="ent_starter_month",
        currency="usd",
        unit_amount=1900,
        interval="month",
        plan_key="starter",
        product_line="golden-product",
        success_url=(
            "https://golden.example.test/success?checkout_session_id={CHECKOUT_SESSION_ID}"
        ),
        cancel_url="https://golden.example.test/pricing",
        expires_at=1_800_000_000,
        request_api_version="2026-06-24.dahlia",
    )
    pack = build_credit_pack_checkout_request_snapshot(
        order_id="22222222-2222-4222-8222-222222222222",
        account_id="00000000-0000-4000-8000-000000000001",
        customer_id=None,
        price_id="price_golden_pack",
        lookup_key="ent_pack_boost-100",
        currency="usd",
        unit_amount=99_999_999,
        pack_key="boost-100",
        pack_credits="100.125",
        expires_days=365,
        product_line="golden-product",
        success_url=(
            "https://golden.example.test/success?checkout_session_id={CHECKOUT_SESSION_ID}"
        ),
        cancel_url="https://golden.example.test/pricing",
        expires_at=1_800_000_000,
        request_api_version="2025-12-15.clover",
    )
    assert subscription == vectors["subscription"]
    assert pack == vectors["credit_pack"]
    assert validate_checkout_request_snapshot(vectors["subscription"]) == subscription
    assert (
        validate_checkout_request_snapshot(
            vectors["credit_pack"],
            expected_pack_credits="100.125",
            expected_expires_days=365,
            expected_product_line="golden-product",
        )
        == pack
    )


@pytest.mark.parametrize(
    ("name", "timing", "policy", "target_price_id", "target_interval", "proration", "amount"),
    [
        (
            "plan_full_period_reset",
            "immediate",
            "full_period_reset",
            "price_golden_pro_month",
            "month",
            None,
            4_900,
        ),
        (
            "plan_prorated_delta",
            "immediate",
            "prorated_delta",
            "price_golden_pro_month",
            "month",
            1_800_000_123,
            4_900,
        ),
        (
            "plan_scheduled",
            "period_end",
            "full_period_reset",
            "price_golden_pro_year",
            "year",
            None,
            35_300,
        ),
    ],
)
def test_plan_change_builders_and_validator_replay_cross_runtime_golden(
    name: str,
    timing: Literal["immediate", "period_end"],
    policy: Literal["full_period_reset", "prorated_delta"],
    target_price_id: str,
    target_interval: Literal["month", "year"],
    proration: int | None,
    amount: int,
) -> None:
    context = PlanChangeContext(
        subscription_id="sub_golden_plan",
        subscription_item_id="si_golden_plan",
        current_price_id="price_golden_starter_month",
        current_lookup_key="ent_starter_month",
        target_price_id=target_price_id,
        target_interval=target_interval,
        current_period_start=datetime.fromtimestamp(1_800_000_000, tz=UTC),
        current_period_end=datetime.fromtimestamp(1_802_592_000, tz=UTC),
        schedule_id=None,
    )
    suffix = "apply" if timing == "immediate" else "schedule"
    built = build_plan_change_request_snapshot(
        context,
        timing=timing,
        policy=policy,
        proration_date=proration,
        idempotency_key=(f"plan-change:33333333-3333-4333-8333-333333333333:{suffix}"),
        request_api_version="2026-06-24.dahlia",
        product_line="golden-product",
        source_lookup_key="ent_starter_month",
        target_lookup_key=f"ent_pro_{target_interval}",
        source_plan_key="starter",
        target_plan_key="pro",
        source_currency="usd",
        target_currency="usd",
        source_unit_amount=1_900,
        target_unit_amount=amount,
    )
    expected = golden()[name]
    assert built == expected
    assert validate_plan_change_request_snapshot(expected) == built


def test_pack_expectations_reject_self_consistent_metadata_tampering() -> None:
    for field, changed, expected, message in (
        ("pack_credits", "999", {"expected_pack_credits": "100.125"}, "credits"),
        ("expires_days", "1", {"expected_expires_days": 365}, "expiry"),
        (
            "product_line",
            "other-product",
            {"expected_product_line": "golden-product"},
            "product line",
        ),
    ):
        value = copy.deepcopy(golden()["credit_pack"])
        params = value["params"]
        assert isinstance(params, dict)
        metadata = params["metadata"]
        nested = params["payment_intent_data"]
        evidence = value["resolved_price"]
        assert isinstance(metadata, dict) and isinstance(nested, dict)
        assert isinstance(nested["metadata"], dict) and isinstance(evidence, dict)
        metadata[field] = changed
        nested["metadata"][field] = changed
        if field == "product_line":
            evidence[field] = changed
        with pytest.raises(StripeRequestSnapshotError, match=message):
            validate_checkout_request_snapshot(value, **expected)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "mutator",
    [
        lambda value: value.update({"extra": True}),
        lambda value: value.update({"version": 99}),
        lambda value: value.update({"kind": "other"}),
        lambda value: value["resolved_price"].update({"currency": "USD"}),
        lambda value: value["params"].update({"line_items": []}),
        lambda value: value["params"].update({"payment_method_types": ["card", "cash"]}),
        lambda value: value["params"].update({"customer_creation": "if_required"}),
    ],
)
def test_malformed_checkout_vectors_fail_closed(mutator) -> None:  # type: ignore[no-untyped-def]
    value = copy.deepcopy(golden()["credit_pack"])
    mutator(value)
    with pytest.raises(StripeRequestSnapshotError):
        validate_checkout_request_snapshot(value)


def test_secret_oversize_and_timestamp_sentinel_are_rejected() -> None:
    secret = copy.deepcopy(golden()["subscription"])
    secret["params"]["cancel_url"] = "https://example.test/sk_test_secret"  # type: ignore[index]
    with pytest.raises(StripeRequestSnapshotError, match="secret"):
        validate_checkout_request_snapshot(secret)

    oversized = copy.deepcopy(golden()["subscription"])
    oversized["params"]["metadata"]["claim_token"] = "x" * (33 * 1024)  # type: ignore[index]
    with pytest.raises(StripeRequestSnapshotError, match="32 KiB"):
        validate_checkout_request_snapshot(oversized)

    timestamp = copy.deepcopy(golden()["credit_pack"])
    timestamp["params"]["expires_at"] = 253_402_300_800  # type: ignore[index]
    with pytest.raises(StripeRequestSnapshotError, match="expiry"):
        validate_checkout_request_snapshot(timestamp)


def test_stripe_amount_boundary_is_shared_and_fail_closed() -> None:
    accepted = copy.deepcopy(golden()["subscription"])
    accepted["resolved_price"]["unit_amount"] = 99_999_999  # type: ignore[index]
    validate_checkout_request_snapshot(accepted)

    rejected = copy.deepcopy(accepted)
    rejected["resolved_price"]["unit_amount"] = 100_000_000  # type: ignore[index]
    with pytest.raises(StripeRequestSnapshotError, match="unit amount"):
        validate_checkout_request_snapshot(rejected)
