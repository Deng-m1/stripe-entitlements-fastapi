import type { Plan } from "./catalog.js";
import type {
  BillingInterval,
  EffectiveMode,
  TransitionPolicy,
} from "./types.js";

export interface TransitionDecision {
  readonly fromPlan: string;
  readonly fromInterval: BillingInterval;
  readonly targetPlan: string;
  readonly targetInterval: BillingInterval;
  readonly timing: EffectiveMode;
  readonly reason: string;
  readonly policy: TransitionPolicy;
}

export function decideTransition(
  current: Plan,
  currentInterval: BillingInterval,
  target: Plan,
  targetInterval: BillingInterval,
  policy: TransitionPolicy = "full_period_reset",
): TransitionDecision {
  let timing: EffectiveMode;
  let reason: string;
  if (current.key === target.key && currentInterval === targetInterval) {
    timing = "noop";
    reason = "plan and interval are unchanged";
  } else if (currentInterval === "year") {
    timing = "period_end";
    reason = "annual funding lineage must finish before replacing the plan";
  } else if (
    policy === "prorated_delta" &&
    (targetInterval !== "month" || currentInterval !== "month")
  ) {
    timing = "period_end";
    reason = "prorated delta is bounded to same-interval monthly changes";
  } else if (
    policy === "prorated_delta" &&
    target.rank > current.rank &&
    target.monthlyCredits.atoms <= current.monthlyCredits.atoms
  ) {
    timing = "period_end";
    reason = "prorated delta requires a positive credit difference";
  } else if (target.rank > current.rank) {
    timing = "immediate";
    reason =
      policy === "prorated_delta"
        ? "higher monthly tier uses a current-period entitlement delta"
        : "higher tier rank starts a newly funded period";
  } else if (target.rank < current.rank) {
    timing = "period_end";
    reason = "lower tier rank";
  } else if (target.key !== current.key) {
    throw new Error("equal ranks across different plans are ambiguous");
  } else if (currentInterval === "month" && targetInterval === "year") {
    timing = "immediate";
    reason = "same-tier month-to-year conversion";
  } else {
    timing = "period_end";
    reason = "same-tier interval conversion";
  }
  return {
    fromPlan: current.key,
    fromInterval: currentInterval,
    targetPlan: target.key,
    targetInterval,
    timing,
    reason,
    policy,
  };
}
