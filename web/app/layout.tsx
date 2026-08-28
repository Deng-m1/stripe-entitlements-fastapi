import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Schibsted_Grotesk } from "next/font/google";
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

// Schibsted Grotesk is the display *and* UI face (brief §4). It ships as a
// 400–900 variable font, so loading it without a `weight` list buys the whole
// axis in one file and lets the hero set 780 without a second request.
const displayFont = Schibsted_Grotesk({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-display",
});

// Kept for long-form prose only (brief §4): Plex Sans holds a lower x-height
// and looser default tracking, which reads better than a grotesque at FAQ
// paragraph lengths.
const proseFont = IBM_Plex_Sans({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-prose",
  weight: ["400", "500", "600"],
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
    default: "Stripe Subscription Billing for FastAPI & PostgreSQL",
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
    title: "Stripe Subscription Billing for FastAPI & PostgreSQL",
    description: SITE_DESCRIPTION,
    ...(absoluteSiteUrl(publicSiteUrl, "/")
      ? { url: absoluteSiteUrl(publicSiteUrl, "/") }
      : {}),
  },
  twitter: {
    card: "summary_large_image",
    title: "Stripe Subscription Billing for FastAPI & PostgreSQL",
    description: SITE_DESCRIPTION,
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      className={`${displayFont.variable} ${proseFont.variable} ${monoFont.variable}`}
      data-scroll-behavior="smooth"
      lang="en"
    >
      <body>
        <SiteHeader />
        <DemoNotice />
        <main className="shell page">{children}</main>
        <footer className="shell footer">
          <span className="footer-brand">{SITE_NAME}</span>
          <span>
            Reference UI only. Stripe and webhook state remain server-authoritative.
          </span>
        </footer>
      </body>
    </html>
  );
}
