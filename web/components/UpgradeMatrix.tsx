import { referencePlans } from "@/lib/reference-catalog";
import type { BillingInterval } from "@/lib/types";

/**
 * Static, server-rendered 6 × 6 plan-transition matrix. The cell semantics
 * mirror the prorated_delta template in docs/PLAN_TRANSITIONS.md: immediate
 * settlement is bounded to a higher-rank monthly→monthly upgrade; downgrades,
 * interval changes, and every annual-origin change wait for period end.
 */

type TransitionKind = "noop" | "immediate" | "period-end";

interface MatrixState {
  planKey: string;
  interval: BillingInterval;
  rank: number;
  monthlyCredits: number;
  code: string;
  label: string;
}

const KIND_COPY: Record<TransitionKind, string> = {
  noop: "No-op: already on this plan and interval",
  immediate: "Immediate prorated settlement in the current period",
  "period-end": "Scheduled at period end",
};

function buildStates(): MatrixState[] {
  const ranked = [...referencePlans].sort(
    (a, b) => a.display_order - b.display_order,
  );
  const intervals: BillingInterval[] = ["month", "year"];
  return intervals.flatMap((interval) =>
    ranked.map((plan) => {
      const credits = plan.entitlements.find(
        (item) => item.key === "monthly_credits",
      )?.value;
      return {
        planKey: plan.key,
        interval,
        rank: plan.display_order,
        monthlyCredits: typeof credits === "number" ? credits : 0,
        code: `${plan.name.charAt(0)}${interval === "month" ? "M" : "Y"}`,
        label: `${plan.name} ${interval === "month" ? "Monthly" : "Yearly"}`,
      };
    }),
  );
}

function transitionKind(from: MatrixState, to: MatrixState): TransitionKind {
  if (from.planKey === to.planKey && from.interval === to.interval) {
    return "noop";
  }
  if (
    from.interval === "month" &&
    to.interval === "month" &&
    to.rank > from.rank
  ) {
    return "immediate";
  }
  return "period-end";
}

export function UpgradeMatrix() {
  const states = buildStates();
  const highlightFrom = states.at(0);
  const highlightTo = states.at(1);
  const creditDelta =
    highlightFrom && highlightTo
      ? highlightTo.monthlyCredits - highlightFrom.monthlyCredits
      : 0;

  return (
    <div className="upgrade-matrix-wrap">
      <table className="upgrade-matrix">
        <caption>
          Outcome of every plan change under the prorated_delta template, from
          the row state to the column state
        </caption>
        <thead>
          <tr>
            <th scope="col">
              <span aria-hidden="true">from \ to</span>
            </th>
            {states.map((state) => (
              <th key={`${state.planKey}-${state.interval}`} scope="col">
                <span aria-hidden="true">{state.code}</span>
                <span className="sr-only">{state.label}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {states.map((from) => (
            <tr key={`${from.planKey}-${from.interval}`}>
              <th scope="row">{from.label}</th>
              {states.map((to) => {
                const kind = transitionKind(from, to);
                const highlighted = from === highlightFrom && to === highlightTo;
                return (
                  <td
                    className={highlighted ? "matrix-highlight" : undefined}
                    key={`${to.planKey}-${to.interval}`}
                    tabIndex={highlighted ? 0 : undefined}
                  >
                    <span aria-hidden="true" className={`matrix-dot ${kind}`} />
                    <span className="sr-only">{KIND_COPY[kind]}</span>
                    {highlighted ? (
                      <span className="matrix-tooltip">
                        prorated_delta · paid two-line Invoice · +{creditDelta}
                        {" credits · period preserved"}
                      </span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="matrix-legend">
        <li>
          <span aria-hidden="true" className="matrix-dot immediate" />
          Immediate prorated settlement
        </li>
        <li>
          <span aria-hidden="true" className="matrix-dot period-end" />
          Scheduled at period end
        </li>
        <li>
          <span aria-hidden="true" className="matrix-dot noop" />
          No-op
        </li>
      </ul>
      <p className="matrix-footnote">
        Shown: the prorated_delta template. The full_period_reset template
        defines the same 36 cells and instead settles monthly-origin upgrades
        immediately at the full target price.
      </p>
    </div>
  );
}
