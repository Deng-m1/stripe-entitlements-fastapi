import type { Metadata } from "next";
import { HomeScreen } from "@/components/HomeScreen";
import { absoluteSiteUrl, publicSiteUrl } from "@/lib/site";

export const metadata: Metadata = {
  title: "Stripe Billing, Credit Packs & Entitlements for FastAPI & TypeScript",
  description:
    "An open-source Stripe billing template with native FastAPI and TypeScript backends, PostgreSQL, exact fractional credits, credit packs, and full-period or prorated upgrades.",
  alternates: absoluteSiteUrl(publicSiteUrl, "/")
    ? { canonical: absoluteSiteUrl(publicSiteUrl, "/") }
    : undefined,
};

export default function HomePage() {
  return <HomeScreen />;
}
