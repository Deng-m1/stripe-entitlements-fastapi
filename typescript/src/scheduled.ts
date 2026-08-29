import { AnnualGrantService } from "./annual.js";
import type { PlanCatalog } from "./catalog.js";
import type { Database } from "./database.js";
import { ReconciliationService } from "./reconcile.js";
import type {
  ReconciliationGateway,
  ReconciliationProcessor,
} from "./reconcile.js";
import type { ProcessResult, SubscriptionSnapshot } from "./types.js";

const MAX_SERVERLESS_BATCH = 100;

export type CreditPackReconcileOutcome =
  | "reconciled"
  | "idle"
  | "lost_lease"
  | "unavailable"
  | "failed";

export interface CreditPackReconcileSummary {
  readonly outcome: CreditPackReconcileOutcome;
}

export interface ScheduledCreditPackReconciliation {
  reconcileDue(options: {
    readonly limit: number;
  }): Promise<readonly CreditPackReconcileSummary[]>;
}

export interface ScheduledGateway extends ReconciliationGateway {
  subscriptionSnapshot(subscriptionId: string): Promise<SubscriptionSnapshot>;
}

export interface ScheduledKernel {
  readonly database: Database;
  readonly catalog: PlanCatalog;
  readonly gateway: ScheduledGateway;
  requireServices(): {
    readonly processor: ReconciliationProcessor & {
      readonly productLine: string;
    };
    readonly creditPackReconciliation: ScheduledCreditPackReconciliation;
  };
}

export interface AnnualGrantWorker {
  dueAccounts(
    now?: undefined,
    options?: { readonly limit?: number },
  ): Promise<
    readonly { readonly id: string; readonly stripe_subscription_id: string }[]
  >;
  recordFailure(
    accountId: string,
    subscriptionId: string,
    reason: string,
  ): Promise<void>;
  deferCandidate(accountId: string): Promise<void>;
  grantDue(
    accountId: string,
    now: undefined,
    snapshot: SubscriptionSnapshot,
  ): Promise<ProcessResult>;
}

export interface ReconciliationWorker {
  databaseNow(): Promise<string>;
  candidates(
    now?: undefined,
    options?: {
      readonly limit?: number;
      readonly attemptedBefore?: string;
    },
  ): Promise<readonly { readonly id: string }[]>;
  reconcileAccount(accountId: string): Promise<ProcessResult>;
}

export interface ScheduledWorkerFactories {
  annual(kernel: ScheduledKernel): AnnualGrantWorker;
  reconciliation(kernel: ScheduledKernel): ReconciliationWorker;
}

const DEFAULT_FACTORIES: ScheduledWorkerFactories = {
  annual(kernel) {
    const services = kernel.requireServices();
    return new AnnualGrantService(
      kernel.database,
      kernel.catalog,
      services.processor,
    );
  },
  reconciliation(kernel) {
    const services = kernel.requireServices();
    return new ReconciliationService(
      kernel.database,
      services.processor,
      kernel.gateway,
    );
  },
};

function boundedBatchLimit(value: number, field: string): number {
  if (
    !Number.isSafeInteger(value) ||
    typeof value !== "number" ||
    value < 1 ||
    value > MAX_SERVERLESS_BATCH
  ) {
    throw new RangeError(
      `${field} must be an integer between 1 and ${MAX_SERVERLESS_BATCH}`,
    );
  }
  return value;
}

export class AnnualGrantBatchResult {
  public readonly attempted: number;
  public readonly handled: number;
  public readonly replayed: number;
  public readonly ignored: number;
  public readonly failures: number;

  public constructor(input: {
    readonly attempted: number;
    readonly handled: number;
    readonly replayed: number;
    readonly ignored: number;
    readonly failures: number;
  }) {
    Object.assign(this, input);
    this.attempted = input.attempted;
    this.handled = input.handled;
    this.replayed = input.replayed;
    this.ignored = input.ignored;
    this.failures = input.failures;
  }

  public get ok(): boolean {
    return this.failures === 0;
  }

  public publicSummary(): Readonly<Record<string, boolean | number>> {
    return {
      ok: this.ok,
      attempted: this.attempted,
      handled: this.handled,
      replayed: this.replayed,
      ignored: this.ignored,
      failures: this.failures,
    };
  }
}

export class ReconciliationBatchResult {
  public readonly accountsAttempted: number;
  public readonly accountsHandled: number;
  public readonly accountsReplayed: number;
  public readonly accountsIgnored: number;
  public readonly packsAttempted: number;
  public readonly packsReconciled: number;
  public readonly packsIdle: number;
  public readonly packsDeferred: number;
  public readonly failures: number;

  public constructor(input: {
    readonly accountsAttempted: number;
    readonly accountsHandled: number;
    readonly accountsReplayed: number;
    readonly accountsIgnored: number;
    readonly packsAttempted: number;
    readonly packsReconciled: number;
    readonly packsIdle: number;
    readonly packsDeferred: number;
    readonly failures: number;
  }) {
    this.accountsAttempted = input.accountsAttempted;
    this.accountsHandled = input.accountsHandled;
    this.accountsReplayed = input.accountsReplayed;
    this.accountsIgnored = input.accountsIgnored;
    this.packsAttempted = input.packsAttempted;
    this.packsReconciled = input.packsReconciled;
    this.packsIdle = input.packsIdle;
    this.packsDeferred = input.packsDeferred;
    this.failures = input.failures;
  }

