import { describe, expect, it } from "vitest";

import { POSTGRES_BIGINT_MAX } from "../../src/bounds.js";
import {
  spendableSubscriptionAtoms,
  subscriptionCreditsAreSpendable,
  type SubscriptionSpendabilityInput,
} from "../../src/subscription-state.js";
import type { PgTimestamp } from "../../src/types.js";

const AS_OF = "2026-08-29T10:00:00.000000Z";

function input(asOf: unknown = AS_OF): SubscriptionSpendabilityInput {
  return { asOf: asOf as PgTimestamp };
}

function account(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    subscription_status: "active",
    entitlement_revoked: false,
    credit_expires_at: "2026-08-29T10:00:00.000001Z",
    credits_balance: 125_000_000n,
    ...overrides,
  };
}

describe("subscription credit spendability", () => {
  it("compares equivalent offsets without losing the final microsecond", () => {
    const state = account();
    expect(
      subscriptionCreditsAreSpendable(
        state,
        input("2026-08-29 12:00:00+02:00"),
      ),
    ).toBe(true);
    expect(
      spendableSubscriptionAtoms(state, input("2026-08-29 12:00:00+0200")),
    ).toBe(125_000_000n);
  });

  it("treats expiry as an exclusive boundary at microsecond precision", () => {
    const state = account({ credit_expires_at: "2026-08-29T10:00:00.123456Z" });
    expect(
      subscriptionCreditsAreSpendable(
        state,
        input("2026-08-29T10:00:00.123455Z"),
      ),
    ).toBe(true);
    expect(
      subscriptionCreditsAreSpendable(
        state,
        input("2026-08-29T10:00:00.123456Z"),
      ),
    ).toBe(false);
    expect(
      subscriptionCreditsAreSpendable(
        state,
        input("2026-08-29T10:00:00.123457Z"),
      ),
    ).toBe(false);
  });

  it("supports PostgreSQL hour offsets and valid leap days", () => {
    const state = account({ credit_expires_at: "2024-02-29 00:00:01+00" });
    expect(
      subscriptionCreditsAreSpendable(
        state,
        input("2024-02-28T18:59:59.999999-05:00"),
      ),
    ).toBe(true);
  });

  it.each([
    "2026-08-29T10:00:00",
    "2026-08-29T10:00:00z",
    "2026-08-29T10:00:00.1234567Z",
    "2025-02-29T10:00:00Z",
    "2024-02-30T10:00:00Z",
    "0000-01-01T00:00:00Z",
    "10000-01-01T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T00:60:00Z",
    "2026-01-01T00:00:60Z",
    "2026-01-01T00:00:00+24:00",
    "2026-01-01T00:00:00+01:60",
    "infinity",
    " 2026-08-29T10:00:00Z",
    new Date("2026-08-29T10:00:00Z"),
    null,
  ])("fails closed for an invalid as-of timestamp %#", (asOf) => {
    expect(subscriptionCreditsAreSpendable(account(), input(asOf))).toBe(false);
    expect(spendableSubscriptionAtoms(account(), input(asOf))).toBe(0n);
  });

  it.each(["2026-08-29T10:00:00", "2025-02-29T10:00:00Z", 1_785_578_400, null])(
    "fails closed for an invalid expiry timestamp %#",
    (creditExpiresAt) => {
      const state = account({ credit_expires_at: creditExpiresAt });
      expect(subscriptionCreditsAreSpendable(state, input())).toBe(false);
      expect(spendableSubscriptionAtoms(state, input())).toBe(0n);
    },
  );

  it.each([
    [{ subscription_status: "past_due" }, "non-active status"],
    [{ subscription_status: true }, "malformed status"],
    [{ entitlement_revoked: true }, "revocation"],
    [{ entitlement_revoked: "false" }, "string revocation"],
    [{ entitlement_revoked: 0 }, "numeric revocation"],
  ] as const)("rejects invalid account state %#", (overrides, _name) => {
    void _name;
    expect(subscriptionCreditsAreSpendable(account(overrides), input())).toBe(
      false,
    );
  });

  it("allows an absent revocation marker to match the Python reference contract", () => {
    const state = account();
    delete state["entitlement_revoked"];
    expect(subscriptionCreditsAreSpendable(state, input())).toBe(true);
  });

  it.each([
    [125_000_000, "number"],
    ["125000000", "string"],
    [-1n, "negative bigint"],
    [POSTGRES_BIGINT_MAX + 1n, "out-of-range bigint"],
    [undefined, "missing balance"],
  ] as const)("returns zero for a malformed %s balance", (balance, _kind) => {
    void _kind;
    const state = account({ credits_balance: balance });
    expect(subscriptionCreditsAreSpendable(state, input())).toBe(true);
    expect(spendableSubscriptionAtoms(state, input())).toBe(0n);
  });

  it("rejects prototype-bearing and accessor-bearing integration state", () => {
    class Account {
      public readonly subscription_status = "active";
    }
    expect(subscriptionCreditsAreSpendable(new Account(), input())).toBe(false);

    let accessed = false;
    const accessor = Object.defineProperty({}, "subscription_status", {
      enumerable: true,
      get: () => {
        accessed = true;
        return "active";
      },
    });
    expect(subscriptionCreditsAreSpendable(accessor, input())).toBe(false);
    expect(accessed).toBe(false);
  });
});
