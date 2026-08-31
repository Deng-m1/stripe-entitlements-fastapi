import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { CheckoutCreationRejected } from "../../src/checkout.js";
import { buildPlanChangeRequestSnapshot } from "../../src/stripe-request-snapshots.js";
import {
  StripeGateway,
  type PlanChangeContext,
  type StripeGatewayOptions,
} from "../../src/stripe-gateway.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, name = "value"): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function array(value: unknown, name = "value"): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array`);
  }
  return value as unknown[];
}

function asyncResult(value: unknown) {
  return vi.fn((...args: unknown[]): Promise<unknown> => {
    void args;
    return Promise.resolve(value);
  });
}

function recurringPrice(
  plan = "starter",
  amount = 1900,
  id = `price_${plan}_month`,
): Record<string, unknown> {
  return {
    id,
    lookup_key: `ent_${plan}_month`,
    active: true,
    type: "recurring",
    currency: "usd",
    unit_amount: amount,
    billing_scheme: "per_unit",
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    tax_behavior: "unspecified",
    tiers_mode: null,
    transform_quantity: null,
    custom_unit_amount: null,
    currency_options: null,
    product: {
      id: `prod_${plan}`,
      active: true,
      metadata: { product_line: "example-entitlements", plan },
    },
  };
}

function packPrice(): Record<string, unknown> {
  return {
    id: "price_pack_boost_100",
    lookup_key: "ent_pack_boost-100",
    active: true,
    type: "one_time",
    currency: "usd",
    unit_amount: 1500,
    billing_scheme: "per_unit",
    recurring: null,
    tax_behavior: "unspecified",
    tiers_mode: null,
    transform_quantity: null,
    custom_unit_amount: null,
    currency_options: null,
    metadata: {
      product_line: "example-entitlements",
      credit_pack: "boost-100",
    },
    product: {
      id: "prod_pack_boost_100",
      active: true,
      metadata: {
        product_line: "example-entitlements",
        credit_pack: "boost-100",
      },
    },
  };
}

function subscriptionFixture(): Record<string, unknown> {
  return {
    id: "sub_test",
    object: "subscription",
    livemode: false,
    status: "active",
    cancel_at_period_end: false,
    schedule: null,
    pending_update: null,
    latest_invoice: null,
    items: {
      has_more: false,
      data: [
        {
          id: "si_test",
          quantity: 1,
          current_period_start: 1_800_000_000,
          current_period_end: 1_802_592_000,
          price: {
            id: "price_starter_month",
            lookup_key: "ent_starter_month",
          },
        },
      ],
    },
  };
}

function planChangeSnapshot(
  overrides: {
    readonly policy?: "full_period_reset" | "prorated_delta";
    readonly timing?: "immediate" | "period_end";
  } = {},
) {
  const policy = overrides.policy ?? "full_period_reset";
  const timing = overrides.timing ?? "immediate";
  return buildPlanChangeRequestSnapshot({
    context: context(),
    timing,
    policy,
    prorationDate: policy === "prorated_delta" ? 1_801_000_000n : null,
    idempotencyKey: `plan-change:test:${timing === "immediate" ? "apply" : "schedule"}`,
    requestApiVersion: "2025-12-15.clover",
    productLine: "frozen-product-line",
    sourceLookupKey: "ent_starter_month",
    targetLookupKey: "ent_pro_month",
    sourcePlanKey: "starter",
    targetPlanKey: "pro",
    sourceCurrency: "usd",
    targetCurrency: "usd",
    sourceUnitAmount: 1900n,
    targetUnitAmount: 4900n,
  });
}

function invoicePayment(
  invoiceId: string,
  paymentIntentId = `pi_for_${invoiceId}`,
) {
  return {
    id: `inpay_${invoiceId}`,
    invoice: invoiceId,
    status: "paid",
    payment: { type: "payment_intent", payment_intent: paymentIntentId },
  };
}

function mockStripe() {
  const invoicePaymentIntents = new Map<string, string>();
  const pricesRetrieve = vi.fn((...args: unknown[]): Promise<unknown> => {
    const priceId = args[0];
    const plan =
      typeof priceId === "string" && priceId.includes("pro")
        ? "pro"
        : "starter";
    const amount = plan === "pro" ? 4900 : 1900;
    return Promise.resolve(recurringPrice(plan, amount, String(priceId)));
  });
  const invoicePaymentsList = vi.fn((...args: unknown[]): Promise<unknown> => {
    const params = record(args[0], "InvoicePayment params");
    const payment = params["payment"];
    if (isRecord(payment) && typeof payment["payment_intent"] === "string") {
      invoicePaymentIntents.set("in_mapped", payment["payment_intent"]);
      return Promise.resolve({
        data: [invoicePayment("in_mapped", payment["payment_intent"])],
        has_more: false,
      });
    }
    const invoice = params["invoice"];
    const invoiceId = typeof invoice === "string" ? invoice : "in_default";
    const paymentIntentId =
      invoicePaymentIntents.get(invoiceId) ??
      (invoiceId.startsWith("in_")
        ? `pi_${invoiceId.slice(3)}`
        : `pi_for_${invoiceId}`);
    return Promise.resolve({
      data: [invoicePayment(invoiceId, paymentIntentId)],
      has_more: false,
    });
  });
  const paymentIntentRetrieve = vi.fn(
    (...args: unknown[]): Promise<unknown> =>
      Promise.resolve({
        id: args[0],
        object: "payment_intent",
        livemode: false,
        metadata: {},
      }),
  );
  const client = {
    webhooks: { constructEvent: vi.fn() },
    prices: {
      list: asyncResult({ data: [recurringPrice()], has_more: false }),
      retrieve: pricesRetrieve,
    },
    invoicePayments: { list: invoicePaymentsList },
    invoices: {
      list: asyncResult({ data: [] }),
      listLineItems: asyncResult({ data: [], has_more: false }),
      createPreview: asyncResult({}),
    },
    subscriptions: {
      retrieve: asyncResult(subscriptionFixture()),
      update: asyncResult({}),
    },
    checkout: {
      sessions: {
        create: asyncResult({
          id: "cs_test",
          url: "https://checkout.stripe.test/session",
        }),
        retrieve: asyncResult({ id: "cs_test", livemode: false }),
      },
    },
    paymentIntents: { retrieve: paymentIntentRetrieve },
    charges: {
      retrieve: asyncResult({ id: "ch_test", livemode: false }),
    },
    billingPortal: {
      configurations: { retrieve: asyncResult(safePortal()) },
      sessions: { create: asyncResult(safePortalSession()) },
    },
    subscriptionSchedules: {
      create: asyncResult({}),
      update: asyncResult({}),
      retrieve: asyncResult({}),
    },
  };
  return client;
}

