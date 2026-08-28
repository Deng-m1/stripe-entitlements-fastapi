"use client";

import { useCallback, useEffect, useState } from "react";
import { ChangePreviewDialog } from "@/components/ChangePreviewDialog";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import {
  annualEquivalentMonthly,
  annualSavings,
  annualSavingsPercent,
  formatMoney,
  priceFor,
} from "@/lib/money";
import { BillingApiError } from "@/lib/http-api";
import {
  completeIdempotentIntent,
  idempotencyKeyForIntent,
} from "@/lib/idempotency";
import {
  browserBillingRedirect,
  browserInternalRedirect,
  getBillingApi,
} from "@/lib/runtime";
import { REPOSITORY_URL } from "@/lib/site";
import {
  confirmRequiredStripePayment,
  successUrl,
} from "@/lib/stripe-payment";
import type {
  AccountResponse,
  BillingApi,
  BillingInterval,
  CatalogPlan,
  CatalogResponse,
  ChangePreview,
  Entitlement,
  Redirect,
} from "@/lib/types";

interface PricingScreenProps {
  api?: BillingApi;
  billingRedirect?: Redirect;
  initialCatalog?: CatalogResponse;
  internalRedirect?: Redirect;
}

export function PricingScreen({
  api = getBillingApi(),
  billingRedirect = browserBillingRedirect,
  initialCatalog,
  internalRedirect = browserInternalRedirect,
}: PricingScreenProps) {
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [catalog, setCatalog] = useState<CatalogResponse | null>(
    initialCatalog ?? null,
  );
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<ChangePreview | null>(null);
  const [paymentUrl, setPaymentUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  function requestKey(kind: "checkout" | "preview", planKey: string) {
    const identity = `${kind}:${planKey}:${interval}`;
    return { identity, value: idempotencyKeyForIntent(identity) };
  }

  const load = useCallback(async () => {
    try {
      const [nextCatalog, nextAccount] = await Promise.all([
        api.getCatalog(),
        api.getAccount(),
      ]);
      setError(null);
      setCatalog(nextCatalog);
      setAccount(nextAccount);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [api]);

  useEffect(() => {
    let active = true;
    void Promise.all([api.getCatalog(), api.getAccount()])
      .then(([nextCatalog, nextAccount]) => {
        if (!active) return;
        setError(null);
        setCatalog(nextCatalog);
        setAccount(nextAccount);
      })
      .catch((caught: unknown) => {
        if (active) setError(errorMessage(caught));
      });
    return () => {
      active = false;
    };
  }, [api]);

  async function choose(plan: CatalogPlan) {
    if (!account) return;
    const hasSubscription =
      account.plan_key !== "free" &&
      account.plan_interval !== null &&
      account.subscription_status !== "none" &&
      account.subscription_status !== "canceled";
    const key = requestKey(hasSubscription ? "preview" : "checkout", plan.key);
    setBusyKey(plan.key);
    setError(null);
    setMessage(null);
    try {
      if (hasSubscription) {
        const nextPreview = await api.previewPlanChange(
          {
            plan_key: plan.key,
            interval,
          },
          { idempotencyKey: key.value },
        );
        setPreview(nextPreview);
        setPaymentUrl(null);
        setPreviewError(null);
      } else {
        const origin = window.location.origin;
        const checkoutSuccessUrl = new URL("/billing/success", origin);
        checkoutSuccessUrl.searchParams.set("expected_plan", plan.key);
        checkoutSuccessUrl.searchParams.set("expected_interval", interval);
        const result = await api.createCheckout(
          {
            plan_key: plan.key,
            interval,
            success_url: checkoutSuccessUrl.toString(),
            cancel_url: `${origin}/pricing`,
          },
          { idempotencyKey: key.value },
        );
        billingRedirect(result.url);
      }
    } catch (caught) {
      if (
        hasSubscription &&
        caught instanceof BillingApiError &&
        caught.status === 409 &&
        caught.message.includes("no longer reusable")
      ) {
        completeIdempotentIntent(key.identity);
      }
      setError(errorMessage(caught));
    } finally {
      setBusyKey(null);
    }
  }

  async function confirmChange() {
    if (!preview) return;
    setBusyKey(preview.target_plan_key);
    setPreviewError(null);
    try {
      const result = await api.confirmPlanChange({
        preview_id: preview.preview_id,
      });
      if (
        result.status === "payment_required" ||
        result.status === "action_required"
      ) {
        if (result.payment_client_secret) {
          await confirmRequiredStripePayment(result);
        } else if (result.payment_url) {
          setPaymentUrl(result.payment_url);
          return;
        } else {
          await confirmRequiredStripePayment(result);
        }
      }
      if (result.timing === "immediate") {
        // A successful confirmation request (including SCA) is not entitlement
        // proof. Keep the preview idempotency key until the success screen sees
        // webhook-projected entitlement state.
        internalRedirect(successUrl(result));
        return;
      }
      const refreshedAccount = await api.getAccount();
      completeIdempotentIntent(
        `preview:${preview.target_plan_key}:${preview.target_interval}`,
      );
      setAccount(refreshedAccount);
      setPreview(null);
      setPaymentUrl(null);
      setMessage(
        "The server accepted the request. The account API reports the pending period-end change.",
      );
    } catch (caught) {
      setPreviewError(errorMessage(caught));
    } finally {
      setBusyKey(null);
    }
  }

  if (error && !catalog) {
    return <ErrorState error={error} retry={() => void load()} />;
  }
  if (!catalog) return <LoadingState label="Loading plan catalog…" />;

  const sortedPlans = [...catalog.plans].sort(
    (left, right) => left.display_order - right.display_order,
  );
  const savingsPercents = sortedPlans
    .map((plan) => annualSavingsPercent(plan))
    .filter((value): value is number => value !== null);
  const maxSavingsPercent =
    savingsPercents.length > 0 ? Math.max(...savingsPercents) : null;
  const savingsAreUniform =
    maxSavingsPercent !== null &&
    savingsPercents.length === sortedPlans.length &&
    savingsPercents.every((value) => value === maxSavingsPercent);
  const yearlyToggleBadge =
    maxSavingsPercent === null
      ? null
      : savingsAreUniform
        ? `Save ${maxSavingsPercent}%`
        : `Save up to ${maxSavingsPercent}%`;
  const featuredPlanKey =
    sortedPlans.length >= 3
      ? sortedPlans[Math.floor(sortedPlans.length / 2)].key
      : null;
  const compareRows = comparisonRows(sortedPlans);
  const compareCellClass = (planKey?: string) =>
    planKey !== undefined && planKey === featuredPlanKey
      ? "compare-featured"
      : undefined;

  return (
    <div className="pricing-page">
      <section className="pricing-hero">
        <div aria-hidden="true" className="pricing-ribbon" />
        <div className="shell">
          <section className="hero">
            <p className="eyebrow">Explicit billing, structured entitlements</p>
            <h1>
              Choose a plan without hiding the{" "}
              <em className="pricing-accent">billing consequences.</em>
            </h1>
            <p>
              Plan identity comes from stable catalog keys. Prices are display
              and billing data—not tier detection logic.
            </p>
          </section>

          <div
            className="interval-toggle"
            aria-label="Billing interval"
            role="group"
          >
            {(["month", "year"] as const).map((value) => (
              <button
                aria-pressed={interval === value}
                className={interval === value ? "active" : ""}
                key={value}
                onClick={() => setInterval(value)}
                type="button"
              >
                {value === "month" ? "Monthly" : "Yearly"}
                {value === "year" && yearlyToggleBadge ? (
                  <span aria-hidden="true" className="toggle-save">
                    {yearlyToggleBadge}
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          <ul aria-label="Billing guarantees" className="pricing-microcopy">
            <li>Webhook-verified entitlements</li>
            <li>Catalog-priced annual savings</li>
            <li>Explicit proration policies</li>
          </ul>

          {message ? (
            <p className="success-banner" role="status">
              {message}
            </p>
          ) : null}
          {!account && !error ? (
            <p className="account-loading" role="status">
              Plans are ready. Loading the authenticated account state…
            </p>
          ) : null}
          {error ? (
            <div className="inline-error" role="alert">
              <span>{error}</span>
              <button
                className="button ghost"
                onClick={() => void load()}
                type="button"
              >
                Try again
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <div className="plan-grid">
        {sortedPlans.map((plan, index) => {
          const selectedPrice = priceFor(plan, interval);
          const savings = annualSavings(plan);
          const previous = index > 0 ? sortedPlans[index - 1] : null;
          const cardEntitlements = (
            previous ? entitlementUpgrades(plan, previous) : plan.entitlements
          ).filter(
            (entitlement) =>
              entitlement.value !== false && entitlement.value !== 0,
          );
          const featured = plan.key === featuredPlanKey;
          const current =
            account !== null &&
            account.plan_key === plan.key &&
            account.plan_interval === interval;
          const cancellationPending = account?.pending_cancellation != null;
          return (
            <article
              className={featured ? "plan-card pricing-featured" : "plan-card"}
              key={plan.key}
            >
              {featured ? <p className="pricing-flag">Recommended</p> : null}
              <div>
                <p className="eyebrow">Plan key: {plan.key}</p>
                <h2>{plan.name}</h2>
                <p>{plan.description}</p>
              </div>
              <div className="price-block">
                {interval === "month" ? (
                  <>
                    <div className="price-row">
                      <strong>
                        {formatMoney(
                          selectedPrice.unit_amount,
                          selectedPrice.currency,
                        )}
                      </strong>
                      <span>/month</span>
                    </div>
                    {savings !== null ? (
                      <small>
                        or {formatMoney(annualEquivalentMonthly(plan), selectedPrice.currency)}/mo with yearly billing
                      </small>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div className="price-row">
                      <strong>
                        {formatMoney(
                          annualEquivalentMonthly(plan),
                          selectedPrice.currency,
                        )}
                      </strong>
                      <span>/mo equivalent</span>
                    </div>
                    <small>
                      {formatMoney(selectedPrice.unit_amount, selectedPrice.currency)} billed
                      yearly
                    </small>
                    {savings !== null ? (
                      <small className="saving">
                        Save {formatMoney(savings, selectedPrice.currency)}/year
                      </small>
                    ) : null}
                  </>
                )}
              </div>
              <p className="pricing-inherits">
                {previous ? `Everything in ${previous.name}, plus:` : "Includes:"}
              </p>
              <ul className="entitlement-list">
                {cardEntitlements.map((entitlement) => (
                  <li key={entitlement.key}>
                    <span aria-hidden="true">✓</span>
                    {entitlementLine(entitlement)}
                  </li>
                ))}
                {interval === "year" ? (
                  <li>
                    <span aria-hidden="true">✓</span>
                    Annual payment; credits continue on monthly grant slots
                  </li>
                ) : null}
              </ul>
              <button
                aria-label={`Choose ${plan.name} ${interval}`}
                aria-busy={busyKey === plan.key}
                className="button primary full"
                disabled={!account || current || cancellationPending || busyKey !== null}
                onClick={() => void choose(plan)}
                type="button"
              >
                {!account
                  ? "Loading account…"
                  : current
                  ? "Current plan"
                  : cancellationPending
                    ? "Cancellation scheduled"
                  : busyKey === plan.key
                    ? "Preparing…"
                    : account.plan_key === "free" || account.plan_interval === null
                      ? `Start ${plan.name}`
                      : `Preview ${plan.name} change`}
              </button>
            </article>
          );
        })}
      </div>

      <section aria-labelledby="plan-comparison-heading" className="pricing-compare">
        <p className="eyebrow">Catalog truth</p>
        <h2 id="plan-comparison-heading">Compare plans</h2>
        <p>
          Every value below comes from the same catalog the billing server enforces.
          The yearly discount is the catalog&apos;s explicit annual price—no Stripe
          Coupon or promotion code is created or simulated.
        </p>
        <p className="table-scroll-hint">Scroll sideways to compare every plan.</p>
        <div className="comparison-table-wrap">
          <table className="comparison-table">
            <caption>Plan price and entitlement comparison</caption>
            <thead>
              <tr>
                <th scope="col">What you get</th>
                {sortedPlans.map((plan) => (
                  <th
                    className={compareCellClass(plan.key)}
                    key={plan.key}
                    scope="col"
                  >
                    {plan.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Monthly price</th>
                {sortedPlans.map((plan) => (
                  <td className={compareCellClass(plan.key)} key={plan.key}>
                    {formatMoney(
                      plan.prices.month.unit_amount,
                      plan.prices.month.currency,
                    )}
                    /mo
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">Yearly price</th>
                {sortedPlans.map((plan) => (
                  <td className={compareCellClass(plan.key)} key={plan.key}>
                    {formatMoney(
                      plan.prices.year.unit_amount,
                      plan.prices.year.currency,
                    )}
                    /yr
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">Yearly savings vs monthly</th>
                {sortedPlans.map((plan) => {
                  const planSavings = annualSavings(plan);
                  const percent = annualSavingsPercent(plan);
                  return (
                    <td className={compareCellClass(plan.key)} key={plan.key}>
                      {planSavings === null || percent === null
                        ? "—"
                        : `${formatMoney(planSavings, plan.prices.year.currency)} (${percent}%)`}
                    </td>
                  );
                })}
              </tr>
              {compareRows.map((row) => (
                <tr key={row.key}>
                  <th scope="row">{row.label}</th>
                  {row.cells.map((cell, cellIndex) => (
                    <td
                      className={compareCellClass(sortedPlans[cellIndex]?.key)}
                      key={sortedPlans[cellIndex]?.key ?? cellIndex}
                    >
                      {typeof cell === "string" ? (
                        cell
                      ) : (
                        <IncludedMark included={cell === true} />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="pricing-footnote">
          Choosing a plan starts the demo Checkout or a server-calculated change
          preview; entitlements change only after webhook-verified account state,
          never from the redirect alone.
        </p>
      </section>

      <section aria-labelledby="pricing-cta-heading" className="pricing-cta">
        <div>
          <p className="eyebrow">Webhook truth included</p>
          <h2 id="pricing-cta-heading">
            Take the same catalog into production.
          </h2>
          <p>
            Every plan above is enforced by the FastAPI reference backend:
            signed webhooks, a PostgreSQL event inbox, and idempotent
            entitlement grants.
          </p>
        </div>
        <div className="pricing-cta-actions">
          <a className="button primary" href="/account">
            Open the demo account
          </a>
          <a className="button secondary" href={REPOSITORY_URL}>
            View the source
          </a>
        </div>
      </section>

      {preview ? (
        <ChangePreviewDialog
          busy={busyKey !== null}
          error={previewError}
          key={preview.preview_id}
          onCancel={() => {
            setPreview(null);
            setPaymentUrl(null);
          }}
          onConfirm={() => void confirmChange()}
          onOpenPayment={() => {
            if (!paymentUrl) return;
            try {
              billingRedirect(paymentUrl);
            } catch (caught) {
              setPreviewError(errorMessage(caught));
            }
          }}
          paymentUrl={paymentUrl}
          preview={preview}
          targetName={
            catalog.plans.find((plan) => plan.key === preview.target_plan_key)?.name ??
            preview.target_plan_key
          }
        />
      ) : null}
    </div>
  );
}

function IncludedMark({ included }: { included: boolean }) {
  return included ? (
    <span className="pricing-included">
      <span aria-hidden="true">✓</span>
      <span className="pricing-sr">Included</span>
    </span>
  ) : (
    <span className="pricing-excluded">
      <span aria-hidden="true">—</span>
      <span className="pricing-sr">Not included</span>
    </span>
  );
}

function entitlementLine(entitlement: Entitlement): string {
  if (entitlement.value === true) return entitlement.label;
  const value =
    typeof entitlement.value === "number"
      ? entitlement.value.toLocaleString("en-US")
      : String(entitlement.value);
  return entitlement.unit
    ? `${entitlement.label}: ${value} ${entitlement.unit}`
    : `${entitlement.label}: ${value}`;
}

/** Entitlements that are new or changed relative to the previous tier. */
function entitlementUpgrades(
  plan: CatalogPlan,
  previous: CatalogPlan,
): Entitlement[] {
  const previousByKey = new Map(
    previous.entitlements.map((entitlement) => [entitlement.key, entitlement]),
  );
  return plan.entitlements.filter((entitlement) => {
    const before = previousByKey.get(entitlement.key);
    return (
      !before ||
      before.value !== entitlement.value ||
      before.unit !== entitlement.unit
    );
  });
}

interface ComparisonRow {
  key: string;
  label: string;
  cells: (string | boolean | null)[];
}

function comparisonRows(plans: CatalogPlan[]): ComparisonRow[] {
  const orderedKeys: string[] = [];
  const meta = new Map<string, { label: string; unit?: string }>();
  for (const plan of plans) {
    for (const entitlement of plan.entitlements) {
      if (!meta.has(entitlement.key)) {
        orderedKeys.push(entitlement.key);
        meta.set(entitlement.key, {
          label: entitlement.label,
          unit: entitlement.unit,
        });
      }
    }
  }
  return orderedKeys.map((key) => {
    const shared = meta.get(key);
    return {
      key,
      label: shared?.label ?? key,
      cells: plans.map((plan) => {
        const found = plan.entitlements.find(
          (entitlement) => entitlement.key === key,
        );
        if (!found) return null;
        if (typeof found.value === "boolean") return found.value;
        const value =
          typeof found.value === "number"
            ? found.value.toLocaleString("en-US")
            : String(found.value);
        return found.unit ? `${value} ${found.unit}` : value;
      }),
    };
  });
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Unknown billing error";
}

