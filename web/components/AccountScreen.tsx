"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import {
  completeIdempotentIntent,
  idempotencyKeyForIntent,
} from "@/lib/idempotency";
import { formatDate } from "@/lib/money";
import { browserBillingRedirect, getBillingApi } from "@/lib/runtime";
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
  if (!account || !catalog) return <LoadingState label="Loading account state…" />;

  const currentName =
    catalog.plans.find((plan) => plan.key === account.plan_key)?.name ??
    account.plan_key;
  const pendingName = account.pending_change
    ? catalog.plans.find(
        (plan) => plan.key === account.pending_change?.target_plan_key,
      )?.name ?? account.pending_change.target_plan_key
    : null;
  const pendingPaymentUrl = account.pending_change?.payment_url;
  const hasSubscription =
    account.subscription_status !== "none" &&
    account.subscription_status !== "canceled";

  return (
    <div
      aria-busy={loading}
      style={{ opacity: loading ? 0.7 : 1, transition: "opacity 160ms ease" }}
    >
      {/* Workspace header (DESIGN_SYSTEM.md §5.3): one quiet mesh accent rule,
          the page title, and a rail of the three facts a visitor checks
          first, so the answer is legible before any card is read. */}
      <section className="account-header">
        <p className="eyebrow">
          <span className="eyebrow-label">
            Webhook-authoritative account projection
          </span>
        </p>
        <h1>Your billing account</h1>
        <p>
          This view reports stored plan identity, interval, credits, and entitlements
          independently. A price is never used to guess the current tier.
        </p>
        <dl aria-label="Account status summary" className="account-rail">
          <div>
            <dt>Plan</dt>
            <dd>
              {currentName}
              {account.plan_interval ? ` · ${account.plan_interval}` : ""}
            </dd>
          </div>
          <div>
            <dt>Product access</dt>
            <dd>
              <span
                className={
                  account.entitlements_enforceable
                    ? "status status-active"
                    : "status status-past_due"
                }
              >
                {account.entitlements_enforceable ? "Enforceable" : "Paused"}
              </span>
            </dd>
          </div>
          <div>
            <dt>Entitlements</dt>
            <dd>{account.entitlements.length}</dd>
          </div>
        </dl>
      </section>

      {account.subscription_status === "past_due" ? (
        <section className="pending-banner" aria-labelledby="past-due-title">
          <p className="eyebrow">Payment attention needed</p>
          <h2 id="past-due-title">Your latest payment has not settled</h2>
          <p>
            {account.entitlements_enforceable
              ? "Stripe reports this subscription as past due."
              : "Product access is paused until Stripe reports the invoice as paid."}{" "}
            Update the payment method in the Stripe Billing Portal below;
            entitlements resume only after the paid webhook is processed.
          </p>
        </section>
      ) : null}

      {account.pending_change ? (
        <section className="pending-banner" aria-labelledby="pending-title">
          <p className="eyebrow">Pending billing change</p>
          <h2 id="pending-title">
            {pendingName} · {account.pending_change.target_interval}
          </h2>
          <p>
            {account.pending_change.timing === "period_end"
              ? `Your current benefits remain active until ${formatDate(
                  account.pending_change.effective_at,
                )}. No immediate entitlement switch is shown.`
              : `The change is awaiting billing/webhook completion from ${formatDate(
                  account.pending_change.effective_at,
                )}.`}
            {account.pending_change.status === "requires_action"
              ? " Stripe needs one more payment step before this change can settle."
              : ""}
          </p>
          {pendingPaymentUrl ? (
            <div className="account-actions">
              <button
                className="button primary"
                onClick={() => openPendingPayment(pendingPaymentUrl)}
                type="button"
              >
                Continue payment on Stripe
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {account.pending_cancellation ? (
        <section className="pending-banner" aria-labelledby="cancellation-title">
          <p className="eyebrow">Cancellation scheduled</p>
          <h2 id="cancellation-title">Current plan → Free</h2>
          <p>
            Your current benefits remain active until {formatDate(
              account.pending_cancellation.effective_at,
            )}. Plan changes are paused while cancellation is pending; use the
            Stripe Billing Portal to resume the subscription first.
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
            Dismiss
          </button>
        </p>
      ) : null}

      {/* Workspace body: the projection people read runs down the main
          column, the numbers and the controls they act on sit in the rail.
          Splitting them this way also stops the shorter card from stretching
          to its neighbour's height and leaving a dead half-column. */}
      <div className="account-workspace">
        <div className="account-main">
          <section className="account-card">
            <p className="eyebrow">
              <span className="eyebrow-label">Subscription</span>
            </p>
            <h2>{currentName}</h2>
            {!hasSubscription ? (
              <p>
                No Stripe subscription is active for this account. Use “Review
                plan changes” to start one — access is granted only after the
                paid webhook is processed, never by the redirect back to this
                app.
              </p>
            ) : null}
            <dl className="fact-list">
              <div>
                <dt>Plan key</dt>
                <dd>{account.plan_key}</dd>
              </div>
              <div>
                <dt>Billing interval</dt>
                <dd>{account.plan_interval ?? "None"}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <span
                    className={`status status-${account.subscription_status}`}
                  >
                    {account.subscription_status}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Upgrade settlement</dt>
                <dd>{account.transition_policy.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt>Current period ends</dt>
                <dd>{formatDate(account.current_period_end)}</dd>
              </div>
            </dl>
          </section>

          <section className="entitlements-section">
            <p className="eyebrow">
              <span className="eyebrow-label">Structured entitlements</span>
            </p>
            <h2>What the product may enforce</h2>
            {account.entitlements.length === 0 ? (
              <div className="entitlement-empty">
                <strong>Nothing enforceable yet</strong>
                <span>
                  Structured entitlements appear here after a subscription
                  webhook projects them. The product enforces exactly what is
                  listed — nothing is inferred from prices or redirects.
                </span>
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
        </div>

        <div className="account-rail-column">
          <section className="account-card credits-card">
            <p className="eyebrow">
              <span className="eyebrow-label">Credits</span>
            </p>
            <p className="credit-balance">
              {account.credits.balance.toLocaleString()}
            </p>
            <p className="credit-caption">available credits</p>
            {account.credits.balance === 0 && !account.credits.next_grant_at ? (
              <p>
                No grant is scheduled. Credit grants start with a paid
                subscription period and are recorded with database-enforced
                idempotency.
              </p>
            ) : null}
            <dl className="fact-list">
              <div>
                <dt>Grant amount</dt>
                <dd>{account.credits.grant_amount.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Next grant</dt>
                <dd>{formatDate(account.credits.next_grant_at)}</dd>
              </div>
            </dl>
          </section>

          <section
            aria-labelledby="manage-title"
            className="account-card manage-card"
          >
            <p className="eyebrow">
              <span className="eyebrow-label">Manage</span>
            </p>
            <h2 id="manage-title">Plan changes and billing management</h2>
            <p>
              Plan and interval changes stay in this app so the server can
              enforce the safe transition matrix. The Stripe Billing Portal
              handles payment methods, invoices, and cancellation.
            </p>
            <div className="account-actions">
              <Link className="button primary" href="/pricing">
                Review plan changes
              </Link>
              <button
                aria-busy={portalBusy}
                className="button secondary"
                disabled={portalBusy}
                onClick={() => void openPortal()}
                type="button"
              >
                {portalBusy ? "Opening Portal…" : "Open Stripe Billing Portal"}
              </button>
              <button
                aria-busy={loading}
                className="button ghost"
                disabled={loading}
                onClick={() => void refresh()}
                type="button"
              >
                {loading ? "Refreshing…" : "Refresh projection"}
              </button>
            </div>
            {loadedAt ? (
              <p className="projection-stamp">
                Projection loaded {formatDate(loadedAt)}. Refreshing re-reads
                the webhook-backed account API and never mutates billing state.
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

function EntitlementCard({ entitlement }: { entitlement: Entitlement }) {
  return (
    <article className="entitlement-card">
      <p>{entitlement.label}</p>
      <strong>
        {typeof entitlement.value === "boolean"
          ? entitlement.value
            ? "Included"
            : "Not included"
          : String(entitlement.value)}{" "}
        {entitlement.unit ?? ""}
      </strong>
      <small>{entitlement.key}</small>
      {entitlement.description ? <span>{entitlement.description}</span> : null}
    </article>
  );
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Unknown billing error";
}
