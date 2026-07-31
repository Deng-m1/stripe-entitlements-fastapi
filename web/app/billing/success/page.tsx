import type { Metadata } from "next";
import { SuccessScreen } from "@/components/SuccessScreen";
import type { BillingInterval } from "@/lib/types";

export const metadata: Metadata = {
  title: "Confirming billing",
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
  const expectedInterval =
    query.expected_interval === "month" ||
    query.expected_interval === "year"
      ? (query.expected_interval as BillingInterval)
      : undefined;
  return (
    <SuccessScreen
      expectedInterval={expectedInterval}
      expectedPlan={query.expected_plan}
    />
  );
}
