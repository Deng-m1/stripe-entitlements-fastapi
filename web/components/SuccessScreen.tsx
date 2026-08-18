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

export function SuccessScreen({
  expectedPlan,
  expectedInterval,
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
  }, [api, expectedInterval, expectedPlan, maxAttempts, pollIntervalMs]);

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
      <div className={`success-mark ${state}`} aria-hidden="true">
        {state === "confirmed" ? "✓" : "↻"}
      </div>
      <p className="eyebrow">Checkout returned</p>
      <h1>{heading}</h1>
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
      ) : (
        <p>
          Poll {attempt} of {maxAttempts}. Entitlements are granted only after the
          backend processes Stripe state; refreshing this page is safe.
        </p>
      )}
      {lastError ? <p className="inline-error" role="alert">{lastError}</p> : null}
      <div className="account-actions">
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
