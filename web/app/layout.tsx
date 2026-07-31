import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DemoNotice } from "@/components/DemoNotice";
import { SiteHeader } from "@/components/SiteHeader";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Stripe Entitlements Reference",
    template: "%s · Stripe Entitlements Reference",
  },
  description:
    "A minimal frontend reference for explicit subscription, credit, and plan-change states.",
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