  public get ok(): boolean {
    return this.failures === 0;
  }

  public publicSummary(): Readonly<Record<string, boolean | number>> {
    return {
      ok: this.ok,
      accounts_attempted: this.accountsAttempted,
      accounts_handled: this.accountsHandled,
      accounts_replayed: this.accountsReplayed,
      accounts_ignored: this.accountsIgnored,
      packs_attempted: this.packsAttempted,
      packs_reconciled: this.packsReconciled,
      packs_idle: this.packsIdle,
      packs_deferred: this.packsDeferred,
      failures: this.failures,
    };
  }
}

export async function runAnnualGrantBatch(
  kernel: ScheduledKernel,
  options: {
    readonly limit?: number;
    readonly factories?: ScheduledWorkerFactories;
  } = {},
): Promise<AnnualGrantBatchResult> {
  const limit = boundedBatchLimit(
    options.limit ?? 25,
    "annual grant batch limit",
  );
  const worker = (options.factories ?? DEFAULT_FACTORIES).annual(kernel);
  const candidates = await worker.dueAccounts(undefined, { limit });
  let handled = 0;
  let replayed = 0;
  let ignored = 0;
  let failures = 0;
  for (const candidate of candidates) {
    let snapshot: SubscriptionSnapshot;
    try {
      snapshot = await kernel.gateway.subscriptionSnapshot(
        candidate.stripe_subscription_id,
      );
    } catch (error) {
      failures += 1;
      try {
        await worker.recordFailure(
          candidate.id,
          candidate.stripe_subscription_id,
          `subscription snapshot failed: ${
            error instanceof Error ? error.constructor.name : "UnknownError"
          }`,
        );
      } catch {
        // The non-zero summary still asks the scheduler to retry.
      }
      try {
        await worker.deferCandidate(candidate.id);
      } catch {
        // The candidate remains visible for the next bounded pass.
      }
      continue;
    }
    let result: ProcessResult;
    try {
      result = await worker.grantDue(candidate.id, undefined, snapshot);
    } catch {
      failures += 1;
      continue;
    }
    if (result.outcome === "handled") {
      handled += 1;
    } else if (result.outcome === "replayed") {
      replayed += 1;
    } else if (result.outcome === "ignored") {
      ignored += 1;
      try {
        await worker.deferCandidate(candidate.id);
      } catch {
        failures += 1;
      }
    } else {
      failures += 1;
    }
  }
  return new AnnualGrantBatchResult({
    attempted: candidates.length,
    handled,
    replayed,
    ignored,
    failures,
  });
}

export async function runReconciliationBatch(
  kernel: ScheduledKernel,
  options: {
    readonly accountLimit?: number;
    readonly creditPackLimit?: number;
    readonly factories?: ScheduledWorkerFactories;
  } = {},
): Promise<ReconciliationBatchResult> {
  const accountLimit = boundedBatchLimit(
    options.accountLimit ?? 20,
    "reconciliation account batch limit",
  );
  const creditPackLimit = boundedBatchLimit(
    options.creditPackLimit ?? 20,
    "credit-pack reconciliation batch limit",
  );
  const services = kernel.requireServices();
  const worker = (options.factories ?? DEFAULT_FACTORIES).reconciliation(
    kernel,
  );
  const runStarted = await worker.databaseNow();
  const candidates = await worker.candidates(undefined, {
    limit: accountLimit,
    attemptedBefore: runStarted,
  });
  let accountsHandled = 0;
  let accountsReplayed = 0;
  let accountsIgnored = 0;
  let failures = 0;
  for (const candidate of candidates) {
    let result: ProcessResult;
    try {
      result = await worker.reconcileAccount(candidate.id);
    } catch {
      failures += 1;
      continue;
    }
    if (result.outcome === "handled") {
      accountsHandled += 1;
    } else if (result.outcome === "replayed") {
      accountsReplayed += 1;
    } else if (result.outcome === "ignored") {
      accountsIgnored += 1;
    } else {
      failures += 1;
    }
  }
  const packResults = await services.creditPackReconciliation.reconcileDue({
    limit: creditPackLimit,
  });
  const packsReconciled = packResults.filter(
    (result) => result.outcome === "reconciled",
  ).length;
  const packsIdle = packResults.filter(
    (result) => result.outcome === "idle",
  ).length;
  const packsDeferred = packResults.filter(
    (result) =>
      result.outcome === "lost_lease" || result.outcome === "unavailable",
  ).length;
  const packFailures = packResults.filter(
    (result) => result.outcome === "failed",
  ).length;
  const known = packsReconciled + packsIdle + packsDeferred + packFailures;
  failures += packFailures + (packResults.length - known);
  return new ReconciliationBatchResult({
    accountsAttempted: candidates.length,
    accountsHandled,
    accountsReplayed,
    accountsIgnored,
    packsAttempted: packResults.length,
    packsReconciled,
    packsIdle,
    packsDeferred,
    failures,
  });
}