function gateway(
  client: ReturnType<typeof mockStripe>,
  options: Omit<StripeGatewayOptions, "client"> = {},
): StripeGateway {
  return new StripeGateway("sk_test_dummy", "whsec_test", {
    ...options,
    client: client as unknown as Stripe,
  });
}

function event(
  type: string,
  object: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: `evt_${type.replaceAll(".", "_")}`,
    object: "event",
    type,
    created: 1_800_000_000,
    livemode: false,
    data: { object },
  };
}

function safePortal(): Record<string, unknown> {
  return {
    id: "bpc_test",
    active: true,
    livemode: false,
    metadata: { product_line: "example-entitlements" },
    features: {
      subscription_update: { enabled: false },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      payment_method_update: { enabled: true },
    },
  };
}

function safePortalSession(): Record<string, unknown> {
  return {
    id: "bps_test",
    object: "billing_portal.session",
    customer: "cus_test",
    configuration: "bpc_test",
    return_url: "http://localhost:3000/account",
    livemode: false,
    url: "https://billing.stripe.test/session",
  };
}

function context(
  overrides: Partial<PlanChangeContext> = {},
): PlanChangeContext {
  return {
    subscriptionId: "sub_test",
    subscriptionItemId: "si_test",
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

function fullPreview(): Record<string, unknown> {
  return {
    amount_due: 4900,
    subtotal: 4900,
    total: 4900,
    starting_balance: 0,
    ending_balance: 0,
    pre_payment_credit_notes_amount: 0,
    post_payment_credit_notes_amount: 0,
    currency: "usd",
    automatic_tax: { enabled: false },
    discounts: [],
    total_tax_amounts: [],
    total_taxes: [],
    total_discount_amounts: [],
    lines: {
      has_more: false,
      data: [
        {
          id: "il_target",
          amount: 4900,
          quantity: 1,
          currency: "usd",
          proration: false,
          price: { id: "price_pro_month" },
          period: { start: 1_801_000_000, end: 1_803_592_000 },
          discounts: [],
          taxes: [],
          discount_amounts: [],
          pretax_credit_amounts: [],
        },
      ],
    },
  };
}

function callArguments(
  stub: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } },
  index = 0,
): readonly unknown[] {
  const args = stub.mock.calls[index];
  if (args === undefined) {
    throw new Error(`missing mock call ${String(index)}`);
  }
  return args;
}

describe("StripeGateway construction and raw webhook verification", () => {
  it.each(["rk_test_restricted", "not-a-key", "sk_unknown"])(
    "rejects unsupported API key %s",
    (key) => {
      expect(() => new StripeGateway(key, "whsec_test")).toThrow(/sk_test_/u);
    },
  );

  it("rejects webhook and redirect configuration drift", () => {
    expect(() => new StripeGateway("sk_test_dummy", "invalid")).toThrow(
      /whsec_/u,
    );
    expect(
      () =>
        new StripeGateway("sk_test_dummy", "whsec_test", {
          checkoutSuccessUrl: "https://app.test/success?untrusted=1",
        }),
    ).toThrow(/query or fragment/u);
    expect(
      () =>
        new StripeGateway("sk_test_dummy", "whsec_test", {
          portalReturnUrl: "https://user:pass@app.test/account",
        }),
    ).toThrow(/origin-safe/u);
  });

  it("uses stripe-node raw-body signature verification and strips internal controls", () => {
    const secret = "whsec_test_raw_body";
    const payload = JSON.stringify({
      id: "evt_signed",
      object: "event",
      type: "invoice.paid",
      _remote_verified: true,
      data: {
        object: {
          id: "in_signed",
          _unsupported_invoice_payment_shape: false,
          lines: {
            data: [
              { id: "il_signed", _resolved_lookup_key: "bad", amount: 1900 },
            ],
          },
        },
      },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
    });
    const parsed = new StripeGateway("sk_test_dummy", secret).constructEvent(
      payload,
      signature,
    );
    expect(parsed["id"]).toBe("evt_signed");
    expect(parsed).not.toHaveProperty("_remote_verified");
    const data = record(parsed["data"]);
    const object = record(data["object"]);
    expect(object).not.toHaveProperty("_unsupported_invoice_payment_shape");
    const line = record(array(record(object["lines"])["data"])[0]);
    expect(line).toEqual({ id: "il_signed", amount: 1900 });
    expect(() =>
      new StripeGateway("sk_test_dummy", secret).constructEvent(payload, "bad"),
    ).toThrow();
  });
});

