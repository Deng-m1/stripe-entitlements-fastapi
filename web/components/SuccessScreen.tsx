"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useLocale } from "@/components/LocaleProvider";
import { completeIdempotentIntent } from "@/lib/idempotency";
import { formatCreditDecimal } from "@/lib/credit-amount";
import { getBillingApi, publicSimulationMode } from "@/lib/runtime";
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
  const { t } = useLocale();
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
      ? publicSimulationMode
        ? t("Simulated account state is ready")
        : t("Webhook-backed account state is ready")
      : state === "invalid"
        ? t("This billing return cannot be verified")
        : state === "timed_out"
          ? t("Payment may still be processing")
          : publicSimulationMode
            ? t("Waiting for simulated projection")
            : t("Waiting for webhook confirmation");

  return (
    <section
      aria-busy={state === "validating" || state === "polling"}
      aria-live="polite"
      className="app-page billing-result success-card"
    >
      <style>{successLocalStyles}</style>
      <div className={`success-mark ${state}`} aria-hidden="true">
        {state === "confirmed" ? "✓" : state === "timed_out" ? "!" : "↻"}
      </div>
      <p className="eyebrow">
        {publicSimulationMode ? t("Simulation returned") : t("Checkout returned")}
      </p>
      <h1>{heading}</h1>
      {state !== "invalid" ? (
        <ol className="success-steps">
          <li className="done">
            {publicSimulationMode ? t("Simulated redirect returned") : t("Returned from checkout")}
          </li>
          <li
            aria-current={state === "confirmed" ? undefined : "step"}
            className={state === "confirmed" ? "done" : "active"}
          >
            {publicSimulationMode
              ? t("Browser-local projection applied")
              : t("Webhook projection applied")}
          </li>
          <li className={state === "confirmed" ? "done" : ""}>
            {expectedCreditPack
              ? publicSimulationMode
                ? t("Sample credits available")
                : t("Purchased credits available")
              : publicSimulationMode
                ? t("Sample entitlements active")
                : t("Entitlements enforceable")}
          </li>
        </ol>
      ) : null}
      {state === "confirmed" ? (
        publicSimulationMode ? (
          <p>{t("Browser-local sample state now shows the requested {{target}}. No Checkout, payment, webhook, or server account was created.", {
            target: expectedCreditPack
              ? t("{{pack}} credit pack", { pack: expectedCreditPack })
              : t("{{plan}} plan", {
                  plan: `${account?.plan_key}/${account?.plan_interval}`,
                }),
          })}</p>
        ) : expectedCreditPack ? (
          <p>{t("The account API now reports the {{pack}} funding lot for this exact Checkout Session. The return redirect itself was not treated as proof of payment.", {
            pack: expectedCreditPack,
          })}</p>
        ) : (
          <p>{t("The account API now reports {{plan}} as active. The success redirect itself was not treated as proof of entitlement.", {
            plan: `${account?.plan_key}/${account?.plan_interval}`,
          })}</p>
        )
      ) : state === "invalid" ? (
        <p>{t("The return URL must identify exactly one valid catalog plan/interval or one credit pack and Checkout Session. Review the account state directly; this page will not infer a successful purchase.")}</p>
      ) : state === "timed_out" ? (
        <p>{t("{{attempts}} polls finished without a {{projection}} {{target}} result. No entitlement or purchased balance. {{guidance}}", {
          attempts: maxAttempts,
          projection: publicSimulationMode ? t("simulated") : t("webhook-projected"),
          target: expectedCreditPack ?? `${expectedPlan}/${expectedInterval}`,
          guidance: publicSimulationMode
            ? t("Resetting the public simulation is safe.")
            : t("Stripe may still be processing. Checking again is safe and repeatable."),
        })}</p>
      ) : (
        <p>{t("Poll {{attempt}} of {{max}}. Entitlements are granted only after the {{source}}; refreshing this page is safe.", {
          attempt,
          max: maxAttempts,
          source: publicSimulationMode
            ? t("browser-local simulation applies its delayed sample projection")
            : t("backend processes Stripe state"),
        })}</p>
      )}
      {state === "confirmed" && account ? (
        <dl className="success-facts">
          <div>
            <dt>{t("Plan")}</dt>
            <dd>
              {account.plan_key} · {account.plan_interval}
            </dd>
          </div>
          <div>
            <dt>{t("Subscription")}</dt>
            <dd>{account.subscription_status}</dd>
          </div>
          <div>
            <dt>{t("Credit balance")}</dt>
            <dd>{t("{{amount}} credits", {
              amount: formatCreditDecimal(account.credits.balance),
            })}</dd>
          </div>
          {expectedCreditPack ? (
            <div>
              <dt>{t("Purchased balance")}</dt>
              <dd>
                {t("{{amount}} credits", {
                  amount: formatCreditDecimal(account.credits.purchased_balance),
                })}
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
            {t("Check account state again")}
          </button>
        ) : null}
        <Link className="button primary" href="/account">
          {t("View account")}
        </Link>
        <Link className="button ghost" href="/pricing">
          {t("Back to pricing")}
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
