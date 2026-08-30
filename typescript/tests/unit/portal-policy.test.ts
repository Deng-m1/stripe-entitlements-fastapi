import { describe, expect, it } from "vitest";

import { portalConfigurationIsSafe } from "../../src/portal-policy.js";

const EXPECTED = {
  expectedLivemode: false,
  expectedProductLine: "example-entitlements",
} as const;

function safePortal(): Record<string, unknown> {
  return {
    active: true,
    livemode: false,
    metadata: { product_line: "example-entitlements" },
    features: {
      customer_update: { enabled: true, allowed_updates: ["email"] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_update: { enabled: false },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
    },
  };
}

function nestedRecord(
  owner: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return owner[key] as Record<string, unknown>;
}

describe("dedicated Stripe Portal configuration", () => {
  it("accepts the safe policy and ignores benign or future feature keys", () => {
    const config = safePortal();
    const features = nestedRecord(config, "features");
    delete features["invoice_history"];
    features["customer_update"] = {
      enabled: false,
      allowed_updates: ["email", "address"],
    };
    features["future_feature"] = { enabled: true };
    expect(portalConfigurationIsSafe(config, EXPECTED)).toBe(true);
  });

  it.each([
    [
      "inactive",
      (config: Record<string, unknown>): void => {
        config["active"] = false;
      },
    ],
    [
      "wrong livemode",
      (config: Record<string, unknown>): void => {
        config["livemode"] = true;
      },
    ],
    [
      "wrong product line",
      (config: Record<string, unknown>): void => {
        nestedRecord(config, "metadata")["product_line"] = "other";
      },
    ],
    [
      "subscription updates",
      (config: Record<string, unknown>): void => {
        nestedRecord(nestedRecord(config, "features"), "subscription_update")[
          "enabled"
        ] = true;
      },
    ],
    [
      "disabled cancellation",
      (config: Record<string, unknown>): void => {
        nestedRecord(nestedRecord(config, "features"), "subscription_cancel")[
          "enabled"
        ] = false;
      },
    ],
    [
      "immediate cancellation",
      (config: Record<string, unknown>): void => {
        nestedRecord(nestedRecord(config, "features"), "subscription_cancel")[
          "mode"
        ] = "immediately";
      },
    ],
  ] as const)("rejects %s", (_name, mutate) => {
    const config = safePortal();
    mutate(config);
    expect(portalConfigurationIsSafe(config, EXPECTED)).toBe(false);
  });

  it.each([
    null,
    [],
    {},
    { features: [], metadata: {} },
    { features: {}, metadata: {} },
    {
      active: true,
      livemode: false,
      metadata: { product_line: "example-entitlements" },
      features: { subscription_update: [], subscription_cancel: {} },
    },
  ])("fails closed for incomplete or malformed mappings %#", (config) => {
    expect(portalConfigurationIsSafe(config, EXPECTED)).toBe(false);
  });

  it("rejects class and accessor objects", () => {
    class PortalConfig {
      public readonly active = true;
    }
    expect(portalConfigurationIsSafe(new PortalConfig(), EXPECTED)).toBe(false);

    let accessed = false;
    const accessor = Object.defineProperty({}, "features", {
      enumerable: true,
      get: () => {
        accessed = true;
        return {};
      },
    });
    expect(portalConfigurationIsSafe(accessor, EXPECTED)).toBe(false);
    expect(accessed).toBe(false);
  });
});
