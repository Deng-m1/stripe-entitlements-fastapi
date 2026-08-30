import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildCreditPackCheckoutRequestSnapshot,
  buildPlanChangeRequestSnapshot,
  buildSubscriptionCheckoutRequestSnapshot,
  planChangeContextFromSnapshot,
  StripeRequestSnapshotError,
  validateCheckoutRequestSnapshot,
  validatePlanChangeRequestSnapshot,
  type PlanChangeRequestSnapshot,
  type PlanChangeSnapshotBuildInput,
} from "../../src/stripe-request-snapshots.js";
import type { PlanChangeContext } from "../../src/stripe-gateway.js";

function subscriptionSnapshot() {
  return buildSubscriptionCheckoutRequestSnapshot({
    accountId: "00000000-0000-4000-8000-000000000001",
    claimToken: "11111111-1111-4111-8111-111111111111",
    customerId: "cus_snapshot",
    priceId: "price_snapshot",
    lookupKey: "ent_starter_month",
    currency: "usd",
    unitAmount: 1900n,
    interval: "month",
    planKey: "starter",
    productLine: "example-entitlements",
    successUrl:
      "https://app.example.test/success?checkout_session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://app.example.test/pricing",
    expiresAt: 1_800_000_000n,
    requestApiVersion: "2026-06-24.dahlia",
  });
}

function packSnapshot() {
  return buildCreditPackCheckoutRequestSnapshot({
    orderId: "22222222-2222-4222-8222-222222222222",
    accountId: "00000000-0000-4000-8000-000000000001",
    priceId: "price_pack_snapshot",
    lookupKey: "ent_pack_boost-100",
    currency: "usd",
    unitAmount: 1500n,
    packKey: "boost-100",
    packCredits: "100.125",
    expiresDays: 365,
    productLine: "example-entitlements",
    successUrl:
      "https://app.example.test/success?checkout_session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://app.example.test/pricing",
    expiresAt: 1_800_000_000n,
    requestApiVersion: "2026-06-24.dahlia",
  });
}

function planContext(
  overrides: Partial<PlanChangeContext> = {},
): PlanChangeContext {
  return {
    subscriptionId: "sub_snapshot",
    subscriptionItemId: "si_snapshot",
    currentPriceId: "price_starter_month",
    currentLookupKey: "ent_starter_month",
    targetPriceId: "price_pro_month",
    targetInterval: "month",
    currentPeriodStart: 1_800_000_000n,
    currentPeriodEnd: 1_802_592_000n,
    scheduleId: null,
    subscriptionStatus: "active",
    cancelAtPeriodEnd: false,
    pendingUpdate: false,
    pendingExpiresAt: null,
    recoveryUrl: null,
    clientSecret: null,
    ...overrides,
  };
}

function planBuildInput(
  timing: "immediate" | "period_end" = "immediate",
  policy: "full_period_reset" | "prorated_delta" = "full_period_reset",
  context: PlanChangeContext = planContext(),
): PlanChangeSnapshotBuildInput {
  return {
    context,
    timing,
    policy,
    prorationDate:
      timing === "immediate" && policy === "prorated_delta"
        ? 1_800_000_123n
        : null,
    idempotencyKey: `plan-change:33333333-3333-4333-8333-333333333333:${
      timing === "immediate" ? "apply" : "schedule"
    }`,
    requestApiVersion: "2026-06-24.dahlia",
    productLine: "example-entitlements",
    sourceLookupKey: "ent_starter_month",
    targetLookupKey:
      context.targetInterval === "month" ? "ent_pro_month" : "ent_pro_year",
    sourcePlanKey: "starter",
    targetPlanKey: "pro",
    sourceCurrency: "usd",
    targetCurrency: "usd",
    sourceUnitAmount: 1_900n,
    targetUnitAmount: context.targetInterval === "month" ? 4_900n : 35_300n,
  };
}

