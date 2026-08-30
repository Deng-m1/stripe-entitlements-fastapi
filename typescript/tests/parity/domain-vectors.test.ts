import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { PlanCatalog } from "../../src/catalog.js";
import { creditAtoms, creditDecimal } from "../../src/credit-amount.js";
import { redactedEventSnapshot } from "../../src/event-audit.js";
import {
  hasUnsupportedInvoiceAdjustments,
  hasUnsupportedInvoicePaymentShape,
} from "../../src/invoice-policy.js";
import {
  catalogOneTimePriceMatches,
  catalogPriceMatches,
  type CatalogOneTimePriceExpectation,
  type CatalogPriceExpectation,
} from "../../src/price-policy.js";
import {
  portalConfigurationIsSafe,
  type PortalConfigurationExpectation,
} from "../../src/portal-policy.js";
import { eventWins, rankFor } from "../../src/ordering.js";
import {
  spendableSubscriptionAtoms,
  subscriptionCreditsAreSpendable,
} from "../../src/subscription-state.js";
import { decideTransition } from "../../src/transitions.js";
import type { BillingInterval, TransitionPolicy } from "../../src/types.js";

const GOLDEN = fileURLToPath(
  new URL("../../../tests/golden/domain-policy-vectors.json", import.meta.url),
);
const CATALOG = fileURLToPath(new URL("../../../plans.toml", import.meta.url));

let vectors: Readonly<Record<string, unknown>>;
let catalog: PlanCatalog;

