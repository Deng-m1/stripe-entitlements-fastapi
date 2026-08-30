import { fileURLToPath } from "node:url";

import type { QueryResultRow } from "pg";
import { beforeAll, describe, expect, test } from "vitest";

import { PlanCatalog } from "../../src/catalog.js";
import type { Database } from "../../src/database.js";
import {
  PlanChangeBusyError,
  PlanChangeConflictError,
  PlanChangeCoordinator,
} from "../../src/plan-changes.js";
import {
  FakePlanGateway,
  PERIOD_END_EPOCH,
  seedPaidAccount,
} from "./plan-change-support.js";
import { postgresDatabase } from "../support/postgres-setup.js";

const CATALOG_PATH = fileURLToPath(
  new URL("../../../plans.toml", import.meta.url),
);

let catalog: PlanCatalog;
let database: Database;

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let settle = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

beforeAll(async () => {
  catalog = await PlanCatalog.fromToml(CATALOG_PATH);
  database = postgresDatabase();
});

describe("plan-change leases, crashes, and webhook races", () => {
  test("commits finish and incident resolution atomically, then retries safely", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    const service = new PlanChangeCoordinator(database, catalog, gateway);
    const preview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      "atomic-finish",
    );
    await database.query(
      `insert into billing_incidents(
         kind,dedupe_key,account_id,invoice_id,detail)
       values('unbound_plan_change_payment_failed','in_fake_plan_change',
              $1::uuid,'in_fake_plan_change','{}'::jsonb)`,
      [accountId],
    );
    await database.query(
      `create or replace function fail_plan_change_incident_resolution()
         returns trigger language plpgsql as $$
         begin
           raise exception 'injected incident resolution failure';
         end
         $$`,
    );
    await database.query(
      `create trigger fail_plan_change_incident_resolution_trigger
         before update on billing_incidents
         for each row when (old.kind='unbound_plan_change_payment_failed')
         execute function fail_plan_change_incident_resolution()`,
    );

    try {
      await expect(
        service.confirm(accountId, preview.changeId),
      ).rejects.toThrow(/injected incident resolution failure/u);
    } finally {
      await database.query(
        `drop trigger if exists fail_plan_change_incident_resolution_trigger
           on billing_incidents`,
      );
      await database.query(
        "drop function if exists fail_plan_change_incident_resolution()",
      );
    }

    const failedFinish = await database.query<
      {
        readonly status: string;
        readonly settlement_invoice_id: string | null;
        readonly lease_token: string | null;
        readonly last_error: string | null;
        readonly unresolved: string;
      } & QueryResultRow
    >(
      `select p.status,p.settlement_invoice_id,p.lease_token,p.last_error,
              (select count(*) from billing_incidents
                where kind='unbound_plan_change_payment_failed'
                  and invoice_id='in_fake_plan_change'
                  and resolved_at is null)::text as unresolved
         from billing_plan_changes p where p.id=$1::uuid`,
      [preview.changeId],
    );
    expect(failedFinish.rows[0]).toMatchObject({
      status: "applying",
      settlement_invoice_id: null,
      lease_token: null,
      unresolved: "1",
    });
    expect(failedFinish.rows[0]?.last_error).toMatch(/Error$/u);

    const recovered = await service.confirm(accountId, preview.changeId);
    expect(recovered.status).toBe("applied");
    expect(gateway.applyCalls).toEqual([
      `plan-change:${preview.changeId}:apply`,
      `plan-change:${preview.changeId}:apply`,
    ]);
    expect(gateway.remoteApplyMutations).toBe(1);
    const resolved = await database.query<
      { readonly resolved: boolean } & QueryResultRow
    >(
      `select resolved_at is not null as resolved from billing_incidents
        where kind='unbound_plan_change_payment_failed'
          and invoice_id='in_fake_plan_change'`,
    );
    expect(resolved.rows[0]?.resolved).toBe(true);
  });

  test("lets a failed funding webhook win before confirm finishes", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    const service = new PlanChangeCoordinator(database, catalog, gateway);
    const preview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      "webhook-failure-wins",
    );
    gateway.beforeApplyReturn = async () => {
      await database.query(
        `update billing_plan_changes set
           status='failed',settlement_invoice_id=$2,
           last_error='invoice_funding_closed',
           lease_token=null,lease_expires_at=null,updated_at=now()
         where id=$1::uuid`,
        [preview.changeId, gateway.settlementInvoiceId],
      );
    };

    await expect(service.confirm(accountId, preview.changeId)).rejects.toThrow(
      /could not fund/u,
    );
    const state = await database.query<
      {
        readonly status: string;
        readonly settlement_invoice_id: string | null;
      } & QueryResultRow
    >(
      "select status,settlement_invoice_id from billing_plan_changes where id=$1::uuid",
      [preview.changeId],
    );
    expect(state.rows[0]).toEqual({
      status: "failed",
      settlement_invoice_id: "in_fake_plan_change",
    });
  });

  test("lets a completed funding webhook win before confirm finishes", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    const service = new PlanChangeCoordinator(database, catalog, gateway);
    const preview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      "webhook-success-wins",
    );
    gateway.beforeApplyReturn = async () => {
      await database.query(
        `update billing_plan_changes set
           status='completed',settlement_invoice_id=$2,
           completed_at=clock_timestamp(),lease_token=null,
           lease_expires_at=null,updated_at=now()
         where id=$1::uuid`,
        [preview.changeId, gateway.settlementInvoiceId],
      );
    };

    const result = await service.confirm(accountId, preview.changeId);
    expect(result.status).toBe("completed");
    const state = await database.query<
      {
        readonly status: string;
        readonly settlement_invoice_id: string | null;
      } & QueryResultRow
    >(
      "select status,settlement_invoice_id from billing_plan_changes where id=$1::uuid",
      [preview.changeId],
    );
    expect(state.rows[0]).toEqual({
      status: "completed",
      settlement_invoice_id: "in_fake_plan_change",
    });
  });

  test("aborts an account mutation during preview and records a durable incident", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    gateway.beforePreviewReturn = async () => {
      await database.query(
        "update billing_accounts set grant_epoch=grant_epoch+1 where id=$1::uuid",
        [accountId],
      );
    };
    const service = new PlanChangeCoordinator(database, catalog, gateway);

    await expect(
      service.previewRemote(accountId, "pro", "month", "account-race"),
    ).rejects.toBeInstanceOf(PlanChangeConflictError);
    const incidents = await database.query<
      { readonly count: string } & QueryResultRow
    >(
      "select count(*)::text as count from billing_incidents where kind='plan_change_account_race'",
    );
    expect(incidents.rows[0]?.count).toBe("1");
  });

  test("records a durable account race after Stripe has already applied", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    const service = new PlanChangeCoordinator(database, catalog, gateway);
    const preview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      "post-apply-account-race",
    );
    gateway.beforeApplyReturn = async () => {
      await database.query(
        "update billing_accounts set grant_epoch=grant_epoch+1 where id=$1::uuid",
        [accountId],
      );
    };

    await expect(service.confirm(accountId, preview.changeId)).rejects.toThrow(
      /billing account changed during the Stripe call/u,
    );
    expect(gateway.remoteApplyMutations).toBe(1);
    const state = await database.query<
      {
        readonly status: string;
        readonly remote_started_at: string | null;
        readonly lease_token: string | null;
        readonly incidents: string;
      } & QueryResultRow
    >(
      `select p.status,p.remote_started_at,p.lease_token,
              (select count(*) from billing_incidents
                where kind='plan_change_account_race'
                  and dedupe_key=p.id::text)::text as incidents
         from billing_plan_changes p where p.id=$1::uuid`,
      [preview.changeId],
    );
    expect(state.rows[0]).toMatchObject({
      status: "applying",
      lease_token: null,
      incidents: "1",
    });
    expect(state.rows[0]?.remote_started_at).not.toBeNull();
  });

  test("rejects a prorated funding-lineage change before remote apply", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    gateway.amountDue = 1_500n;
    gateway.prorationCredit = 950n;
    gateway.sourceProrationAmount = 950n;
    gateway.targetProrationAmount = 2_450n;
    const service = new PlanChangeCoordinator(database, catalog, gateway, {
      transitionPolicy: "prorated_delta",
    });
    const preview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      "funding-lineage-race",
    );
    await database.query(
      `insert into credit_ledger(
         account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
         stripe_invoice_id,grant_slot)
       values($1::uuid,1,1,1,'upgrade_delta_grant',1,
              'in_newer_funding_lineage',2)`,
      [accountId],
    );

    await expect(service.confirm(accountId, preview.changeId)).rejects.toThrow(
      /funding lineage changed/u,
    );
    expect(gateway.applyCalls).toEqual([]);
    const state = await database.query<
      {
        readonly status: string;
        readonly remote_started_at: string | null;
      } & QueryResultRow
    >(
      "select status,remote_started_at from billing_plan_changes where id=$1::uuid",
      [preview.changeId],
    );
    expect(state.rows[0]).toEqual({
      status: "previewed",
      remote_started_at: null,
    });
  });

  test("returns busy for a same-key quote while its lease is live", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    const started = deferred();
    const release = deferred();
    gateway.beforePreviewReturn = async () => {
      started.resolve();
      await release.promise;
    };
    const service = new PlanChangeCoordinator(database, catalog, gateway);
    const first = service.previewRemote(
      accountId,
      "pro",
      "month",
      "concurrent-same",
    );
    await started.promise;

    try {
      await expect(
        service.previewRemote(accountId, "pro", "month", "concurrent-same"),
      ).rejects.toThrow(/still being calculated/u);
    } finally {
      release.resolve();
    }

    await expect(first).resolves.toMatchObject({ status: "previewed" });
    expect(gateway.previewCalls).toBe(1);
  });

  test("allows only one of two different concurrent intents", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const service = new PlanChangeCoordinator(
      database,
      catalog,
      new FakePlanGateway(),
    );
    const attempt = async (target: string, key: string): Promise<string> => {
      try {
        return (await service.previewRemote(accountId, target, "month", key))
          .changeId;
      } catch (error) {
        if (error instanceof PlanChangeBusyError) {
          return "busy";
        }
        throw error;
      }
    };

    const results = await Promise.all([
      attempt("pro", "concurrent-a"),
      attempt("ultra", "concurrent-b"),
    ]);

    expect(results.filter((result) => result === "busy")).toHaveLength(1);
    const pending = await database.query<
      { readonly count: string } & QueryResultRow
    >(
      `select count(*)::text as count from billing_plan_changes where status in (
         'reserved','previewed','applying','scheduled','applied','requires_action')`,
    );
    expect(pending.rows[0]?.count).toBe("1");
  });

  test("reacquires an expired preview lease without exposing partial state", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    const started = deferred();
    const release = deferred();
    gateway.beforePreviewReturn = async () => {
      started.resolve();
      await release.promise;
    };
    const service = new PlanChangeCoordinator(database, catalog, gateway, {
      leaseTtlSeconds: 1,
    });
    const crashedWorker = service.previewRemote(
      accountId,
      "pro",
      "month",
      "expired-lease",
    );
    await started.promise;
    await database.query(
      `update billing_plan_changes
          set lease_expires_at=now()-interval '1 second'
        where account_id=$1::uuid and idempotency_key='expired-lease'`,
      [accountId],
    );
    gateway.beforePreviewReturn = undefined;

    const recovered = await service.previewRemote(
      accountId,
      "pro",
      "month",
      "expired-lease",
    );
    release.resolve();
    const staleResult = await crashedWorker;

    expect(recovered.status).toBe("previewed");
    expect(staleResult.changeId).toBe(recovered.changeId);
    expect(staleResult.status).toBe("previewed");
    expect(gateway.previewCalls).toBe(2);
  });

  test("uses one remote idempotency key after unknown success and local response loss", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    const service = new PlanChangeCoordinator(database, catalog, gateway);
    const preview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      "unknown-apply",
    );
    await database.query(
      `create or replace function fail_first_plan_change_finish()
         returns trigger language plpgsql as $$
         begin
           if new.settlement_invoice_id is not null
              and old.settlement_invoice_id is null then
             raise exception 'simulated response loss after Stripe apply';
           end if;
           return new;
         end
         $$`,
    );
    await database.query(
      `create trigger fail_first_plan_change_finish_trigger
         before update on billing_plan_changes
         for each row execute function fail_first_plan_change_finish()`,
    );

    try {
      await expect(
        service.confirm(accountId, preview.changeId),
      ).rejects.toThrow(/response loss after Stripe apply/u);
    } finally {
      await database.query(
        `drop trigger if exists fail_first_plan_change_finish_trigger
           on billing_plan_changes`,
      );
      await database.query(
        "drop function if exists fail_first_plan_change_finish()",
      );
    }

    gateway.currentLookup = "ent_pro_month";
    gateway.remotePeriodEnd = PERIOD_END_EPOCH + 30n * 86_400n;
    await database.query(
      `update billing_plan_changes set
         preview_expires_at=now()-interval '1 hour',
         lease_expires_at=now()-interval '1 second'
       where id=$1::uuid`,
      [preview.changeId],
    );

    const recovered = await service.confirm(accountId, preview.changeId);
    expect(recovered.status).toBe("applied");
    expect(gateway.applyCalls).toEqual([
      `plan-change:${preview.changeId}:apply`,
      `plan-change:${preview.changeId}:apply`,
    ]);
    expect(gateway.remoteApplyMutations).toBe(1);
    const state = await database.query<
      {
        readonly status: string;
        readonly remote_started_at: string | null;
      } & QueryResultRow
    >(
      "select status,remote_started_at from billing_plan_changes where id=$1::uuid",
      [preview.changeId],
    );
    expect(state.rows[0]?.status).toBe("applied");
    expect(state.rows[0]?.remote_started_at).not.toBeNull();
  });

  test("uses one schedule idempotency key after an unknown period-end result", async () => {
    const accountId = await seedPaidAccount(database, catalog, {
      plan: "pro",
      interval: "year",
    });
    const gateway = new FakePlanGateway("ent_pro_year");
    const service = new PlanChangeCoordinator(database, catalog, gateway);
    const preview = await service.previewRemote(
      accountId,
      "ultra",
      "month",
      "unknown-schedule",
    );
    await database.query(
      `create or replace function fail_first_plan_change_schedule_finish()
         returns trigger language plpgsql as $$
         begin
           if new.stripe_schedule_id is not null
              and old.stripe_schedule_id is null then
             raise exception 'simulated response loss after Stripe schedule';
           end if;
           return new;
         end
         $$`,
    );
    await database.query(
      `create trigger fail_first_plan_change_schedule_finish_trigger
         before update on billing_plan_changes
         for each row execute function fail_first_plan_change_schedule_finish()`,
    );

    try {
      await expect(
        service.confirm(accountId, preview.changeId),
      ).rejects.toThrow(/response loss after Stripe schedule/u);
    } finally {
      await database.query(
        `drop trigger if exists fail_first_plan_change_schedule_finish_trigger
           on billing_plan_changes`,
      );
      await database.query(
        "drop function if exists fail_first_plan_change_schedule_finish()",
      );
    }

    gateway.remoteScheduleId = "sub_sched_test";
    const recovered = await service.confirm(accountId, preview.changeId);
    expect(recovered.status).toBe("scheduled");
    expect(gateway.scheduleCalls).toEqual([
      `plan-change:${preview.changeId}:schedule`,
      `plan-change:${preview.changeId}:schedule`,
    ]);
    expect(gateway.remoteScheduleMutations).toBe(1);
  });

  test("refuses to bind a different settlement Invoice during a webhook race", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    const service = new PlanChangeCoordinator(database, catalog, gateway);
    const preview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      "settlement-cas",
    );
    gateway.beforeApplyReturn = async () => {
      await database.query(
        `update billing_plan_changes set
           status='completed',settlement_invoice_id='in_webhook_other',
           completed_at=clock_timestamp(),lease_token=null,
           lease_expires_at=null,updated_at=now()
         where id=$1::uuid`,
        [preview.changeId],
      );
    };

    await expect(service.confirm(accountId, preview.changeId)).rejects.toThrow(
      /different settlement Invoice/u,
    );
    const state = await database.query<
      {
        readonly status: string;
        readonly settlement_invoice_id: string | null;
      } & QueryResultRow
    >(
      "select status,settlement_invoice_id from billing_plan_changes where id=$1::uuid",
      [preview.changeId],
    );
    expect(state.rows[0]).toEqual({
      status: "completed",
      settlement_invoice_id: "in_webhook_other",
    });
  });

  test("stops retrying an unknown remote result after 23 hours", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    const service = new PlanChangeCoordinator(database, catalog, gateway);
    const preview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      "old-unknown",
    );
    await database.query(
      `update billing_plan_changes set
         status='applying',remote_started_at=now()-interval '24 hours',
         preview_expires_at=now()-interval '23 hours',
         lease_token=null,lease_expires_at=null
       where id=$1::uuid`,
      [preview.changeId],
    );

    await expect(service.confirm(accountId, preview.changeId)).rejects.toThrow(
      /too old to retry safely/u,
    );
    expect(gateway.applyCalls).toEqual([]);
    const state = await database.query<
      { readonly status: string } & QueryResultRow
    >("select status from billing_plan_changes where id=$1::uuid", [
      preview.changeId,
    ]);
    expect(state.rows[0]?.status).toBe("applying");
  });

  test("single-flights many simultaneous confirmation workers", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    const started = deferred();
    const release = deferred();
    gateway.beforeApplyReturn = async () => {
      started.resolve();
      await release.promise;
    };
    const service = new PlanChangeCoordinator(database, catalog, gateway);
    const preview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      "confirm-race",
    );
    const winner = service.confirm(accountId, preview.changeId);
    await started.promise;

    const observers = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.confirm(accountId, preview.changeId),
      ),
    );
    expect(observers.every((result) => result.status === "applying")).toBe(
      true,
    );
    release.resolve();
    await expect(winner).resolves.toMatchObject({ status: "applied" });
    expect(gateway.applyCalls).toHaveLength(1);
    expect(gateway.remoteApplyMutations).toBe(1);
  });

  test("expires requires-action work before admitting a new intent", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    gateway.pending = true;
    const service = new PlanChangeCoordinator(database, catalog, gateway);
    const preview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      "expired-sca",
    );
    await service.confirm(accountId, preview.changeId);
    await database.query(
      `update billing_plan_changes
          set remote_pending_expires_at=now()-interval '1 second'
        where id=$1::uuid`,
      [preview.changeId],
    );
    gateway.pending = false;

    const replacement = await service.previewRemote(
      accountId,
      "ultra",
      "month",
      "after-expired-sca",
    );
    expect(replacement.status).toBe("previewed");
    const old = await database.query<
      {
        readonly status: string;
        readonly last_error: string | null;
      } & QueryResultRow
    >("select status,last_error from billing_plan_changes where id=$1::uuid", [
      preview.changeId,
    ]);
    expect(old.rows[0]).toEqual({
      status: "failed",
      last_error: "pending_update_expired",
    });
  });
});
