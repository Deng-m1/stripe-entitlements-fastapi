import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { QueryResultRow } from "pg";
import { beforeAll, describe, expect, test } from "vitest";

import { PlanCatalog } from "../../src/catalog.js";
import { CreditService } from "../../src/credits.js";
import { EventProcessor } from "../../src/event-processor.js";
import { postgresDatabase } from "../support/postgres-setup.js";

const ROOT_CATALOG = fileURLToPath(
  new URL("../../../plans.toml", import.meta.url),
);
const STARTER = 300_000_000n;
const PRO = 1_000_000_000n;
const ULTRA = 4_000_000_000n;
const PERIOD_START = 1_800_000_000;
const PERIOD_END = 1_802_592_000;
const PLAN_CREDITS = {
  starter: STARTER,
  pro: PRO,
  ultra: ULTRA,
} as const;
const CATALOG_AMOUNTS: Readonly<Record<string, number>> = {
  starter_month: 1900,
  starter_year: 13_700,
  pro_month: 4900,
  pro_year: 35_300,
  ultra_month: 14_900,
  ultra_year: 107_300,
};

let catalog: PlanCatalog;

beforeAll(async () => {
  catalog = await PlanCatalog.fromToml(ROOT_CATALOG);
});

function resolvedPrice(
  plan: "starter" | "pro" | "ultra",
  interval: "month" | "year",
): Record<string, unknown> {
  const amount = CATALOG_AMOUNTS[`${plan}_${interval}`];
  if (amount === undefined) {
    throw new Error("test catalog amount is missing");
  }
  return {
    id: `price_${plan}_${interval}`,
    lookup_key: `ent_${plan}_${interval}`,
    active: true,
    type: "recurring",
    currency: "usd",
    unit_amount: amount,
    billing_scheme: "per_unit",
    recurring: { interval, interval_count: 1, usage_type: "licensed" },
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

function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  options: { readonly id?: string; readonly created?: number } = {},
): Record<string, unknown> {
  return {
    id: options.id ?? `evt_${randomUUID()}`,
    type,
    created: options.created ?? PERIOD_START + 10,
    livemode: false,
    api_version: "2026-06-24.dahlia",
    data: { object },
  };
}

function paidInvoice(
  accountId: string,
  options: {
    readonly invoiceId?: string;
    readonly customer?: string;
    readonly subscription?: string;
    readonly plan?: "starter" | "pro" | "ultra";
    readonly interval?: "month" | "year";
    readonly billingReason?: string;
    readonly eventId?: string;
    readonly created?: number;
    readonly periodStart?: number;
    readonly periodEnd?: number;
    readonly claimToken?: string;
  } = {},
): Record<string, unknown> {
  const invoiceId = options.invoiceId ?? "in_test";
  const customer = options.customer ?? "cus_test";
  const subscription = options.subscription ?? "sub_test";
  const plan = options.plan ?? "starter";
  const interval = options.interval ?? "month";
  const amount = CATALOG_AMOUNTS[`${plan}_${interval}`];
  if (amount === undefined) {
    throw new Error("test catalog amount is missing");
  }
  const periodStart = options.periodStart ?? PERIOD_START;
  const periodEnd =
    options.periodEnd ??
    periodStart + (interval === "year" ? 31_536_000 : 2_592_000);
  return stripeEvent(
    "invoice.paid",
    {
      id: invoiceId,
      customer,
      subscription,
      billing_reason: options.billingReason ?? "subscription_cycle",
      amount_paid: amount,
      amount_due: amount,
      subtotal: amount,
      total: amount,
      currency: "usd",
      parent: {
        subscription_details: {
          subscription,
          metadata: {
            account_id: accountId,
            product_line: "example-entitlements",
            ...(options.claimToken === undefined
              ? {}
              : { claim_token: options.claimToken }),
          },
        },
      },
      lines: {
        data: [
          {
            id: `il_${invoiceId}`,
            amount,
            currency: "usd",
            quantity: 1,
            price: {
              id: `price_${plan}_${interval}`,
              lookup_key: `ent_${plan}_${interval}`,
            },
            _resolved_price: resolvedPrice(plan, interval),
            period: { start: periodStart, end: periodEnd },
            proration: false,
          },
        ],
        has_more: false,
      },
    },
    {
      ...(options.eventId === undefined ? {} : { id: options.eventId }),
      ...(options.created === undefined ? {} : { created: options.created }),
    },
  );
}

function proratedInvoice(
  accountId: string,
  options: {
    readonly invoiceId?: string;
    readonly eventId?: string;
    readonly created?: number;
    readonly customer?: string;
    readonly subscription?: string;
    readonly sourcePlan?: "starter" | "pro";
    readonly targetPlan?: "pro" | "ultra";
    readonly sourceCredit?: number;
    readonly targetCharge?: number;
    readonly prorationDate?: number;
    readonly periodEnd?: number;
  } = {},
): Record<string, unknown> {
  const invoiceId = options.invoiceId ?? "in_delta";
  const customer = options.customer ?? "cus_test";
  const subscription = options.subscription ?? "sub_test";
  const sourcePlan = options.sourcePlan ?? "starter";
  const targetPlan = options.targetPlan ?? "pro";
  const sourceCredit = options.sourceCredit ?? 950;
  const targetCharge = options.targetCharge ?? 2450;
  const prorationDate = options.prorationDate ?? 1_801_000_000;
  const periodEnd = options.periodEnd ?? PERIOD_END;
  const amount = targetCharge - sourceCredit;
  return stripeEvent(
    "invoice.paid",
    {
      id: invoiceId,
      customer,
      subscription,
      billing_reason: "subscription_update",
      amount_paid: amount,
      amount_due: amount,
      subtotal: amount,
      total: amount,
      starting_balance: 0,
      ending_balance: 0,
      currency: "usd",
      total_tax_amounts: [],
      total_discount_amounts: [],
      discounts: [],
      parent: {
        subscription_details: {
          subscription,
          metadata: {
            account_id: accountId,
            product_line: "example-entitlements",
          },
        },
      },
      lines: {
        data: [
          {
            id: `il_source_${invoiceId}`,
            amount: -sourceCredit,
            currency: "usd",
            quantity: 1,
            price: {
              id: `price_${sourcePlan}_month`,
              lookup_key: `ent_${sourcePlan}_month`,
            },
            _resolved_price: resolvedPrice(sourcePlan, "month"),
            period: { start: prorationDate, end: periodEnd },
            proration: true,
          },
          {
            id: `il_target_${invoiceId}`,
            amount: targetCharge,
            currency: "usd",
            quantity: 1,
            price: {
              id: `price_${targetPlan}_month`,
              lookup_key: `ent_${targetPlan}_month`,
            },
            _resolved_price: resolvedPrice(targetPlan, "month"),
            period: { start: prorationDate, end: periodEnd },
            proration: true,
          },
        ],
        has_more: false,
        _all_lines_loaded: true,
      },
    },
    {
      ...(options.eventId === undefined ? {} : { id: options.eventId }),
      created: options.created ?? prorationDate + 10,
    },
  );
}

function refund(
  invoiceId: string,
  amount: number,
  amountRefunded: number,
  options: {
    readonly eventId?: string;
    readonly customer?: string;
    readonly created?: number;
  } = {},
): Record<string, unknown> {
  return stripeEvent(
    "charge.refunded",
    {
      id: `ch_${invoiceId}`,
      customer: options.customer ?? "cus_test",
      invoice: invoiceId,
      amount,
      amount_refunded: amountRefunded,
      refunded: amountRefunded >= amount,
    },
    {
      ...(options.eventId === undefined ? {} : { id: options.eventId }),
      created: options.created ?? PERIOD_START + 20,
    },
  );
}

function dispute(
  invoiceId: string,
  amount = 1900,
  options: {
    readonly customer?: string;
    readonly eventId?: string;
    readonly created?: number;
  } = {},
): Record<string, unknown> {
  const charge = {
    id: `ch_${invoiceId}`,
    customer: options.customer ?? "cus_test",
    invoice: invoiceId,
    amount,
    amount_refunded: 0,
    refunded: false,
  };
  return stripeEvent(
    "charge.dispute.created",
    {
      id: `dp_${invoiceId}`,
      charge: charge.id,
      _resolved_charge: charge,
    },
    {
      ...(options.eventId === undefined ? {} : { id: options.eventId }),
      ...(options.created === undefined ? {} : { created: options.created }),
    },
  );
}

function failedInvoice(
  accountId: string,
  options: {
    readonly invoiceId?: string;
    readonly billingReason?: string;
    readonly eventId?: string;
    readonly created?: number;
    readonly customer?: string;
    readonly subscription?: string;
  } = {},
): Record<string, unknown> {
  return stripeEvent(
    "invoice.payment_failed",
    {
      id: options.invoiceId ?? "in_failed",
      customer: options.customer ?? "cus_test",
      subscription: options.subscription ?? "sub_test",
      billing_reason: options.billingReason ?? "subscription_cycle",
      metadata: { account_id: accountId, product_line: "example-entitlements" },
      lines: { data: [] },
    },
    {
      ...(options.eventId === undefined ? {} : { id: options.eventId }),
      ...(options.created === undefined ? {} : { created: options.created }),
    },
  );
}

function subscriptionEvent(
  accountId: string,
  type: "customer.subscription.updated" | "customer.subscription.deleted",
  options: {
    readonly status?: string;
    readonly plan?: "starter" | "pro" | "ultra";
    readonly subscription?: string;
    readonly customer?: string;
    readonly eventId?: string;
    readonly created?: number;
    readonly cancelAtPeriodEnd?: boolean;
    readonly claimToken?: string;
  } = {},
): Record<string, unknown> {
  const plan = options.plan ?? "starter";
  const subscription = options.subscription ?? "sub_test";
  return stripeEvent(
    type,
    {
      id: subscription,
      customer: options.customer ?? "cus_test",
      status: options.status ?? "active",
      metadata: {
        account_id: accountId,
        product_line: "example-entitlements",
        ...(options.claimToken === undefined
          ? {}
          : { claim_token: options.claimToken }),
      },
      current_period_end: PERIOD_END,
      cancel_at_period_end: options.cancelAtPeriodEnd ?? false,
      items: {
        data: [
          {
            id: "si_test",
            quantity: 1,
            current_period_start: PERIOD_START,
            current_period_end: PERIOD_END,
            price: {
              id: `price_${plan}_month`,
              lookup_key: `ent_${plan}_month`,
            },
            _resolved_price: resolvedPrice(plan, "month"),
          },
        ],
      },
    },
    {
      ...(options.eventId === undefined ? {} : { id: options.eventId }),
      ...(options.created === undefined ? {} : { created: options.created }),
    },
  );
}

function checkoutEvent(
  type: "checkout.session.completed" | "checkout.session.expired",
  accountId: string,
  sessionId: string,
  claimToken: string,
): Record<string, unknown> {
  return stripeEvent(type, {
    id: sessionId,
    customer: `cus_${sessionId}`,
    subscription: `sub_${sessionId}`,
    client_reference_id: accountId,
    metadata: {
      account_id: accountId,
      product_line: "example-entitlements",
      claim_token: claimToken,
    },
  });
}

function processor(): EventProcessor {
  return new EventProcessor(
    postgresDatabase(),
    catalog,
    "example-entitlements",
    {
      expectedApiVersion: "2026-06-24.dahlia",
    },
  );
}

async function account(
  options: {
    readonly customer?: string | null;
    readonly subscription?: string | null;
    readonly plan?: "free" | "starter" | "pro" | "ultra";
    readonly interval?: "month" | "year" | null;
  } = {},
): Promise<string> {
  const database = postgresDatabase();
  const id = await database.createAccount(`ts-projector:${randomUUID()}`);
  const subscription =
    options.subscription === undefined ? "sub_test" : options.subscription;
  const plan = options.plan ?? (subscription === null ? "free" : "starter");
  const interval =
    options.interval === undefined
      ? subscription === null
        ? null
        : "month"
      : options.interval;
  await database.query(
    `update billing_accounts set stripe_customer_id=$2,stripe_subscription_id=$3,
       plan_key=$4,plan_interval=$5,subscription_status=$6 where id=$1::uuid`,
    [
      id,
      options.customer === undefined ? "cus_test" : options.customer,
      subscription,
      plan,
      interval,
      subscription === null ? "none" : "active",
    ],
  );
  return id;
}

async function snapshot(accountId: string): Promise<Record<string, unknown>> {
  const result = await postgresDatabase().query<
    QueryResultRow & Record<string, unknown>
  >("select * from billing_accounts where id=$1::uuid", [accountId]);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("test account disappeared");
  }
  return row;
}

