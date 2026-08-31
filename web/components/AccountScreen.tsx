"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import { useLocale } from "@/components/LocaleProvider";
import {
  creditAmountFromEntitlement,
  formatCreditDecimal,
  isZeroCreditDecimal,
} from "@/lib/credit-amount";
import {
  completeIdempotentIntent,
  idempotencyKeyForIntent,
} from "@/lib/idempotency";
import { formatDate } from "@/lib/money";
import {
  browserBillingRedirect,
  getBillingApi,
  publicSimulationMode,
} from "@/lib/runtime";
import type {
  AccountResponse,
  BillingApi,
  CatalogResponse,
  Entitlement,
  Redirect,
} from "@/lib/types";

interface AccountScreenProps {
  api?: BillingApi;
  redirect?: Redirect;
}

export function AccountScreen({
  api = getBillingApi(),
  redirect = browserBillingRedirect,
}: AccountScreenProps) {
  const { numberLocale, t } = useLocale();
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const [nextAccount, nextCatalog] = await Promise.all([
        api.getAccount(),
        api.getCatalog(),
      ]);
      if (sequence !== loadSequence.current) return;
      setError(null);
      setAccount(nextAccount);
      setCatalog(nextCatalog);
      setLoadedAt(new Date().toISOString());
    } catch (caught) {
      if (sequence !== loadSequence.current) return;
      setError(errorMessage(caught));
    }
  }, [api]);

  // Event-handler wrapper: the busy flag may not be set synchronously inside
  // the mount effect, and the initial load already renders LoadingState.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await load();
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    // Deferred to a microtask so the effect body itself never sets state.
    void Promise.resolve().then(load);
    return () => {
      // Invalidate in-flight loads so an unmounted screen never updates state.
      loadSequence.current += 1;
    };
  }, [load]);

  async function openPortal() {
    setPortalBusy(true);
    setError(null);
    try {
      const intent = "portal";
      const idempotencyKey = idempotencyKeyForIntent(intent);
      const returnUrl = new URL("/account", window.location.origin).toString();
      const result = await api.createPortal(returnUrl, { idempotencyKey });
      redirect(result.url);
      completeIdempotentIntent(intent);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPortalBusy(false);
    }
  }

  function openPendingPayment(url: string) {
    setError(null);
    try {
      redirect(url);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  if (error && (!account || !catalog)) {
    return (
      <ErrorState
        error={error}
        retry={() => void refresh()}
        retrying={loading}
        title="We could not load your account projection."
      />
    );
  }
  if (!account || !catalog)
    return <LoadingState label="Loading account state…" />;

  const currentName =
    catalog.plans.find((plan) => plan.key === account.plan_key)?.name ??
    (account.plan_key === "free" ? t("Free") : account.plan_key);
  const pendingName = account.pending_change
    ? (catalog.plans.find(
        (plan) => plan.key === account.pending_change?.target_plan_key,
      )?.name ?? account.pending_change.target_plan_key)
    : null;
  const pendingPaymentUrl = account.pending_change?.payment_url;
  const hasSubscription =
    account.subscription_status !== "none" &&
    account.subscription_status !== "canceled";

  return (
    <div
      aria-busy={loading}
      className="app-page account-page"
      style={{ opacity: loading ? 0.7 : 1, transition: "opacity 160ms ease" }}
    >
      <section className="hero compact account-hero">
        <div className="account-hero-copy">
          <p className="eyebrow">
            {publicSimulationMode
              ? t("Browser-local account simulation")
              : t("Webhook-authoritative account projection")}
          </p>
          <h1>{t("Your billing account")}</h1>
          <p>
            {publicSimulationMode
              ? t("This view reports isolated sample plan, credit, and entitlement state stored only for this browser tab.")
              : t("This view reports stored plan identity, interval, credits, and entitlements independently. A price is never used to guess the current tier.")}
          </p>
        </div>
        <div aria-hidden="true" className="account-hero-status">
          <span>{t("POSTGRESQL PROJECTION")}</span>
          <strong>{publicSimulationMode ? t("browser-local") : t("AUTHORITATIVE")}</strong>
          <small>{t("read model · no client grants")}</small>
          <i>{account.subscription_status.toUpperCase()}</i>
        </div>
      </section>

      {account.subscription_status === "past_due" ? (
        <section className="pending-banner" aria-labelledby="past-due-title">
          <p className="eyebrow">{t("Payment attention needed")}</p>
          <h2 id="past-due-title">{t("Your latest payment has not settled")}</h2>
          <p>
            {account.entitlements_enforceable
              ? t("Stripe reports this subscription as past due.")
              : t("Product access is paused until Stripe reports the invoice as paid.")}{" "}
            {t("Update the payment method in the Stripe Billing Portal below; entitlements resume only after the paid webhook is processed.")}
          </p>
        </section>
      ) : null}

      {account.pending_change ? (
        <section className="pending-banner" aria-labelledby="pending-title">
          <p className="eyebrow">{t("Pending billing change")}</p>
          <h2 id="pending-title">
            {pendingName} · {account.pending_change.target_interval}
          </h2>
          <p>
            {account.pending_change.timing === "period_end"
              ? t("Your current benefits remain active until {{date}}. No immediate entitlement switch is shown.", {
                  date: formatDate(account.pending_change.effective_at, numberLocale),
                })
              : t("The change is awaiting billing/webhook completion from {{date}}.", {
                  date: formatDate(account.pending_change.effective_at, numberLocale),
                })}
            {account.pending_change.status === "requires_action"
              ? ` ${t("Stripe needs one more payment step before this change can settle.")}`
              : ""}
          </p>
          {pendingPaymentUrl ? (
            <div className="account-actions">
              <button
                className="button primary"
                onClick={() => openPendingPayment(pendingPaymentUrl)}
                type="button"
              >
                {t("Continue payment on Stripe")}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {account.pending_cancellation ? (
        <section
          className="pending-banner"
          aria-labelledby="cancellation-title"
        >
          <p className="eyebrow">{t("Cancellation scheduled")}</p>
          <h2 id="cancellation-title">{t("Current plan → Free")}</h2>
          <p>
            {t("Your current benefits remain active until {{date}}. Plan changes are paused while cancellation is pending; use the Stripe Billing Portal to resume the subscription first.", {
              date: formatDate(account.pending_cancellation.effective_at, numberLocale),
            })}
          </p>
        </section>
      ) : null}

      {error ? (
        <p className="inline-error" role="alert">
          <span>{error}</span>
          <button
            className="button ghost"
            onClick={() => setError(null)}
            type="button"
          >
            {t("Dismiss")}
          </button>
        </p>
      ) : null}

      <div className="account-grid">
        <section className="account-card">
          <p className="eyebrow">{t("Subscription")}</p>
          <h2>{currentName}</h2>
          {!hasSubscription ? (
            <p>
              {publicSimulationMode
                ? t("No sample subscription is active. Use “Review plan changes” below to simulate one without contacting Stripe.")
                : t("No Stripe subscription is active for this account. Use “Review plan changes” below to start one — access is granted only after the paid webhook is processed, never by the redirect back to this app.")}
            </p>
          ) : null}
          <dl className="fact-list">
            <div>
              <dt>{t("Plan key")}</dt>
              <dd>{account.plan_key}</dd>
            </div>
            <div>
              <dt>{t("Billing interval")}</dt>
              <dd>{account.plan_interval ?? t("None")}</dd>
            </div>
            <div>
              <dt>{t("Status")}</dt>
              <dd>
                <span
                  className={`status status-${account.subscription_status}`}
                >
                  {account.subscription_status}
                </span>
              </dd>
            </div>
            <div>
              <dt>{t("Upgrade settlement")}</dt>
              <dd>{account.transition_policy.replaceAll("_", " ")}</dd>
            </div>
            <div>
              <dt>{t("Product access")}</dt>
              <dd>
                {account.entitlements_enforceable ? t("Enforceable") : t("Paused")}
              </dd>
            </div>
            <div>
              <dt>{t("Current period ends")}</dt>
              <dd>{formatDate(account.current_period_end, numberLocale)}</dd>
            </div>
          </dl>
        </section>

        <section className="account-card">
          <p className="eyebrow">{t("Credits")}</p>
          <p className="credit-balance">
            {formatCreditDecimal(account.credits.balance)}
          </p>
          <p>{t("available credits")}</p>
          {isZeroCreditDecimal(account.credits.balance) &&
          !account.credits.next_grant_at ? (
            <p>
              {t("No grant is scheduled. Credit grants start with a paid subscription period and are recorded with database-enforced idempotency.")}
            </p>
          ) : null}
          <dl className="fact-list">
            <div>
              <dt>{t("Subscription balance")}</dt>
              <dd>
                {formatCreditDecimal(account.credits.subscription_balance)}
              </dd>
            </div>
            <div>
              <dt>{t("Purchased balance")}</dt>
              <dd>{formatCreditDecimal(account.credits.purchased_balance)}</dd>
            </div>
            <div>
              <dt>{t("Grant amount")}</dt>
              <dd>{formatCreditDecimal(account.credits.grant_amount)}</dd>
            </div>
            <div>
              <dt>{t("Next grant")}</dt>
              <dd>{formatDate(account.credits.next_grant_at, numberLocale)}</dd>
            </div>
          </dl>
          {account.credits.credit_packs.length > 0 ? (
            <div className="credit-lot-list">
              <h3>{t("Active credit-pack lots")}</h3>
              <ul>
                {account.credits.credit_packs.map((lot) => (
                  <li key={lot.lot_id}>
                    <span>{lot.pack_key}</span>
                    <strong>
                      {t("{{amount}} credits", {
                        amount: formatCreditDecimal(lot.remaining),
                      })}
                    </strong>
                    <small>{t("expires {{date}}", {
                      date: formatDate(lot.expires_at, numberLocale),
                    })}</small>
                  </li>
                ))}
              </ul>
              <p>
                {t("Packs add spendable credits only. They do not change this account’s plan features, limits, or subscription status.")}
              </p>
            </div>
          ) : null}
        </section>
      </div>

      <section className="entitlements-section">
        <div>
          <p className="eyebrow">{t("Structured entitlements")}</p>
          <h2>{t("What the product may enforce")}</h2>
        </div>
        {account.entitlements.length === 0 ? (
          <div className="entitlement-grid">
            <article className="entitlement-card">
              <p>{t("No entitlements granted")}</p>
              <strong>{t("Nothing enforceable yet")}</strong>
              <span>
                {publicSimulationMode
                  ? t("Sample entitlements appear after the browser-local projection. Nothing here is a payment or production entitlement.")
                  : t("Structured entitlements appear here after a subscription webhook projects them. The product enforces exactly what is listed — nothing is inferred from prices or redirects.")}
              </span>
            </article>
          </div>
        ) : (
          <div className="entitlement-grid">
            {account.entitlements.map((entitlement) => (
              <EntitlementCard
                entitlement={entitlement}
                key={entitlement.key}
              />
            ))}
          </div>
        )}
      </section>

      <section
        aria-labelledby="manage-title"
        className="account-card"
        style={{ marginTop: 18 }}
      >
        <p className="eyebrow">{t("Manage")}</p>
        <h2 id="manage-title">{t("Plan changes and billing management")}</h2>
        <p>
          {publicSimulationMode
            ? t("Plan changes and the Portal return are simulated inside this browser tab. No server, payment method, invoice, or cancellation is changed.")
            : t("Plan and interval changes stay in this app so the server can enforce the safe transition matrix. The Stripe Billing Portal handles payment methods, invoices, and cancellation.")}
        </p>
        {loadedAt ? (
          <p>
            {publicSimulationMode
              ? t("Projection loaded {{date}}. Refreshing re-reads browser-local sample state.", {
                  date: formatDate(loadedAt, numberLocale),
                })
              : t("Projection loaded {{date}}. Refreshing re-reads the webhook-backed account API and never mutates billing state.", {
                  date: formatDate(loadedAt, numberLocale),
                })}
          </p>
        ) : null}
        <div className="account-actions">
          <button
            aria-busy={loading}
            className="button ghost"
            disabled={loading}
            onClick={() => void refresh()}
            type="button"
          >
            {loading
              ? t("Refreshing…")
              : publicSimulationMode
                ? t("Refresh simulation")
                : t("Refresh projection")}
          </button>
          <button
            aria-busy={portalBusy}
            className="button secondary"
            disabled={portalBusy}
            onClick={() => void openPortal()}
            type="button"
          >
            {portalBusy
              ? t("Opening Portal…")
              : publicSimulationMode
                ? t("Open simulated Portal")
                : t("Open Stripe Billing Portal")}
          </button>
          <Link className="button primary" href="/pricing">
            {t("Review plan changes")}
          </Link>
        </div>
      </section>
    </div>
  );
}

function EntitlementCard({ entitlement }: { entitlement: Entitlement }) {
  const { numberLocale, t } = useLocale();
  return (
    <article className="entitlement-card">
      <p>{t(entitlement.label)}</p>
      <strong>
        {typeof entitlement.value === "boolean"
          ? entitlement.value
            ? t("Included")
            : t("Not included")
          : entitlement.key === "monthly_credits"
            ? formatCreditDecimal(
                creditAmountFromEntitlement(entitlement).decimal,
              )
            : typeof entitlement.value === "number"
              ? entitlement.value.toLocaleString(numberLocale)
              : String(entitlement.value)}{" "}
        {entitlement.unit ? t(entitlement.unit) : ""}
      </strong>
      <small>{entitlement.key}</small>
      {entitlement.description ? <span>{t(entitlement.description)}</span> : null}
    </article>
  );
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Unknown billing error";
}
