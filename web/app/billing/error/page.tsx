import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Billing error",
  robots: { index: false, follow: false },
};

interface BillingErrorPageProps {
  searchParams: Promise<{
    code?: string;
  }>;
}

const errorMessages: Record<string, string> = {
  payment_failed:
    "Stripe could not complete the payment. Review your account before retrying.",
  payment_canceled:
    "The payment flow was canceled. Your existing account state remains unchanged.",
  authentication_failed:
    "Payment authentication did not complete. Review your account before retrying.",
};

export default async function BillingErrorPage({
  searchParams,
}: BillingErrorPageProps) {
  const query = await searchParams;
  const knownCode = query.code && errorMessages[query.code] ? query.code : null;
  return (
    <section className="success-card error-card" role="alert">
      <div className="success-mark timed_out" aria-hidden="true">!</div>
      <p className="eyebrow">Billing action stopped</p>
      <h1>Nothing was assumed about your entitlement state.</h1>
      <p>
        {(knownCode && errorMessages[knownCode]) ??
          "The billing operation could not be completed. Review your account before retrying."}
      </p>
      {knownCode ? <code>Error code: {knownCode}</code> : null}
      <div className="account-actions">
        <Link className="button primary" href="/account">Review account</Link>
        <Link className="button ghost" href="/pricing">Back to pricing</Link>
      </div>
    </section>
  );
}