function planSnapshot(
  timing: "immediate" | "period_end" = "immediate",
  policy: "full_period_reset" | "prorated_delta" = "full_period_reset",
  context: PlanChangeContext = planContext(),
): PlanChangeRequestSnapshot {
  return buildPlanChangeRequestSnapshot(
    planBuildInput(timing, policy, context),
  );
}

function mutable(value: unknown): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected object");
  }
  return value as Record<string, unknown>;
}

describe("durable Checkout request snapshots", () => {
  it("builds and replays the same golden snapshots as Python", () => {
    const golden = JSON.parse(
      readFileSync(
        new URL(
          "../../../tests/golden/stripe-request-snapshots.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const subscription = buildSubscriptionCheckoutRequestSnapshot({
      accountId: "00000000-0000-4000-8000-000000000001",
      claimToken: "11111111-1111-4111-8111-111111111111",
      customerId: "cus_golden",
      priceId: "price_golden_subscription",
      lookupKey: "ent_starter_month",
      currency: "usd",
      unitAmount: 1900n,
      interval: "month",
      planKey: "starter",
      productLine: "golden-product",
      successUrl:
        "https://golden.example.test/success?checkout_session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://golden.example.test/pricing",
      expiresAt: 1_800_000_000n,
      requestApiVersion: "2026-06-24.dahlia",
    });
    const pack = buildCreditPackCheckoutRequestSnapshot({
      orderId: "22222222-2222-4222-8222-222222222222",
      accountId: "00000000-0000-4000-8000-000000000001",
      priceId: "price_golden_pack",
      lookupKey: "ent_pack_boost-100",
      currency: "usd",
      unitAmount: 99_999_999n,
      packKey: "boost-100",
      packCredits: "100.125",
      expiresDays: 365,
      productLine: "golden-product",
      successUrl:
        "https://golden.example.test/success?checkout_session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://golden.example.test/pricing",
      expiresAt: 1_800_000_000n,
      requestApiVersion: "2025-12-15.clover",
    });
    const goldenPlanContext = (
      targetPriceId: string,
      targetInterval: "month" | "year",
    ): PlanChangeContext => ({
      subscriptionId: "sub_golden_plan",
      subscriptionItemId: "si_golden_plan",
      currentPriceId: "price_golden_starter_month",
      currentLookupKey: "ent_starter_month",
      targetPriceId,
      targetInterval,
      currentPeriodStart: 1_800_000_000n,
      currentPeriodEnd: 1_802_592_000n,
      scheduleId: null,
      subscriptionStatus: "active",
      cancelAtPeriodEnd: false,
      pendingUpdate: false,
      pendingExpiresAt: null,
      recoveryUrl: null,
      clientSecret: null,
    });
    const goldenPlanSnapshot = (
      timing: "immediate" | "period_end",
      policy: "full_period_reset" | "prorated_delta",
      targetPriceId: string,
      targetInterval: "month" | "year",
      prorationDate: bigint | null,
      targetUnitAmount: bigint,
    ) =>
      buildPlanChangeRequestSnapshot({
        context: goldenPlanContext(targetPriceId, targetInterval),
        timing,
        policy,
        prorationDate,
        idempotencyKey: `plan-change:33333333-3333-4333-8333-333333333333:${
          timing === "immediate" ? "apply" : "schedule"
        }`,
        requestApiVersion: "2026-06-24.dahlia",
        productLine: "golden-product",
        sourceLookupKey: "ent_starter_month",
        targetLookupKey: `ent_pro_${targetInterval}`,
        sourcePlanKey: "starter",
        targetPlanKey: "pro",
        sourceCurrency: "usd",
        targetCurrency: "usd",
        sourceUnitAmount: 1_900n,
        targetUnitAmount,
      });
    const planSnapshots = {
      plan_full_period_reset: goldenPlanSnapshot(
        "immediate",
        "full_period_reset",
        "price_golden_pro_month",
        "month",
        null,
        4_900n,
      ),
      plan_prorated_delta: goldenPlanSnapshot(
        "immediate",
        "prorated_delta",
        "price_golden_pro_month",
        "month",
        1_800_000_123n,
        4_900n,
      ),
      plan_scheduled: goldenPlanSnapshot(
        "period_end",
        "full_period_reset",
        "price_golden_pro_year",
        "year",
        null,
        35_300n,
      ),
    };
    expect(subscription).toEqual(golden["subscription"]);
    expect(pack).toEqual(golden["credit_pack"]);
    expect(validateCheckoutRequestSnapshot(golden["subscription"])).toEqual(
      subscription,
    );
    expect(
      validateCheckoutRequestSnapshot(golden["credit_pack"], {
        packCredits: "100.125",
        expiresDays: 365,
        productLine: "golden-product",
      }),
    ).toEqual(pack);
    for (const [name, snapshot] of Object.entries(planSnapshots)) {
      expect(snapshot).toEqual(golden[name]);
      expect(validatePlanChangeRequestSnapshot(golden[name])).toEqual(snapshot);
    }
  });

  it("round-trips subscription and pack requests without promotion-code authority", () => {
    const subscription = validateCheckoutRequestSnapshot(
      subscriptionSnapshot(),
      {
        kind: "subscription",
        accountId: "00000000-0000-4000-8000-000000000001",
        requestIdentity: "11111111-1111-4111-8111-111111111111",
        lookupKey: "ent_starter_month",
        currency: "usd",
        unitAmount: 1900n,
        interval: "month",
        offeringKey: "starter",
        productLine: "example-entitlements",
        customerId: "cus_snapshot",
      },
    );
    const pack = validateCheckoutRequestSnapshot(packSnapshot(), {
      kind: "credit_pack",
      packCredits: "100.125",
      expiresDays: 365,
      productLine: "example-entitlements",
      customerId: null,
    });
    expect(subscription.params).not.toHaveProperty("allow_promotion_codes");
    expect(pack.params).not.toHaveProperty("allow_promotion_codes");
    expect(pack.params).not.toHaveProperty("customer_email");
  });

  it("uses semantic object equality after PostgreSQL JSONB key reordering", () => {
    const snapshot = mutable(packSnapshot());
    const params = record(snapshot["params"]);
    const metadata = record(params["metadata"]);
    const reordered = Object.fromEntries(Object.entries(metadata).reverse());
    params["metadata"] = reordered;
    record(params["payment_intent_data"])["metadata"] = {
      ...reordered,
    };
    expect(() => validateCheckoutRequestSnapshot(snapshot)).not.toThrow();
  });

  it("rejects pack credit, expiry, and product-line tampering against durable facts", () => {
    const creditTamper = mutable(packSnapshot());
    const creditParams = record(creditTamper["params"]);
    record(creditParams["metadata"])["pack_credits"] = "999";
    record(record(creditParams["payment_intent_data"])["metadata"])[
      "pack_credits"
    ] = "999";
    expect(() =>
      validateCheckoutRequestSnapshot(creditTamper, { packCredits: "100.125" }),
    ).toThrow(/pack credits drifted/u);

    const expiryTamper = mutable(packSnapshot());
    const expiryParams = record(expiryTamper["params"]);
    record(expiryParams["metadata"])["expires_days"] = "1";
    record(record(expiryParams["payment_intent_data"])["metadata"])[
      "expires_days"
    ] = "1";
    expect(() =>
      validateCheckoutRequestSnapshot(expiryTamper, { expiresDays: 365 }),
    ).toThrow(/pack expiry drifted/u);

    const productTamper = mutable(packSnapshot());
    record(productTamper["resolved_price"])["product_line"] = "other-line";
    const productParams = record(productTamper["params"]);
    record(productParams["metadata"])["product_line"] = "other-line";
    record(record(productParams["payment_intent_data"])["metadata"])[
      "product_line"
    ] = "other-line";
    expect(() =>
      validateCheckoutRequestSnapshot(productTamper, {
        productLine: "example-entitlements",
      }),
    ).toThrow(/product line drifted/u);
  });

  it("rejects shape tampering, identity drift, and interval mismatch", () => {
    const extra = mutable(subscriptionSnapshot());
    extra["unexpected"] = true;
    expect(() => validateCheckoutRequestSnapshot(extra)).toThrow(
      /unsupported shape/u,
    );

    const line = mutable(subscriptionSnapshot());
    record(line["params"])["line_items"] = [
      { price: "price_attacker", quantity: 1 },
    ];
    expect(() => validateCheckoutRequestSnapshot(line)).toThrow(
      /line item drifted/u,
    );

    expect(() =>
      validateCheckoutRequestSnapshot(subscriptionSnapshot(), {
        interval: "year",
      }),
    ).toThrow(/interval drifted/u);
  });

  it("rejects secrets, oversized values, and non-JSON sentinels", () => {
    const secret = mutable(subscriptionSnapshot());
    record(secret["params"])["cancel_url"] =
      "https://example.test/sk_test_do_not_persist";
    expect(() => validateCheckoutRequestSnapshot(secret)).toThrow(
      /secret marker/u,
    );

    const oversized = mutable(subscriptionSnapshot());
    record(record(oversized["params"])["metadata"])["claim_token"] = "x".repeat(
      33 * 1024,
    );
    expect(() => validateCheckoutRequestSnapshot(oversized)).toThrow(
      /exceeds 32 KiB/u,
    );

    for (const sentinel of [undefined, Symbol("snapshot"), 1n]) {
      expect(() => validateCheckoutRequestSnapshot(sentinel)).toThrow(
        StripeRequestSnapshotError,
      );
    }
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => validateCheckoutRequestSnapshot(cyclic)).toThrow(
      /not JSON serializable/u,
    );
  });

  it("enforces the shared Stripe amount and timestamp boundaries", () => {
    const accepted = mutable(packSnapshot());
    record(accepted["resolved_price"])["unit_amount"] = 99_999_999;
    const acceptedParams = record(accepted["params"]);
    record(acceptedParams["metadata"])["price_amount"] = "99999999";
    record(record(acceptedParams["payment_intent_data"])["metadata"])[
      "price_amount"
    ] = "99999999";
    expect(() => validateCheckoutRequestSnapshot(accepted)).not.toThrow();

    const rejected = mutable(accepted);
    record(rejected["resolved_price"])["unit_amount"] = 100_000_000;
    const rejectedParams = record(rejected["params"]);
    record(rejectedParams["metadata"])["price_amount"] = "100000000";
    record(record(rejectedParams["payment_intent_data"])["metadata"])[
      "price_amount"
    ] = "100000000";
    expect(() => validateCheckoutRequestSnapshot(rejected)).toThrow(
      /Checkout unit amount is invalid/u,
    );

    const timestamp = mutable(packSnapshot());
    record(timestamp["params"])["expires_at"] = 253_402_300_800;
    expect(() => validateCheckoutRequestSnapshot(timestamp)).toThrow(
      /Checkout expiry is invalid/u,
    );
  });
});

