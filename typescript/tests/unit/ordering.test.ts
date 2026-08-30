import { describe, expect, it } from "vitest";

import { eventWins, rankFor } from "../../src/ordering.js";

describe("ordered Stripe projection", () => {
  it("preserves the same-second dominance contract", () => {
    expect(rankFor("invoice.payment_failed")).toBe(10);
    expect(rankFor("customer.subscription.updated")).toBe(20);
    expect(rankFor("invoice.paid")).toBe(30);
    expect(rankFor("customer.subscription.deleted")).toBe(40);
    expect(rankFor("unknown")).toBe(0);
  });

  it("compares event creation before rank", () => {
    expect(
      eventWins({
        currentCreated: 10n,
        currentRank: 40,
        eventCreated: 11n,
        eventRank: 0,
      }),
    ).toBe(true);
    expect(
      eventWins({
        currentCreated: 10n,
        currentRank: 20,
        eventCreated: 10n,
        eventRank: 30,
      }),
    ).toBe(true);
    expect(
      eventWins({
        currentCreated: 10n,
        currentRank: 30,
        eventCreated: 10n,
        eventRank: 30,
      }),
    ).toBe(false);
  });
});