async function insertPlanChange(
  accountId: string,
  options: {
    readonly policy?: "full_period_reset" | "prorated_delta";
    readonly settlementInvoiceId?: string | null;
    readonly status?: string;
    readonly targetPlan?: "pro" | "ultra";
    readonly targetInterval?: "month" | "year";
    readonly prorationDate?: number;
    readonly sourceProration?: number;
    readonly targetProration?: number;
    readonly expectedCreditDelta?: bigint;
  } = {},
): Promise<string> {
  const database = postgresDatabase();
  const current = await snapshot(accountId);
  const id = randomUUID();
  const policy = options.policy ?? "full_period_reset";
  const targetPlan = options.targetPlan ?? "pro";
  const targetInterval = options.targetInterval ?? "month";
  const prorationDate = options.prorationDate ?? 1_801_000_000;
  const sourceProration =
    options.sourceProration ?? (current["plan_key"] === "pro" ? 2450 : 950);
  const targetProration =
    options.targetProration ?? (targetPlan === "ultra" ? 7450 : 2450);
  let sourceInvoice: string | null = null;
  if (policy === "prorated_delta") {
    const source = await database.query<
      { readonly stripe_invoice_id: string } & QueryResultRow
    >(
      `select stripe_invoice_id from credit_ledger
         where account_id=$1::uuid and grant_epoch=$2::bigint
           and grant_slot is not null and entitlement_units>0
         order by id desc limit 1`,
      [accountId, current["grant_epoch"]],
    );
    sourceInvoice = source.rows[0]?.stripe_invoice_id ?? null;
  }
  const sourcePlan = current["plan_key"];
  if (
    policy === "prorated_delta" &&
    sourcePlan !== "starter" &&
    sourcePlan !== "pro" &&
    sourcePlan !== "ultra"
  ) {
    throw new Error("prorated test change requires a paid source plan");
  }
  const expectedCreditDelta =
    policy === "prorated_delta"
      ? (options.expectedCreditDelta ??
        PLAN_CREDITS[targetPlan] -
          PLAN_CREDITS[sourcePlan as keyof typeof PLAN_CREDITS])
      : undefined;
  await database.query(
    `insert into billing_plan_changes(
       id,account_id,idempotency_key,stripe_subscription_id,
       from_plan_key,from_interval,target_plan_key,target_interval,
       effective_mode,status,stripe_request_key,expected_grant_epoch,
       expected_entitlement_period_end,expected_subscription_status,
       expected_cancel_at_period_end,transition_policy,
       expected_source_invoice_id,expected_credit_delta,
       expected_entitlement_revoked,proration_date,
       estimated_source_proration,estimated_target_proration,
       estimated_amount_due,estimated_period_start,estimated_period_end,
       estimate_currency,settlement_invoice_id)
     values($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,'immediate',$9,$10,
            $11::bigint,$12::timestamptz,$13,$14,$15,$16,$17::bigint,$18,
            $19::bigint,$20::bigint,$21::bigint,$22::bigint,
            to_timestamp($19::bigint),$12::timestamptz,$23,$24)`,
    [
      id,
      accountId,
      `request-${id}`,
      current["stripe_subscription_id"],
      current["plan_key"],
      current["plan_interval"],
      targetPlan,
      targetInterval,
      options.status ?? "applied",
      `plan-change:${id}`,
      current["grant_epoch"],
      current["entitlement_period_end"],
      current["subscription_status"],
      current["cancel_at_period_end"],
      policy,
      sourceInvoice,
      expectedCreditDelta?.toString() ?? null,
      current["entitlement_revoked"],
      policy === "prorated_delta" ? String(prorationDate) : null,
      policy === "prorated_delta" ? String(sourceProration) : null,
      policy === "prorated_delta" ? String(targetProration) : null,
      policy === "prorated_delta"
        ? String(targetProration - sourceProration)
        : null,
      policy === "prorated_delta" ? "usd" : null,
      options.settlementInvoiceId ?? null,
    ],
  );
  return id;
}

