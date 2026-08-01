import type { Metadata } from "next";
import { PricingScreen } from "@/components/PricingScreen";
import { referenceCatalog } from "@/lib/reference-catalog";
import { absoluteSiteUrl, publicSiteUrl } from "@/lib/site";

export const metadata: Metadata = {
  title: "Stripe Subscription Pricing and Entitlements",
  description:
    "Compare a tested three-tier Stripe subscription catalog with monthly and annual prices, credit grants, annual savings, and explicit plan-change behavior.",
  alternates: absoluteSiteUrl(publicSiteUrl, "/pricing")
    ? { canonical: absoluteSiteUrl(publicSiteUrl, "/pricing") }
    : undefined,
  openGraph: {
    title: "Stripe Subscription Pricing and Entitlements",
    description:
      "A three-tier monthly and annual Stripe billing reference with structured entitlements and safe plan changes.",
    ...(absoluteSiteUrl(publicSiteUrl, "/pricing")
      ? { url: absoluteSiteUrl(publicSiteUrl, "/pricing") }
      : {}),
  },
};

export default function PricingPage() {
  return <PricingScreen initialCatalog={referenceCatalog} />;
}
