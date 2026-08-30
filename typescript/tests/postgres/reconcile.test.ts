import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "vitest";

import { PlanCatalog } from "../../src/catalog.js";
import type { Database } from "../../src/database.js";
import { EventProcessor } from "../../src/event-processor.js";
import {
  customerFactFingerprint,
  ReconciliationService,
  type ReconciliationGateway,
  type ReconciliationProcessor,
} from "../../src/reconcile.js";
import type { ProcessResult } from "../../src/types.js";
import { postgresDatabase } from "../support/postgres-setup.js";

const ROOT_CATALOG = fileURLToPath(
  new URL("../../../plans.toml", import.meta.url),
);
const RACE_PERIOD_START = 1_800_000_000;
const RACE_PERIOD_STALE = 1_802_592_000;
const RACE_PERIOD_FRESH = 1_805_184_000;
const RACE_PERIOD_LATEST = 1_807_776_000;

let catalog: PlanCatalog;

beforeAll(async () => {
  catalog = await PlanCatalog.fromToml(ROOT_CATALOG);
});

function starterPrice(): Readonly<Record<string, unknown>> {
  return {
    id: "price_starter_month",
    lookup_key: "ent_starter_month",
    active: true,
    type: "recurring",
    currency: "usd",
    unit_amount: 1900,
    billing_scheme: "per_unit",
    recurring: {
      interval: "month",
      interval_count: 1,
      usage_type: "licensed",
    },
    tax_behavior: "unspecified",
    tiers_mode: null,
    transform_quantity: null,
    custom_unit_amount: null,
    currency_options: null,
    product: {
      id: "prod_starter",
      active: true,
      metadata: { product_line: "example-entitlements", plan: "starter" },
    },
  };
}

function subscriptionSnapshot(
  accountId: string,
  subscriptionId: string,
  customerId: string,
  options: {
    readonly status: "active" | "past_due" | "canceled";
    readonly cancelAtPeriodEnd: boolean;
    readonly periodEnd: number;
  },
): Readonly<Record<string, unknown>> {
  return {
    id: subscriptionId,
    object: "subscription",
    livemode: false,
    customer: customerId,
    status: options.status,
    cancel_at_period_end: options.cancelAtPeriodEnd,
    current_period_end: options.periodEnd,
    metadata: {
      account_id: accountId,
      product_line: "example-entitlements",
    },
    items: {
      data: [
        {
          id: "si_reconcile_race",
          quantity: 1,
          current_period_start: RACE_PERIOD_START,
          current_period_end: options.periodEnd,
          price: {
            id: "price_starter_month",
            lookup_key: "ent_starter_month",
          },
          _resolved_price: starterPrice(),
        },
      ],
    },
  };
}

function subscriptionWebhook(
  eventId: string,
  created: number,
  subscription: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    id: eventId,
    object: "event",
    type: "customer.subscription.updated",
    created,
    livemode: false,
    api_version: "2026-06-24.dahlia",
    data: { object: subscription },
  };
}

class FakeGateway implements ReconciliationGateway {
  public subscription: Readonly<Record<string, unknown>>;
  public paid: Record<string, unknown> | undefined;
  public subscriptionFailure: Error | undefined;
  public paidFailure: Error | undefined;

  public constructor(subscriptionId: string, status = "active") {
    this.subscription = {
      id: subscriptionId,
      object: "subscription",
      status,
      livemode: false,
      customer: "cus_reconcile",
    };
    this.paid = {
      id: "evt_remote_paid",
      object: "event",
      type: "invoice.paid",
      created: 1_800_000_000,
      livemode: false,
      data: { object: { id: "in_reconcile" } },
    };
  }

  public async subscriptionObject(): Promise<
    Readonly<Record<string, unknown>>
  > {
    if (this.subscriptionFailure !== undefined) {
      throw this.subscriptionFailure;
    }
    return this.subscription;
  }

  public async latestPaidInvoiceEvent(): Promise<
    Record<string, unknown> | undefined
  > {
    if (this.paidFailure !== undefined) {
      throw this.paidFailure;
    }
    return this.paid === undefined ? undefined : { ...this.paid };
  }
}

class RecordingProcessor implements ReconciliationProcessor {
  public readonly events: Record<string, unknown>[] = [];
  public result: ProcessResult = { outcome: "handled" };

  public async process(event: unknown): Promise<ProcessResult> {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      throw new TypeError("test processor expected an event object");
    }
    this.events.push(event as Record<string, unknown>);
    return this.result;
  }
}

