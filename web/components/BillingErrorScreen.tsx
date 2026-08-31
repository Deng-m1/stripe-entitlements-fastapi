"use client";

import Link from "next/link";
import { useLocale } from "@/components/LocaleProvider";

interface BillingErrorCopy {
  title: string;
  detail: string;
  guidance: string;
}

const errorCopy: Record<string, BillingErrorCopy> = {
  payment_failed: {
    title: "The payment did not complete",
    detail:
      "Stripe could not complete the payment, so no plan or credit change was recorded.",
    guidance:
      "Check the payment method through the Stripe Billing Portal on your account page, then retry the change from pricing.",
  },
  payment_canceled: {
    title: "The payment flow was canceled",
    detail:
      "You left the Stripe payment flow before it finished. Your existing account state remains unchanged.",
    guidance:
      "Restart the same change from the pricing page whenever you are ready; a retried intent reuses its original idempotency key.",
  },
  authentication_failed: {
    title: "Payment authentication did not complete",
    detail:
      "The additional authentication step Stripe requested was not completed, so the payment did not settle.",
    guidance:
      "Retry the change and finish the authentication prompt, or update the payment method in the Billing Portal first.",
  },
};

const fallbackCopy: BillingErrorCopy = {
  title: "The billing operation could not be completed",
  detail: "The billing operation stopped before it finished.",
  guidance: "Review your account state before retrying.",
};

export function BillingErrorScreen({ code }: { code: string | null }) {
  const { t } = useLocale();
  const copy = code ? (errorCopy[code] ?? fallbackCopy) : fallbackCopy;

  return (
    <section className="app-page billing-result success-card error-card" role="alert">
      <div className="success-mark timed_out" aria-hidden="true">!</div>
      <p className="eyebrow">{t("Billing action stopped")}</p>
      <h1>{t(copy.title)}</h1>
      <p>{t(copy.detail)}</p>
      <p>
        {t(
          "Nothing was assumed about your entitlement state: plans and credits change only after the backend verifies the matching Stripe webhook.",
        )}
      </p>
      <p>{t(copy.guidance)}</p>
      {code ? <code>{t("Error code: {{code}}", { code })}</code> : null}
      <div className="account-actions">
        <Link className="button primary" href="/account">{t("Review account")}</Link>
        <Link className="button ghost" href="/pricing">{t("Back to pricing")}</Link>
      </div>
    </section>
  );
}
