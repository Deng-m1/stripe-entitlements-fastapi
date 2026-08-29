import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "vitest";

import { AnnualGrantService } from "../../src/annual.js";
import { PlanCatalog } from "../../src/catalog.js";
import type { Database } from "../../src/database.js";
import type { SubscriptionSnapshot } from "../../src/types.js";
import { postgresDatabase } from "../support/postgres-setup.js";

const CATALOG_PATH = fileURLToPath(
  new URL("../../../plans.toml", import.meta.url),
);
const ANCHOR = "2026-01-01T00:00:00.000000Z";
const PERIOD_END = "2027-01-01T00:00:00.000000Z";
const STARTER_ATOMS = 300_000_000n;

let catalog: PlanCatalog;
let database: Database;

function resolvedAnnualPrice(
  plan = "starter",
): Readonly<Record<string, unknown>> {
  const amounts: Readonly<Record<string, number>> = {
    starter: 13_700,
    pro: 35_300,
    ultra: 107_300,
  };
  return {
    id: `price_${plan}_year`,
    lookup_key: `ent_${plan}_year`,
    active: true,
    type: "recurring",
    currency: "usd",
    unit_amount: amounts[plan],
    billing_scheme: "per_unit",
    recurring: {
      interval: "year",
      interval_count: 1,
      usage_type: "licensed",
    },
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

function snapshot(plan = "starter"): SubscriptionSnapshot {
  return {
    subscriptionId: "sub_test",
    status: "active",
    lookupKey: `ent_${plan}_year`,
    currentPeriodEnd: PERIOD_END,
    resolvedPrice: resolvedAnnualPrice(plan),
    quantity: 1n,
    itemsComplete: true,
  };
}

async function annualAccount(
  invoiceId = `in_${randomUUID()}`,
  stripeIdentity: {
    readonly customer: string;
    readonly subscription: string;
  } = {
    customer: "cus_test",
    subscription: "sub_test",
  },
): Promise<string> {
  const accountId = await database.createAccount(`ts-annual:${randomUUID()}`);
  await database.transaction(async (transaction) => {
    await transaction.query(
      `update billing_accounts set
         stripe_customer_id=$6,stripe_subscription_id=$7,
         plan_key='starter',plan_interval='year',subscription_status='active',
         credits_balance=$2::bigint,grant_epoch=1,current_period_end=$3::timestamptz,
         annual_anchor=$4::timestamptz,annual_grants_issued=1,
         annual_grants_allowed=12,funding_invoice_id=$5,
         entitlement_period_end=$3::timestamptz,
         credit_expires_at='2026-02-01T00:00:00Z'::timestamptz
       where id=$1::uuid`,
      [
        accountId,
        STARTER_ATOMS.toString(),
        PERIOD_END,
        ANCHOR,
        invoiceId,
        stripeIdentity.customer,
        stripeIdentity.subscription,
      ],
    );
    await transaction.query(
      `insert into stripe_invoice_state(
         invoice_id,account_id,amount_total,grant_units_per_slot,grants_issued
       ) values($1,$2::uuid,13700,$3::bigint,1)`,
      [invoiceId, accountId, STARTER_ATOMS.toString()],
    );
    await transaction.query(
      `insert into credit_ledger(
         account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
         stripe_event_id,stripe_invoice_id,grant_slot
       ) values(
         $1::uuid,$2::bigint,$2::bigint,$2::bigint,'subscription_grant',
         1,$3,$4,1
       )`,
      [accountId, STARTER_ATOMS.toString(), `paid:${invoiceId}`, invoiceId],
    );
  });
  return accountId;
}

beforeAll(async () => {
  database = postgresDatabase();
  catalog = await PlanCatalog.fromToml(CATALOG_PATH);
});

describe("annual monthly grant projection", () => {
  test("many workers issue exactly one due slot", async () => {
    const invoiceId = "in_ts_annual_race";
    const accountId = await annualAccount(invoiceId);
    const service = new AnnualGrantService(database, catalog, {
      productLine: "example-entitlements",
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.grantDue(accountId, "2026-02-02T00:00:00.123456Z", snapshot()),
      ),
    );

    expect(
      results.filter((result) => result.outcome === "handled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.outcome === "replayed"),
    ).toHaveLength(19);
    const slots = await database.query<{ readonly grant_slot: number }>(
      `select grant_slot from credit_ledger
        where stripe_invoice_id=$1 order by grant_slot`,
      [invoiceId],
    );
    expect(slots.rows.map((row) => row.grant_slot)).toEqual([1, 2]);
  });

  test("downtime jumps to the current slot without backfill spam", async () => {
    const invoiceId = "in_ts_annual_jump";
    const accountId = await annualAccount(invoiceId);
    const result = await new AnnualGrantService(database, catalog, {
      productLine: "example-entitlements",
    }).grantDue(accountId, "2026-06-15T00:00:00Z", snapshot());

    expect(result).toMatchObject({
      outcome: "handled",
      reason: "granted annual slot 6",
    });
    const slots = await database.query<{ readonly grant_slot: number }>(
      "select grant_slot from credit_ledger where stripe_invoice_id=$1 order by grant_slot",
      [invoiceId],
    );
    expect(slots.rows.map((row) => row.grant_slot)).toEqual([1, 6]);
  });

  test("resets each slot to the exact catalog atom amount", async () => {
    const accountId = await annualAccount("in_ts_annual_exact");
    await database.query(
      "update billing_accounts set credits_balance=299875000 where id=$1::uuid",
      [accountId],
    );
    await new AnnualGrantService(database, catalog, {
      productLine: "example-entitlements",
    }).grantDue(accountId, "2026-02-02T00:00:00Z", snapshot());

    const state = await database.query<{
      readonly credits_balance: string;
      readonly grant_epoch: string;
      readonly delta: string;
    }>(
      `select a.credits_balance,a.grant_epoch,l.delta
         from billing_accounts a join credit_ledger l on l.account_id=a.id
        where a.id=$1::uuid and l.grant_slot=2`,
      [accountId],
    );
    expect(state.rows[0]).toMatchObject({
      credits_balance: "300000000",
      grant_epoch: "2",
      delta: "125000",
    });
  });

  test("remote mismatch fails closed and records a durable incident", async () => {
    const accountId = await annualAccount("in_ts_annual_mismatch");
    const result = await new AnnualGrantService(database, catalog, {
      productLine: "example-entitlements",
    }).grantDue(accountId, "2026-02-02T00:00:00Z", snapshot("pro"));

    expect(result).toMatchObject({
      outcome: "ignored",
      reason: "remote and local annual plans differ",
    });
    const incident = await database.query<{
      readonly kind: string;
      readonly detail: Readonly<Record<string, unknown>>;
    }>("select kind,detail from billing_incidents where account_id=$1::uuid", [
      accountId,
    ]);
    expect(incident.rows[0]?.kind).toBe("annual_plan_mismatch");
    expect(incident.rows[0]?.detail).toMatchObject({
      remote_lookup_key: "ent_pro_year",
      local_plan: "starter",
    });
  });

  test("a closed funding invoice stops future grants", async () => {
    const invoiceId = "in_ts_annual_closed";
    const accountId = await annualAccount(invoiceId);
    await database.query(
      `update stripe_invoice_state set fully_refunded=true,amount_refunded=amount_total
        where invoice_id=$1`,
      [invoiceId],
    );
    const result = await new AnnualGrantService(database, catalog, {
      productLine: "example-entitlements",
    }).grantDue(accountId, "2026-02-02T00:00:00Z", snapshot());

    expect(result).toMatchObject({
      outcome: "ignored",
      reason: "funding invoice is closed",
    });
    const account = await database.query<{
      readonly annual_grants_issued: number;
      readonly annual_grants_allowed: number;
    }>(
      "select annual_grants_issued,annual_grants_allowed from billing_accounts where id=$1::uuid",
      [accountId],
    );
    expect(account.rows[0]).toMatchObject({
      annual_grants_issued: 1,
      annual_grants_allowed: 1,
    });
  });

  test("candidate scans are bounded, exclude attempted owners, and preserve microseconds", async () => {
    const first = await annualAccount("in_ts_annual_scan_a", {
      customer: "cus_ts_annual_scan_a",
      subscription: "sub_ts_annual_scan_a",
    });
    const second = await annualAccount("in_ts_annual_scan_b", {
      customer: "cus_ts_annual_scan_b",
      subscription: "sub_ts_annual_scan_b",
    });
    const service = new AnnualGrantService(database, catalog, {
      productLine: "example-entitlements",
    });
    const due = await service.dueAccounts("2026-02-01T00:00:00.000001Z", {
      limit: 1,
      excludeAccountIds: new Set([first]),
    });

    expect(due).toHaveLength(1);
    expect(due[0]?.id).toBe(second);
    await expect(
      service.dueAccounts("2026-02-01T00:00:00", { limit: 1 }),
    ).rejects.toThrow("timezone-aware");
    await expect(service.dueAccounts(undefined, { limit: 0 })).rejects.toThrow(
      "positive integer",
    );
  });

  test("network failure incidents are deduplicated and resolved by a grant", async () => {
    const accountId = await annualAccount("in_ts_annual_recovery");
    const service = new AnnualGrantService(database, catalog, {
      productLine: "example-entitlements",
    });
    await service.recordFailure(accountId, "sub_test", "TimeoutError");
    await service.recordFailure(accountId, "sub_test", "ConnectionError");
    await service.grantDue(accountId, "2026-02-02T00:00:00Z", snapshot());

    const incident = await database.query<{
      readonly seen_count: number;
      readonly resolved_at: string | null;
      readonly detail: Readonly<Record<string, unknown>>;
    }>(
      "select seen_count,resolved_at,detail from billing_incidents where account_id=$1::uuid",
      [accountId],
    );
    expect(incident.rows[0]?.seen_count).toBe(2);
    expect(incident.rows[0]?.detail).toMatchObject({
      reason: "ConnectionError",
    });
    expect(incident.rows[0]?.resolved_at).not.toBeNull();
  });
});
