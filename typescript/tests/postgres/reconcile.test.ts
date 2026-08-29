import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import type { Database } from "../../src/database.js";
import {
  customerFactFingerprint,
  ReconciliationService,
  type ReconciliationGateway,
  type ReconciliationProcessor,
} from "../../src/reconcile.js";
import type { ProcessResult } from "../../src/types.js";
import { postgresDatabase } from "../support/postgres-setup.js";

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
