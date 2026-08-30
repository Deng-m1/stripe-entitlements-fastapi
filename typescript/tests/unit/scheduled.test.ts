import { describe, expect, test } from "vitest";

import type { PlanCatalog } from "../../src/catalog.js";
import type { Database } from "../../src/database.js";
import {
  runAnnualGrantBatch,
  runReconciliationBatch,
  type AnnualGrantWorker,
  type ReconciliationWorker,
  type ScheduledKernel,
  type ScheduledWorkerFactories,
} from "../../src/scheduled.js";
import type { ProcessResult, SubscriptionSnapshot } from "../../src/types.js";

function kernel(input?: {
  readonly failingSubscription?: string;
  readonly packOutcomes?: readonly (
    | "reconciled"
    | "idle"
    | "lost_lease"
    | "unavailable"
    | "failed"
  )[];
}): ScheduledKernel {
  return {
    database: {} as Database,
    catalog: {} as PlanCatalog,
    gateway: {
      async subscriptionSnapshot(
        subscriptionId,
      ): Promise<SubscriptionSnapshot> {
        if (subscriptionId === input?.failingSubscription) {
          throw new Error("sk_test_secret_must_not_escape");
        }
        return {
          subscriptionId,
          status: "active",
          itemsComplete: true,
        };
      },
      async subscriptionObject(): Promise<Readonly<Record<string, unknown>>> {
        return {};
      },
      async latestPaidInvoiceEvent(): Promise<undefined> {
        return undefined;
      },
    },
    requireServices() {
      return {
        processor: {
          productLine: "test",
          async process(): Promise<ProcessResult> {
            return { outcome: "handled" };
          },
        },
        creditPackReconciliation: {
          async reconcileDue() {
            return (input?.packOutcomes ?? []).map((outcome) => ({ outcome }));
          },
        },
      };
    },
  };
}

describe("bounded scheduled workers", () => {
  test("annual batch returns identity-free counts and defers failed or ignored candidates", async () => {
    const calls: unknown[] = [];
    const worker: AnnualGrantWorker = {
      async dueAccounts(_now, options) {
        calls.push(["due", options?.limit]);
        return [
          { id: "account-handled", stripe_subscription_id: "sub_handled" },
          { id: "account-replayed", stripe_subscription_id: "sub_replayed" },
          { id: "account-ignored", stripe_subscription_id: "sub_ignored" },
          {
            id: "account-failed",
            stripe_subscription_id: "sub_remote_failure",
          },
        ];
      },
      async recordFailure(accountId, subscriptionId, reason) {
        calls.push(["failure", accountId, subscriptionId, reason]);
      },
      async deferCandidate(accountId) {
        calls.push(["defer", accountId]);
      },
      async grantDue(accountId) {
        return {
          outcome: accountId.replace(
            "account-",
            "",
          ) as ProcessResult["outcome"],
        };
      },
    };
    const factories: ScheduledWorkerFactories = {
      annual: () => worker,
      reconciliation: () => {
        throw new Error("unused");
      },
    };

    const result = await runAnnualGrantBatch(
      kernel({ failingSubscription: "sub_remote_failure" }),
      { limit: 7, factories },
    );

    expect(calls).toContainEqual(["due", 7]);
    expect(calls).toContainEqual(["defer", "account-ignored"]);
    expect(calls).toContainEqual(["defer", "account-failed"]);
    expect(calls).not.toContainEqual(["defer", "account-handled"]);
    expect(result.publicSummary()).toEqual({
      ok: false,
      attempted: 4,
      handled: 1,
      replayed: 1,
      ignored: 1,
      failures: 1,
    });
    const rendered = JSON.stringify(result.publicSummary());
    expect(rendered).not.toContain("account-");
    expect(rendered).not.toContain("sub_");
    expect(rendered).not.toContain("sk_test_");
  });

  test("reconciliation bounds both queues and classifies every outcome", async () => {
    const calls: unknown[] = [];
    const worker: ReconciliationWorker = {
      async databaseNow() {
        return "2026-08-29T00:00:00.123456Z";
      },
      async candidates(_now, options) {
        calls.push(["candidates", options]);
        return [{ id: "handled" }, { id: "failed" }];
      },
      async reconcileAccount(accountId) {
        if (accountId === "failed") {
          throw new Error("private failure");
        }
        return { outcome: "handled", accountId };
      },
    };
    const factories: ScheduledWorkerFactories = {
      annual: () => {
        throw new Error("unused");
      },
      reconciliation: () => worker,
    };

    const result = await runReconciliationBatch(
      kernel({
        packOutcomes: ["reconciled", "idle", "lost_lease", "failed"],
      }),
      { accountLimit: 9, creditPackLimit: 11, factories },
    );

    expect(calls).toContainEqual([
      "candidates",
      {
        limit: 9,
        attemptedBefore: "2026-08-29T00:00:00.123456Z",
      },
    ]);
    expect(result.publicSummary()).toEqual({
      ok: false,
      accounts_attempted: 2,
      accounts_handled: 1,
      accounts_replayed: 0,
      accounts_ignored: 0,
      packs_attempted: 4,
      packs_reconciled: 1,
      packs_idle: 1,
      packs_deferred: 1,
      failures: 2,
    });
  });

  test.each([0, -1, 101, 1.5, Number.NaN])(
    "invalid serverless limit %s fails closed before work",
    async (limit) => {
      await expect(runAnnualGrantBatch(kernel(), { limit })).rejects.toThrow(
        "between 1 and 100",
      );
      await expect(
        runReconciliationBatch(kernel(), { accountLimit: limit }),
      ).rejects.toThrow("between 1 and 100");
      await expect(
        runReconciliationBatch(kernel(), { creditPackLimit: limit }),
      ).rejects.toThrow("between 1 and 100");
    },
  );
});
