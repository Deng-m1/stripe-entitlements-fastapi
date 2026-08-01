import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage, { metadata as homeMetadata } from "@/app/page";
import manifest from "@/app/manifest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

describe("public SEO surface", () => {
  it("renders searchable project, plan, savings, and scope content", () => {
    const { container } = render(<HomePage />);

    expect(homeMetadata.title).toBe(
      "Stripe Billing & Entitlements Template for FastAPI",
    );
    expect(homeMetadata.description).toMatch(
      /FastAPI, PostgreSQL entitlements, Next\.js.*full-period or prorated/i,
    );

    expect(
      screen.getByRole("heading", {
        name: /Race-safe Stripe billing for FastAPI/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("table", {
        name: /Reference Stripe subscription plans and annual savings/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "Starter" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "Pro" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "Ultra" })).toBeInTheDocument();
    expect(screen.getByText(/does not claim coupons/i)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Full-price or prorated upgrades/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Both define a complete 6 × 6 monthly\/yearly transition matrix/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/full_period_reset and prorated_delta/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Does it support Stripe prorated subscription upgrades/i),
    ).toBeInTheDocument();

    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const json = JSON.parse(script?.textContent ?? "{}") as {
      "@graph"?: Array<{ "@type"?: string }>;
    };
    expect(json["@graph"]?.map((item) => item["@type"])).toEqual([
      "SoftwareApplication",
      "FAQPage",
    ]);
  });

  it("fails closed when indexing is not explicitly configured", () => {
    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
    expect(sitemap()).toEqual([]);
  });

  it("provides a web manifest for the reference application", () => {
    expect(manifest()).toMatchObject({
      name: "Stripe Entitlements for FastAPI",
      start_url: "/",
      display: "standalone",
    });
  });
});