function record(
  value: unknown,
  name: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function array(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array`);
  }
  return value as readonly unknown[];
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
  return value;
}

function interval(value: unknown, name: string): BillingInterval {
  if (value !== "month" && value !== "year") {
    throw new TypeError(`${name} must be month or year`);
  }
  return value;
}

function policy(value: unknown): TransitionPolicy {
  if (value !== "full_period_reset" && value !== "prorated_delta") {
    throw new TypeError("golden transition policy is invalid");
  }
  return value;
}

beforeAll(async () => {
  const parsed: unknown = JSON.parse(await readFile(GOLDEN, "utf8"));
  vectors = record(parsed, "golden vectors");
  expect(vectors["schemaVersion"]).toBe(2);
  catalog = await PlanCatalog.fromToml(CATALOG);
});

describe("shared Python/TypeScript domain policy vectors", () => {
  it("matches exact credit parsing, normalization, and rejection vectors", () => {
    for (const raw of array(vectors["creditAmounts"], "creditAmounts")) {
      const vector = record(raw, "credit amount vector");
      const input = vector["input"];
      if (typeof input !== "string" && typeof input !== "number") {
        throw new TypeError("credit vector input must be a string or number");
      }
      if (!boolean(vector["valid"], "credit vector valid")) {
        expect(
          () => creditAtoms(input),
          text(vector["name"], "vector name"),
        ).toThrow();
        continue;
      }
      const atoms = creditAtoms(input);
      expect(atoms.toString(), text(vector["name"], "vector name")).toBe(
        text(vector["atoms"], "credit vector atoms"),
      );
      expect(creditDecimal(atoms)).toBe(
        text(vector["canonical"], "credit vector canonical"),
      );
    }
  });

  it("matches both complete 6 by 6 transition policy matrices", () => {
    const transitions = record(vectors["transitions"], "transitions");
    const states = array(transitions["states"], "transition states");
    const policies = array(transitions["policies"], "transition policies");
    expect(states).toHaveLength(6);
    expect(policies).toHaveLength(2);
    for (const rawPolicy of policies) {
      const policyVector = record(rawPolicy, "transition policy");
      const selectedPolicy = policy(policyVector["policy"]);
      const outcomes = array(policyVector["outcomes"], "transition outcomes");
      expect(outcomes).toHaveLength(states.length);
      for (const [sourceIndex, rawSource] of states.entries()) {
        const source = record(rawSource, "transition source");
        const row = array(outcomes[sourceIndex], "transition outcome row");
        expect(row).toHaveLength(states.length);
        for (const [targetIndex, rawTarget] of states.entries()) {
          const target = record(rawTarget, "transition target");
          const expected = text(row[targetIndex], "transition outcome");
          const decide = () =>
            decideTransition(
              catalog.require(text(source["plan"], "source plan")),
              interval(source["interval"], "source interval"),
              catalog.require(text(target["plan"], "target plan")),
              interval(target["interval"], "target interval"),
              selectedPolicy,
            );
          if (expected === "unsupported") {
            expect(decide).toThrow();
          } else {
            expect(decide().timing).toBe(expected);
            expect(decide().policy).toBe(selectedPolicy);
          }
        }
      }
    }
  });

  it("matches shared event ordering comparisons", () => {
    for (const raw of array(vectors["eventOrdering"], "eventOrdering")) {
      const vector = record(raw, "event ordering vector");
      const current = record(vector["current"], "current event");
      const event = record(vector["event"], "incoming event");
      expect(
        eventWins({
          currentCreated: BigInt(text(current["created"], "current created")),
          currentRank: rankFor(text(current["type"], "current type")),
          eventCreated: BigInt(text(event["created"], "event created")),
          eventRank: rankFor(text(event["type"], "event type")),
        }),
        text(vector["name"], "vector name"),
      ).toBe(boolean(vector["wins"], "ordering wins"));
    }
  });

  it("matches Invoice adjustment vectors", () => {
    for (const raw of array(
      vectors["invoiceAdjustments"],
      "invoiceAdjustments",
    )) {
      const vector = record(raw, "invoice adjustment vector");
      expect(
        hasUnsupportedInvoiceAdjustments(vector["invoice"], vector["lines"]),
        text(vector["name"], "vector name"),
      ).toBe(vector["unsupported"]);
    }
  });

  it("matches Invoice payment vectors", () => {
    for (const raw of array(vectors["invoicePayments"], "invoicePayments")) {
      const vector = record(raw, "invoice payment vector");
      expect(
        hasUnsupportedInvoicePaymentShape(vector["invoice"]),
        text(vector["name"], "vector name"),
      ).toBe(vector["unsupported"]);
    }
  });

  it("matches recurring and one-time Price vectors", () => {
    for (const raw of array(vectors["prices"], "prices")) {
      const vector = record(raw, "Price vector");
      const result =
        vector["kind"] === "recurring"
          ? catalogPriceMatches(
              vector["price"],
              vector["expected"] as CatalogPriceExpectation,
            )
          : catalogOneTimePriceMatches(
              vector["price"],
              vector["expected"] as CatalogOneTimePriceExpectation,
            );
      expect(result, text(vector["name"], "vector name")).toBe(
        vector["matches"],
      );
    }
  });

  it("matches Portal configuration vectors", () => {
    for (const raw of array(
      vectors["portalConfigurations"],
      "portalConfigurations",
    )) {
      const vector = record(raw, "Portal vector");
      expect(
        portalConfigurationIsSafe(
          vector["config"],
          vector["expected"] as PortalConfigurationExpectation,
        ),
        text(vector["name"], "vector name"),
      ).toBe(vector["safe"]);
    }
  });

  it("matches exact timestamp and bigint subscription vectors", () => {
    for (const raw of array(vectors["subscriptions"], "subscriptions")) {
      const vector = record(raw, "subscription vector");
      const rawAccount = record(vector["account"], "vector account");
      const account = {
        ...rawAccount,
        credits_balance: BigInt(
          text(rawAccount["credits_balance"], "credits_balance"),
        ),
      };
      const input = { asOf: text(vector["asOf"], "asOf") };
      expect(
        subscriptionCreditsAreSpendable(account, input),
        text(vector["name"], "vector name"),
      ).toBe(vector["spendable"]);
      expect(
        spendableSubscriptionAtoms(account, input).toString(),
        text(vector["name"], "vector name"),
      ).toBe(vector["spendableAtoms"]);
    }
  });

  it("matches minimal Event audit snapshots", () => {
    for (const raw of array(vectors["eventAudits"], "eventAudits")) {
      const vector = record(raw, "Event audit vector");
      expect(
        redactedEventSnapshot(vector["event"]),
        text(vector["name"], "vector name"),
      ).toEqual(vector["snapshot"]);
    }
  });
});
