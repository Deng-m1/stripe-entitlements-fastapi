"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { completeIdempotentIntent } from "@/lib/idempotency";
import { formatCreditDecimal } from "@/lib/credit-amount";
import { getBillingApi } from "@/lib/runtime";
import type { AccountResponse, BillingApi, BillingInterval } from "@/lib/types";

interface SuccessScreenProps {
  expectedPlan?: string;
  expectedInterval?: BillingInterval;
  expectedCreditPack?: string;
  expectedCheckoutSessionId?: string;
  api?: BillingApi;
  pollIntervalMs?: number;
  maxAttempts?: number;
}

export function SuccessScreen({
  expectedPlan,
  expectedInterval,
  expectedCreditPack,
  expectedCheckoutSessionId,
  api = getBillingApi(),
  pollIntervalMs = 1500,
  maxAttempts = 12,
}: SuccessScreenProps) {
  const [state, setState] = useState<
    "validating" | "polling" | "confirmed" | "timed_out" | "invalid"
  >("validating");
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
        const packConfirmed = Boolean(
          expectedCreditPack &&
            expectedCheckoutSessionId &&
            current.credits.credit_packs.some(
              (lot) =>
                lot.pack_key === expectedCreditPack &&
                lot.checkout_session_id === expectedCheckoutSessionId,
            ),
        );
        const subscriptionConfirmed = Boolean(
          expectedPlan &&
            expectedInterval &&
            current.plan_key === expectedPlan &&
            current.plan_interval === expectedInterval &&
            current.subscription_status === "active" &&
            current.entitlements_enforceable,
        );
        if (packConfirmed || subscriptionConfirmed) {
          if (packConfirmed) {
            completeIdempotentIntent(`credit-pack:${expectedCreditPack}`);
          } else {
            completeIdempotentIntent(
              `checkout:${expectedPlan}:${expectedInterval}`,
            );
            completeIdempotentIntent(
              `preview:${expectedPlan}:${expectedInterval}`,
            );
          }
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
      const planTargetValid = Boolean(
        expectedPlan &&
          expectedInterval &&
          !expectedCreditPack &&
          (!expectedCheckoutSessionId ||
            /^cs_[A-Za-z0-9_]+$/.test(expectedCheckoutSessionId)) &&
          /^[a-z][a-z0-9_-]{0,63}$/.test(expectedPlan),
      );
      const packTargetValid = Boolean(
        expectedCreditPack &&
          expectedCheckoutSessionId &&
          !expectedPlan &&
          !expectedInterval &&
          /^[a-z][a-z0-9-]{0,63}$/.test(expectedCreditPack) &&
          /^cs_[A-Za-z0-9_]+$/.test(expectedCheckoutSessionId),
      );
      if (!planTargetValid && !packTargetValid) {
        setState("invalid");
        return;
      }
      try {
        const catalog = await api.getCatalog();
        if (cancelled) return;
        if (
          (planTargetValid &&
            !catalog.plans.some((plan) => plan.key === expectedPlan)) ||
          (packTargetValid &&
            !catalog.credit_packs.some(
              (pack) => pack.key === expectedCreditPack,
            ))
        ) {
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
  }, [
    api,
    expectedCheckoutSessionId,
    expectedCreditPack,
    expectedInterval,
    expectedPlan,
    maxAttempts,
    pollIntervalMs,
    pollRun,
  ]);

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

  return (
    <section
      aria-busy={state === "validating" || state === "polling"}
      aria-live="polite"
      className="success-card"
    >
      <style>{successLocalStyles}</style>
      <div className={`success-mark ${state}`} aria-hidden="true">
        {state === "confirmed" ? "✓" : state === "timed_out" ? "!" : "↻"}
      </div>
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
            {expectedCreditPack ? "Purchased credits available" : "Entitlements enforceable"}
          </li>
        </ol>
      ) : null}
      {state === "confirmed" ? (
        expectedCreditPack ? (
          <p>
            The account API now reports the {expectedCreditPack} funding lot for this
            exact Checkout Session. The return redirect itself was not treated as proof
            of payment.
          </p>
        ) : (
          <p>
            The account API now reports {account?.plan_key}/{account?.plan_interval} as
            active. The success redirect itself was not treated as proof of entitlement.
          </p>
        )
      ) : state === "invalid" ? (
        <p>
          The return URL must identify exactly one valid catalog plan/interval or one
          credit pack and Checkout Session. Review the account state directly; this page
          will not infer a successful purchase.
        </p>
      ) : state === "timed_out" ? (
        <p>
          {maxAttempts} polls finished without a webhook-projected{" "}
          {expectedCreditPack ?? `${expectedPlan}/${expectedInterval}`} result. No
          entitlement or purchased balance is assumed from the redirect; Stripe may
          still be processing. Checking again is safe and repeatable.
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
            <dd>{formatCreditDecimal(account.credits.balance)} credits</dd>
          </div>
          {expectedCreditPack ? (
            <div>
              <dt>Purchased balance</dt>
              <dd>
                {formatCreditDecimal(account.credits.purchased_balance)} credits
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {lastError ? <p className="inline-error" role="alert">{lastError}</p> : null}
      <div className="account-actions">
        {state === "timed_out" ? (
          <button
            className="button secondary"
            onClick={restartPolling}
            type="button"
          >
            Check account state again
          </button>
        ) : null}
        <Link className="button primary" href="/account">
          View account
        </Link>
        <Link className="button ghost" href="/pricing">
          Back to pricing
        </Link>
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
