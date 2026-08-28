"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { completeIdempotentIntent } from "@/lib/idempotency";
import { getBillingApi } from "@/lib/runtime";
import type { AccountResponse, BillingApi, BillingInterval } from "@/lib/types";

interface SuccessScreenProps {
  expectedPlan?: string;
  expectedInterval?: BillingInterval;
  api?: BillingApi;
  pollIntervalMs?: number;
  maxAttempts?: number;
}

type ScreenState =
  | "validating"
  | "polling"
  | "confirmed"
  | "timed_out"
  | "invalid";

// Settlement status chip (DESIGN_SYSTEM.md §5.4): success semantics only
// after the webhook projection is confirmed; a bare redirect stays pending.
const chipByState: Record<ScreenState, { label: string; tone: string }> = {
  validating: { label: "Verifying return", tone: "chip-pending" },
  polling: { label: "Awaiting webhook", tone: "chip-pending" },
  confirmed: { label: "Webhook verified", tone: "chip-confirmed" },
  timed_out: { label: "Unconfirmed", tone: "chip-pending" },
  invalid: { label: "Unverifiable", tone: "chip-stopped" },
};

export function SuccessScreen({
  expectedPlan,
  expectedInterval,
  api = getBillingApi(),
  pollIntervalMs = 1500,
  maxAttempts = 12,
}: SuccessScreenProps) {
  const [state, setState] = useState<ScreenState>("validating");
  const [attempt, setAttempt] = useState(0);
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [pollRun, setPollRun] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll(nextAttempt: number) {
      if (cancelled) return;
      setAttempt(nextAttempt);
      try {
        const current = await api.getAccount();
        if (cancelled) return;
        setAccount(current);
        setLastError(null);
        const matchesPlan = current.plan_key === expectedPlan;
        const matchesInterval = current.plan_interval === expectedInterval;
        if (
          matchesPlan &&
          matchesInterval &&
          current.subscription_status === "active" &&
          current.entitlements_enforceable
        ) {
          completeIdempotentIntent(
            `checkout:${expectedPlan}:${expectedInterval}`,
          );
          completeIdempotentIntent(
            `preview:${expectedPlan}:${expectedInterval}`,
          );
          setState("confirmed");
          return;
        }
      } catch (caught) {
        if (cancelled) return;
        setLastError(
          caught instanceof Error ? caught.message : "Unknown account polling error",
        );
      }
      if (nextAttempt >= maxAttempts) {
        setState("timed_out");
        return;
      }
      timer = setTimeout(() => void poll(nextAttempt + 1), pollIntervalMs);
    }

    async function validateAndPoll() {
      if (
        !expectedPlan ||
        !expectedInterval ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(expectedPlan)
      ) {
        setState("invalid");
        return;
      }
      try {
        const catalog = await api.getCatalog();
        if (cancelled) return;
        if (!catalog.plans.some((plan) => plan.key === expectedPlan)) {
          setState("invalid");
          return;
        }
        setState("polling");
        await poll(1);
      } catch (caught) {
        if (cancelled) return;
        setLastError(
          caught instanceof Error
            ? caught.message
            : "Unknown billing return validation error",
        );
        setState("timed_out");
      }
    }

    void validateAndPoll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, expectedInterval, expectedPlan, maxAttempts, pollIntervalMs, pollRun]);

  function restartPolling() {
    setState("validating");
    setLastError(null);
    setAttempt(0);
    setPollRun((run) => run + 1);
  }

  const heading =
    state === "confirmed"
      ? "Webhook-backed account state is ready"
      : state === "invalid"
        ? "This billing return cannot be verified"
        : state === "timed_out"
          ? "Payment may still be processing"
          : "Waiting for webhook confirmation";

  const chip = chipByState[state];

  return (
    <section
      aria-busy={state === "validating" || state === "polling"}
      aria-live="polite"
      className="settlement-band"
    >
      <style>{successLocalStyles}</style>
      <div className="settlement-inner">
        <div className="settlement-card">
          {state === "confirmed" ? (
            <div aria-hidden="true" className="settlement-medallion">
              <span>✓</span>
            </div>
          ) : (
            <div aria-hidden="true" className={`settlement-mark ${state}`}>
              {state === "timed_out" || state === "invalid" ? "!" : "↻"}
            </div>
          )}
          <span className={`settlement-chip ${chip.tone}`}>{chip.label}</span>
          <p className="eyebrow">Checkout returned</p>
          <h1>{heading}</h1>
          {state !== "invalid" ? (
            <ol className="success-steps">
              <li className="done">Returned from checkout</li>
              <li
                aria-current={state === "confirmed" ? undefined : "step"}
                className={state === "confirmed" ? "done" : "active"}
              >
                Webhook projection applied
              </li>
              <li className={state === "confirmed" ? "done" : ""}>
                Entitlements enforceable
              </li>
            </ol>
          ) : null}
          {state === "confirmed" ? (
            <p>
              The account API now reports {account?.plan_key}/{account?.plan_interval} as
              active. The success redirect itself was not treated as proof of entitlement.
            </p>
          ) : state === "invalid" ? (
            <p>
              The return URL is missing a valid catalog plan and interval. Review the
              account state directly; this page will not infer a successful purchase.
            </p>
          ) : state === "timed_out" ? (
            <p>
              {maxAttempts} polls finished without a webhook-projected{" "}
              {expectedPlan}/{expectedInterval} account. No entitlement is assumed from
              the redirect; Stripe may still be processing. Checking again is safe and
              repeatable.
            </p>
          ) : (
            <p>
              Poll {attempt} of {maxAttempts}. Entitlements are granted only after the
              backend processes Stripe state; refreshing this page is safe.
            </p>
          )}
          {state === "confirmed" && account ? (
            <dl className="success-facts">
              <div>
                <dt>Plan</dt>
                <dd>
                  {account.plan_key} · {account.plan_interval}
                </dd>
              </div>
              <div>
                <dt>Subscription</dt>
                <dd>{account.subscription_status}</dd>
              </div>
              <div>
                <dt>Credit balance</dt>
                <dd>{account.credits.balance.toLocaleString("en-US")} credits</dd>
              </div>
            </dl>
          ) : null}
          {lastError ? <p className="inline-error" role="alert">{lastError}</p> : null}
          <div className="account-actions">
            {state === "timed_out" ? (
              <button
                className="button primary"
                onClick={restartPolling}
                type="button"
              >
                Check account state again
              </button>
            ) : null}
            <Link
              className={state === "timed_out" ? "button secondary" : "button primary"}
              href="/account"
            >
              View account
            </Link>
            <Link
              className={state === "timed_out" ? "button ghost" : "button secondary"}
              href="/pricing"
            >
              Back to pricing
            </Link>
          </div>
        </div>
        <p className="settlement-note">
          Entitlements change only on verified Stripe webhooks — never on redirects
        </p>
      </div>
    </section>
  );
}

const successLocalStyles = `
.success-steps {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  justify-content: center;
  list-style: none;
  margin: 0;
  padding: 0;
}

.success-steps li {
  align-items: center;
  color: var(--muted);
  display: inline-flex;
  font-size: 0.88rem;
  font-weight: 650;
  gap: 8px;
}

.success-steps li::before {
  background: var(--line);
  border-radius: 50%;
  content: "";
  height: 9px;
  width: 9px;
}

.success-steps li.active {
  color: var(--text);
}

.success-steps li.active::before {
  background: var(--warning);
}

.success-steps li.done {
  color: var(--success);
}

.success-steps li.done::before {
  background: var(--success);
}

.success-facts {
  display: grid;
  gap: 10px 22px;
  grid-template-columns: repeat(3, minmax(0, auto));
  justify-content: center;
  margin: 0;
}

.success-facts div {
  border-top: 1px solid var(--line);
  padding-top: 10px;
  text-align: left;
}

@media (max-width: 560px) {
  .success-facts {
    grid-template-columns: 1fr;
  }
}
`;
