import type { Metadata } from "next";
import { BillingErrorScreen } from "@/components/BillingErrorScreen";

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

export default async function BillingErrorPage({
  searchParams,
}: BillingErrorPageProps) {
  const query = await searchParams;
  const knownCode =
    query.code &&
    ["payment_failed", "payment_canceled", "authentication_failed"].includes(
      query.code,
    )
      ? query.code
      : null;
  return <BillingErrorScreen code={knownCode} />;
}
