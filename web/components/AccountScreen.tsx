"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
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
  const [portalBusy, setPortalBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [nextAccount, nextCatalog] = await Promise.all([
        api.getAccount(),
        api.getCatalog(),
      ]);
      setError(null);
      setAccount(nextAccount);
      setCatalog(nextCatalog);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [api]);

  useEffect(() => {
    let active = true;
    void Promise.all([api.getAccount(), api.getCatalog()])
      .then(([nextAccount, nextCatalog]) => {
        if (!active) return;
        setError(null);
        setAccount(nextAccount);
        setCatalog(nextCatalog);
      })
      .catch((caught: unknown) => {
        if (active) setError(errorMessage(caught));
      });
    return () => {
      active = false;
    };
  }, [api]);

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
    return <ErrorState error={error} retry={() => void load()} />;
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

  return (
    <div>
      <section className="hero compact">
        <p className="eyebrow">Webhook-authoritative account projection</p>
        <h1>Your billing account</h1>
        <p>
          This view reports stored plan identity, interval, credits, and entitlements
          independently. A price is never used to guess the current tier.
        </p>
      </section>

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
          </p>
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

      {error ? <p className="inline-error" role="alert">{error}</p> : null}

      <div className="account-grid">
        <section className="account-card">
          <p className="eyebrow">Subscription</p>
          <h2>{currentName}</h2>
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
              <dd><span className={`status status-${account.subscription_status}`}>{account.subscription_status}</span></dd>
            </div>
            <div>
              <dt>Upgrade settlement</dt>
              <dd>{account.transition_policy.replaceAll("_", " ")}</dd>
            </div>
            <div>
              <dt>Product access</dt>
              <dd>{account.entitlements_enforceable ? "Enforceable" : "Paused"}</dd>
            </div>
            <div>
              <dt>Current period ends</dt>
              <dd>{formatDate(account.current_period_end)}</dd>
            </div>
          </dl>
        </section>

        <section className="account-card">
          <p className="eyebrow">Credits</p>
          <p className="credit-balance">{account.credits.balance.toLocaleString()}</p>
          <p>available credits</p>
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
      </div>

      <section className="entitlements-section">
        <div>
          <p className="eyebrow">Structured entitlements</p>
          <h2>What the product may enforce</h2>
        </div>
        <div className="entitlement-grid">
          {account.entitlements.map((entitlement) => (
            <EntitlementCard entitlement={entitlement} key={entitlement.key} />
          ))}
        </div>
      </section>

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
        {pendingPaymentUrl ? (
          <button
            className="button secondary"
            onClick={() => openPendingPayment(pendingPaymentUrl)}
            type="button"
          >
            Continue payment on Stripe
          </button>
        ) : null}
      </div>
      <p className="portal-scope-note">
        The Portal is for payment methods, invoices, and cancellation. Plan price
        changes stay in this app so the server can enforce the safe transition matrix.
      </p>
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
