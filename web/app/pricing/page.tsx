import type { Metadata } from "next";
import { PricingScreen } from "@/components/PricingScreen";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Compare explicit monthly and annual plan catalog values.",
};

export default function PricingPage() {
  return <PricingScreen />;
}
