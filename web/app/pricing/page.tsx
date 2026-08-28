import type { Metadata } from "next";
import { PricingScreen } from "@/components/PricingScreen";
import { referenceCatalog } from "@/lib/reference-catalog";
import { absoluteSiteUrl, publicSiteUrl } from "@/lib/site";

export const metadata: Metadata = {
  title: "Stripe Subscription Plans, Credit Packs & Entitlements",
  description:
    "Compare monthly and annual Stripe subscription plans plus one-time credit packs, exact credit entitlements, catalog-priced annual savings, and full-period or prorated upgrade templates.",
  alternates: absoluteSiteUrl(publicSiteUrl, "/pricing")
    ? { canonical: absoluteSiteUrl(publicSiteUrl, "/pricing") }
    : undefined,
  openGraph: {
    title: "Stripe Subscription Plans, Credit Packs & Entitlements",
    description:
      "A three-tier Stripe billing reference with monthly and annual subscriptions, one-time credit packs, exact entitlements, and full-price or prorated upgrades.",
    ...(absoluteSiteUrl(publicSiteUrl, "/pricing")
      ? { url: absoluteSiteUrl(publicSiteUrl, "/pricing") }
      : {}),
  },
};

export default function PricingPage() {
  return <PricingScreen initialCatalog={referenceCatalog} />;
}
