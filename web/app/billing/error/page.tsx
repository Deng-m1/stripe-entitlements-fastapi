import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Billing error",
  description: "A billing action stopped without changing entitlement state.",
  robots: { index: false, follow: false },
};

interface BillingErrorPageProps {
  searchParams: Promise<{
    code?: string;
  }>;
}

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

export default async function BillingErrorPage({
  searchParams,
}: BillingErrorPageProps) {
  const query = await searchParams;
  const knownCode = query.code && errorCopy[query.code] ? query.code : null;
  const copy = knownCode ? errorCopy[knownCode] : fallbackCopy;
  return (
    <section className="settlement-band" role="alert">
      <div className="settlement-inner">
        <div className="settlement-card">
          <div className="settlement-mark stopped" aria-hidden="true">!</div>
          <span className="settlement-chip chip-stopped">No state change</span>
          <p className="eyebrow">Billing action stopped</p>
          <h1>{copy.title}</h1>
          <p>{copy.detail}</p>
          <p>
            Nothing was assumed about your entitlement state: plans and credits change
            only after the backend verifies the matching Stripe webhook.
          </p>
          <p>{copy.guidance}</p>
          {knownCode ? <code>Error code: {knownCode}</code> : null}
          <div className="account-actions">
            <Link className="button primary" href="/account">Review account</Link>
            <Link className="button secondary" href="/pricing">Back to pricing</Link>
          </div>
        </div>
        <p className="settlement-note">
          Entitlements change only on verified Stripe webhooks — never on redirects
        </p>
      </div>
    </section>
  );
}
