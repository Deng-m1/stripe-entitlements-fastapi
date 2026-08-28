import type { Metadata } from "next";
import { PricingScreen } from "@/components/PricingScreen";
import { referenceCatalog } from "@/lib/reference-catalog";
import { absoluteSiteUrl, publicSiteUrl } from "@/lib/site";

export const metadata: Metadata = {
  title: "Stripe Subscription Pricing and Entitlements",
  description:
    "Compare a three-tier Stripe catalog with monthly and annual prices, credit entitlements, explicit annual savings priced in the catalog (no simulated coupons), and complete full-period or prorated-difference templates.",
  alternates: absoluteSiteUrl(publicSiteUrl, "/pricing")
    ? { canonical: absoluteSiteUrl(publicSiteUrl, "/pricing") }
    : undefined,
  openGraph: {
    title: "Stripe Subscription Pricing and Entitlements",
    description:
      "A three-tier monthly and annual Stripe billing reference with structured entitlements, catalog-priced annual savings, and full-price or prorated plan upgrades.",
    ...(absoluteSiteUrl(publicSiteUrl, "/pricing")
      ? { url: absoluteSiteUrl(publicSiteUrl, "/pricing") }
      : {}),
  },
};

export default function PricingPage() {
  // The route-level wrapper lets globals.css collapse the shared page
  // padding so the full-bleed gradient ribbon opens at the very top, even
  // while the client screen is still in its loading or error state.
  return (
    <div className="pricing-route">
      <PricingScreen initialCatalog={referenceCatalog} />
    </div>
  );
}
