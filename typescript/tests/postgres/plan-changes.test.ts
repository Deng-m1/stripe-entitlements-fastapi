import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { QueryResultRow } from "pg";
import { beforeAll, describe, expect, test } from "vitest";

import { PlanCatalog } from "../../src/catalog.js";
import type { Database } from "../../src/database.js";
import {
  PlanChangeBusyError,
  PlanChangeConflictError,
  PlanChangeCoordinator,
  PlanChangeUnavailableError,
} from "../../src/plan-changes.js";
import type { TransitionPolicy } from "../../src/types.js";
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

beforeAll(async () => {
  catalog = await PlanCatalog.fromToml(CATALOG_PATH);
  database = postgresDatabase();
});

describe("plan-change intent and full-period-reset policy", () => {
  test.each(["", " padded ", "line\nbreak", "x".repeat(201), "💳".repeat(51)])(
    "rejects a malformed idempotency key %#",
    async (key) => {
      const accountId = await seedPaidAccount(database, catalog);
      const service = new PlanChangeCoordinator(
        database,
        catalog,
        new FakePlanGateway(),
      );

      await expect(
        service.previewRemote(accountId, "pro", "month", key),
      ).rejects.toThrow(/1 to 200/u);
    },
  );

  test("validates lease and policy configuration at runtime", () => {
    const gateway = new FakePlanGateway();
    expect(
      () =>
        new PlanChangeCoordinator(database, catalog, gateway, {
          leaseTtlSeconds: 0,
        }),
    ).toThrow(/positive/u);
    expect(
      () =>
        new PlanChangeCoordinator(database, catalog, gateway, {
          transitionPolicy: "unsupported" as TransitionPolicy,
        }),
    ).toThrow(/unknown transition policy/u);
  });

  test("retires a legacy reserved preview before any gateway I/O", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const changeId = randomUUID();
    const requestKey = `plan-change:${changeId}`;
    await database.query(
      `insert into billing_plan_changes(
         id,account_id,idempotency_key,stripe_subscription_id,
         from_plan_key,from_interval,target_plan_key,target_interval,
         effective_mode,status,stripe_request_key,expected_grant_epoch,
         expected_entitlement_period_end,expected_subscription_status,
         expected_cancel_at_period_end,expected_entitlement_revoked,
         request_snapshot_version)
       select $2::uuid,id,$3,stripe_subscription_id,plan_key,plan_interval,
              'pro','month','immediate','reserved',$4,grant_epoch,
              entitlement_period_end,subscription_status,cancel_at_period_end,
              entitlement_revoked,null
         from billing_accounts where id=$1::uuid`,
      [accountId, changeId, "legacy-preview", requestKey],
    );
    const gateway = new FakePlanGateway();
    const service = new PlanChangeCoordinator(database, catalog, gateway);

    await expect(
      service.previewRemote(accountId, "pro", "month", "legacy-preview"),
    ).rejects.toThrow(/new Idempotency-Key/u);

    const retired = await database.query<
      {
        readonly status: string;
        readonly last_error: string | null;
        readonly request_snapshot_version: number | null;
        readonly stripe_request_snapshot: unknown;
        readonly remote_started_at: string | null;
      } & QueryResultRow
    >(
      `select status,last_error,request_snapshot_version,
              stripe_request_snapshot,remote_started_at
         from billing_plan_changes where id=$1::uuid`,
      [changeId],
    );
    expect(gateway.prepareCalls).toBe(0);
    expect(gateway.previewCalls).toBe(0);
    expect(retired.rows[0]).toEqual({
      status: "failed",
      last_error: "missing_remote_request_snapshot",
      request_snapshot_version: null,
      stripe_request_snapshot: null,
      remote_started_at: null,
    });
  });

  test("previews, confirms, and replays one full-price remote mutation", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    const service = new PlanChangeCoordinator(database, catalog, gateway);

    const preview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      "upgrade-1",
    );
    const duplicatePreview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      "upgrade-1",
    );
    await database.query(
      `insert into billing_incidents(
         kind,dedupe_key,account_id,invoice_id,detail)
       values('unbound_plan_change_payment_failed','in_fake_plan_change',
              $1::uuid,'in_fake_plan_change','{}'::jsonb)`,
      [accountId],
    );

    expect(duplicatePreview.changeId).toBe(preview.changeId);
    expect(preview.estimatedAmountDue).toBe(4_900n);
    expect(preview.estimatedCreditApplied).toBe(0n);
    expect(preview.decision.timing).toBe("immediate");

    const confirmed = await service.confirm(accountId, preview.changeId);
    const duplicateConfirm = await service.confirm(accountId, preview.changeId);

    expect(confirmed.status).toBe("applied");
    expect(duplicateConfirm).toMatchObject({
      status: "applied",
      replayed: true,
    });
    expect(gateway.previewCalls).toBe(1);
    expect(gateway.applyCalls).toEqual([
      `plan-change:${preview.changeId}:apply`,
    ]);
    expect(gateway.remoteApplyMutations).toBe(1);

    const state = await database.query<
      {
        readonly settlement_invoice_id: string | null;
        readonly incident_resolved: boolean;
      } & QueryResultRow
    >(
      `select p.settlement_invoice_id,
              coalesce((select resolved_at is not null from billing_incidents
                         where kind='unbound_plan_change_payment_failed'
                           and invoice_id='in_fake_plan_change'),false)
                as incident_resolved
         from billing_plan_changes p where p.id=$1::uuid`,
      [preview.changeId],
    );
    expect(state.rows[0]).toEqual({
      settlement_invoice_id: "in_fake_plan_change",
      incident_resolved: true,
    });
  });

  test("rejects a malformed frozen request before any confirm gateway I/O", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    const service = new PlanChangeCoordinator(database, catalog, gateway);
    const preview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      "malformed-frozen-plan-change",
    );
    const callsBeforeConfirm = {
      prepare: gateway.prepareCalls,
      preview: gateway.previewCalls,
      apply: gateway.applyCalls.length,
      schedule: gateway.scheduleCalls.length,
    };
    await database.query(
      `update billing_plan_changes
          set request_snapshot_version=1,stripe_request_snapshot='{}'::jsonb
        where id=$1::uuid`,
      [preview.changeId],
    );

    await expect(service.confirm(accountId, preview.changeId)).rejects.toThrow(
      new PlanChangeUnavailableError(
        "the persisted plan-change request snapshot is invalid; operator reconciliation is required",
      ),
    );
    expect({
      prepare: gateway.prepareCalls,
      preview: gateway.previewCalls,
      apply: gateway.applyCalls.length,
      schedule: gateway.scheduleCalls.length,
    }).toEqual(callsBeforeConfirm);
    expect(gateway.remoteApplyMutations).toBe(0);
    expect(gateway.remoteScheduleMutations).toBe(0);
  });

  test("returns SCA recovery data without persisting the client secret", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    gateway.pending = true;
    const service = new PlanChangeCoordinator(database, catalog, gateway);
    const preview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      "sca-1",
    );

    const result = await service.confirm(accountId, preview.changeId);

    expect(result).toMatchObject({
      status: "requires_action",
      recoveryUrl: "https://invoice.test/recover",
      clientSecret: "ephemeral-client-secret",
    });
    const stored = await database.query(
      "select * from billing_plan_changes where id=$1::uuid",
      [result.changeId],
    );
    expect(JSON.stringify(stored.rows[0])).not.toContain(
      "ephemeral-client-secret",
    );
  });

  test("schedules annual changes and blocks a second durable intent", async () => {
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
      "defer-1",
    );

    expect(preview.decision.timing).toBe("period_end");
    await expect(
      service.previewRemote(accountId, "starter", "month", "other-request"),
    ).rejects.toBeInstanceOf(PlanChangeBusyError);

    const result = await service.confirm(accountId, preview.changeId);
    expect(result.status).toBe("scheduled");
    const effective = await database.query<
      { readonly epoch: string } & QueryResultRow
    >("select extract(epoch from $1::timestamptz)::bigint as epoch", [
      result.effectiveAt,
    ]);
    expect(effective.rows[0]?.epoch).toBe(PERIOD_END_EPOCH.toString());
    expect(gateway.applyCalls).toEqual([]);
    expect(gateway.scheduleCalls).toEqual([
      `plan-change:${preview.changeId}:schedule`,
    ]);
  });

  test.each([
    { label: "cross-invoice credit", prorationCredit: 1n },
    { label: "underfunded total", amountDue: 1n },
    { label: "customer balance", customerBalanceCredit: 1n },
    { label: "tax", taxAmount: 1n },
    { label: "discount", discountAmount: 1n },
    { label: "unsafe invoice shape", safeShape: false },
    { label: "currency drift", estimateCurrency: "eur" },
  ])("defers an unsafe full-price preview: $label", async (override) => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    Object.assign(gateway, override);
    const service = new PlanChangeCoordinator(database, catalog, gateway);

    const preview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      `unsafe-${override.label}`,
    );
    const confirmed = await service.confirm(accountId, preview.changeId);

    expect(preview.decision.timing).toBe("period_end");
    expect(confirmed.status).toBe("scheduled");
    expect(gateway.applyCalls).toEqual([]);
    expect(gateway.scheduleCalls).toHaveLength(1);
  });

  test("expires an idle preview and permanently retires its intent key", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    const service = new PlanChangeCoordinator(database, catalog, gateway);
    const preview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      "expired-preview",
    );
    await database.query(
      `update billing_plan_changes
          set preview_expires_at=now()-interval '1 second'
        where id=$1::uuid`,
      [preview.changeId],
    );

    await expect(service.confirm(accountId, preview.changeId)).rejects.toThrow(
      /preview expired/u,
    );
    await expect(
      service.previewRemote(accountId, "pro", "month", "expired-preview"),
    ).rejects.toThrow(/no longer reusable/u);
    const state = await database.query<
      {
        readonly status: string;
        readonly last_error: string | null;
      } & QueryResultRow
    >("select status,last_error from billing_plan_changes where id=$1::uuid", [
      preview.changeId,
    ]);
    expect(state.rows[0]).toEqual({
      status: "failed",
      last_error: "preview_expired",
    });
    expect(gateway.applyCalls).toEqual([]);
  });

  test("detects remote period drift before starting the Stripe mutation", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    const service = new PlanChangeCoordinator(database, catalog, gateway);
    const preview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      "period-drift",
    );
    gateway.remotePeriodEnd = PERIOD_END_EPOCH + 31n * 86_400n;

    await expect(service.confirm(accountId, preview.changeId)).rejects.toThrow(
      /billing period drifted/u,
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

  test("blocks an unrelated remote pending update before previewing a charge", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    gateway.observedPending = true;
    const service = new PlanChangeCoordinator(database, catalog, gateway);

    await expect(
      service.previewRemote(accountId, "pro", "month", "remote-pending"),
    ).rejects.toThrow(/unrelated pending change/u);
    expect(gateway.previewCalls).toBe(0);
    expect(gateway.applyCalls).toEqual([]);
  });

  test("rejects an account with pending cancellation before a gateway call", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    await database.query(
      "update billing_accounts set cancel_at_period_end=true where id=$1::uuid",
      [accountId],
    );
    const gateway = new FakePlanGateway();
    const service = new PlanChangeCoordinator(database, catalog, gateway);

    await expect(
      service.previewRemote(accountId, "pro", "month", "cancel-pending"),
    ).rejects.toThrow(/pending subscription cancellation/u);
    expect(gateway.prepareCalls).toBe(0);
    expect(gateway.previewCalls).toBe(0);
  });

  test("binds one idempotency key to one immutable target", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const service = new PlanChangeCoordinator(
      database,
      catalog,
      new FakePlanGateway(),
    );
    await service.previewRemote(accountId, "pro", "month", "bound-target");

    await expect(
      service.previewRemote(accountId, "ultra", "month", "bound-target"),
    ).rejects.toBeInstanceOf(PlanChangeConflictError);
  });

  test("completes a no-op without contacting Stripe", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = new FakePlanGateway();
    const service = new PlanChangeCoordinator(database, catalog, gateway);

    const result = await service.previewRemote(
      accountId,
      "starter",
      "month",
      "no-op",
    );

    expect(result).toMatchObject({
      status: "completed",
      decision: { timing: "noop" },
    });
    expect(gateway.prepareCalls).toBe(0);
  });

  test("full-period reset permits a same-tier month-to-year replacement", async () => {
    const accountId = await seedPaidAccount(database, catalog, { plan: "pro" });
    const gateway = new FakePlanGateway("ent_pro_month");
    gateway.amountDue = 35_300n;
    const service = new PlanChangeCoordinator(database, catalog, gateway);

    const preview = await service.previewRemote(
      accountId,
      "pro",
      "year",
      "month-to-year",
    );
    const confirmed = await service.confirm(accountId, preview.changeId);

    expect(preview.decision.timing).toBe("immediate");
    expect(preview.estimatedAmountDue).toBe(35_300n);
    expect(confirmed.status).toBe("applied");
  });

  test("requires an active paid subscription", async () => {
    const accountId = await database.createAccount("v1:user:free-plan-change");
    const service = new PlanChangeCoordinator(
      database,
      catalog,
      new FakePlanGateway(),
    );

    await expect(
      service.previewRemote(accountId, "pro", "month", "free-account"),
    ).rejects.toBeInstanceOf(PlanChangeUnavailableError);
  });
});