describe("event preparation before database work", () => {
  it.each([
    { id: "evt_bad_data", type: "invoice.paid", data: [] },
    { id: "evt_bad_object", type: "invoice.paid", data: { object: [] } },
    { id: "evt_no_id", type: "invoice.paid", data: { object: {} } },
    event("invoice.payment_failed", {
      id: "in_failed",
      lines: { data: [{ price: { id: "price_remote" } }] },
    }),
    event("customer.subscription.deleted", {
      id: "sub_deleted",
      items: { data: [{ price: { id: "price_remote" } }] },
    }),
  ])(
    "does no mutable lookup for unsupported/non-mutating event %#",
    async (payload) => {
      const client = mockStripe();
      const prepared = await gateway(client).prepareEvent(payload);
      expect(prepared).toEqual(payload);
      expect(client.prices.retrieve).not.toHaveBeenCalled();
      expect(client.invoicePayments.list).not.toHaveBeenCalled();
    },
  );

  it("resolves legacy and Dahlia Price references once and validates one payment", async () => {
    const client = mockStripe();
    const payload = event("invoice.paid", {
      id: "in_paid",
      lines: {
        has_more: false,
        data: [
          { id: "il_legacy", price: { id: "price_starter_month" } },
          {
            id: "il_dahlia",
            pricing: { price_details: { price: "price_starter_month" } },
          },
          "invalid-line",
        ],
      },
    });
    const prepared = await gateway(client).prepareEvent(payload);
    const object = record(record(prepared["data"])["object"]);
    const lines = array(record(object["lines"])["data"]);
    expect(record(lines[0])["_resolved_lookup_key"]).toBe("ent_starter_month");
    expect(record(lines[1])["_resolved_lookup_key"]).toBe("ent_starter_month");
    expect(lines[2]).toBe("invalid-line");
    expect(client.prices.retrieve).toHaveBeenCalledTimes(1);
    expect(client.invoicePayments.list).toHaveBeenCalledTimes(1);
    expect(record(callArguments(client.invoicePayments.list)[0])).toEqual({
      invoice: "in_paid",
      status: "paid",
      limit: 2,
    });
    expect(object).not.toHaveProperty("_unsupported_invoice_payment_shape");
    expect(record(object["lines"])["_all_lines_loaded"]).toBe(true);
  });

  it("materializes complete Invoice pagination and advances the cursor", async () => {
    const client = mockStripe();
    client.invoices.listLineItems
      .mockResolvedValueOnce({
        data: [{ id: "il_1", price: "price_starter_month" }],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [{ id: "il_2", price: "price_pro_month" }],
        has_more: false,
      });
    const prepared = await gateway(client).prepareEvent(
      event("invoice.paid", {
        id: "in_pages",
        lines: { data: [{ id: "il_embedded" }], has_more: true },
      }),
    );
    const object = record(record(prepared["data"])["object"]);
    const lines = array(record(object["lines"])["data"]);
    expect(lines.map((line) => record(line)["id"])).toEqual(["il_1", "il_2"]);
    expect(callArguments(client.invoices.listLineItems, 0)[1]).toEqual({
      limit: 100,
    });
    expect(callArguments(client.invoices.listLineItems, 1)[1]).toEqual({
      limit: 100,
      starting_after: "il_1",
    });
  });

  it.each([
    [{ data: {}, has_more: false }, "invalid shape"],
    [
      { data: [{ amount: 1 }], has_more: false },
      "missing or duplicate identity",
    ],
    [{ data: [], has_more: true }, "did not advance"],
  ] as const)(
    "persists a durable pagination marker for %s",
    async (page, message) => {
      const client = mockStripe();
      client.invoices.listLineItems.mockResolvedValue(page);
      const prepared = await gateway(client).prepareEvent(
        event("invoice.paid", {
          id: "in_bad_page",
          lines: { data: [{ id: "embedded" }], has_more: true },
        }),
      );
      const invoice = record(record(prepared["data"])["object"]);
      expect(String(invoice["_preparation_error"])).toContain(message);
      expect(record(invoice["lines"])).toMatchObject({
        has_more: true,
        _all_lines_loaded: false,
      });
    },
  );

  it("marks multi-payment invoices unsupported and retries absent mappings", async () => {
    const client = mockStripe();
    client.invoicePayments.list.mockResolvedValueOnce({
      data: [
        invoicePayment("in_multi", "pi_a"),
        invoicePayment("in_multi", "pi_b"),
      ],
      has_more: false,
    });
    const prepared = await gateway(client).prepareEvent(
      event("invoice.paid", {
        id: "in_multi",
        lines: { data: [], has_more: false },
      }),
    );
    expect(
      record(record(prepared["data"])["object"])[
        "_unsupported_invoice_payment_shape"
      ],
    ).toBe(true);

    const absent = mockStripe();
    absent.invoicePayments.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    await expect(
      gateway(absent).prepareEvent(
        event("invoice.paid", {
          id: "in_absent",
          lines: { data: [], has_more: false },
        }),
      ),
    ).rejects.toThrow(/not exposed/u);
  });

  it("resolves refund Invoice ownership through PaymentIntent and InvoicePayment", async () => {
    const client = mockStripe();
    const prepared = await gateway(client).prepareEvent(
      event("charge.refunded", {
        id: "ch_refund",
        payment_intent: "pi_refund",
        amount: 1900,
        amount_refunded: 950,
      }),
    );
    const charge = record(record(prepared["data"])["object"]);
    expect(charge["_resolved_invoice_id"]).toBe("in_mapped");
    expect(record(charge["_resolved_payment_intent"])["id"]).toBe("pi_refund");
    expect(client.invoicePayments.list).toHaveBeenCalledTimes(2);
  });

  it("resolves disputes through the Charge and rejects conflicting identities", async () => {
    const client = mockStripe();
    client.charges.retrieve.mockResolvedValue({
      id: "ch_dispute",
      payment_intent: "pi_dispute",
      invoice: "in_dispute",
    });
    const prepared = await gateway(client).prepareEvent(
      event("charge.dispute.created", { id: "dp_test", charge: "ch_dispute" }),
    );
    const dispute = record(record(prepared["data"])["object"]);
    expect(record(dispute["_resolved_charge"])["id"]).toBe("ch_dispute");
    expect(dispute["_resolved_invoice_id"]).toBe("in_dispute");

    const conflict = mockStripe();
    conflict.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_other",
      metadata: {},
    });
    await expect(
      gateway(conflict).prepareEvent(
        event("charge.refunded", {
          id: "ch_conflict",
          payment_intent: "pi_expected",
        }),
      ),
    ).rejects.toThrow(/conflicting PaymentIntent/u);
  });

  it("does not seek an Invoice for a one-time credit-pack PaymentIntent", async () => {
    const client = mockStripe();
    client.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_pack",
      metadata: { billing_kind: "credit_pack" },
    });
    const prepared = await gateway(client).prepareEvent(
      event("charge.refunded", { id: "ch_pack", payment_intent: "pi_pack" }),
    );
    expect(record(record(prepared["data"])["object"])).not.toHaveProperty(
      "_resolved_invoice_id",
    );
    expect(client.invoicePayments.list).not.toHaveBeenCalled();
  });
});

describe("read-only reconciliation objects", () => {
  it("validates identity and test/live mode for Checkout, PaymentIntent, and Charge", async () => {
    const client = mockStripe();
    client.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_test",
      livemode: false,
    });
    client.charges.retrieve.mockResolvedValue({
      id: "ch_test",
      livemode: false,
    });
    await expect(
      gateway(client).checkoutSessionObject("cs_test"),
    ).resolves.toMatchObject({
      id: "cs_test",
    });
    await expect(
      gateway(client).paymentIntentObject("pi_test"),
    ).resolves.toMatchObject({
      id: "pi_test",
    });
    await expect(
      gateway(client).chargeObject("ch_test"),
    ).resolves.toMatchObject({
      id: "ch_test",
    });
    await expect(gateway(client).chargeObject("pi_wrong")).rejects.toThrow(
      /ch_/u,
    );
    client.charges.retrieve.mockResolvedValue({
      id: "ch_other",
      livemode: false,
    });
    await expect(gateway(client).chargeObject("ch_test")).rejects.toThrow(
      /different Charge/u,
    );
    client.charges.retrieve.mockResolvedValue({
      id: "ch_test",
      livemode: true,
    });
    await expect(gateway(client).chargeObject("ch_test")).rejects.toThrow(
      /mode/u,
    );
  });

  it("returns an exact bigint/microsecond subscription snapshot for one complete item", async () => {
    const client = mockStripe();
    const snapshot = await gateway(client).subscriptionSnapshot("sub_test");
    expect(snapshot).toEqual({
      subscriptionId: "sub_test",
      status: "active",
      lookupKey: "ent_starter_month",
      currentPeriodEnd: "2027-02-14T08:00:00.000000Z",
      resolvedPrice: recurringPrice("starter", 1900, "price_starter_month"),
      quantity: 1n,
      itemsComplete: true,
    });
  });

  it("marks paginated subscription items incomplete and omits partial facts", async () => {
    const client = mockStripe();
    const subscription = subscriptionFixture();
    record(subscription["items"])["has_more"] = true;
    client.subscriptions.retrieve.mockResolvedValue(subscription);
    await expect(
      gateway(client).subscriptionSnapshot("sub_test"),
    ).resolves.toEqual({
      subscriptionId: "sub_test",
      status: "active",
      itemsComplete: false,
    });
  });

  it("builds a remotely verified latest paid Invoice event using paid_at and Dahlia parent", async () => {
    const client = mockStripe();
    client.invoices.list.mockResolvedValue({
      data: [
        {
          id: "in_latest",
          parent: { subscription_details: { subscription: "sub_test" } },
          status: "paid",
          livemode: false,
          created: 100,
          status_transitions: { paid_at: 120 },
          lines: { data: [], has_more: false },
        },
      ],
    });
    const prepared = await gateway(client).latestPaidInvoiceEvent("sub_test");
    expect(prepared).toMatchObject({
      id: "reconcile:in_latest",
      type: "invoice.paid",
      created: 120,
      livemode: false,
      _remote_verified: true,
    });
    expect(client.invoices.list).toHaveBeenCalledWith({
      subscription: "sub_test",
      status: "paid",
      limit: 1,
    });
  });

  it("returns undefined for no paid Invoice and rejects collection identity drift", async () => {
    const client = mockStripe();
    await expect(
      gateway(client).latestPaidInvoiceEvent("sub_none"),
    ).resolves.toBeUndefined();
    client.invoices.list.mockResolvedValue({
      data: [
        {
          id: "in_wrong",
          subscription: "sub_other",
          livemode: false,
          created: 1,
        },
      ],
    });
    await expect(
      gateway(client).latestPaidInvoiceEvent("sub_test"),
    ).rejects.toThrow(/different Subscription/u);
  });
});