describe("durable plan-change request snapshots", () => {
  it("round-trips reset, prorated, and scheduled mutations", () => {
    const reset = planSnapshot();
    expect(reset).toMatchObject({
      kind: "plan_change_immediate",
      policy: "full_period_reset",
      params: {
        billing_cycle_anchor: "now",
        proration_behavior: "none",
      },
    });
    expect(
      validatePlanChangeRequestSnapshot(reset, {
        idempotencyKey:
          "plan-change:33333333-3333-4333-8333-333333333333:apply",
        subscriptionId: "sub_snapshot",
        timing: "immediate",
        policy: "full_period_reset",
      }),
    ).toEqual(reset);
    expect(planChangeContextFromSnapshot(reset)).toEqual(planContext());

    const prorated = planSnapshot("immediate", "prorated_delta");
    expect(prorated).toMatchObject({
      kind: "plan_change_immediate",
      policy: "prorated_delta",
      params: {
        proration_behavior: "always_invoice",
        proration_date: 1_800_000_123,
      },
    });
    expect(() =>
      validatePlanChangeRequestSnapshot(prorated, {
        timing: "immediate",
        policy: "prorated_delta",
      }),
    ).not.toThrow();

    const scheduledContext = planContext({
      targetPriceId: "price_pro_year",
      targetInterval: "year",
      scheduleId: "sub_sched_existing",
      subscriptionStatus: "past_due",
      cancelAtPeriodEnd: true,
      pendingUpdate: true,
    });
    const scheduled = planSnapshot(
      "period_end",
      "full_period_reset",
      scheduledContext,
    );
    expect(scheduled).toMatchObject({
      kind: "plan_change_schedule",
      params: {
        create: { from_subscription: "sub_snapshot" },
        configure: {
          boundary: 1_802_592_000,
          target_price_id: "price_pro_year",
          target_interval: "year",
          end_behavior: "release",
          proration_behavior: "none",
        },
      },
    });
    expect(planChangeContextFromSnapshot(scheduled)).toEqual(scheduledContext);
  });

  it("rejects unsafe builder inputs before a snapshot can be frozen", () => {
    expect(() =>
      buildPlanChangeRequestSnapshot({
        ...planBuildInput("immediate", "prorated_delta"),
        prorationDate: null,
      }),
    ).toThrow(/requires a proration date/u);

    expect(() =>
      buildPlanChangeRequestSnapshot({
        ...planBuildInput(),
        context: planContext({ currentPeriodStart: -1n }),
      }),
    ).toThrow(/current period start is invalid/u);
    expect(() =>
      buildPlanChangeRequestSnapshot({
        ...planBuildInput(),
        context: planContext({
          currentPeriodEnd: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        }),
      }),
    ).toThrow(/current period end is invalid/u);
    expect(() =>
      buildPlanChangeRequestSnapshot({
        ...planBuildInput(),
        sourceUnitAmount: -1n,
      }),
    ).toThrow(/source unit amount is invalid/u);
    expect(() =>
      buildPlanChangeRequestSnapshot({
        ...planBuildInput(),
        targetUnitAmount: 100_000_000n,
      }),
    ).toThrow(/target unit amount is invalid/u);
  });

  it("fails closed on root, context, Price-evidence, and reset-policy drift", () => {
    const cases: ReadonlyArray<
      readonly [
        mutate: (snapshot: Record<string, unknown>) => void,
        message: RegExp,
      ]
    > = [
      [(snapshot) => (snapshot["schema"] = "other"), /unsupported.*version/u],
      [(snapshot) => (snapshot["kind"] = "other"), /unsupported.*kind/u],
      [(snapshot) => (snapshot["policy"] = "other"), /policy is invalid/u],
      [
        (snapshot) =>
          (record(snapshot["context"])["subscription_id"] = "cus_wrong"),
        /Subscription id is invalid/u,
      ],
      [
        (snapshot) => (record(snapshot["context"])["target_interval"] = "week"),
        /target interval is invalid/u,
      ],
      [
        (snapshot) => {
          const context = record(snapshot["context"]);
          context["current_period_end"] = context["current_period_start"];
        },
        /plan-change period is invalid/u,
      ],
      [
        (snapshot) =>
          (record(snapshot["context"])["schedule_id"] = "sched_wrong"),
        /Subscription Schedule id is invalid/u,
      ],
      [
        (snapshot) =>
          (record(snapshot["context"])["cancel_at_period_end"] = "false"),
        /boolean context is invalid/u,
      ],
      [
        (snapshot) =>
          (record(snapshot["price_evidence"])["source_price_id"] =
            "price_other"),
        /evidence conflicts with context/u,
      ],
      [
        (snapshot) =>
          (record(snapshot["price_evidence"])["source_plan_key"] = ""),
        /source_plan_key is invalid/u,
      ],
      [
        (snapshot) =>
          (record(snapshot["price_evidence"])["source_currency"] = "USD"),
        /source_currency is invalid/u,
      ],
      [
        (snapshot) =>
          (record(snapshot["price_evidence"])["source_unit_amount"] =
            100_000_000),
        /source_unit_amount is invalid/u,
      ],
      [
        (snapshot) => (record(snapshot["params"])["unexpected"] = true),
        /immediate mutation params has an unsupported shape/u,
      ],
      [
        (snapshot) => (record(snapshot["params"])["items"] = []),
        /immediate mutation policy drifted/u,
      ],
      [
        (snapshot) =>
          (record(snapshot["params"])["billing_cycle_anchor"] = "unchanged"),
        /full-period mutation policy drifted/u,
      ],
    ];
    for (const [mutate, message] of cases) {
      const snapshot = mutable(planSnapshot());
      mutate(snapshot);
      expect(() => validatePlanChangeRequestSnapshot(snapshot)).toThrow(
        message,
      );
    }
    expect(() => validatePlanChangeRequestSnapshot(null)).toThrow(
      /unsupported shape/u,
    );
  });

  it("binds every caller expectation to the frozen plan-change identity", () => {
    const snapshot = planSnapshot();
    for (const expected of [
      { idempotencyKey: "plan-change:other:apply" },
      { subscriptionId: "sub_other" },
      { timing: "period_end" as const },
      { policy: "prorated_delta" as const },
    ]) {
      expect(() =>
        validatePlanChangeRequestSnapshot(snapshot, expected),
      ).toThrow(/drifted/u);
    }
  });

  it("rejects each immediate mutation-policy component independently", () => {
    const resetCases: ReadonlyArray<(params: Record<string, unknown>) => void> =
      [
        (params) =>
          (params["items"] = [{ id: "si_other", price: "price_pro_month" }]),
        (params) => (params["payment_behavior"] = "error_if_incomplete"),
        (params) => (params["expand"] = []),
      ];
    for (const mutate of resetCases) {
      const snapshot = mutable(planSnapshot());
      mutate(record(snapshot["params"]));
      expect(() => validatePlanChangeRequestSnapshot(snapshot)).toThrow(
        /immediate mutation policy drifted/u,
      );
    }

    const prorationBehavior = mutable(
      planSnapshot("immediate", "prorated_delta"),
    );
    record(prorationBehavior["params"])["proration_behavior"] = "none";
    expect(() => validatePlanChangeRequestSnapshot(prorationBehavior)).toThrow(
      /prorated mutation policy drifted/u,
    );

    const prorationDate = mutable(planSnapshot("immediate", "prorated_delta"));
    record(prorationDate["params"])["proration_date"] = 253_402_300_800;
    expect(() => validatePlanChangeRequestSnapshot(prorationDate)).toThrow(
      /proration date is invalid/u,
    );
  });

  it("rejects each scheduled mutation-policy component independently", () => {
    const context = planContext({
      targetPriceId: "price_pro_year",
      targetInterval: "year",
    });
    const valid = planSnapshot("period_end", "full_period_reset", context);

    const create = mutable(valid);
    record(create["params"])["create"] = { from_subscription: "sub_other" };
    expect(() => validatePlanChangeRequestSnapshot(create)).toThrow(
      /Schedule create params drifted/u,
    );

    const configureCases: ReadonlyArray<
      (configure: Record<string, unknown>) => void
    > = [
      (configure) => (configure["boundary"] = 1_802_592_001),
      (configure) => (configure["target_price_id"] = "price_other"),
      (configure) => (configure["target_interval"] = "month"),
      (configure) => (configure["end_behavior"] = "cancel"),
      (configure) => (configure["proration_behavior"] = "always_invoice"),
      (configure) => (configure["metadata"] = {}),
    ];
    for (const mutate of configureCases) {
      const snapshot = mutable(valid);
      const configure = record(record(snapshot["params"])["configure"]);
      mutate(configure);
      expect(() => validatePlanChangeRequestSnapshot(snapshot)).toThrow(
        /Schedule configure policy drifted/u,
      );
    }
  });
});
