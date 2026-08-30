import { describe, expect, it } from "vitest";
import {
  billingRedirectUrl,
  configuredBillingApiBaseUrl,
  internalRedirectUrl,
  isUnsafeProductionDemoConfiguration,
} from "@/lib/runtime";

describe("billing redirect boundaries", () => {
  const origin = "https://app.example";

  it.each([
    ["/account", "https://app.example/account"],
    ["https://checkout.stripe.com/c/pay/test", "https://checkout.stripe.com/c/pay/test"],
    ["https://billing.stripe.com/p/session/test", "https://billing.stripe.com/p/session/test"],
    ["https://invoice.stripe.com/i/test", "https://invoice.stripe.com/i/test"],
  ])("allows a known billing destination: %s", (input, expected) => {
    expect(billingRedirectUrl(input, origin, "production")).toBe(expected);
  });

  it.each([
    "https://attacker.example/phish",
    "https://stripe.com.attacker.example/phish",
    "https://user@stripe.com/path",
    "javascript:alert(1)",
    "http://checkout.stripe.com/c/pay/test",
  ])("rejects an unsafe billing destination: %s", (input) => {
    expect(() => billingRedirectUrl(input, origin, "production")).toThrow();
  });

  it("allows only same-origin internal redirects", () => {
    expect(internalRedirectUrl("/billing/success", origin, "production")).toBe(
      "https://app.example/billing/success",
    );
    expect(() =>
      internalRedirectUrl("https://checkout.stripe.com/test", origin, "production"),
    ).toThrow("application origin");
  });

  it("allows loopback HTTP for local development, never production", () => {
    expect(
      billingRedirectUrl(
        "/billing/success",
        "http://localhost:3000",
        "development",
      ),
    ).toBe("http://localhost:3000/billing/success");
    expect(() =>
      billingRedirectUrl(
        "/billing/success",
        "http://localhost:3000",
        "production",
      ),
    ).toThrow("HTTPS");
  });
});

describe("production demo guard", () => {
  it("rejects mock mode and browser-exposed demo auth in production", () => {
    expect(
      isUnsafeProductionDemoConfiguration("production", "mock", undefined),
    ).toBe(true);
    expect(
      isUnsafeProductionDemoConfiguration("production", "http", "demo-token"),
    ).toBe(true);
    expect(
      isUnsafeProductionDemoConfiguration("production", "http", undefined),
    ).toBe(false);
    expect(
      isUnsafeProductionDemoConfiguration("development", "mock", "demo-token"),
    ).toBe(false);
  });

  it("defaults HTTP deployments to the explicit same-origin sentinel", () => {
    expect(configuredBillingApiBaseUrl(undefined)).toBe("same-origin");
    expect(configuredBillingApiBaseUrl("https://billing.example")).toBe(
      "https://billing.example",
    );
    expect(configuredBillingApiBaseUrl("")).toBe("");
  });
});
