import type { Metadata } from "next";
import { PricingScreen } from "@/components/PricingScreen";
import { referenceCatalog } from "@/lib/reference-catalog";
import { absoluteSiteUrl, publicSiteUrl } from "@/lib/site";

export const metadata: Metadata = {
  title: "Stripe Subscription Pricing and Entitlements",
  description:
    "Compare a three-tier Stripe catalog with monthly and annual prices, credit entitlements, savings, and complete full-period or prorated-difference templates.",
  alternates: absoluteSiteUrl(publicSiteUrl, "/pricing")
    ? { canonical: absoluteSiteUrl(publicSiteUrl, "/pricing") }
    : undefined,
  openGraph: {
    title: "Stripe Subscription Pricing and Entitlements",
    description:
      "A three-tier monthly and annual Stripe billing reference with structured entitlements and full-price or prorated plan upgrades.",
    ...(absoluteSiteUrl(publicSiteUrl, "/pricing")
      ? { url: absoluteSiteUrl(publicSiteUrl, "/pricing") }
      : {}),
  },
};

export default function PricingPage() {
  return <PricingScreen initialCatalog={referenceCatalog} />;
}