describe("subscription and credit-pack Checkout", () => {
  it("replays a frozen Checkout with its original API version and never resolves Price again", async () => {
    const preparingClient = mockStripe();
    const snapshot = await gateway(preparingClient, {
      apiVersion: "2025-12-15.clover",
      productLine: "example-entitlements",
      checkoutSuccessUrl: "https://old.example.test/success",
      checkoutCancelUrl: "https://old.example.test/pricing",
    }).prepareCheckoutSession({
      accountId: "00000000-0000-4000-8000-000000000001",
      lookupKey: "ent_starter_month",
      expectedCurrency: "usd",
      expectedUnitAmount: 1900n,
      expectedInterval: "month",
      claimToken: "claim-frozen",
      expiresAtEpoch: 1_800_000_000n,
      planKey: "starter",
      interval: "month",
    });
    const replayClient = mockStripe();
    replayClient.prices.list.mockRejectedValue(
      new Error("Price.list must not run during replay"),
    );
    const replayGateway = gateway(replayClient, {
      apiVersion: "2026-06-24.dahlia",
      productLine: "rotated-line",
      checkoutSuccessUrl: "https://new.example.test/success",
      checkoutCancelUrl: "https://new.example.test/pricing",
    });

    await replayGateway.createCheckoutSessionFromSnapshot(snapshot);
    await replayGateway.createCheckoutSessionFromSnapshot(snapshot);

    expect(replayClient.prices.list).not.toHaveBeenCalled();
    expect(replayClient.checkout.sessions.create).toHaveBeenCalledTimes(2);
    const first = callArguments(replayClient.checkout.sessions.create, 0);
    const second = callArguments(replayClient.checkout.sessions.create, 1);
    expect(second).toEqual(first);
    expect(record(first[0])["success_url"]).toContain("old.example.test");
    expect(record(first[1])).toEqual({
      idempotencyKey:
        "checkout:00000000-0000-4000-8000-000000000001:claim-frozen",
      apiVersion: "2025-12-15.clover",
    });
  });

  it("rejects an interval mismatch before Price lookup or Session creation", async () => {
    const client = mockStripe();
    await expect(
      gateway(client).prepareCheckoutSession({
        accountId: "account",
        lookupKey: "ent_starter_month",
        expectedCurrency: "usd",
        expectedUnitAmount: 1900n,
        expectedInterval: "year",
        claimToken: "claim",
        expiresAtEpoch: 1_800_000_000n,
        planKey: "starter",
        interval: "month",
      }),
    ).rejects.toBeInstanceOf(CheckoutCreationRejected);
    expect(client.prices.list).not.toHaveBeenCalled();
    expect(client.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("creates a pinned subscription Checkout with server-owned parameters and idempotency", async () => {
    const client = mockStripe();
    const result = await gateway(client).createCheckoutSession({
      accountId: "00000000-0000-4000-8000-000000000001",
      lookupKey: "ent_starter_month",
      expectedCurrency: "usd",
      expectedUnitAmount: 1900n,
      expectedInterval: "month",
      claimToken: "claim-1",
      expiresAtEpoch: 1_800_000_000n,
      customerEmail: "person@example.test",
      planKey: "starter",
      interval: "month",
    });
    expect(result).toEqual(["cs_test", "https://checkout.stripe.test/session"]);
    const priceParams = record(callArguments(client.prices.list)[0]);
    expect(priceParams).toEqual({
      lookup_keys: ["ent_starter_month"],
      active: true,
      limit: 2,
      expand: ["data.currency_options", "data.product"],
    });
    const [rawParams, rawOptions] = callArguments(
      client.checkout.sessions.create,
    );
    const params = record(rawParams);
    expect(params).toMatchObject({
      mode: "subscription",
      line_items: [{ price: "price_starter_month", quantity: 1 }],
      expires_at: 1_800_000_000,
    });
    expect(params).not.toHaveProperty("customer_email");
    expect(params).not.toHaveProperty("allow_promotion_codes");
    expect(String(params["success_url"])).toContain(
      "checkout_session_id={CHECKOUT_SESSION_ID}",
    );
    expect(record(rawOptions)).toEqual({
      idempotencyKey: "checkout:00000000-0000-4000-8000-000000000001:claim-1",
      apiVersion: "2026-06-24.dahlia",
    });
  });

  it("omits email when a stable Stripe Customer is supplied", async () => {
    const client = mockStripe();
    await gateway(client).createCheckoutSession({
      accountId: "account",
      customerId: "cus_test",
      customerEmail: "ignored@example.test",
      lookupKey: "ent_starter_month",
      expectedCurrency: "usd",
      expectedUnitAmount: 1900n,
      expectedInterval: "month",
      claimToken: "claim",
      expiresAtEpoch: 1_800_000_000n,
      planKey: "starter",
      interval: "month",
    });
    const params = record(callArguments(client.checkout.sessions.create)[0]);
    expect(params["customer"]).toBe("cus_test");
    expect(params).not.toHaveProperty("customer_email");
  });

  it("creates a card-only one-time credit-pack Checkout and exact metadata", async () => {
    const client = mockStripe();
    client.prices.list.mockResolvedValue({
      data: [packPrice()],
      has_more: false,
    });
    const result = await gateway(client, {
      checkoutSuccessUrl: "https://app.example.test/billing/success",
      checkoutCancelUrl: "https://app.example.test/pricing",
    }).createCreditPackCheckoutSession({
      orderId: "order-1",
      accountId: "account-1",
      customerEmail: "buyer@example.test",
      lookupKey: "ent_pack_boost-100",
      expectedCurrency: "usd",
      expectedUnitAmount: 1500n,
      packKey: "boost-100",
      packCredits: "100.125",
      expiresDays: 365,
      expiresAtEpoch: 1_800_000_000n,
    });
    expect(result[0]).toBe("cs_test");
    const [rawParams, rawOptions] = callArguments(
      client.checkout.sessions.create,
    );
    const params = record(rawParams);
    expect(params).toMatchObject({
      mode: "payment",
      payment_method_types: ["card"],
      customer_creation: "always",
    });
    expect(params).not.toHaveProperty("customer_email");
    const metadata = record(record(params["payment_intent_data"])["metadata"]);
    expect(metadata).toEqual({
      billing_kind: "credit_pack",
      pack_schema_version: "1",
      product_line: "example-entitlements",
      credit_pack_order_id: "order-1",
      account_id: "account-1",
      pack_key: "boost-100",
      pack_credits: "100.125",
      price_amount: "1500",
      currency: "usd",
      expires_days: "365",
      lookup_key: "ent_pack_boost-100",
    });
    expect(params["metadata"]).toEqual(metadata);
    expect(record(rawOptions)).toEqual({
      idempotencyKey: "credit-pack:order-1",
      apiVersion: "2026-06-24.dahlia",
    });
  });

  it("rejects catalog drift, unsafe bigint conversion, and invalid Stripe session output", async () => {
    const drift = mockStripe();
    drift.prices.list.mockResolvedValue({
      data: [{ ...recurringPrice(), unit_amount: 1 }],
      has_more: false,
    });
    await expect(
      gateway(drift).createCheckoutSession({
        accountId: "account",
        lookupKey: "ent_starter_month",
        expectedCurrency: "usd",
        expectedUnitAmount: 1900n,
        expectedInterval: "month",
        claimToken: "claim",
        expiresAtEpoch: 1_800_000_000n,
        planKey: "starter",
        interval: "month",
      }),
    ).rejects.toBeInstanceOf(CheckoutCreationRejected);
    expect(drift.checkout.sessions.create).not.toHaveBeenCalled();

    const unsafe = mockStripe();
    await expect(
      gateway(unsafe).createCheckoutSession({
        accountId: "account",
        lookupKey: "ent_starter_month",
        expectedCurrency: "usd",
        expectedUnitAmount: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        expectedInterval: "month",
        claimToken: "claim",
        expiresAtEpoch: 1_800_000_000n,
        planKey: "starter",
        interval: "month",
      }),
    ).rejects.toThrow(/safe integer/u);

    const badSession = mockStripe();
    badSession.checkout.sessions.create.mockResolvedValue({
      id: "cs_test",
      url: "http://insecure.test/session",
    });
    await expect(
      gateway(badSession).createCheckoutSession({
        accountId: "account",
        lookupKey: "ent_starter_month",
        expectedCurrency: "usd",
        expectedUnitAmount: 1900n,
        expectedInterval: "month",
        claimToken: "claim",
        expiresAtEpoch: 1_800_000_000n,
        planKey: "starter",
        interval: "month",
      }),
    ).rejects.toThrow(/non-HTTPS/u);
  });
});

describe("dedicated safe Billing Portal", () => {
  it("validates configuration then creates the exact customer-bound session", async () => {
    const client = mockStripe();
    const result = await gateway(client, {
      portalConfigurationId: "bpc_test",
    }).createPortalSession({
      customerId: "cus_test",
      idempotencyKey: "portal:account:request",
    });
    expect(result).toEqual(["bps_test", "https://billing.stripe.test/session"]);
    expect(callArguments(client.billingPortal.sessions.create)).toEqual([
      {
        customer: "cus_test",
        configuration: "bpc_test",
        return_url: "http://localhost:3000/account",
      },
      { idempotencyKey: "portal:account:request" },
    ]);
  });

  it("rejects missing or drifted Portal configuration before session creation", async () => {
    const client = mockStripe();
    await expect(
      gateway(client).createPortalSession({
        customerId: "cus_test",
        idempotencyKey: "key",
      }),
    ).rejects.toThrow(/configuration is missing or invalid/u);
    const unsafe = safePortal();
    record(record(unsafe["features"])["subscription_update"])["enabled"] = true;
    client.billingPortal.configurations.retrieve.mockResolvedValue(unsafe);
    await expect(
      gateway(client, {
        portalConfigurationId: "bpc_test",
      }).createPortalSession({
        customerId: "cus_test",
        idempotencyKey: "key",
      }),
    ).rejects.toThrow(/drifted/u);
    expect(client.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it.each([
    null,
    "pc_invalid_private_value",
    "bpc_",
    "bpc_replace_me_private_value",
  ])(
    "rejects unusable Portal configuration %s before any Stripe request",
    async (portalConfigurationId) => {
      const client = mockStripe();
      await expect(
        gateway(client, { portalConfigurationId }).createPortalSession({
          customerId: "cus_test",
          idempotencyKey: "key",
        }),
      ).rejects.toThrow(/configuration is missing or invalid/u);
      expect(
        client.billingPortal.configurations.retrieve,
      ).not.toHaveBeenCalled();
      expect(client.billingPortal.sessions.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    { id: "not_bps" },
    { customer: "cus_other" },
    { configuration: "bpc_other" },
    { return_url: "https://attacker.test" },
    { livemode: true },
    { url: "http://insecure.test" },
  ])("rejects Portal Session output drift %#", async (mutation) => {
    const client = mockStripe();
    client.billingPortal.sessions.create.mockResolvedValue({
      ...safePortalSession(),
      ...mutation,
    });
    await expect(
      gateway(client, {
        portalConfigurationId: "bpc_test",
      }).createPortalSession({
        customerId: "cus_test",
        idempotencyKey: "key",
      }),
    ).rejects.toThrow(/Stripe returned/u);
  });
});

describe("plan-change preparation and preview", () => {
  it("authorizes exact target/source Prices and returns the complete subscription context", async () => {
    const client = mockStripe();
    client.prices.list.mockResolvedValue({
      data: [recurringPrice("pro", 4900, "price_pro_month")],
      has_more: false,
    });
    const prepared = await gateway(client).preparePlanChange({
      subscriptionId: "sub_test",
      targetLookupKey: "ent_pro_month",
      expectedCurrency: "usd",
      expectedUnitAmount: 4900n,
      expectedPlanKey: "pro",
      targetInterval: "month",
      expectedSourceLookupKey: "ent_starter_month",
      expectedSourceCurrency: "usd",
      expectedSourceUnitAmount: 1900n,
      expectedSourcePlanKey: "starter",
      sourceInterval: "month",
    });
    expect(prepared).toEqual(context());
    expect(callArguments(client.subscriptions.retrieve)).toEqual([
      "sub_test",
      { expand: ["latest_invoice.confirmation_secret"] },
    ]);
  });

  it.each([
    [
      "quantity",
      (subscription: Record<string, unknown>) => {
        record(array(record(subscription["items"])["data"])[0])["quantity"] =
          "1";
      },
    ],
    [
      "exactly one item",
      (subscription: Record<string, unknown>) => {
        record(subscription["items"])["has_more"] = true;
      },
    ],
    [
      "integer timestamps",
      (subscription: Record<string, unknown>) => {
        record(array(record(subscription["items"])["data"])[0])[
          "current_period_start"
        ] = "1";
      },
    ],
    [
      "Subscription status",
      (subscription: Record<string, unknown>) => {
        subscription["status"] = "future";
      },
    ],
    [
      "cancel_at_period_end",
      (subscription: Record<string, unknown>) => {
        subscription["cancel_at_period_end"] = "false";
      },
    ],
    [
      "pending_update",
      (subscription: Record<string, unknown>) => {
        subscription["pending_update"] = "bad";
      },
    ],
  ] as const)(
    "rejects malformed source contract: %s",
    async (message, mutate) => {
      const client = mockStripe();
      client.prices.list.mockResolvedValue({
        data: [recurringPrice("pro", 4900, "price_pro_month")],
        has_more: false,
      });
      const subscription = subscriptionFixture();
      mutate(subscription);
      client.subscriptions.retrieve.mockResolvedValue(subscription);
      await expect(
        gateway(client).preparePlanChange({
          subscriptionId: "sub_test",
          targetLookupKey: "ent_pro_month",
          expectedCurrency: "usd",
          expectedUnitAmount: 4900n,
          expectedPlanKey: "pro",
          targetInterval: "month",
          expectedSourceLookupKey: "ent_starter_month",
          expectedSourceCurrency: "usd",
          expectedSourceUnitAmount: 1900n,
          expectedSourcePlanKey: "starter",
          sourceInterval: "month",
        }),
      ).rejects.toThrow(message);
    },
  );

  it("rejects an archived/mutable source Price that drifts from the authorized plan", async () => {
    const client = mockStripe();
    client.prices.list.mockResolvedValue({
      data: [recurringPrice("pro", 4900, "price_pro_month")],
      has_more: false,
    });
    const source = recurringPrice("starter", 1900, "price_starter_month");
    record(record(source["product"])["metadata"])["plan"] = "ultra";
    client.prices.retrieve.mockResolvedValue(source);
    await expect(
      gateway(client).preparePlanChange({
        subscriptionId: "sub_test",
        targetLookupKey: "ent_pro_month",
        expectedCurrency: "usd",
        expectedUnitAmount: 4900n,
        expectedPlanKey: "pro",
        targetInterval: "month",
        expectedSourceLookupKey: "ent_starter_month",
        expectedSourceCurrency: "usd",
        expectedSourceUnitAmount: 1900n,
        expectedSourcePlanKey: "starter",
        sourceInterval: "month",
      }),
    ).rejects.toThrow(/authorized source plan/u);
  });

  it("accepts the exact full-period-reset Invoice and omits proration_date", async () => {
    const client = mockStripe();
    client.invoices.createPreview.mockResolvedValue(fullPreview());
    const estimate =
      await gateway(client).previewImmediatePlanChange(context());
    expect(estimate).toMatchObject({
      amountDue: 4900n,
      prorationCredit: 0n,
      customerBalanceCredit: 0n,
      currency: "usd",
      safeInvoiceShape: true,
      sourceProrationAmount: 0n,
      targetProrationAmount: 0n,
    });
    const params = record(callArguments(client.invoices.createPreview)[0]);
    expect(record(params["subscription_details"])).toMatchObject({
      billing_cycle_anchor: "now",
      proration_behavior: "none",
    });
    expect(record(params["subscription_details"])).not.toHaveProperty(
      "proration_date",
    );
  });

  it.each([
    [
      "pagination",
      (preview: Record<string, unknown>) => {
        record(preview["lines"])["has_more"] = true;
      },
    ],
    [
      "zero tax object",
      (preview: Record<string, unknown>) => {
        record(array(record(preview["lines"])["data"])[0])["tax_amounts"] = [
          { amount: 0 },
        ];
      },
    ],
    [
      "zero discount object",
      (preview: Record<string, unknown>) => {
        record(array(record(preview["lines"])["data"])[0])["discount_amounts"] =
          [{ amount: 0 }];
      },
    ],
    [
      "zero-valued Invoice discount participation",
      (preview: Record<string, unknown>) => {
        preview["discounts"] = [{ coupon: "redacted" }];
      },
    ],
    [
      "automatic tax",
      (preview: Record<string, unknown>) => {
        preview["automatic_tax"] = { enabled: true };
      },
    ],
    [
      "singular discount",
      (preview: Record<string, unknown>) => {
        preview["discount"] = {};
      },
    ],
    [
      "credit note",
      (preview: Record<string, unknown>) => {
        preview["pre_payment_credit_notes_amount"] = 1;
      },
    ],
    [
      "malformed total",
      (preview: Record<string, unknown>) => {
        preview["total"] = "4900";
      },
    ],
    [
      "unsafe total",
      (preview: Record<string, unknown>) => {
        preview["total"] = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
  ] as const)(
    "fails closed for final Invoice drift: %s",
    async (_name, mutate) => {
      const client = mockStripe();
      const preview = fullPreview();
      mutate(preview);
      client.invoices.createPreview.mockResolvedValue(preview);
      const estimate =
        await gateway(client).previewImmediatePlanChange(context());
      expect(estimate.safeInvoiceShape).toBe(false);
    },
  );

  it("shares a fixed proration timestamp across the safe delta preview shape", async () => {
    const client = mockStripe();
    client.invoices.createPreview.mockResolvedValue({
      amount_due: 1500,
      subtotal: 1500,
      total: 1500,
      starting_balance: 0,
      ending_balance: 0,
      pre_payment_credit_notes_amount: 0,
      post_payment_credit_notes_amount: 0,
      currency: "usd",
      total_tax_amounts: [],
      total_discount_amounts: [],
      lines: {
        has_more: false,
        data: [
          {
            id: "il_source",
            amount: -950,
            quantity: 1,
            currency: "usd",
            proration: true,
            price: { id: "price_starter_month" },
            period: { start: 1_801_000_000, end: 1_802_592_000 },
          },
          {
            id: "il_target",
            amount: 2450,
            quantity: 1,
            currency: "usd",
            parent: { subscription_item_details: { proration: true } },
            pricing: { price_details: { price: "price_pro_month" } },
            period: { start: 1_801_000_000, end: 1_802_592_000 },
          },
        ],
      },
    });
    const estimate = await gateway(client).previewImmediatePlanChange(
      context(),
      {
        policy: "prorated_delta",
        prorationDate: 1_801_000_000n,
      },
    );
    expect(estimate).toMatchObject({
      amountDue: 1500n,
      sourceProrationAmount: 950n,
      targetProrationAmount: 2450n,
      prorationCredit: 950n,
      periodStart: 1_801_000_000n,
      periodEnd: 1_802_592_000n,
      safeInvoiceShape: true,
    });
    const params = record(callArguments(client.invoices.createPreview)[0]);
    expect(record(params["subscription_details"])).toMatchObject({
      proration_behavior: "always_invoice",
      proration_date: 1_801_000_000,
    });
    await expect(
      gateway(client).previewImmediatePlanChange(context(), {
        policy: "prorated_delta",
      }),
    ).rejects.toThrow(/fixed prorationDate/u);
  });
});

describe("applying and scheduling plan changes", () => {
  it.each(["full_period_reset", "prorated_delta"] as const)(
    "replays a frozen %s mutation without resolving the rotated target Price",
    async (policy) => {
      const client = mockStripe();
      client.subscriptions.update.mockResolvedValue({
        id: "sub_test",
        livemode: false,
        status: "active",
        pending_update: null,
        latest_invoice: {
          id: "in_settlement",
          hosted_invoice_url: "https://invoice.test/paid",
          confirmation_secret: null,
        },
      });
      const instance = gateway(client, {
        apiVersion: "2026-06-24.dahlia",
        productLine: "rotated-product-line",
      });
      const snapshot = planChangeSnapshot({ policy });
      await instance.executePlanChangeRequestSnapshot(snapshot);
      await instance.executePlanChangeRequestSnapshot(snapshot);
      expect(client.prices.list).not.toHaveBeenCalled();
      expect(client.subscriptions.retrieve).not.toHaveBeenCalled();
      expect(client.subscriptions.update).toHaveBeenCalledTimes(2);
      const calls = client.subscriptions.update.mock.calls;
      expect(calls[0]).toEqual(calls[1]);
      expect(calls[0]?.[0]).toBe("sub_test");
      expect(calls[0]?.[1]).toEqual(snapshot.params);
      expect(calls[0]?.[2]).toEqual({
        idempotencyKey: snapshot.idempotency_key,
        apiVersion: "2025-12-15.clover",
      });
    },
  );

  it("pins every Schedule request to the frozen API version and product line", async () => {
    const client = mockStripe();
    const current = {
      start_date: 1_800_000_000,
      end_date: 1_802_592_000,
      collection_method: "charge_automatically",
      items: [{ price: { id: "price_starter_month" }, quantity: 1 }],
    };
    client.subscriptionSchedules.create.mockResolvedValue({
      id: "sub_sched_test",
      phases: [current],
    });
    client.subscriptionSchedules.update.mockImplementation(
      (...args: unknown[]): Promise<unknown> =>
        Promise.resolve({ id: args[0] }),
    );
    client.subscriptionSchedules.retrieve.mockImplementation(
      (...args: unknown[]): Promise<unknown> => {
        const updateArgs = callArguments(client.subscriptionSchedules.update);
        const params = record(updateArgs[1]);
        return Promise.resolve({
          id: args[0],
          subscription: "sub_test",
          end_behavior: params["end_behavior"],
          metadata: params["metadata"],
          phases: params["phases"],
        });
      },
    );
    const snapshot = planChangeSnapshot({ timing: "period_end" });
    await gateway(client, {
      apiVersion: "2026-06-24.dahlia",
      productLine: "rotated-product-line",
    }).executePlanChangeRequestSnapshot(snapshot);
    expect(callArguments(client.subscriptionSchedules.create)[1]).toEqual({
      idempotencyKey: `${snapshot.idempotency_key}:create`,
      apiVersion: "2025-12-15.clover",
    });
    expect(callArguments(client.subscriptionSchedules.update)[2]).toEqual({
      idempotencyKey: `${snapshot.idempotency_key}:configure`,
      apiVersion: "2025-12-15.clover",
    });
    expect(callArguments(client.subscriptionSchedules.retrieve)[2]).toEqual({
      apiVersion: "2025-12-15.clover",
    });
    expect(
      record(callArguments(client.subscriptionSchedules.update)[1])["metadata"],
    ).toEqual({
      product_line: "frozen-product-line",
      plan_change_key: snapshot.idempotency_key,
    });
  });

  it("applies full-period reset with pending-if-incomplete and stable idempotency", async () => {
    const client = mockStripe();
    client.subscriptions.update.mockResolvedValue({
      id: "sub_test",
      livemode: false,
      status: "active",
      pending_update: null,
      latest_invoice: {
        id: "in_settlement",
        hosted_invoice_url: "https://invoice.test/paid",
        confirmation_secret: { client_secret: "pi_paid_secret_value" },
      },
    });
    const result = await gateway(client).applyImmediatePlanChange(context(), {
      idempotencyKey: "change:full",
    });
    expect(result).toEqual({
      remoteId: "sub_test",
      pendingUpdate: false,
      pendingExpiresAt: null,
      recoveryUrl: null,
      clientSecret: null,
      settlementInvoiceId: "in_settlement",
    });
    const [id, rawParams, rawOptions] = callArguments(
      client.subscriptions.update,
    );
    expect(id).toBe("sub_test");
    expect(record(rawParams)).toMatchObject({
      billing_cycle_anchor: "now",
      proration_behavior: "none",
      payment_behavior: "pending_if_incomplete",
      expand: ["latest_invoice.confirmation_secret"],
    });
    expect(record(rawOptions)).toEqual({ idempotencyKey: "change:full" });
  });

  it("applies prorated delta with the same fixed date and exposes pending recovery only", async () => {
    const client = mockStripe();
    client.subscriptions.update.mockResolvedValue({
      id: "sub_test",
      livemode: false,
      status: "active",
      pending_update: { expires_at: 1_801_000_100 },
      latest_invoice: {
        id: "in_pending",
        hosted_invoice_url: "https://invoice.test/recover",
        confirmation_secret: { client_secret: "pi_pending_secret_value" },
      },
    });
    const result = await gateway(client).applyImmediatePlanChange(context(), {
      idempotencyKey: "change:delta",
      policy: "prorated_delta",
      prorationDate: 1_801_000_000n,
    });
    expect(result).toMatchObject({
      pendingUpdate: true,
      pendingExpiresAt: 1_801_000_100n,
      recoveryUrl: "https://invoice.test/recover",
      clientSecret: "pi_pending_secret_value",
      settlementInvoiceId: "in_pending",
    });
    const params = record(callArguments(client.subscriptions.update)[1]);
    expect(params).toMatchObject({
      proration_behavior: "always_invoice",
      proration_date: 1_801_000_000,
    });
    expect(params).not.toHaveProperty("billing_cycle_anchor");
  });

  it.each([
    [
      {
        id: "sub_other",
        livemode: false,
        status: "active",
        latest_invoice: { id: "in" },
      },
      "different Subscription",
    ],
    [
      {
        id: "sub_test",
        livemode: true,
        status: "active",
        latest_invoice: { id: "in" },
      },
      "mode",
    ],
    [
      {
        id: "sub_test",
        livemode: false,
        status: "future",
        latest_invoice: { id: "in" },
      },
      "unsupported",
    ],
    [
      {
        id: "sub_test",
        livemode: false,
        status: "active",
        pending_update: {},
        latest_invoice: "in",
      },
      "expanded latest Invoice",
    ],
    [
      {
        id: "sub_test",
        livemode: false,
        status: "active",
        pending_update: { item: 1 },
        latest_invoice: { id: "in" },
      },
      "integer expiry",
    ],
  ] as const)(
    "rejects ambiguous apply result %#",
    async (response, message) => {
      const client = mockStripe();
      client.subscriptions.update.mockResolvedValue(response);
      await expect(
        gateway(client).applyImmediatePlanChange(context(), {
          idempotencyKey: "change",
        }),
      ).rejects.toThrow(message);
    },
  );

  it("creates/configures/verifies a two-phase schedule and preserves current policy", async () => {
    const client = mockStripe();
    const current = {
      start_date: 1_800_000_000,
      end_date: 1_802_592_000,
      collection_method: "charge_automatically",
      automatic_tax: {
        enabled: false,
        liability: null,
        disabled_reason: "finalization_requires_location_inputs",
      },
      description: "",
      default_payment_method: null,
      metadata: { keep: "yes" },
      items: [{ price: { id: "price_starter_month" }, quantity: 1 }],
    };
    client.subscriptionSchedules.create.mockResolvedValue({
      id: "sub_sched_test",
      phases: [current],
    });
    client.subscriptionSchedules.update.mockImplementation(
      (...args: unknown[]): Promise<unknown> =>
        Promise.resolve({ id: args[0] }),
    );
    client.subscriptionSchedules.retrieve.mockImplementation(
      (...args: unknown[]): Promise<unknown> => {
        const updateArgs = callArguments(client.subscriptionSchedules.update);
        const params = record(updateArgs[1]);
        return Promise.resolve({
          id: args[0],
          subscription: "sub_test",
          end_behavior: params["end_behavior"],
          metadata: params["metadata"],
          phases: params["phases"],
        });
      },
    );
    const result = await gateway(client).schedulePlanChange(context(), {
      idempotencyKey: "change:1",
    });
    expect(result.remoteId).toBe("sub_sched_test");
    expect(callArguments(client.subscriptionSchedules.create)).toEqual([
      { from_subscription: "sub_test" },
      { idempotencyKey: "change:1:create" },
    ]);
    const [, rawParams, rawOptions] = callArguments(
      client.subscriptionSchedules.update,
    );
    const params = record(rawParams);
    const phases = array(params["phases"]);
    expect(record(phases[0])).toMatchObject({
      collection_method: "charge_automatically",
      automatic_tax: { enabled: false },
      metadata: { keep: "yes" },
      end_date: 1_802_592_000,
      proration_behavior: "none",
    });
    expect(record(phases[1])).toMatchObject({
      start_date: 1_802_592_000,
      duration: { interval: "month", interval_count: 1 },
      items: [{ price: "price_pro_month", quantity: 1 }],
      automatic_tax: { enabled: false },
      proration_behavior: "none",
    });
    expect(record(record(phases[0])["automatic_tax"])).not.toHaveProperty(
      "disabled_reason",
    );
    expect(record(phases[0])).not.toHaveProperty("description");
    expect(record(phases[0])).not.toHaveProperty("default_payment_method");
    expect(record(rawOptions)).toEqual({
      idempotencyKey: "change:1:configure",
    });
  });

  it("recovers an already configured schedule without a second update", async () => {
    const client = mockStripe();
    const configured = {
      id: "sub_sched_existing",
      subscription: "sub_test",
      end_behavior: "release",
      metadata: {
        product_line: "example-entitlements",
        plan_change_key: "change:existing",
      },
      phases: [
        {
          end_date: 1_802_592_000,
          proration_behavior: "none",
          items: [{ price: "price_starter_month", quantity: 1 }],
        },
        {
          start_date: 1_802_592_000,
          duration: { interval: "month", interval_count: 1 },
          proration_behavior: "none",
          items: [{ price: "price_pro_month", quantity: 1 }],
        },
      ],
    };
    client.subscriptionSchedules.create.mockResolvedValue(configured);
    const result = await gateway(client).schedulePlanChange(context(), {
      idempotencyKey: "change:existing",
    });
    expect(result.remoteId).toBe("sub_sched_existing");
    expect(client.subscriptionSchedules.update).not.toHaveBeenCalled();
  });

  it("rejects malformed schedule quantities and verification drift without throwing in matcher", async () => {
    const client = mockStripe();
    client.subscriptionSchedules.create.mockResolvedValue({
      id: "sub_sched_bad",
      phases: [{ items: [{ price: "price_starter_month", quantity: "1" }] }],
    });
    await expect(
      gateway(client).schedulePlanChange(context(), {
        idempotencyKey: "change:bad",
      }),
    ).rejects.toThrow(/one resolvable Price/u);
    expect(
      gateway(mockStripe()).configuredScheduleMatches(
        { phases: "bad" },
        context(),
        "key",
      ),
    ).toBe(false);
  });

  it("matches legacy end_date month/year durations including end-of-month clamping", () => {
    const client = mockStripe();
    const instance = gateway(client);
    const january31 = context({
      currentPeriodEnd: 1_706_659_200n,
      targetInterval: "month",
    });
    const schedule = {
      subscription: "sub_test",
      end_behavior: "release",
      metadata: {
        product_line: "example-entitlements",
        plan_change_key: "legacy",
      },
      phases: [
        {
          end_date: 1_706_659_200,
          proration_behavior: "none",
          items: [{ price: "price_starter_month", quantity: 1 }],
        },
        {
          start_date: 1_706_659_200,
          end_date: 1_709_164_800,
          proration_behavior: "none",
          items: [{ price: "price_pro_month", quantity: 1 }],
        },
      ],
    };
    expect(
      instance.configuredScheduleMatches(schedule, january31, "legacy"),
    ).toBe(true);
  });
});
