"use client";

import { useLocale } from "@/components/LocaleProvider";
import { referencePlans } from "@/lib/reference-catalog";
import {
  creditAmountFromEntitlement,
  formatCreditDecimal,
  subtractCreditDecimals,
} from "@/lib/credit-amount";
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
  monthlyCredits: string;
  planName: string;
  planAbbr: string;
  intervalAbbr: string;
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
      );
      if (!credits) {
        throw new Error(`Plan ${plan.key} has no monthly credit entitlement.`);
      }
      return {
        planKey: plan.key,
        interval,
        rank: plan.display_order,
        monthlyCredits: creditAmountFromEntitlement(credits).decimal,
        planName: plan.name,
        planAbbr: plan.name.slice(0, 3),
        intervalAbbr: interval === "month" ? "mo" : "yr",
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
  const { t } = useLocale();
  const states = buildStates();
  const highlightFrom = states.at(0);
  const highlightTo = states.at(1);
  const creditDelta =
    highlightFrom && highlightTo
      ? subtractCreditDecimals(
          highlightTo.monthlyCredits,
          highlightFrom.monthlyCredits,
        )
      : "0";
  const formattedCreditDelta = formatCreditDecimal(creditDelta);

  return (
    <div className="upgrade-matrix-layout">
      <p className="table-scroll-hint">
        {t("Scroll sideways for the yearly target columns.")}
      </p>
      <div
        aria-label={t("Scrollable plan transition matrix")}
        className="upgrade-matrix-wrap"
        role="region"
        tabIndex={0}
      >
        <table className="upgrade-matrix">
          <caption>{t("Outcome of every plan change under the prorated_delta template, from the row state to the column state")}</caption>
          <thead>
            <tr>
              <th scope="col">
                <span aria-hidden="true">{t("from \\ to")}</span>
              </th>
              {states.map((state) => (
                <th key={`${state.planKey}-${state.interval}`} scope="col">
                  <span aria-hidden="true" className="matrix-col-code">
                    <span>{state.planAbbr}</span>
                    <span>{state.intervalAbbr}</span>
                  </span>
                  <span className="sr-only">
                    {state.planName} {t(state.interval === "month" ? "Monthly" : "Yearly")}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {states.map((from) => (
              <tr key={`${from.planKey}-${from.interval}`}>
                <th scope="row">
                  <span className="sr-only">
                    {from.planName} {t(from.interval === "month" ? "Monthly" : "Yearly")}
                  </span>
                  <span aria-hidden="true" className="matrix-row-label">
                    {from.planName} {t(from.interval === "month" ? "Monthly" : "Yearly")}
                  </span>
                  <span aria-hidden="true" className="matrix-row-code">
                    {from.planAbbr}·{from.intervalAbbr}
                  </span>
                </th>
                {states.map((to) => {
                  const kind = transitionKind(from, to);
                  const highlighted =
                    from === highlightFrom && to === highlightTo;
                  return (
                    <td
                      className={highlighted ? "matrix-highlight" : undefined}
                      key={`${to.planKey}-${to.interval}`}
                      tabIndex={highlighted ? 0 : undefined}
                    >
                      <span
                        aria-hidden="true"
                        className={`matrix-dot ${kind}`}
                      />
                      <span className="sr-only">{t(KIND_COPY[kind])}</span>
                      {highlighted ? (
                        <span className="matrix-tooltip">
                          {t("prorated_delta · paid two-line Invoice · +{{credits}} credits · period preserved", {
                            credits: formattedCreditDelta,
                          })}
                        </span>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="matrix-aside">
        <p className="matrix-callout">
          <span className="matrix-callout-path">
            {t("Starter → Pro · monthly (highlighted cell)")}
          </span>
          {t("prorated_delta settles it immediately: a paid two-line Invoice, +{{credits}} credits, and the current period preserved.", {
            credits: formattedCreditDelta,
          })}
        </p>
        <ul className="matrix-legend">
          <li>
            <span aria-hidden="true" className="matrix-dot immediate" />
            {t("Immediate prorated settlement")}
          </li>
          <li>
            <span aria-hidden="true" className="matrix-dot period-end" />
            {t("Scheduled at period end")}
          </li>
          <li>
            <span aria-hidden="true" className="matrix-dot noop" />
            {t("No-op")}
          </li>
        </ul>
        <p className="matrix-footnote">
          {t("Shown: the prorated_delta template. The full_period_reset template defines the same 36 cells and instead settles monthly-origin upgrades immediately at the full target price.")}
        </p>
      </div>
    </div>
  );
}