async function account(
  database: Database,
  subscriptionId = `sub_${randomUUID()}`,
  status: "active" | "past_due" = "active",
): Promise<string> {
  const accountId = await database.createAccount(
    `ts-reconcile:${randomUUID()}`,
  );
  await database.query(
    `update billing_accounts set
       stripe_customer_id=$2,stripe_subscription_id=$3,
       subscription_status=$4,plan_key='starter',plan_interval='month',
       event_created=100,event_rank=20,
       current_period_end='2026-01-01T00:00:00Z',
       entitlement_period_end='2026-01-01T00:00:00Z'
     where id=$1::uuid`,
    [accountId, `cus_${randomUUID()}`, subscriptionId, status],
  );
  return accountId;
}

describe("reconciliation orchestration", () => {
  test("active repair projects status before the latest paid invoice", async () => {
    const database = postgresDatabase();
    const subscriptionId = "sub_ts_reconcile_active";
    const accountId = await account(database, subscriptionId);
    const gateway = new FakeGateway(subscriptionId);
    const processor = new RecordingProcessor();

    const result = await new ReconciliationService(
      database,
      processor,
      gateway,
    ).reconcileAccount(accountId);

    expect(result.outcome).toBe("handled");
    expect(processor.events.map((event) => event["type"])).toEqual([
      "customer.subscription.updated",
      "invoice.paid",
    ]);
    for (const event of processor.events) {
      expect(event["_remote_verified"]).toBe(true);
      expect(event["_expected_account"]).toMatchObject({
        stripe_subscription_id: subscriptionId,
        event_created: "100",
        event_rank: 20,
      });
    }
    expect(String(processor.events[1]?.["id"])).toContain(
      `reconcile:in_reconcile:${subscriptionId}`,
    );
  });

  test("paid compare-and-swap retries against a refreshed projection cursor", async () => {
    const database = postgresDatabase();
    const subscriptionId = "sub_ts_reconcile_cas";
    const accountId = await account(database, subscriptionId);
    const gateway = new FakeGateway(subscriptionId);
    const events: Record<string, unknown>[] = [];
    let paidAttempts = 0;
    const processor: ReconciliationProcessor = {
      async process(raw): Promise<ProcessResult> {
        const event = raw as Record<string, unknown>;
        events.push(event);
        if (event["type"] === "invoice.paid") {
          paidAttempts += 1;
          if (paidAttempts === 1) {
            await database.query(
              "update billing_accounts set event_created=101,event_rank=30 where id=$1::uuid",
              [accountId],
            );
            return {
              outcome: "ignored",
              reason: "older than the paid entitlement period",
              accountId,
            };
          }
        }
        return { outcome: "handled", accountId };
      },
    };

    const result = await new ReconciliationService(
      database,
      processor,
      gateway,
    ).reconcileAccount(accountId);

    expect(result.outcome).toBe("handled");
    const paidEvents = events.filter(
      (event) => event["type"] === "invoice.paid",
    );
    expect(paidEvents).toHaveLength(2);
    expect(paidEvents[0]?.["id"]).not.toBe(paidEvents[1]?.["id"]);
    expect(paidEvents[1]?.["_expected_account"]).toMatchObject({
      event_created: "101",
      event_rank: 30,
    });
  });

  test("status CAS retry fetches fresh Stripe state before projecting", async () => {
    const database = postgresDatabase();
    const subscriptionId = "sub_ts_reconcile_status_refresh";
    const customerId = "cus_ts_reconcile_status_refresh";
    const accountId = await account(database, subscriptionId);
    await database.query(
      `update billing_accounts set stripe_customer_id=$2,
         current_period_end=to_timestamp($3::bigint),
         entitlement_period_end=to_timestamp($3::bigint)
       where id=$1::uuid`,
      [accountId, customerId, RACE_PERIOD_STALE],
    );
    const stale = subscriptionSnapshot(accountId, subscriptionId, customerId, {
      status: "active",
      cancelAtPeriodEnd: false,
      periodEnd: RACE_PERIOD_STALE,
    });
    const fresh = subscriptionSnapshot(accountId, subscriptionId, customerId, {
      status: "past_due",
      cancelAtPeriodEnd: true,
      periodEnd: RACE_PERIOD_FRESH,
    });
    let subscriptionReads = 0;
    let paidRead = false;
    const gateway: ReconciliationGateway = {
      async subscriptionObject() {
        subscriptionReads += 1;
        return subscriptionReads === 1 ? stale : fresh;
      },
      async latestPaidInvoiceEvent() {
        paidRead = true;
        return undefined;
      },
    };
    const projector = new EventProcessor(
      database,
      catalog,
      "example-entitlements",
      { expectedApiVersion: "2026-06-24.dahlia" },
    );
    let webhookCommitted = false;
    const processor: ReconciliationProcessor = {
      async process(event): Promise<ProcessResult> {
        const candidate = event as Readonly<Record<string, unknown>>;
        if (!webhookCommitted && candidate["_remote_verified"] === true) {
          webhookCommitted = true;
          const webhookResult = await projector.process(
            subscriptionWebhook(
              "evt_ts_reconcile_status_refresh",
              RACE_PERIOD_START + 10,
              fresh,
            ),
          );
          expect(webhookResult.outcome).toBe("handled");
        }
        return projector.process(event);
      },
    };

    const result = await new ReconciliationService(
      database,
      processor,
      gateway,
    ).reconcileAccount(accountId);

    expect(result.outcome).toBe("handled");
    expect(subscriptionReads).toBe(2);
    expect(paidRead).toBe(false);
    const projected = await database.query<{
      readonly subscription_status: string;
      readonly cancel_at_period_end: boolean;
      readonly period_end_epoch: string;
    }>(
      `select subscription_status,cancel_at_period_end,
              extract(epoch from current_period_end)::bigint::text as period_end_epoch
         from billing_accounts where id=$1::uuid`,
      [accountId],
    );
    expect(projected.rows[0]).toEqual({
      subscription_status: "past_due",
      cancel_at_period_end: true,
      period_end_epoch: String(RACE_PERIOD_FRESH),
    });
  });

  test("a second status CAS loss stops without overwriting the newer webhook", async () => {
    const database = postgresDatabase();
    const subscriptionId = "sub_ts_reconcile_status_bounded";
    const customerId = "cus_ts_reconcile_status_bounded";
    const accountId = await account(database, subscriptionId);
    await database.query(
      `update billing_accounts set stripe_customer_id=$2,
         current_period_end=to_timestamp($3::bigint),
         entitlement_period_end=to_timestamp($3::bigint)
       where id=$1::uuid`,
      [accountId, customerId, RACE_PERIOD_STALE],
    );
    const stale = subscriptionSnapshot(accountId, subscriptionId, customerId, {
      status: "active",
      cancelAtPeriodEnd: false,
      periodEnd: RACE_PERIOD_STALE,
    });
    const firstCommitted = subscriptionSnapshot(
      accountId,
      subscriptionId,
      customerId,
      {
        status: "past_due",
        cancelAtPeriodEnd: true,
        periodEnd: RACE_PERIOD_FRESH,
      },
    );
    const latestCommitted = subscriptionSnapshot(
      accountId,
      subscriptionId,
      customerId,
      {
        status: "active",
        cancelAtPeriodEnd: false,
        periodEnd: RACE_PERIOD_LATEST,
      },
    );
    let subscriptionReads = 0;
    const gateway: ReconciliationGateway = {
      async subscriptionObject() {
        subscriptionReads += 1;
        return subscriptionReads === 1 ? stale : firstCommitted;
      },
      async latestPaidInvoiceEvent() {
        throw new Error(
          "paid Invoice lookup must not run after a lost status CAS",
        );
      },
    };
    const projector = new EventProcessor(
      database,
      catalog,
      "example-entitlements",
      { expectedApiVersion: "2026-06-24.dahlia" },
    );
    let interleaving = 0;
    const processor: ReconciliationProcessor = {
      async process(event): Promise<ProcessResult> {
        const candidate = event as Readonly<Record<string, unknown>>;
        if (candidate["_remote_verified"] === true && interleaving < 2) {
          const next = interleaving === 0 ? firstCommitted : latestCommitted;
          interleaving += 1;
          const webhookResult = await projector.process(
            subscriptionWebhook(
              `evt_ts_reconcile_status_bounded_${String(interleaving)}`,
              RACE_PERIOD_START + interleaving * 10,
              next,
            ),
          );
          expect(webhookResult.outcome).toBe("handled");
        }
        return projector.process(event);
      },
    };

    const result = await new ReconciliationService(
      database,
      processor,
      gateway,
    ).reconcileAccount(accountId);

    expect(result).toMatchObject({
      outcome: "ignored",
      reason: "older or weaker than the applied state",
      accountId,
    });
    expect(subscriptionReads).toBe(2);
    expect(interleaving).toBe(2);
    const projected = await database.query<{
      readonly subscription_status: string;
      readonly cancel_at_period_end: boolean;
      readonly period_end_epoch: string;
    }>(
      `select subscription_status,cancel_at_period_end,
              extract(epoch from current_period_end)::bigint::text as period_end_epoch
         from billing_accounts where id=$1::uuid`,
      [accountId],
    );
    expect(projected.rows[0]).toEqual({
      subscription_status: "active",
      cancel_at_period_end: false,
      period_end_epoch: String(RACE_PERIOD_LATEST),
    });
    const incident = await database.query<{
      readonly detail: Readonly<Record<string, unknown>>;
    }>(
      `select detail from billing_incidents
        where account_id=$1::uuid and kind='reconciliation_failed'
          and resolved_at is null`,
      [accountId],
    );
    expect(incident.rows[0]?.detail).toEqual({
      reason:
        "status projection did not commit: older or weaker than the applied state",
    });
  });

  test("cancellation CAS loss refetches and preserves a newer active webhook", async () => {
    const database = postgresDatabase();
    const subscriptionId = "sub_ts_reconcile_cancellation_refresh";
    const customerId = "cus_ts_reconcile_cancellation_refresh";
    const accountId = await account(database, subscriptionId);
    await database.query(
      `update billing_accounts set stripe_customer_id=$2,
         current_period_end=to_timestamp($3::bigint),
         entitlement_period_end=to_timestamp($3::bigint),
         credits_balance=300000000
       where id=$1::uuid`,
      [accountId, customerId, RACE_PERIOD_STALE],
    );
    const staleCancellation = subscriptionSnapshot(
      accountId,
      subscriptionId,
      customerId,
      {
        status: "canceled",
        cancelAtPeriodEnd: false,
        periodEnd: RACE_PERIOD_STALE,
      },
    );
    const freshActive = subscriptionSnapshot(
      accountId,
      subscriptionId,
      customerId,
      {
        status: "active",
        cancelAtPeriodEnd: false,
        periodEnd: RACE_PERIOD_FRESH,
      },
    );
    let subscriptionReads = 0;
    const gateway: ReconciliationGateway = {
      async subscriptionObject() {
        subscriptionReads += 1;
        return subscriptionReads === 1 ? staleCancellation : freshActive;
      },
      async latestPaidInvoiceEvent() {
        throw new Error(
          "paid Invoice lookup must not run after cancellation state drift",
        );
      },
    };
    const projector = new EventProcessor(
      database,
      catalog,
      "example-entitlements",
      { expectedApiVersion: "2026-06-24.dahlia" },
    );
    let webhookCommitted = false;
    const processor: ReconciliationProcessor = {
      async process(event): Promise<ProcessResult> {
        const candidate = event as Readonly<Record<string, unknown>>;
        if (!webhookCommitted && candidate["_remote_verified"] === true) {
          webhookCommitted = true;
          const webhookResult = await projector.process(
            subscriptionWebhook(
              "evt_ts_reconcile_cancellation_refresh",
              RACE_PERIOD_START + 10,
              freshActive,
            ),
          );
          expect(webhookResult.outcome).toBe("handled");
        }
        return projector.process(event);
      },
    };

    const result = await new ReconciliationService(
      database,
      processor,
      gateway,
    ).reconcileAccount(accountId);

    expect(result).toMatchObject({
      outcome: "ignored",
      reason: "remote subscription changed during reconciliation",
      accountId,
    });
    expect(subscriptionReads).toBe(2);
    expect(webhookCommitted).toBe(true);
    const projected = await database.query<{
      readonly stripe_subscription_id: string | null;
      readonly plan_key: string;
      readonly subscription_status: string;
      readonly cancel_at_period_end: boolean;
      readonly period_end_epoch: string;
      readonly credits_balance: string;
    }>(
      `select stripe_subscription_id,plan_key,subscription_status,
              cancel_at_period_end,credits_balance::text,
              extract(epoch from current_period_end)::bigint::text as period_end_epoch
         from billing_accounts where id=$1::uuid`,
      [accountId],
    );
    expect(projected.rows[0]).toEqual({
      stripe_subscription_id: subscriptionId,
      plan_key: "starter",
      subscription_status: "active",
      cancel_at_period_end: false,
      period_end_epoch: String(RACE_PERIOD_FRESH),
      credits_balance: "300000000",
    });
    const incident = await database.query<{
      readonly detail: Readonly<Record<string, unknown>>;
    }>(
      `select detail from billing_incidents
        where account_id=$1::uuid and kind='reconciliation_failed'
          and resolved_at is null`,
      [accountId],
    );
    expect(incident.rows[0]?.detail).toEqual({
      reason: "remote subscription changed during cancellation reconciliation",
    });
  });

  test("cancellation uses a privacy-preserving cross-language stable customer hash", async () => {
    const database = postgresDatabase();
    const subscriptionId = "sub_ts_reconcile_canceled";
    const accountId = await account(database, subscriptionId);
    const gateway = new FakeGateway(subscriptionId, "canceled");
    gateway.subscription = {
      ...gateway.subscription,
      customer: { id: "cus_private_value" },
      canceled_at: 1_800_001_234,
    };
    const processor = new RecordingProcessor();

    await new ReconciliationService(
      database,
      processor,
      gateway,
    ).reconcileAccount(accountId);

    const eventId = String(processor.events[0]?.["id"]);
    expect(eventId).toContain(
      customerFactFingerprint({ customer: "cus_private_value" }),
    );
    expect(eventId).not.toContain("cus_private_value");
    expect(processor.events[0]?.["created"]).toBe(1_800_001_234);
  });

  test("a committed duplicate is reconstructed as replayed", async () => {
    const database = postgresDatabase();
    const subscriptionId = "sub_ts_reconcile_duplicate";
    const accountId = await account(database, subscriptionId);
    const gateway = new FakeGateway(subscriptionId, "past_due");
    const processor: ReconciliationProcessor = {
      async process(raw): Promise<ProcessResult> {
        const event = raw as Record<string, unknown>;
        await database.query(
          `insert into stripe_webhook_events(
             id,event_type,livemode,payload,outcome,reason,processed_at
           ) values($1,$2,false,'{}'::jsonb,'handled','already done',now())`,
          [event["id"], event["type"]],
        );
        return { outcome: "duplicate", reason: "event id already committed" };
      },
    };

    const result = await new ReconciliationService(
      database,
      processor,
      gateway,
    ).reconcileAccount(accountId);

    expect(result).toMatchObject({
      outcome: "replayed",
      reason: "synthetic Event already committed a projection",
      accountId,
    });
  });

  test("remote contract failures fail closed and record identity-free reasons", async () => {
    const database = postgresDatabase();
    const subscriptionId = "sub_ts_reconcile_invalid";
    const accountId = await account(database, subscriptionId);
    const gateway = new FakeGateway(subscriptionId);
    gateway.subscription = { ...gateway.subscription, livemode: "false" };
    const processor = new RecordingProcessor();

    const result = await new ReconciliationService(
      database,
      processor,
      gateway,
    ).reconcileAccount(accountId);

    expect(result).toMatchObject({
      outcome: "ignored",
      reason: "Stripe returned an invalid subscription mode",
    });
    expect(processor.events).toHaveLength(0);
    const incident = await database.query<{
      readonly detail: Readonly<Record<string, unknown>>;
    }>("select detail from billing_incidents where account_id=$1::uuid", [
      accountId,
    ]);
    expect(incident.rows[0]?.detail).toEqual({
      reason: "Stripe returned an invalid subscription mode",
    });
  });

  test("network exception details never persist secret-bearing messages", async () => {
    const database = postgresDatabase();
    const subscriptionId = "sub_ts_reconcile_failure";
    const accountId = await account(database, subscriptionId);
    const gateway = new FakeGateway(subscriptionId);
    gateway.subscriptionFailure = new Error("sk_test_must_never_be_persisted");

    await expect(
      new ReconciliationService(
        database,
        new RecordingProcessor(),
        gateway,
      ).reconcileAccount(accountId),
    ).rejects.toThrow("must_never_be_persisted");
    const incident = await database.query<{
      readonly detail: Readonly<Record<string, unknown>>;
    }>("select detail from billing_incidents where account_id=$1::uuid", [
      accountId,
    ]);
    expect(incident.rows[0]?.detail).toEqual({
      reason: "subscription retrieval failed: Error",
    });
    expect(JSON.stringify(incident.rows[0])).not.toContain("sk_test_");
  });

  test("candidate rotation is bounded and excludes accounts from the current pass", async () => {
    const database = postgresDatabase();
    const first = await account(database, "sub_ts_candidate_a", "past_due");
    const second = await account(database, "sub_ts_candidate_b", "past_due");
    const service = new ReconciliationService(
      database,
      new RecordingProcessor(),
      new FakeGateway("unused"),
    );
    const candidates = await service.candidates(
      "2026-08-29T12:00:00.123456+00:00",
      {
        attemptedBefore: "2026-08-29T12:00:00.123456+00:00",
        limit: 1,
        excludeAccountIds: new Set([first]),
      },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe(second);
    await expect(
      service.candidates("2026-08-29T12:00:00", { limit: 1 }),
    ).rejects.toThrow("timezone-aware");
    await expect(service.candidates(undefined, { limit: 0 })).rejects.toThrow(
      "positive integer",
    );
  });
});
