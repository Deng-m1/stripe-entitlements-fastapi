import { describe, expect, it } from "vitest";

import {
  checkoutSuccessBaseUrlIsSafe,
  loadSettings,
  publicHttpUrlIsStructurallySafe,
} from "../../src/config.js";
import { databasePoolOptions } from "../../src/database.js";

function environment(): Record<string, string> {
  return {
    DATABASE_URL: "postgresql://app:password@db.example.test/app",
    STRIPE_SECRET_KEY: "sk_test_placeholder",
    STRIPE_WEBHOOK_SECRET: "whsec_placeholder",
    STRIPE_WEBHOOK_API_VERSION: "2026-06-24.dahlia",
  };
}

describe("TypeScript runtime configuration", () => {
  it("loads strict defaults without logging secret values", () => {
    const settings = loadSettings(environment());
    expect(settings.billingTransitionPolicy).toBe("full_period_reset");
    expect(settings.lookupPrefix).toBe("ent");
    expect(settings.stripeSecretKey.startsWith("sk_test_")).toBe(true);
    expect(settings).toMatchObject({
      databasePoolMin: 1,
      databasePoolMax: 20,
      databasePoolIdleTimeoutMs: 10_000,
      databaseConnectTimeoutMs: 10_000,
    });
  });

  it("loads bounded PostgreSQL pool settings for serverless deployments", () => {
    const settings = loadSettings({
      ...environment(),
      DATABASE_POOL_MIN: "0",
      DATABASE_POOL_MAX: "4",
      DATABASE_POOL_IDLE_TIMEOUT_MS: "30000",
      DATABASE_CONNECT_TIMEOUT_MS: "5000",
    });

    expect(settings).toMatchObject({
      databasePoolMin: 0,
      databasePoolMax: 4,
      databasePoolIdleTimeoutMs: 30_000,
      databaseConnectTimeoutMs: 5_000,
    });
    expect(databasePoolOptions(settings)).toEqual({
      min: 0,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  });

  it.each([
    ["DATABASE_POOL_MIN", "-1"],
    ["DATABASE_POOL_MAX", "0"],
    ["DATABASE_POOL_MAX", "101"],
    ["DATABASE_POOL_MAX", "1.5"],
    ["DATABASE_POOL_IDLE_TIMEOUT_MS", "999"],
    ["DATABASE_CONNECT_TIMEOUT_MS", "120001"],
  ])("rejects an invalid bounded pool setting %s", (name, value) => {
    expect(() => loadSettings({ ...environment(), [name]: value })).toThrow(
      name,
    );
  });

  it("rejects a PostgreSQL pool minimum above its maximum", () => {
    expect(() =>
      loadSettings({
        ...environment(),
        DATABASE_POOL_MIN: "5",
        DATABASE_POOL_MAX: "4",
      }),
    ).toThrow("DATABASE_POOL_MIN");
  });

  it.each([
    ["STRIPE_SECRET_KEY", "bad"],
    ["STRIPE_WEBHOOK_SECRET", "bad"],
    ["STRIPE_WEBHOOK_API_VERSION", "latest"],
    ["DATABASE_URL", "mysql://db/app"],
    ["LOOKUP_PREFIX", "bad_prefix"],
    ["BILLING_TRANSITION_POLICY", "magic"],
  ])("rejects invalid %s without echoing its value", (name, value) => {
    const env = { ...environment(), [name]: value };
    expect(() => loadSettings(env)).toThrow();
    try {
      loadSettings(env);
    } catch (error: unknown) {
      expect(String(error)).not.toContain(value);
    }
  });

  it.each([
    ["https://app.example.test/path", true],
    ["http://localhost:3000/path", true],
    ["https://user:pass@app.example.test/path", false],
    ["javascript:alert(1)", false],
    ["/relative", false],
  ])("validates origin-safe URL %s", (value, expected) => {
    expect(publicHttpUrlIsStructurallySafe(value)).toBe(expected);
  });

  it("requires the Checkout success base to omit query and fragment", () => {
    expect(
      checkoutSuccessBaseUrlIsSafe("https://app.example.test/success"),
    ).toBe(true);
    expect(
      checkoutSuccessBaseUrlIsSafe("https://app.example.test/success?x=1"),
    ).toBe(false);
    expect(
      checkoutSuccessBaseUrlIsSafe("https://app.example.test/success#x"),
    ).toBe(false);
  });
});