async function reserveCheckout(
  accountId: string,
  sessionId: string,
): Promise<string> {
  const token = randomUUID();
  await postgresDatabase().query(
    `insert into checkout_claims(
       account_id,claim_token,session_id,plan_key,plan_interval,expires_at)
     values($1::uuid,$2::uuid,$3,'starter','month',clock_timestamp()+interval '30 minutes')`,
    [accountId, token, sessionId],
  );
  return token;
}

describe("subscription Event projector", () => {
  test("full-period paid projection is delivery- and business-idempotent", async () => {
    const accountId = await account();
    const service = processor();
    const first = paidInvoice(accountId, {
      invoiceId: "in_idempotent",
      eventId: "evt_paid_one",
    });
    await expect(service.process(first)).resolves.toMatchObject({
      outcome: "handled",
      accountId,
    });
    await expect(service.process(first)).resolves.toMatchObject({
      outcome: "duplicate",
    });
    await expect(
      service.process(
        paidInvoice(accountId, {
          invoiceId: "in_idempotent",
          eventId: "evt_paid_two",
          created: PERIOD_START + 20,
        }),
      ),
    ).resolves.toMatchObject({ outcome: "replayed", accountId });
    const current = await snapshot(accountId);
    expect(current["credits_balance"]).toBe(STARTER.toString());
    expect(current["grant_epoch"]).toBe("1");
    const grants = await postgresDatabase().query<
      { readonly count: string } & QueryResultRow
    >(
      "select count(*)::text as count from credit_ledger where stripe_invoice_id='in_idempotent' and grant_slot=1",
    );
    expect(grants.rows[0]?.count).toBe("1");
  });

  test("new paid cycle resets instead of accumulating credits", async () => {
    const accountId = await account();
    const service = processor();
    await service.process(
      paidInvoice(accountId, { invoiceId: "in_cycle_one", created: 100 }),
    );
    await postgresDatabase().query(
      "update billing_accounts set credits_balance=200000000 where id=$1::uuid",
      [accountId],
    );
    await service.process(
      paidInvoice(accountId, {
        invoiceId: "in_cycle_two",
        created: 200,
        periodStart: PERIOD_END,
        periodEnd: PERIOD_END + 2_592_000,
      }),
    );
    const current = await snapshot(accountId);
    expect(current["credits_balance"]).toBe(STARTER.toString());
    expect(current["grant_epoch"]).toBe("2");
  });

  test("partial refund before and after paid converges", async () => {
    for (const order of ["paid-first", "refund-first"] as const) {
      const accountId = await account({
        customer: `cus_${order}`,
        subscription: `sub_${order}`,
      });
      const service = processor();
      const paid = paidInvoice(accountId, {
        invoiceId: `in_${order}`,
        customer: `cus_${order}`,
        subscription: `sub_${order}`,
      });
      const refunded = refund(`in_${order}`, 1900, 950, {
        customer: `cus_${order}`,
      });
      const events =
        order === "paid-first" ? [paid, refunded] : [refunded, paid];
      for (const event of events) {
        await service.process(event);
      }
      expect((await snapshot(accountId))["credits_balance"]).toBe("150000000");
    }
  });

  test("full refund and dispute close funding once across distinct Events", async () => {
    for (const kind of ["refund", "dispute"] as const) {
      const customer = `cus_closed_${kind}`;
      const subscription = `sub_closed_${kind}`;
      const accountId = await account({ customer, subscription });
      const service = processor();
      const invoiceId = `in_closed_${kind}`;
      await service.process(
        paidInvoice(accountId, { invoiceId, customer, subscription }),
      );
      const first =
        kind === "refund"
          ? refund(invoiceId, 1900, 1900, { customer })
          : dispute(invoiceId, 1900, { customer });
      await expect(service.process(first)).resolves.toMatchObject({
        outcome: "handled",
      });
      const replay =
        kind === "refund"
          ? refund(invoiceId, 1900, 1900, {
              eventId: `evt_second_${kind}`,
              customer,
            })
          : {
              ...dispute(invoiceId, 1900, { customer }),
              id: `evt_second_${kind}`,
            };
      await expect(service.process(replay)).resolves.toMatchObject({
        outcome: "replayed",
      });
      const current = await snapshot(accountId);
      expect(current["credits_balance"]).toBe("0");
      expect(current["entitlement_revoked"]).toBe(true);
    }
  });

  test("concurrent same and different Events grant one business slot", async () => {
    const accountId = await account();
    const service = processor();
    const same = paidInvoice(accountId, {
      invoiceId: "in_race",
      eventId: "evt_same",
    });
    const sameResults = await Promise.all(
      Array.from({ length: 20 }, () => service.process(same)),
    );
    expect(
      sameResults.filter((result) => result.outcome === "handled"),
    ).toHaveLength(1);
    expect(
      sameResults.filter((result) => result.outcome === "duplicate"),
    ).toHaveLength(19);

    const secondAccount = await account({
      customer: "cus_second",
      subscription: "sub_second",
    });
    const different = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        service.process(
          paidInvoice(secondAccount, {
            invoiceId: "in_different_events",
            customer: "cus_second",
            subscription: "sub_second",
            eventId: `evt_business_${String(index)}`,
          }),
        ),
      ),
    );
    expect(
      different.filter((result) => result.outcome === "handled"),
    ).toHaveLength(1);
    expect(
      different.filter((result) => result.outcome === "replayed"),
    ).toHaveLength(11);
  });

  test("cross-account refund cannot mutate the Invoice owner", async () => {
    const owner = await account({ customer: "cus_owner" });
    const attacker = await account({
      customer: "cus_attacker",
      subscription: "sub_attacker",
    });
    const service = processor();
    await service.process(
      paidInvoice(owner, { invoiceId: "in_owned", customer: "cus_owner" }),
    );
    await expect(
      service.process(
        refund("in_owned", 1900, 1900, { customer: "cus_attacker" }),
      ),
    ).resolves.toMatchObject({ outcome: "ignored", accountId: attacker });
    expect((await snapshot(owner))["credits_balance"]).toBe(STARTER.toString());
    expect((await snapshot(attacker))["credits_balance"]).toBe("0");
    const state = await postgresDatabase().query<
      {
        readonly account_id: string;
        readonly amount_refunded: string;
      } & QueryResultRow
    >(
      "select account_id::text,amount_refunded::text from stripe_invoice_state where invoice_id='in_owned'",
    );
    expect(state.rows[0]).toMatchObject({
      account_id: owner,
      amount_refunded: "0",
    });
  });

  test("same-second paid dominates payment failure", async () => {
    const accountId = await account();
    const service = processor();
    const results = await Promise.all([
      service.process(
        paidInvoice(accountId, { invoiceId: "in_tie", created: 500 }),
      ),
      service.process(
        failedInvoice(accountId, { invoiceId: "in_failed_tie", created: 500 }),
      ),
    ]);
    expect(results.some((result) => result.outcome === "handled")).toBe(true);
    const current = await snapshot(accountId);
    expect(current["subscription_status"]).toBe("active");
    expect(current["event_rank"]).toBe(30);
  });

  test("same-second terminal deletion dominates paid and clears entitlement", async () => {
    const accountId = await account();
    const service = processor();
    await service.process(
      paidInvoice(accountId, { invoiceId: "in_before_delete", created: 100 }),
    );
    await Promise.all([
      service.process(
        paidInvoice(accountId, {
          invoiceId: "in_delete_tie",
          created: 600,
          periodStart: PERIOD_END,
          periodEnd: PERIOD_END + 2_592_000,
        }),
      ),
      service.process(
        subscriptionEvent(accountId, "customer.subscription.deleted", {
          created: 600,
        }),
      ),
    ]);
    const current = await snapshot(accountId);
    expect(current).toMatchObject({
      plan_key: "free",
      plan_interval: null,
      subscription_status: "canceled",
      credits_balance: "0",
      stripe_subscription_id: null,
      entitlement_revoked: true,
      event_rank: 40,
    });
  });

  test("Checkout completion and paid create converge in either order", async () => {
    for (const order of ["checkout-first", "paid-first"] as const) {
      const accountId = await account({ customer: null, subscription: null });
      const sessionId = `cs_${order}`;
      const token = await reserveCheckout(accountId, sessionId);
      const service = processor();
      const checkout = checkoutEvent(
        "checkout.session.completed",
        accountId,
        sessionId,
        token,
      );
      const paid = paidInvoice(accountId, {
        invoiceId: `in_${order}`,
        customer: `cus_${sessionId}`,
        subscription: `sub_${sessionId}`,
        billingReason: "subscription_create",
        claimToken: token,
      });
      for (const event of order === "checkout-first"
        ? [checkout, paid]
        : [paid, checkout]) {
        await service.process(event);
      }
      const current = await snapshot(accountId);
      expect(current).toMatchObject({
        stripe_customer_id: `cus_${sessionId}`,
        stripe_subscription_id: `sub_${sessionId}`,
        plan_key: "starter",
        credits_balance: STARTER.toString(),
      });
      const claims = await postgresDatabase().query<
        { readonly count: string } & QueryResultRow
      >(
        "select count(*)::text as count from checkout_claims where account_id=$1::uuid",
        [accountId],
      );
      expect(claims.rows[0]?.count).toBe("0");
    }
  });

  test("Checkout expiry releases only the exact Session claim", async () => {
    const accountId = await account({ customer: null, subscription: null });
    const token = await reserveCheckout(accountId, "cs_expire");
    const service = processor();
    await expect(
      service.process(
        checkoutEvent("checkout.session.expired", accountId, "cs_stale", token),
      ),
    ).resolves.toMatchObject({ outcome: "ignored" });
    await expect(
      service.process(
        checkoutEvent(
          "checkout.session.expired",
          accountId,
          "cs_expire",
          token,
        ),
      ),
    ).resolves.toMatchObject({ outcome: "handled", accountId });
  });

  test("optional plan-change failure retains paid source entitlement", async () => {
    const accountId = await account();
    const service = processor();
    await service.process(
      paidInvoice(accountId, { invoiceId: "in_source", created: 100 }),
    );
    await insertPlanChange(accountId, {
      settlementInvoiceId: "in_upgrade_failed",
      status: "applied",
    });
    await expect(
      service.process(
        failedInvoice(accountId, {
          invoiceId: "in_upgrade_failed",
          billingReason: "subscription_update",
          created: 200,
        }),
      ),
    ).resolves.toMatchObject({
      outcome: "ignored",
      reason: "optional plan change payment failed; paid entitlement retained",
      accountId,
    });
    expect(await snapshot(accountId)).toMatchObject({
      plan_key: "starter",
      credits_balance: STARTER.toString(),
      subscription_status: "active",
    });
    const change = await postgresDatabase().query<
      { readonly status: string } & QueryResultRow
    >("select status from billing_plan_changes");
    expect(change.rows[0]?.status).toBe("requires_action");
  });

  test("full-period authenticated plan change completes only from paid Invoice", async () => {
    const accountId = await account();
    const service = processor();
    await service.process(
      paidInvoice(accountId, { invoiceId: "in_full_source", created: 100 }),
    );
    await insertPlanChange(accountId);
    await service.process(
      subscriptionEvent(accountId, "customer.subscription.updated", {
        plan: "pro",
        created: 202,
      }),
    );
    await expect(
      service.process(
        paidInvoice(accountId, {
          invoiceId: "in_full_upgrade",
          plan: "pro",
          billingReason: "subscription_update",
          created: 201,
          periodStart: 1_801_000_000,
          periodEnd: 1_803_592_000,
        }),
      ),
    ).resolves.toMatchObject({ outcome: "handled", accountId });
    expect(await snapshot(accountId)).toMatchObject({
      plan_key: "pro",
      credits_balance: PRO.toString(),
    });
    const change = await postgresDatabase().query<
      {
        readonly status: string;
        readonly settlement_invoice_id: string;
      } & QueryResultRow
    >("select status,settlement_invoice_id from billing_plan_changes");
    expect(change.rows[0]).toMatchObject({
      status: "completed",
      settlement_invoice_id: "in_full_upgrade",
    });
  });

  test("prorated delta grants only the delta and full refund reverts the leaf", async () => {
    const accountId = await account();
    const service = processor();
    await service.process(
      paidInvoice(accountId, { invoiceId: "in_delta_source", created: 100 }),
    );
    await insertPlanChange(accountId, { policy: "prorated_delta" });
    const deltaResult = await service.process(proratedInvoice(accountId));
    expect(deltaResult, JSON.stringify(deltaResult)).toMatchObject({
      outcome: "handled",
      accountId,
    });
    expect(await snapshot(accountId)).toMatchObject({
      plan_key: "pro",
      credits_balance: PRO.toString(),
      grant_epoch: "1",
    });
    await expect(
      service.process(refund("in_delta", 1500, 1500)),
    ).resolves.toMatchObject({
      outcome: "handled",
      accountId,
    });
    expect(await snapshot(accountId)).toMatchObject({
      plan_key: "starter",
      credits_balance: STARTER.toString(),
      grant_epoch: "2",
      entitlement_revoked: false,
    });
  });

  test("same-epoch usage refund satisfies an outstanding partial clawback debt", async () => {
    const accountId = await account();
    const service = processor();
    const credits = new CreditService(postgresDatabase());
    const invoiceId = "in_partial_clawback_debt";
    const debitKey = "spent-before-partial-clawback";

    await service.process(paidInvoice(accountId, { invoiceId }));
    await credits.charge(accountId, "300", debitKey);
    await service.process(refund(invoiceId, 1900, 950));

    const beforeRefund = await postgresDatabase().query<
      {
        readonly credits_balance: string;
        readonly target_units: string;
        readonly collected_units: string;
      } & QueryResultRow
    >(
      `select a.credits_balance,d.target_units,d.collected_units
         from billing_accounts a
         join billing_clawback_debts d on d.account_id=a.id
        where a.id=$1::uuid and d.stripe_invoice_id=$2`,
      [accountId, invoiceId],
    );
    expect(beforeRefund.rows[0]).toEqual({
      credits_balance: "0",
      target_units: "150000000",
      collected_units: "0",
    });

    const refunded = await credits.refund(debitKey, {
      expectedAccountId: accountId,
    });
    expect(refunded.outcome).toBe("refunded");
    expect(refunded.restoredAtoms).toBe(STARTER);
    expect(refunded.balanceAtoms).toBe(150_000_000n);
    const afterRefund = await postgresDatabase().query<
      {
        readonly credits_balance: string;
        readonly target_units: string;
        readonly collected_units: string;
        readonly debit_amount: string;
        readonly restored_credits: string;
        readonly allocation_amount: string;
        readonly allocation_refunded: string;
        readonly ledger_total: string;
        readonly collection_total: string;
      } & QueryResultRow
    >(
      `select a.credits_balance,d.target_units,d.collected_units,
              debit.amount as debit_amount,
              debit.restored_credits,
              allocation.amount as allocation_amount,
              allocation.refunded_amount as allocation_refunded,
              (select sum(delta)::text from credit_ledger
                where account_id=a.id) as ledger_total,
              (select coalesce(sum(-delta),0)::text from credit_ledger
                where account_id=a.id
                  and reason='clawback_debt_collection') as collection_total
         from billing_accounts a
         join billing_clawback_debts d on d.account_id=a.id
         join credit_debits debit
           on debit.account_id=a.id and debit.idempotency_key=$3
         join credit_debit_allocations allocation
           on allocation.debit_idempotency_key=debit.idempotency_key
        where a.id=$1::uuid and d.stripe_invoice_id=$2`,
      [accountId, invoiceId, debitKey],
    );
    expect(afterRefund.rows[0]).toEqual({
      credits_balance: "150000000",
      target_units: "150000000",
      collected_units: "150000000",
      debit_amount: "300000000",
      restored_credits: "300000000",
      allocation_amount: "300000000",
      allocation_refunded: "300000000",
      ledger_total: "150000000",
      collection_total: "150000000",
    });
  });

  test("prorated delta grant collects source clawback debt atomically", async () => {
    const accountId = await account();
    const service = processor();
    const credits = new CreditService(postgresDatabase());
    const sourceInvoiceId = "in_delta_source_with_debt";
    const settlementInvoiceId = "in_delta_collects_source_debt";

    await service.process(
      paidInvoice(accountId, { invoiceId: sourceInvoiceId }),
    );
    await credits.charge(accountId, "300", "spent-source-before-delta");
    await service.process(refund(sourceInvoiceId, 1900, 950));
    const changeId = await insertPlanChange(accountId, {
      policy: "prorated_delta",
    });

    const result = await service.process(
      proratedInvoice(accountId, { invoiceId: settlementInvoiceId }),
    );
    expect(result).toMatchObject({ outcome: "handled", accountId });
    const state = await postgresDatabase().query<
      {
        readonly plan_key: string;
        readonly credits_balance: string;
        readonly grant_epoch: string;
        readonly debt_target: string;
        readonly debt_collected: string;
        readonly source_invoice_id: string;
        readonly entitlement_delta: string;
        readonly refunded_units: string;
        readonly allocation_status: string;
        readonly change_status: string;
        readonly settlement_invoice_id: string;
        readonly ledger_total: string;
        readonly delta_grant_total: string;
        readonly collection_total: string;
      } & QueryResultRow
    >(
      `select a.plan_key,a.credits_balance,a.grant_epoch,
              debt.target_units as debt_target,
              debt.collected_units as debt_collected,
              allocation.source_invoice_id,
              allocation.entitlement_delta,
              allocation.refunded_units,
              allocation.status as allocation_status,
              change.status as change_status,
              change.settlement_invoice_id,
              (select sum(delta)::text from credit_ledger
                where account_id=a.id) as ledger_total,
              (select coalesce(sum(delta),0)::text from credit_ledger
                where account_id=a.id and stripe_invoice_id=$3
                  and reason='upgrade_delta_grant') as delta_grant_total,
              (select coalesce(sum(-delta),0)::text from credit_ledger
                where account_id=a.id
                  and reason='clawback_debt_collection') as collection_total
         from billing_accounts a
         join billing_clawback_debts debt on debt.account_id=a.id
         join billing_funding_allocations allocation
           on allocation.account_id=a.id and allocation.stripe_invoice_id=$3
         join billing_plan_changes change
           on change.id=allocation.plan_change_id and change.id=$4::uuid
        where a.id=$1::uuid and debt.stripe_invoice_id=$2`,
      [accountId, sourceInvoiceId, settlementInvoiceId, changeId],
    );
    expect(state.rows[0]).toEqual({
      plan_key: "pro",
      credits_balance: "550000000",
      grant_epoch: "1",
      debt_target: "150000000",
      debt_collected: "150000000",
      source_invoice_id: sourceInvoiceId,
      entitlement_delta: "700000000",
      refunded_units: "0",
      allocation_status: "active",
      change_status: "completed",
      settlement_invoice_id: settlementInvoiceId,
      ledger_total: "550000000",
      delta_grant_total: "700000000",
      collection_total: "150000000",
    });
  });

  test("annual paid Invoice establishes slot one and funding identity", async () => {
    const accountId = await account({ plan: "starter", interval: "year" });
    const service = processor();
    await expect(
      service.process(
        paidInvoice(accountId, {
          invoiceId: "in_annual",
          interval: "year",
          periodEnd: PERIOD_START + 31_536_000,
        }),
      ),
    ).resolves.toMatchObject({ outcome: "handled", accountId });
    expect(await snapshot(accountId)).toMatchObject({
      plan_interval: "year",
      credits_balance: STARTER.toString(),
      annual_grants_issued: 1,
      annual_grants_allowed: 12,
      funding_invoice_id: "in_annual",
    });
  });

  test("processing exception rolls back Event claim and retries successfully", async () => {
    const database = postgresDatabase();
    const accountId = await account();
    const service = processor();
    await database.query(`
      create function ts_fail_subscription_grant() returns trigger language plpgsql as $$
      begin
        if new.reason='subscription_grant' then
          raise exception 'test projector rollback';
        end if;
        return new;
      end $$;
      create trigger ts_fail_subscription_grant
      before insert on credit_ledger for each row execute function ts_fail_subscription_grant()
    `);
    const event = paidInvoice(accountId, {
      invoiceId: "in_retry",
      eventId: "evt_retry",
    });
    try {
      await expect(service.process(event)).rejects.toThrow(
        "test projector rollback",
      );
      await expect(service.hasCommittedEvent("evt_retry")).resolves.toBe(false);
    } finally {
      await database.query(
        "drop trigger if exists ts_fail_subscription_grant on credit_ledger",
      );
      await database.query(
        "drop function if exists ts_fail_subscription_grant() cascade",
      );
    }
    await expect(service.process(event)).resolves.toMatchObject({
      outcome: "handled",
      accountId,
    });
    await expect(service.hasCommittedEvent("evt_retry")).resolves.toBe(true);
  });

  test("concurrent paid and cumulative refunds converge to the greatest refund", async () => {
    const customer = "cus_paid_refund_race";
    const subscription = "sub_paid_refund_race";
    const accountId = await account({ customer, subscription });
    const service = processor();
    const invoiceId = "in_paid_refund_race";
    const results = await Promise.all([
      service.process(
        paidInvoice(accountId, {
          invoiceId,
          customer,
          subscription,
          eventId: "evt_paid_refund_race_paid",
        }),
      ),
      ...[475, 950, 1425].map((amountRefunded, index) =>
        service.process(
          refund(invoiceId, 1900, amountRefunded, {
            customer,
            eventId: `evt_paid_refund_race_${String(index)}`,
          }),
        ),
      ),
    ]);
    expect(results.every((result) => result.outcome !== "duplicate")).toBe(
      true,
    );
    expect(await snapshot(accountId)).toMatchObject({
      credits_balance: "75000000",
      entitlement_revoked: false,
    });
    const state = await postgresDatabase().query<
      {
        readonly amount_refunded: string;
        readonly fully_refunded: boolean;
      } & QueryResultRow
    >(
      "select amount_refunded::text,fully_refunded from stripe_invoice_state where invoice_id=$1",
      [invoiceId],
    );
    expect(state.rows[0]).toMatchObject({
      amount_refunded: "1425",
      fully_refunded: false,
    });
  });

  test("refund and dispute delivered before paid durably block the grant", async () => {
    for (const kind of ["refund", "dispute"] as const) {
      const customer = `cus_closed_before_paid_${kind}`;
      const subscription = `sub_closed_before_paid_${kind}`;
      const accountId = await account({ customer, subscription });
      const invoiceId = `in_closed_before_paid_${kind}`;
      const service = processor();
      const clawback =
        kind === "refund"
          ? refund(invoiceId, 1900, 1900, {
              customer,
              eventId: `evt_closed_before_paid_${kind}_first`,
            })
          : dispute(invoiceId, 1900, {
              customer,
              eventId: `evt_closed_before_paid_${kind}_first`,
            });
      await expect(service.process(clawback)).resolves.toMatchObject({
        outcome: "ignored",
      });
      await expect(
        service.process(
          paidInvoice(accountId, {
            invoiceId,
            customer,
            subscription,
            eventId: `evt_closed_before_paid_${kind}_paid`,
          }),
        ),
      ).resolves.toMatchObject({ outcome: "ignored" });
      const replay =
        kind === "refund"
          ? refund(invoiceId, 1900, 1900, {
              customer,
              eventId: `evt_closed_before_paid_${kind}_second`,
            })
          : dispute(invoiceId, 1900, {
              customer,
              eventId: `evt_closed_before_paid_${kind}_second`,
            });
      await expect(service.process(replay)).resolves.toMatchObject({
        outcome: "replayed",
      });
      expect(await snapshot(accountId)).toMatchObject({
        plan_key: "starter",
        credits_balance: "0",
      });
      const state = await postgresDatabase().query<
        {
          readonly fully_refunded: boolean;
          readonly disputed: boolean;
          readonly closure_applied: boolean;
        } & QueryResultRow
      >(
        `select fully_refunded,disputed,closure_applied
           from stripe_invoice_state where invoice_id=$1`,
        [invoiceId],
      );
      expect(state.rows[0]).toMatchObject({
        fully_refunded: true,
        disputed: kind === "dispute",
        closure_applied: true,
      });
      const grants = await postgresDatabase().query<
        { readonly count: string } & QueryResultRow
      >(
        `select count(*)::text from credit_ledger
          where stripe_invoice_id=$1 and reason='subscription_grant'`,
        [invoiceId],
      );
      expect(grants.rows[0]?.count).toBe("0");
    }
  });
});
