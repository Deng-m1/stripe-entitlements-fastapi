from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .catalog import Plan

BillingInterval = Literal["month", "year"]
TransitionTiming = Literal["immediate", "period_end", "noop"]
TransitionPolicy = Literal["full_period_reset", "prorated_delta"]


@dataclass(frozen=True, slots=True)
class TransitionDecision:
    from_plan: str
    from_interval: BillingInterval
    target_plan: str
    target_interval: BillingInterval
    timing: TransitionTiming
    reason: str
    policy: TransitionPolicy = "full_period_reset"


def decide_transition(
    current: Plan,
    current_interval: BillingInterval,
    target: Plan,
    target_interval: BillingInterval,
    policy: TransitionPolicy = "full_period_reset",
) -> TransitionDecision:
    """Return explicit policy timing from tier rank, never from price amount."""
    if policy not in {"full_period_reset", "prorated_delta"}:
        raise ValueError(f"unknown transition policy {policy!r}")
    # A paid annual invoice owns a 12-slot funding lineage. Any mid-year replacement
    # can fund the new invoice with a negative proration from the old invoice. The
    # current ledger deliberately has one funding_invoice_id, not a cross-invoice
    # lineage, so a later refund of the old invoice could otherwise be ignored.
    # Therefore every annual-origin change is deferred before tier comparison.
    timing: TransitionTiming
    if current.key == target.key and current_interval == target_interval:
        timing = "noop"
        reason = "plan and interval are unchanged"
    elif current_interval == "year":
        timing = "period_end"
        reason = "annual funding lineage must finish before replacing the plan"
    elif policy == "prorated_delta" and (target_interval != "month" or current_interval != "month"):
        timing = "period_end"
        reason = "prorated delta is bounded to same-interval monthly changes"
    elif target.rank > current.rank:
        timing = "immediate"
        reason = (
            "higher monthly tier uses a current-period entitlement delta"
            if policy == "prorated_delta"
            else "higher tier rank starts a newly funded period"
        )
    elif target.rank < current.rank:
        timing = "period_end"
        reason = "lower tier rank"
    elif target.key != current.key:
        raise ValueError("equal ranks across different plans are ambiguous")
    elif current_interval == "month" and target_interval == "year":
        timing = "immediate"
        reason = "same-tier month-to-year conversion"
    else:
        timing = "period_end"
        reason = "same-tier interval conversion"
    return TransitionDecision(
        current.key,
        current_interval,
        target.key,
        target_interval,
        timing,
        reason,
        policy,
    )
