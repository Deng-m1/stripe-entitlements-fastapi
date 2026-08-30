import { describe, expect, it } from "vitest";
import {
  billingRedirectUrl,
  configuredBillingApiBaseUrl,
  internalRedirectUrl,
  isUnsafeProductionDemoConfiguration,
  isUsableSimulationStorage,
  publicSimulationRedirectUrl,
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

  it("keeps simulation redirects same-origin while allowing its local production smoke", () => {
    expect(
      publicSimulationRedirectUrl(
        "/billing/success?expected_plan=starter",
        "http://127.0.0.1:3099",
      ),
    ).toBe(
      "http://127.0.0.1:3099/billing/success?expected_plan=starter",
    );
    expect(
      publicSimulationRedirectUrl("/account", "https://demo.example"),
    ).toBe("https://demo.example/account");
    expect(() =>
      publicSimulationRedirectUrl(
        "https://checkout.stripe.com/test",
        "https://demo.example",
      ),
    ).toThrow("application origin");
    expect(() =>
      publicSimulationRedirectUrl("/account", "http://demo.example"),
    ).toThrow("require HTTPS");
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

  it("allows only an acknowledged noindex production simulation", () => {
    expect(
      isUnsafeProductionDemoConfiguration(
        "production",
        "simulation",
        undefined,
        "false",
        "1",
      ),
    ).toBe(false);
    expect(
      isUnsafeProductionDemoConfiguration(
        "production",
        "simulation",
        undefined,
        undefined,
        "1",
      ),
    ).toBe(true);
    expect(
      isUnsafeProductionDemoConfiguration(
        "production",
        "simulation",
        undefined,
        "true",
        "1",
      ),
    ).toBe(true);
    expect(
      isUnsafeProductionDemoConfiguration(
        "production",
        "simulation",
        undefined,
        "false",
        undefined,
      ),
    ).toBe(true);
  });

  it("requires writable browser session storage for cross-page simulation", () => {
    const values = new Map<string, string>();
    expect(
      isUsableSimulationStorage({
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key),
      }),
    ).toBe(true);
    expect(values.size).toBe(0);

    expect(
      isUsableSimulationStorage({
        getItem: () => null,
        setItem: () => {
          throw new Error("storage denied");
        },
        removeItem: () => undefined,
      }),
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
