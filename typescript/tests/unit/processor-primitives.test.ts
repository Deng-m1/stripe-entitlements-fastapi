import { describe, expect, it } from "vitest";

import {
  annualSlotsAllowed,
  asStripeId,
  ceilRatio,
  eventShapeError,
  lineIsProration,
  lineLookup,
  linePriceId,
  projectSubscriptionStatus,
  projectionOrder,
  stripeInteger,
  subscriptionId,
  subscriptionMetadata,
} from "../../src/processor-primitives.js";

describe("Stripe processor primitives", () => {
  it("supports both legacy and current object nesting", () => {
    expect(subscriptionId({ subscription: "sub_direct" })).toBe("sub_direct");
    expect(
      subscriptionId({
        parent: { subscription_details: { subscription: "sub_parent" } },
      }),
    ).toBe("sub_parent");
    expect(
      subscriptionMetadata({
        parent: {
          subscription_details: { metadata: { account_id: "account" } },
        },
      }),
    ).toEqual({ account_id: "account" });
    expect(lineLookup({ price: { lookup_key: "ent_starter_month" } })).toBe(
      "ent_starter_month",
    );
    expect(
      lineLookup({
        pricing: { price_details: { lookup_key: "ent_pro_month" } },
      }),
    ).toBe("ent_pro_month");
    expect(
      linePriceId({ pricing: { price_details: { price: "price_current" } } }),
    ).toBe("price_current");
    expect(
      lineIsProration({
        parent: { subscription_item_details: { proration: true } },
      }),
    ).toBe(true);
  });

  it.each(["", " padded ", "line\nbreak", "zero\u200bwidth", "x".repeat(513)])(
    "rejects unsafe Stripe identity %#",
    (value) => expect(asStripeId(value)).toBeUndefined(),
  );

  it("accepts only safe integer values emitted by JSON/stripe-node", () => {
    expect(stripeInteger(123)).toBe(123n);
    expect(stripeInteger(1.5)).toBeUndefined();
    expect(stripeInteger(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
    expect(stripeInteger("123")).toBeUndefined();
  });

  it("validates supported Event envelopes but tolerates unsupported types", () => {
    const base = {
      id: "evt_valid",
      type: "invoice.paid",
      created: 123,
      livemode: false,
      data: { object: { id: "in_valid" } },
    };
    expect(eventShapeError(base)).toBeUndefined();
    expect(eventShapeError({ ...base, created: 1.5 })).toMatch(/created/u);
    expect(eventShapeError({ ...base, livemode: "false" })).toMatch(
      /livemode/u,
    );
    expect(
      eventShapeError({ ...base, type: "future.event", data: null }),
    ).toBeUndefined();
  });

  it.each([
    ["active", "active"],
    ["trialing", "active"],
    ["past_due", "past_due"],
    ["paused", "past_due"],
    ["canceled", "canceled"],
    ["incomplete", "none"],
  ])("projects %s as %s", (input, expected) => {
    expect(projectSubscriptionStatus(input)).toBe(expected);
  });

  it("advances a lexicographic event cursor", () => {
    expect(
      projectionOrder(
        { created: 10n, rank: 20 },
        { created: 10, type: "invoice.paid" },
      ),
    ).toEqual({
      created: 10n,
      rank: 30,
    });
    expect(
      projectionOrder(
        { created: 10n, rank: 40 },
        { created: 10, type: "invoice.payment_failed" },
      ),
    ).toEqual({ created: 10n, rank: 40 });
  });

  it.each([
    [100n, 1n, 4n, 25n],
    [100n, 1n, 3n, 34n],
    [1n, 1n, 2n, 1n],
    [100n, 0n, 4n, 0n],
    [100n, 4n, 4n, 100n],
  ])(
    "computes ceilRatio(%s,%s,%s)",
    (units, numerator, denominator, expected) => {
      expect(ceilRatio(units, numerator, denominator)).toBe(expected);
    },
  );

  it("rounds annual allowed slots half up and never below issued slots", () => {
    expect(annualSlotsAllowed(1_200n, 0n, 1)).toBe(12);
    expect(annualSlotsAllowed(1_200n, 600n, 1)).toBe(6);
    expect(annualSlotsAllowed(1_200n, 1_150n, 2)).toBe(2);
    expect(annualSlotsAllowed(0n, 0n, 3)).toBe(3);
  });
});
