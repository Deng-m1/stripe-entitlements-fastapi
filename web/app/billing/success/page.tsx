import type { Metadata } from "next";
import { SuccessScreen } from "@/components/SuccessScreen";

export const metadata: Metadata = {
  title: "Confirming billing",
  description: "Verify the webhook-backed result of a Stripe billing return.",
  robots: { index: false, follow: false },
};

interface SuccessPageProps {
  searchParams: Promise<{
    expected_plan?: string;
    expected_interval?: string;
  }>;
}

export default async function BillingSuccessPage({
  searchParams,
}: SuccessPageProps) {
  const query = await searchParams;
  // Comparison narrowing keeps the interval a checked BillingInterval; anything
  // else is dropped so SuccessScreen reports an unverifiable billing return.
  const expectedInterval =
    query.expected_interval === "month" || query.expected_interval === "year"
      ? query.expected_interval
      : undefined;
  return (
    <SuccessScreen
      expectedInterval={expectedInterval}
      expectedPlan={query.expected_plan}
    />
  );
}
