import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DemoNotice } from "@/components/DemoNotice";
import { SiteHeader } from "@/components/SiteHeader";
import {
  absoluteSiteUrl,
  allowIndexing,
  publicSiteUrl,
  REPOSITORY_URL,
  SITE_DESCRIPTION,
  SITE_NAME,
} from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  // The loopback fallback only resolves generated image paths on fail-closed noindex
  // builds. Public canonical deployments must provide NEXT_PUBLIC_SITE_URL.
  metadataBase: publicSiteUrl ?? new URL("http://localhost:3000"),
  title: {
    default: "Open-source Stripe Billing for FastAPI",
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: "Tosea", url: REPOSITORY_URL }],
  creator: "Tosea",
  publisher: "Tosea",
  category: "developer tools",
  keywords: [
    "Stripe subscription billing",
    "FastAPI Stripe integration",
    "SaaS billing template",
    "Stripe webhooks",
    "credit entitlements",
    "PostgreSQL billing",
    "Next.js pricing page",
    "subscription upgrades and downgrades",
  ],
  robots: allowIndexing
    ? {
        index: true,
        follow: true,
        googleBot: {
          index: true,
          follow: true,
          "max-image-preview": "large",
          "max-snippet": -1,
          "max-video-preview": -1,
        },
      }
    : { index: false, follow: false },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: "Open-source Stripe Billing for FastAPI",
    description: SITE_DESCRIPTION,
    ...(absoluteSiteUrl(publicSiteUrl, "/")
      ? { url: absoluteSiteUrl(publicSiteUrl, "/") }
      : {}),
  },
  twitter: {
    card: "summary_large_image",
    title: "Open-source Stripe Billing for FastAPI",
    description: SITE_DESCRIPTION,
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SiteHeader />
        <DemoNotice />
        <main className="shell page">{children}</main>
        <footer className="shell footer">
          Reference UI only. Stripe and webhook state remain server-authoritative.
        </footer>
      </body>
    </html>
  );
}
