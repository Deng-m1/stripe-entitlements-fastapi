"use client";

import { useCallback, useEffect, useState } from "react";
import { ChangePreviewDialog } from "@/components/ChangePreviewDialog";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import {
  annualEquivalentMonthly,
  annualSavings,
  formatMoney,
  priceFor,
} from "@/lib/money";
import {
  completeIdempotentIntent,
  idempotencyKeyForIntent,
} from "@/lib/idempotency";
import {
  browserBillingRedirect,
  browserInternalRedirect,
  getBillingApi,
} from "@/lib/runtime";
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
    setBusyKey(plan.key);
    setError(null);
    setMessage(null);
    try {
      const hasSubscription =
        account.plan_key !== "free" &&
        account.plan_interval !== null &&
        account.subscription_status !== "none" &&
        account.subscription_status !== "canceled";
      if (hasSubscription) {
        const key = requestKey("preview", plan.key);
        const nextPreview = await api.previewPlanChange(
          {
            plan_key: plan.key,
            interval,
          },
          { idempotencyKey: key.value },
        );
        completeIdempotentIntent(key.identity);
        setPreview(nextPreview);
        setPaymentUrl(null);
        setPreviewError(null);
      } else {
        const key = requestKey("checkout", plan.key);
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
        completeIdempotentIntent(key.identity);
      }
    } catch (caught) {
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
        // proof. The success screen waits for the webhook-projected account.
        internalRedirect(successUrl(result));
        return;
      }
      const refreshedAccount = await api.getAccount();
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

  return (
    <div>
      <section className="hero">
        <p className="eyebrow">Explicit billing, structured entitlements</p>
        <h1>Choose a plan without hiding the billing consequences.</h1>
        <p>
          Plan identity comes from stable catalog keys. Prices are display and billing
          data—not tier detection logic.
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
          </button>
        ))}
      </div>

      {message ? <p className="success-banner" role="status">{message}</p> : null}
      {!account && !error ? (
        <p className="account-loading" role="status">
          Plans are ready. Loading the authenticated account state…
        </p>
      ) : null}
      {error ? (
        <div className="inline-error" role="alert">
          <span>{error}</span>
          <button className="button ghost" onClick={() => void load()} type="button">
            Try again
          </button>
        </div>
      ) : null}

      <div className="plan-grid">
        {sortedPlans.map((plan) => {
          const selectedPrice = priceFor(plan, interval);
          const savings = annualSavings(plan);
          const current =
            account !== null &&
            account.plan_key === plan.key &&
            account.plan_interval === interval;
          const cancellationPending = account?.pending_cancellation != null;
          return (
            <article className="plan-card" key={plan.key}>
              <div>
                <p className="eyebrow">Plan key: {plan.key}</p>
                <h2>{plan.name}</h2>
                <p>{plan.description}</p>
              </div>
              <div className="price-block">
                {interval === "month" ? (
                  <>
                    <strong>{formatMoney(selectedPrice.unit_amount, selectedPrice.currency)}</strong>
                    <span>/month</span>
                  </>
                ) : (
                  <>
                    <strong>
                      {formatMoney(
                        annualEquivalentMonthly(plan),
                        selectedPrice.currency,
                      )}
                    </strong>
                    <span>/mo equivalent</span>
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
              <ul className="entitlement-list">
                {plan.entitlements.map((entitlement) => (
                  <li key={entitlement.key}>
                    <span aria-hidden="true">✓</span>
                    {entitlement.label}: {String(entitlement.value)}{" "}
                    {entitlement.unit ?? ""}
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

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Unknown billing error";
}