describe("prorated-delta policy", () => {
  function safeDeltaGateway(): FakePlanGateway {
    const gateway = new FakePlanGateway();
    gateway.amountDue = 1_500n;
    gateway.prorationCredit = 950n;
    gateway.sourceProrationAmount = 950n;
    gateway.targetProrationAmount = 2_450n;
    return gateway;
  }

  test("persists and reuses one source-invoice settlement contract", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = safeDeltaGateway();
    const service = new PlanChangeCoordinator(database, catalog, gateway, {
      transitionPolicy: "prorated_delta",
    });
    const before = await database.query<
      { readonly epoch: string } & QueryResultRow
    >("select extract(epoch from now())::bigint as epoch");

    const preview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      "delta-1",
    );
    const after = await database.query<
      { readonly epoch: string } & QueryResultRow
    >("select extract(epoch from now())::bigint as epoch");

    expect(preview).toMatchObject({
      status: "previewed",
      transitionPolicy: "prorated_delta",
      entitlementCreditDelta: 700_000_000n,
      estimatedAmountDue: 1_500n,
      estimatedCreditApplied: 950n,
      decision: { timing: "immediate" },
    });
    expect(gateway.previewPolicy).toBe("prorated_delta");
    expect(gateway.previewProrationDate).toBeTypeOf("bigint");
    expect(gateway.previewProrationDate).toBeGreaterThanOrEqual(
      BigInt(before.rows[0]?.epoch ?? "0"),
    );
    expect(gateway.previewProrationDate).toBeLessThanOrEqual(
      BigInt(after.rows[0]?.epoch ?? "0"),
    );

    const confirmed = await service.confirm(accountId, preview.changeId);
    expect(confirmed.status).toBe("applied");
    expect(gateway.applyPolicy).toBe("prorated_delta");
    expect(gateway.applyProrationDate).toBe(gateway.previewProrationDate);

    const state = await database.query<
      {
        readonly expected_source_invoice_id: string | null;
        readonly expected_credit_delta: string | null;
        readonly proration_date: string | null;
        readonly settlement_invoice_id: string | null;
      } & QueryResultRow
    >(
      `select expected_source_invoice_id,expected_credit_delta,
              proration_date,settlement_invoice_id
         from billing_plan_changes where id=$1::uuid`,
      [preview.changeId],
    );
    expect(state.rows[0]).toEqual({
      expected_source_invoice_id: `in_seed_${accountId}`,
      expected_credit_delta: "700000000",
      proration_date: gateway.previewProrationDate?.toString() ?? null,
      settlement_invoice_id: "in_fake_plan_change",
    });
  });

  test.each([
    { label: "tax", taxAmount: 1n },
    { label: "discount", discountAmount: 1n },
    {
      label: "inconsistent catalog fraction",
      amountDue: 1_450n,
      sourceProrationAmount: 1_000n,
    },
    {
      label: "overfull period",
      amountDue: 6_000n,
      prorationCredit: 3_800n,
      sourceProrationAmount: 3_800n,
      targetProrationAmount: 9_800n,
    },
    { label: "customer balance", customerBalanceCredit: 1n },
    { label: "unsafe shape", safeShape: false },
  ])("defers an unsafe prorated preview: $label", async (override) => {
    const accountId = await seedPaidAccount(database, catalog);
    const gateway = safeDeltaGateway();
    Object.assign(gateway, override);
    const service = new PlanChangeCoordinator(database, catalog, gateway, {
      transitionPolicy: "prorated_delta",
    });

    const preview = await service.previewRemote(
      accountId,
      "pro",
      "month",
      `delta-${override.label}`,
    );
    const confirmed = await service.confirm(accountId, preview.changeId);

    expect(preview.decision.timing).toBe("period_end");
    expect(confirmed.status).toBe("scheduled");
    expect(gateway.applyCalls).toEqual([]);
  });

  test("requires an immutable source invoice", async () => {
    const accountId = await seedPaidAccount(database, catalog, {
      withFundingInvoice: false,
    });
    const service = new PlanChangeCoordinator(
      database,
      catalog,
      safeDeltaGateway(),
      { transitionPolicy: "prorated_delta" },
    );

    await expect(
      service.previewRemote(accountId, "pro", "month", "delta-no-source"),
    ).rejects.toThrow(/funding invoice/u);
  });

  test("rejects an expired local entitlement boundary", async () => {
    const accountId = await seedPaidAccount(database, catalog);
    await database.query(
      `update billing_accounts set
         entitlement_period_end='2020-01-01 UTC'::timestamptz,
         credit_expires_at='2020-01-01 UTC'::timestamptz
       where id=$1::uuid`,
      [accountId],
    );
    const service = new PlanChangeCoordinator(
      database,
      catalog,
      safeDeltaGateway(),
      { transitionPolicy: "prorated_delta" },
    );

    await expect(
      service.previewRemote(accountId, "pro", "month", "delta-expired"),
    ).rejects.toThrow(/funded period boundary/u);
  });

  test("defers downgrades, annual sources, and interval changes", async () => {
    const accountId = await seedPaidAccount(database, catalog, { plan: "pro" });
    const gateway = new FakePlanGateway("ent_pro_month");
    const service = new PlanChangeCoordinator(database, catalog, gateway, {
      transitionPolicy: "prorated_delta",
    });

    expect(
      service.preview(
        { plan_key: "pro", plan_interval: "month" },
        "starter",
        "month",
      ).timing,
    ).toBe("period_end");
    expect(
      service.preview(
        { plan_key: "pro", plan_interval: "month" },
        "ultra",
        "year",
      ).timing,
    ).toBe("period_end");
    expect(
      service.preview(
        { plan_key: "pro", plan_interval: "year" },
        "ultra",
        "year",
      ).timing,
    ).toBe("period_end");

    const preview = await service.previewRemote(
      accountId,
      "starter",
      "month",
      "delta-down",
    );
    const confirmed = await service.confirm(accountId, preview.changeId);
    expect(preview.decision.timing).toBe("period_end");
    expect(confirmed.status).toBe("scheduled");
    expect(gateway.applyCalls).toEqual([]);
  });
});
