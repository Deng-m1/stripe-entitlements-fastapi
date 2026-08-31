import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Schibsted_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import { DemoNotice } from "@/components/DemoNotice";
import { LocaleProvider } from "@/components/LocaleProvider";
import { SiteFooter } from "@/components/SiteFooter";
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

const bodyFont = IBM_Plex_Sans({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600", "700"],
});

const displayFont = Schibsted_Grotesk({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-display",
});

const monoFont = IBM_Plex_Mono({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  // The loopback fallback only resolves generated image paths on fail-closed noindex
  // builds. Public canonical deployments must provide NEXT_PUBLIC_SITE_URL.
  metadataBase: publicSiteUrl ?? new URL("http://localhost:3000"),
  title: {
    default: "Stripe Billing & Credit Entitlements for FastAPI & TypeScript",
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
    "FastAPI subscription billing template",
    "TypeScript Stripe billing",
    "Next.js Stripe backend",
    "Node.js subscription billing",
    "SaaS billing template",
    "Stripe webhooks",
    "credit entitlements",
    "PostgreSQL billing",
    "Stripe annual subscriptions",
    "Stripe Test Clock",
    "Stripe Checkout SCA",
    "Next.js pricing page",
    "subscription upgrades and downgrades",
    "Stripe prorated subscription upgrade",
    "Stripe proration webhook",
    "Stripe credit packs",
    "one-time credit packs Stripe",
    "fractional credit ledger",
    "usage credit billing",
    "Stripe payment intent webhook",
    "FastAPI billing starter",
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
    title: "Stripe Billing & Credit Entitlements for FastAPI & TypeScript",
    description: SITE_DESCRIPTION,
    ...(absoluteSiteUrl(publicSiteUrl, "/")
      ? { url: absoluteSiteUrl(publicSiteUrl, "/") }
      : {}),
  },
  twitter: {
    card: "summary_large_image",
    title: "Stripe Billing & Credit Entitlements for FastAPI & TypeScript",
    description: SITE_DESCRIPTION,
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      className={`${bodyFont.variable} ${displayFont.variable} ${monoFont.variable}`}
      data-scroll-behavior="smooth"
      lang="en"
    >
      <body>
        <LocaleProvider>
          <SiteHeader />
          <DemoNotice />
          <main className="shell page">{children}</main>
          <SiteFooter />
        </LocaleProvider>
      </body>
    </html>
  );
}
