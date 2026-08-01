from __future__ import annotations

import pytest

from stripe_entitlements.catalog import PlanCatalog
from stripe_entitlements.ordering import event_wins, rank_for
from stripe_entitlements.processor import _annual_slots_allowed, _ceil_ratio, _project_status
from stripe_entitlements.transitions import decide_transition


def test_catalog_round_trip(catalog: PlanCatalog) -> None:
    assert catalog.lookup_key("pro", "year") == "ent_pro_year"
    plan, interval = catalog.parse_lookup_key("ent_pro_year") or (None, None)
    assert plan is not None and plan.monthly_credits == 1000
    assert interval == "year"
    assert catalog.parse_lookup_key("other_pro_year") is None
    assert [plan.rank for plan in catalog.ordered()] == [10, 20, 30]
    assert "api_access" in catalog.require("pro").features
    assert catalog.require("ultra").limits["concurrent_jobs"] == 20


@pytest.mark.parametrize("from_plan", ["starter", "pro", "ultra"])
@pytest.mark.parametrize("from_interval", ["month", "year"])
@pytest.mark.parametrize("target_plan", ["starter", "pro", "ultra"])
@pytest.mark.parametrize("target_interval", ["month", "year"])
@pytest.mark.parametrize("policy", ["full_period_reset", "prorated_delta"])
def test_complete_month_year_tier_transition_matrix(
    catalog: PlanCatalog,
    from_plan: str,
    from_interval: str,
    target_plan: str,
    target_interval: str,
    policy: str,
) -> None:
    current = catalog.require(from_plan)
    target = catalog.require(target_plan)
    decision = decide_transition(  # type: ignore[arg-type]
        current, from_interval, target, target_interval, policy
    )
    if from_plan == target_plan and from_interval == target_interval:
        expected = "noop"
    elif from_interval == "year":
        expected = "period_end"
    elif policy == "prorated_delta" and target_interval != "month":
        expected = "period_end"
    elif target.rank > current.rank:
        expected = "immediate"
    elif target.rank < current.rank:
        expected = "period_end"
    elif from_interval == "month" and target_interval == "year":
        expected = "immediate"
    else:
        expected = "period_end"
    assert decision.timing == expected
    assert decision.policy == policy


@pytest.mark.parametrize(
    ("status", "projection"),
    [
        ("active", "active"),
        ("trialing", "active"),
        ("past_due", "past_due"),
        ("unpaid", "past_due"),
        ("paused", "past_due"),
        ("canceled", "canceled"),
        ("incomplete", "none"),
    ],
)
def test_status_projection(status: str, projection: str) -> None:
    assert _project_status(status) == projection


def test_same_second_event_precedence() -> None:
    assert rank_for("customer.subscription.deleted") > rank_for("invoice.paid")
    assert rank_for("invoice.paid") > rank_for("invoice.payment_failed")
    assert event_wins(
        current_created=100,
        current_rank=rank_for("invoice.payment_failed"),
        event_created=100,
        event_rank=rank_for("invoice.paid"),
    )
    assert not event_wins(
        current_created=100,
        current_rank=rank_for("customer.subscription.deleted"),
        event_created=100,
        event_rank=rank_for("invoice.paid"),
    )


@pytest.mark.parametrize(
    ("units", "refunded", "amount", "expected"),
    [(300, 1, 100, 3), (300, 33, 100, 99), (300, 34, 100, 102), (300, 100, 100, 300)],
)
def test_clawback_rounds_up(units: int, refunded: int, amount: int, expected: int) -> None:
    assert _ceil_ratio(units, refunded, amount) == expected


@pytest.mark.parametrize(
    ("refunded", "expected"),
    [(0, 12), (4, 12), (5, 11), (50, 6), (96, 1), (100, 1)],
)
def test_annual_slots_round_half_up_and_never_below_issued(refunded: int, expected: int) -> None:
    assert _annual_slots_allowed(100, refunded, 1) == expected
