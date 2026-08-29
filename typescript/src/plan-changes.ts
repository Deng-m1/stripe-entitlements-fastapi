import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import type { Plan, PlanCatalog } from "./catalog.js";
import type { Database } from "./database.js";
import {
  pgBigInt,
  type BillingAccountRow,
  type TransactionClient,
} from "./db-types.js";
import type {
  PlanChangeContext,
  PlanChangeEstimate,
  PreparePlanChangeInput,
  RemotePlanChange,
} from "./stripe-gateway.js";
import {
  StripeRequestSnapshotError,
  buildPlanChangeRequestSnapshot,
  planChangeContextFromSnapshot,
  validatePlanChangeRequestSnapshot,
  type PlanChangeRequestSnapshot,
} from "./stripe-request-snapshots.js";
import { decideTransition, type TransitionDecision } from "./transitions.js";
import type {
  BillingInterval,
  EffectiveMode,
  PgTimestamp,
  TransitionPolicy,
} from "./types.js";
import { isPlainRecord, isPrintable } from "./validation.js";

const TIMESTAMP =
  // Every repetition is explicitly bounded and the expression is fully anchored.
  // eslint-disable-next-line security/detect-unsafe-regex
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/u;
const MICROS_PER_SECOND = 1_000_000n;
const SECONDS_PER_DAY = 86_400n;

export type PlanChangeStatus =
  | "reserved"
  | "previewed"
  | "applying"
  | "scheduled"
  | "applied"
  | "requires_action"
  | "completed"
  | "failed";

export class PlanChangeError extends Error {}
export class PlanChangeBusyError extends PlanChangeError {}
export class PlanChangeConflictError extends PlanChangeError {}
export class PlanChangeUnavailableError extends PlanChangeError {}

export interface PlanChangeGateway {
  preparePlanChange(input: PreparePlanChangeInput): Promise<PlanChangeContext>;
  applyImmediatePlanChange(
    context: PlanChangeContext,
    input: {
      readonly idempotencyKey: string;
      readonly policy: TransitionPolicy;
      readonly prorationDate?: bigint;
    },
  ): Promise<RemotePlanChange>;
  previewImmediatePlanChange(
    context: PlanChangeContext,
    options: {
      readonly policy: TransitionPolicy;
      readonly prorationDate?: bigint;
    },
  ): Promise<PlanChangeEstimate>;
  schedulePlanChange(
    context: PlanChangeContext,
    input: { readonly idempotencyKey: string },
  ): Promise<RemotePlanChange>;
  executePlanChangeRequestSnapshot?(
    snapshot: PlanChangeRequestSnapshot,
  ): Promise<RemotePlanChange>;
  verifyPlanChangeRequestSnapshot?(
    snapshot: PlanChangeRequestSnapshot,
  ): Promise<PlanChangeContext>;
  readonly apiVersion?: string;
  readonly productLine?: string;
}

export interface PlanChangeResult {
  readonly changeId: string;
  readonly decision: TransitionDecision;
  readonly status: PlanChangeStatus;
  readonly effectiveAt: PgTimestamp | null;
  readonly recoveryUrl: string | null;
  /** Ephemeral response-only secret. It is never persisted. */
  readonly clientSecret: string | null;
  readonly replayed: boolean;
  readonly estimatedAmountDue: bigint | null;
  readonly estimatedCreditApplied: bigint | null;
  readonly estimatedCustomerBalanceCredit: bigint | null;
  readonly estimateCurrency: string | null;
  readonly transitionPolicy: TransitionPolicy;
  readonly entitlementCreditDelta: bigint | null;
}

interface PlanChangeRow extends QueryResultRow {
  readonly id: string;
  readonly account_id: string;
  readonly idempotency_key: string;
  readonly stripe_subscription_id: string;
  readonly from_plan_key: string;
  readonly from_interval: BillingInterval;
  readonly target_plan_key: string;
  readonly target_interval: BillingInterval;
  readonly effective_mode: EffectiveMode;
  readonly status: PlanChangeStatus;
  readonly effective_at: PgTimestamp | null;
  readonly stripe_schedule_id: string | null;
  readonly stripe_request_key: string;
  readonly expected_grant_epoch: string;
  readonly expected_entitlement_period_end: PgTimestamp | null;
  readonly expected_subscription_status: string;
  readonly expected_cancel_at_period_end: boolean;
  readonly proration_date: string | null;
  readonly estimated_amount_due: string | null;
  readonly estimated_credit_applied: string | null;
  readonly estimated_customer_balance_credit: string | null;
  readonly estimate_currency: string | null;
  readonly preview_expires_at: PgTimestamp | null;
  readonly lease_token: string | null;
  readonly lease_expires_at: PgTimestamp | null;
  readonly remote_pending_expires_at: PgTimestamp | null;
  readonly recovery_url: string | null;
  readonly last_error: string | null;
  readonly transition_policy: TransitionPolicy;
  readonly expected_source_invoice_id: string | null;
  readonly expected_credit_delta: string | null;
  readonly expected_entitlement_revoked: boolean;
  readonly settlement_invoice_id: string | null;
  readonly remote_started_at: PgTimestamp | null;
  readonly estimated_source_proration: string | null;
  readonly estimated_target_proration: string | null;
  readonly estimated_period_start: PgTimestamp | null;
  readonly estimated_period_end: PgTimestamp | null;
  readonly completed_at: PgTimestamp | null;
  readonly request_snapshot_version: number | null;
  readonly stripe_request_snapshot: unknown;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  const lengths = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return lengths[month - 1] ?? 0;
}

function daysFromCivil(year: number, month: number, day: number): bigint {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const shiftedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return BigInt(era * 146_097 + dayOfEra - 719_468);
}

function timestampMicros(value: unknown): bigint | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = TIMESTAMP.exec(value);
  if (match === null) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const timezone = match[8];
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    timezone === undefined
  ) {
    return undefined;
  }
  let offsetSeconds = 0;
  if (timezone !== "Z") {
    const sign = timezone.startsWith("+") ? 1 : -1;
    const compact = timezone.slice(1).replace(":", "");
    const offsetHours = Number(compact.slice(0, 2));
    const offsetMinutes = compact.length === 4 ? Number(compact.slice(2)) : 0;
    if (offsetHours > 23 || offsetMinutes > 59) {
      return undefined;
    }
    offsetSeconds = sign * (offsetHours * 3600 + offsetMinutes * 60);
  }
  const localSeconds =
    daysFromCivil(year, month, day) * SECONDS_PER_DAY +
    BigInt(hour * 3600 + minute * 60 + second);
  const fractionalMicros = BigInt(fraction.padEnd(6, "0") || "0");
  return (
    (localSeconds - BigInt(offsetSeconds)) * MICROS_PER_SECOND +
    fractionalMicros
  );
}

function timestampEqualsEpoch(
  timestamp: PgTimestamp | null,
  epochSeconds: bigint,
): boolean {
  return timestampMicros(timestamp) === epochSeconds * MICROS_PER_SECOND;
}

function interval(value: string): BillingInterval {
  if (value !== "month" && value !== "year") {
    throw new PlanChangeConflictError("interval must be month or year");
  }
  return value;
}

function validateIdempotencyKey(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > 200 ||
    !isPrintable(value)
  ) {
    throw new PlanChangeConflictError(
      "Idempotency-Key must contain 1 to 200 visible characters without padding",
    );
  }
  return value;
}

function expectedPriceAmount(
  plan: Plan,
  planInterval: BillingInterval,
): bigint {
  return BigInt(planInterval === "month" ? plan.monthUsd : plan.yearUsd) * 100n;
}

function optionalBigInt(value: string | null, field: string): bigint | null {
  return value === null ? null : pgBigInt(value, field);
}

function decisionFromRow(row: PlanChangeRow): TransitionDecision {
  return {
    fromPlan: row.from_plan_key,
    fromInterval: row.from_interval,
    targetPlan: row.target_plan_key,
    targetInterval: row.target_interval,
    timing: row.effective_mode,
    reason: "persisted transition policy",
    policy: row.transition_policy,
  };
}

function resultFromRow(
  row: PlanChangeRow,
  decision: TransitionDecision,
  replayed: boolean,
  clientSecret: string | null = null,
): PlanChangeResult {
  return {
    changeId: row.id,
    decision,
    status: row.status,
    effectiveAt: row.effective_at,
    recoveryUrl: row.recovery_url,
    clientSecret,
    replayed,
    estimatedAmountDue: optionalBigInt(
      row.estimated_amount_due,
      "estimated amount due",
    ),
    estimatedCreditApplied: optionalBigInt(
      row.estimated_credit_applied,
      "estimated credit applied",
    ),
    estimatedCustomerBalanceCredit: optionalBigInt(
      row.estimated_customer_balance_credit,
      "estimated customer balance credit",
    ),
    estimateCurrency: row.estimate_currency,
    transitionPolicy: row.transition_policy,
    entitlementCreditDelta: optionalBigInt(
      row.expected_credit_delta,
      "expected entitlement credit delta",
    ),
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "UnknownError";
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Durable plan-change intent and remote-call coordinator.
 *
 * Every gateway call occurs outside a PostgreSQL transaction. Short database
 * leases and stable Stripe idempotency keys make unknown outcomes recoverable.
 */
export class PlanChangeCoordinator {
  readonly #database: Database;
  readonly #catalog: PlanCatalog;
  readonly #gateway: PlanChangeGateway;
  readonly #leaseTtlSeconds: number;
  readonly #transitionPolicy: TransitionPolicy;

  public constructor(
    database: Database,
    catalog: PlanCatalog,
    gateway: PlanChangeGateway,
    options: {
      readonly leaseTtlSeconds?: number;
      readonly transitionPolicy?: TransitionPolicy;
    } = {},
  ) {
    const leaseTtlSeconds = options.leaseTtlSeconds ?? 120;
    if (
      !Number.isFinite(leaseTtlSeconds) ||
      leaseTtlSeconds <= 0 ||
      leaseTtlSeconds > Number.MAX_SAFE_INTEGER
    ) {
      throw new RangeError("plan-change lease TTL must be positive");
    }
    const transitionPolicy: unknown =
      options.transitionPolicy ?? "full_period_reset";
    if (
      transitionPolicy !== "full_period_reset" &&
      transitionPolicy !== "prorated_delta"
    ) {
      throw new TypeError(
        `unknown transition policy ${String(transitionPolicy)}`,
      );
    }
    this.#database = database;
    this.#catalog = catalog;
    this.#gateway = gateway;
    this.#leaseTtlSeconds = leaseTtlSeconds;
    this.#transitionPolicy = transitionPolicy;
  }

  public preview(
    account: Readonly<Record<string, unknown>>,
    planKey: string,
    intervalInput: string,
  ): TransitionDecision {
    const target = this.#catalog.require(planKey);
    const currentKey = String(account["plan_key"]);
    const rawCurrentInterval = account["plan_interval"];
    if (
      currentKey === "free" ||
      (rawCurrentInterval !== "month" && rawCurrentInterval !== "year")
    ) {
      throw new PlanChangeUnavailableError(
        "free accounts must start through Checkout",
      );
    }
    return decideTransition(
      this.#catalog.require(currentKey),
      rawCurrentInterval,
      target,
      interval(intervalInput),
      this.#transitionPolicy,
    );
  }

  public async previewRemote(
    accountId: string,
    planKey: string,
    intervalInput: string,
    idempotencyKeyInput: string,
  ): Promise<PlanChangeResult> {
    const idempotencyKey = validateIdempotencyKey(idempotencyKeyInput);
    const { row, replayed } = await this.#reserve(
      accountId,
      planKey,
      intervalInput,
      idempotencyKey,
    );
    let decision = decisionFromRow(row);
    if (row.status === "failed") {
      throw new PlanChangeUnavailableError(
        "this plan-change intent is no longer reusable; start a new intent",
      );
    }
    if (row.status !== "reserved") {
      if (row.status !== "completed" && row.request_snapshot_version !== 1) {
        throw new PlanChangeUnavailableError(
          "this legacy preview has no durable Stripe request snapshot; request a new preview with a new Idempotency-Key",
        );
      }
      return resultFromRow(row, decision, true);
    }
    const leaseToken = randomUUID();
    const leased = await this.#acquireLease(row.id, leaseToken, "reserved");
    if (leased === null) {
      const refreshed = await this.#get(row.id);
      if (refreshed.status === "reserved") {
        throw new PlanChangeBusyError(
          "this plan-change preview is still being calculated",
        );
      }
      return resultFromRow(refreshed, decision, true);
    }
    try {
      // A pre-migration NULL row has no durable remote-request lineage.  Once its
      // lease is recovered it must be retired before even a Stripe preview/read;
      // only an explicitly reserved v0 intent may cross the prepare -> freeze
      // boundary.
      if (leased.request_snapshot_version !== 0) {
        await this.#retireUnfrozenIntent(leased.id, leaseToken);
        throw new PlanChangeUnavailableError(
          "this legacy preview has no durable Stripe request snapshot; request a new preview with a new Idempotency-Key",
        );
      }
      const targetPlan = this.#catalog.require(decision.targetPlan);
      const sourcePlan = this.#catalog.require(decision.fromPlan);
      const targetLookupKey = this.#catalog.lookupKey(
        decision.targetPlan,
        decision.targetInterval,
      );
      const context = await this.#gateway.preparePlanChange({
        subscriptionId: row.stripe_subscription_id,
        targetLookupKey,
        expectedCurrency: targetPlan.currency,
        expectedUnitAmount: expectedPriceAmount(
          targetPlan,
          decision.targetInterval,
        ),
        expectedPlanKey: targetPlan.key,
        targetInterval: decision.targetInterval,
        expectedSourceLookupKey: this.#catalog.lookupKey(
          sourcePlan.key,
          decision.fromInterval,
        ),
        expectedSourceCurrency: sourcePlan.currency,
        expectedSourceUnitAmount: expectedPriceAmount(
          sourcePlan,
          decision.fromInterval,
        ),
        expectedSourcePlanKey: sourcePlan.key,
        sourceInterval: decision.fromInterval,
      });
      await this.#revalidateBeforeRemote(row, context, targetLookupKey);

      let estimate: PlanChangeEstimate | null = null;
      let prorationDate: bigint | null = null;
      if (decision.timing === "immediate") {
        const expectedAmount = expectedPriceAmount(
          targetPlan,
          decision.targetInterval,
        );
        if (decision.policy === "prorated_delta") {
          prorationDate = await this.#databaseEpoch();
        }
        estimate = await this.#gateway.previewImmediatePlanChange(context, {
          policy: decision.policy,
          ...(prorationDate === null ? {} : { prorationDate }),
        });
        let safe: boolean;
        if (decision.policy === "prorated_delta") {
          const sourceCatalogAmount = BigInt(sourcePlan.monthUsd) * 100n;
          const targetCatalogAmount = BigInt(targetPlan.monthUsd) * 100n;
          const ratioError = absolute(
            estimate.sourceProrationAmount * targetCatalogAmount -
              estimate.targetProrationAmount * sourceCatalogAmount,
          );
          safe =
            estimate.safeInvoiceShape &&
            estimate.amountDue > 0n &&
            estimate.sourceProrationAmount > 0n &&
            estimate.sourceProrationAmount <= sourceCatalogAmount &&
            estimate.sourceProrationAmount < estimate.targetProrationAmount &&
            estimate.targetProrationAmount <= targetCatalogAmount &&
            estimate.amountDue ===
              estimate.targetProrationAmount - estimate.sourceProrationAmount &&
            estimate.customerBalanceCredit === 0n &&
            estimate.taxAmount === 0n &&
            estimate.discountAmount === 0n &&
            estimate.currency.toLowerCase() === targetPlan.currency &&
            ratioError <=
              (sourceCatalogAmount > targetCatalogAmount
                ? sourceCatalogAmount
                : targetCatalogAmount) &&
            estimate.periodStart === prorationDate &&
            estimate.periodEnd === context.currentPeriodEnd;
        } else {
          safe =
            estimate.safeInvoiceShape &&
            estimate.amountDue === expectedAmount &&
            estimate.prorationCredit === 0n &&
            estimate.customerBalanceCredit === 0n &&
            estimate.taxAmount === 0n &&
            estimate.discountAmount === 0n &&
            estimate.currency.toLowerCase() === targetPlan.currency;
        }
        if (!safe) {
          decision = {
            ...decision,
            timing: "period_end",
            reason:
              "immediate preview lacked a positive safely-attributed amount due",
          };
        }
      }
      await this.#assertAccountSnapshot(row);
      const requestSnapshot = this.#buildRequestSnapshot(
        row,
        decision,
        context,
        prorationDate,
      );
      const final = await this.#storePreview(
        row.id,
        leaseToken,
        decision,
        context,
        estimate,
        prorationDate,
        requestSnapshot,
      );
      return resultFromRow(final, decision, replayed);
    } catch (error) {
      await this.#releaseAfterError(row.id, leaseToken, errorName(error));
      throw error;
    }
  }

  public async confirm(
    accountId: string,
    previewId: string,
  ): Promise<PlanChangeResult> {
    const initial = await this.#database.query<PlanChangeRow>(
      `select * from billing_plan_changes
        where id=$1::uuid and account_id=$2::uuid`,
      [previewId, accountId],
    );
    let row = initial.rows[0];
    if (row === undefined) {
      throw new PlanChangeUnavailableError("plan-change preview not found");
    }
    let decision = decisionFromRow(row);
    if (row.status === "failed") {
      throw new PlanChangeUnavailableError(
        "this plan-change intent failed; request a new preview",
      );
    }
    if (
      row.status === "scheduled" ||
      row.status === "applied" ||
      row.status === "requires_action" ||
      row.status === "completed"
    ) {
      return resultFromRow(row, decision, true);
    }
    if (decision.timing === "noop") {
      return resultFromRow(row, decision, false);
    }
    if (row.status !== "previewed" && row.status !== "applying") {
      throw new PlanChangeConflictError(
        "preview this exact change before confirming it",
      );
    }

    const leaseToken = randomUUID();
    const leased = await this.#acquireConfirmationLease(row.id, leaseToken);
    if (leased === null) {
      const refreshed = await this.#get(row.id);
      if (await this.#expirePreviewIfIdle(refreshed)) {
        throw new PlanChangeUnavailableError(
          "plan-change preview expired; request a new preview",
        );
      }
      if (refreshed.status === "failed") {
        throw new PlanChangeUnavailableError(
          "this plan-change intent failed; request a new preview",
        );
      }
      return resultFromRow(refreshed, decision, true);
    }
    row = leased;
    decision = decisionFromRow(row);
    try {
      if (row.request_snapshot_version !== 1) {
        await this.#retireUnfrozenIntent(row.id, leaseToken);
        throw new PlanChangeUnavailableError(
          "this preview has no durable Stripe request snapshot; request a new preview with a new Idempotency-Key",
        );
      }
      const requestSnapshot = this.#validatedRequestSnapshot(row);
      const context = planChangeContextFromSnapshot(requestSnapshot);
      await this.#assertRemoteRetryWindow(row);
      if (row.remote_started_at === null) {
        await this.#verifySnapshotBeforeRemoteStart(row, requestSnapshot);
      }
      await this.#assertAccountSnapshot(row);
      row = await this.#markRemoteStarted(row.id, leaseToken);

      const remote = await this.#executeRequestSnapshot(requestSnapshot);
      await this.#assertAccountSnapshot(row);
      let finalStatus: PlanChangeStatus;
      let effectiveAtEpoch: bigint | null;
      if (decision.timing === "immediate") {
        finalStatus = remote.pendingUpdate ? "requires_action" : "applied";
        effectiveAtEpoch = null;
      } else {
        finalStatus = "scheduled";
        effectiveAtEpoch = context.currentPeriodEnd;
      }
      const final = await this.#finish(row.id, leaseToken, {
        status: finalStatus,
        effectiveAtEpoch,
        scheduleId: finalStatus === "scheduled" ? remote.remoteId : null,
        pendingExpiresAtEpoch: remote.pendingExpiresAt,
        recoveryUrl: remote.recoveryUrl,
        settlementInvoiceId: remote.settlementInvoiceId,
      });
      if (final.status === "failed") {
        throw new PlanChangeUnavailableError(
          "the settlement Invoice could not fund the target entitlement",
        );
      }
      return resultFromRow(final, decision, false, remote.clientSecret);
    } catch (error) {
      await this.#releaseAfterError(row.id, leaseToken, errorName(error));
      throw error;
    }
  }

  async #reserve(
    accountId: string,
    planKey: string,
    intervalInput: string,
    idempotencyKey: string,
  ): Promise<{ readonly row: PlanChangeRow; readonly replayed: boolean }> {
    const target = this.#catalog.require(planKey);
    const targetInterval = interval(intervalInput);
    return this.#database.transaction(async (transaction) => {
      const accountResult = await transaction.query<BillingAccountRow>(
        "select * from billing_accounts where id=$1::uuid for update",
        [accountId],
      );
      const account = accountResult.rows[0];
      if (account === undefined) {
        throw new PlanChangeUnavailableError("billing account not found");
      }
      await transaction.query(
        `update billing_plan_changes
            set status='failed',last_error='pending_update_expired',updated_at=now()
          where account_id=$1::uuid and status='requires_action'
            and remote_pending_expires_at <= now()`,
        [accountId],
      );
      await transaction.query(
        `update billing_plan_changes
            set status='failed',last_error='preview_expired',updated_at=now()
          where account_id=$1::uuid and status='previewed'
            and preview_expires_at <= now()
            and (lease_expires_at is null or lease_expires_at <= now())`,
        [accountId],
      );
      const existingResult = await transaction.query<PlanChangeRow>(
        `select * from billing_plan_changes
          where account_id=$1::uuid and idempotency_key=$2`,
        [accountId, idempotencyKey],
      );
      const existing = existingResult.rows[0];
      if (existing !== undefined) {
        if (
          existing.target_plan_key !== target.key ||
          existing.target_interval !== targetInterval
        ) {
          throw new PlanChangeConflictError(
            "Idempotency-Key was already used with a different target",
          );
        }
        return { row: existing, replayed: true };
      }
      if (
        account.subscription_status !== "active" ||
        account.stripe_subscription_id === null
      ) {
        throw new PlanChangeUnavailableError(
          "an active paid subscription is required",
        );
      }
      if (account.cancel_at_period_end) {
        throw new PlanChangeUnavailableError(
          "cancel the pending subscription cancellation before changing plans",
        );
      }
      const currentInterval = interval(String(account.plan_interval));
      const current = this.#catalog.require(account.plan_key);
      const decision = decideTransition(
        current,
        currentInterval,
        target,
        targetInterval,
        this.#transitionPolicy,
      );
      if (
        decision.timing === "period_end" &&
        account.current_period_end === null
      ) {
        throw new PlanChangeUnavailableError(
          "current period end is not known yet",
        );
      }
      const pending = await transaction.query<
        { readonly id: string } & QueryResultRow
      >(
        `select id from billing_plan_changes where account_id=$1::uuid
          and status in (
            'reserved','previewed','applying','scheduled','applied','requires_action'
          )`,
        [accountId],
      );
      if (pending.rows[0] !== undefined) {
        throw new PlanChangeBusyError("another plan change is still pending");
      }

      let expectedSourceInvoiceId: string | null = null;
      let expectedCreditDelta: bigint | null = null;
      if (
        decision.policy === "prorated_delta" &&
        decision.timing === "immediate"
      ) {
        const fundedBoundary = await transaction.query<
          { readonly current: boolean } & QueryResultRow
        >("select $1::timestamptz > now() as current", [
          account.entitlement_period_end,
        ]);
        if (
          account.entitlement_period_end === null ||
          fundedBoundary.rows[0]?.current !== true
        ) {
          throw new PlanChangeUnavailableError(
            "the active entitlement has no current funded period boundary",
          );
        }
        expectedSourceInvoiceId =
          await PlanChangeCoordinator.#latestFundingInvoice(
            transaction,
            account.id,
            pgBigInt(account.grant_epoch, "account grant_epoch"),
          );
        if (expectedSourceInvoiceId === null) {
          throw new PlanChangeUnavailableError(
            "the active entitlement has no immutable funding invoice",
          );
        }
        expectedCreditDelta =
          target.monthlyCredits.atoms - current.monthlyCredits.atoms;
        if (expectedCreditDelta <= 0n) {
          throw new PlanChangeConflictError(
            "a prorated upgrade requires a positive entitlement delta",
          );
        }
      }

      const changeId = randomUUID();
      const status: PlanChangeStatus =
        decision.timing === "noop" ? "completed" : "reserved";
      const inserted = await transaction.query<PlanChangeRow>(
        `insert into billing_plan_changes(
           id,account_id,idempotency_key,stripe_subscription_id,
           from_plan_key,from_interval,target_plan_key,target_interval,
           effective_mode,status,effective_at,stripe_request_key,completed_at,
           expected_grant_epoch,expected_entitlement_period_end,
           expected_subscription_status,expected_cancel_at_period_end,
           transition_policy,expected_source_invoice_id,
           expected_credit_delta,expected_entitlement_revoked,
           request_snapshot_version)
         values($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,
                case when $9::text='period_end' then $11::timestamptz else null end,
                $12,case when $10::text='completed' then now() else null end,
                $13::bigint,$14::timestamptz,$15,$16::boolean,$17,$18,
                $19::bigint,$20::boolean,0)
         returning *`,
        [
          changeId,
          accountId,
          idempotencyKey,
          account.stripe_subscription_id,
          current.key,
          currentInterval,
          target.key,
          targetInterval,
          decision.timing,
          status,
          account.current_period_end,
          `plan-change:${changeId}`,
          account.grant_epoch,
          account.entitlement_period_end,
          account.subscription_status,
          account.cancel_at_period_end,
          decision.policy,
          expectedSourceInvoiceId,
          expectedCreditDelta?.toString() ?? null,
          account.entitlement_revoked,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error("plan-change reservation insert returned no row");
      }
      return { row, replayed: false };
    });
  }

  async #acquireLease(
    changeId: string,
    leaseToken: string,
    expectedStatus: PlanChangeStatus,
  ): Promise<PlanChangeRow | null> {
    const result = await this.#database.query<PlanChangeRow>(
      `update billing_plan_changes
          set lease_token=$2::uuid,
              lease_expires_at=now()+make_interval(secs=>$3::double precision),
              updated_at=now()
        where id=$1::uuid and status=$4
          and (lease_expires_at is null or lease_expires_at <= now())
          and ($4::text <> 'previewed' or
               (preview_expires_at is not null and preview_expires_at > now()))
        returning *`,
      [changeId, leaseToken, this.#leaseTtlSeconds, expectedStatus],
    );
    return result.rows[0] ?? null;
  }

  async #acquireConfirmationLease(
    changeId: string,
    leaseToken: string,
  ): Promise<PlanChangeRow | null> {
    const result = await this.#database.query<PlanChangeRow>(
      `update billing_plan_changes
          set status='applying',lease_token=$2::uuid,
              lease_expires_at=now()+make_interval(secs=>$3::double precision),
              updated_at=now()
        where id=$1::uuid and status in ('previewed','applying')
          and (lease_expires_at is null or lease_expires_at <= now())
          and (status='applying' or
               (preview_expires_at is not null and preview_expires_at > now()))
        returning *`,
      [changeId, leaseToken, this.#leaseTtlSeconds],
    );
    return result.rows[0] ?? null;
  }

  async #markRemoteStarted(
    changeId: string,
    leaseToken: string,
  ): Promise<PlanChangeRow> {
    const result = await this.#database.query<PlanChangeRow>(
      `update billing_plan_changes
          set remote_started_at=coalesce(remote_started_at,now()),updated_at=now()
        where id=$1::uuid and status='applying' and lease_token=$2::uuid
        returning *`,
      [changeId, leaseToken],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new PlanChangeConflictError(
        "plan-change confirmation lease was lost",
      );
    }
    return row;
  }

  async #expirePreviewIfIdle(row: PlanChangeRow): Promise<boolean> {
    if (row.status !== "previewed" || row.preview_expires_at === null) {
      return false;
    }
    const result = await this.#database.query<
      { readonly id: string } & QueryResultRow
    >(
      `update billing_plan_changes
          set status='failed',last_error='preview_expired',lease_token=null,
              lease_expires_at=null,updated_at=now()
        where id=$1::uuid and status='previewed'
          and preview_expires_at <= now()
          and (lease_expires_at is null or lease_expires_at <= now())
        returning id::text`,
      [row.id],
    );
    return result.rows[0] !== undefined;
  }

  #buildRequestSnapshot(
    row: PlanChangeRow,
    decision: TransitionDecision,
    context: PlanChangeContext,
    prorationDate: bigint | null,
  ): PlanChangeRequestSnapshot {
    if (decision.timing !== "immediate" && decision.timing !== "period_end") {
      throw new PlanChangeConflictError(
        "a no-op transition cannot create a Stripe request snapshot",
      );
    }
    const source = this.#catalog.require(decision.fromPlan);
    const target = this.#catalog.require(decision.targetPlan);
    const suffix = decision.timing === "immediate" ? "apply" : "schedule";
    return buildPlanChangeRequestSnapshot({
      context,
      timing: decision.timing,
      policy: decision.policy,
      prorationDate,
      idempotencyKey: `${row.stripe_request_key}:${suffix}`,
      requestApiVersion: this.#gateway.apiVersion ?? "2026-06-24.dahlia",
      productLine: this.#gateway.productLine ?? "example-entitlements",
      sourceLookupKey: this.#catalog.lookupKey(
        source.key,
        decision.fromInterval,
      ),
      targetLookupKey: this.#catalog.lookupKey(
        target.key,
        decision.targetInterval,
      ),
      sourcePlanKey: source.key,
      targetPlanKey: target.key,
      sourceCurrency: source.currency,
      targetCurrency: target.currency,
      sourceUnitAmount: expectedPriceAmount(source, decision.fromInterval),
      targetUnitAmount: expectedPriceAmount(target, decision.targetInterval),
    });
  }

  #validatedRequestSnapshot(row: PlanChangeRow): PlanChangeRequestSnapshot {
    if (
      row.request_snapshot_version !== 1 ||
      !isPlainRecord(row.stripe_request_snapshot)
    ) {
      if (row.remote_started_at !== null) {
        throw new PlanChangeUnavailableError(
          "the Stripe mutation started without a durable request snapshot; operator reconciliation is required",
        );
      }
      throw new PlanChangeConflictError(
        "the plan-change request snapshot is not frozen",
      );
    }
    const decision = decisionFromRow(row);
    if (decision.timing !== "immediate" && decision.timing !== "period_end") {
      throw new PlanChangeConflictError(
        "a no-op transition cannot carry a Stripe request snapshot",
      );
    }
    const suffix = decision.timing === "immediate" ? "apply" : "schedule";
    let snapshot: PlanChangeRequestSnapshot;
    try {
      snapshot = validatePlanChangeRequestSnapshot(
        row.stripe_request_snapshot,
        {
          idempotencyKey: `${row.stripe_request_key}:${suffix}`,
          subscriptionId: row.stripe_subscription_id,
          timing: decision.timing,
          policy: decision.policy,
        },
      );
    } catch (error: unknown) {
      if (error instanceof StripeRequestSnapshotError) {
        throw new PlanChangeUnavailableError(
          "the persisted plan-change request snapshot is invalid; operator reconciliation is required",
        );
      }
      throw error;
    }
    if (
      snapshot.price_evidence["source_plan_key"] !== row.from_plan_key ||
      snapshot.price_evidence["target_plan_key"] !== row.target_plan_key
    ) {
      throw new PlanChangeConflictError(
        "plan-change snapshot plan identity drifted",
      );
    }
    return snapshot;
  }

  async #retireUnfrozenIntent(
    changeId: string,
    leaseToken: string,
  ): Promise<void> {
    await this.#database.query(
      `update billing_plan_changes set status='failed',
              last_error='missing_remote_request_snapshot',
              lease_token=null,lease_expires_at=null,updated_at=now()
        where id=$1::uuid and lease_token=$2::uuid
          and request_snapshot_version is distinct from 1`,
      [changeId, leaseToken],
    );
  }

  async #executeRequestSnapshot(
    snapshot: PlanChangeRequestSnapshot,
  ): Promise<RemotePlanChange> {
    if (this.#gateway.executePlanChangeRequestSnapshot !== undefined) {
      return this.#gateway.executePlanChangeRequestSnapshot(snapshot);
    }
    const context = planChangeContextFromSnapshot(snapshot);
    if (snapshot.kind === "plan_change_schedule") {
      return this.#gateway.schedulePlanChange(context, {
        idempotencyKey: snapshot.idempotency_key,
      });
    }
    const rawProrationDate = snapshot.params["proration_date"];
    return this.#gateway.applyImmediatePlanChange(context, {
      idempotencyKey: snapshot.idempotency_key,
      policy: snapshot.policy,
      ...(typeof rawProrationDate === "number"
        ? { prorationDate: BigInt(rawProrationDate) }
        : {}),
    });
  }

  async #verifySnapshotBeforeRemoteStart(
    row: PlanChangeRow,
    snapshot: PlanChangeRequestSnapshot,
  ): Promise<void> {
    const frozen = planChangeContextFromSnapshot(snapshot);
    let observed: PlanChangeContext;
    if (this.#gateway.verifyPlanChangeRequestSnapshot !== undefined) {
      observed = await this.#gateway.verifyPlanChangeRequestSnapshot(snapshot);
    } else {
      const evidence = snapshot.price_evidence;
      observed = await this.#gateway.preparePlanChange({
        subscriptionId: frozen.subscriptionId,
        targetLookupKey: String(evidence["target_lookup_key"]),
        expectedCurrency: String(evidence["target_currency"]),
        expectedUnitAmount: BigInt(evidence["target_unit_amount"] as number),
        expectedPlanKey: String(evidence["target_plan_key"]),
        targetInterval: frozen.targetInterval,
        expectedSourceLookupKey: String(evidence["source_lookup_key"]),
        expectedSourceCurrency: String(evidence["source_currency"]),
        expectedSourceUnitAmount: BigInt(
          evidence["source_unit_amount"] as number,
        ),
        expectedSourcePlanKey: String(evidence["source_plan_key"]),
        sourceInterval: row.from_interval,
      });
    }
    if (observed.subscriptionItemId !== frozen.subscriptionItemId) {
      throw new PlanChangeConflictError(
        "Stripe subscription item identity changed",
      );
    }
    if (observed.currentPriceId !== frozen.currentPriceId) {
      throw new PlanChangeConflictError("Stripe source Price identity changed");
    }
    if (observed.currentPeriodStart !== frozen.currentPeriodStart) {
      throw new PlanChangeConflictError(
        "Stripe billing period drifted; reconcile first",
      );
    }
    await this.#revalidateBeforeRemote(
      row,
      observed,
      String(snapshot.price_evidence["target_lookup_key"]),
    );
  }

  async #storePreview(
    changeId: string,
    leaseToken: string,
    decision: TransitionDecision,
    context: PlanChangeContext,
    estimate: PlanChangeEstimate | null,
    prorationDate: bigint | null,
    requestSnapshot: PlanChangeRequestSnapshot,
  ): Promise<PlanChangeRow> {
    const result = await this.#database.query<PlanChangeRow>(
      `update billing_plan_changes
          set status='previewed',effective_mode=$3,
              effective_at=case when $3::text='period_end'
                                then to_timestamp($4::numeric) else null end,
              proration_date=$5::bigint,estimated_amount_due=$6::bigint,
              estimated_credit_applied=$7::bigint,
              estimated_customer_balance_credit=$8::bigint,
              estimate_currency=$9,estimated_source_proration=$10::bigint,
              estimated_target_proration=$11::bigint,
              estimated_period_start=to_timestamp($12::numeric),
              estimated_period_end=to_timestamp($13::numeric),
              preview_expires_at=now()+interval '10 minutes',
              request_snapshot_version=1,stripe_request_snapshot=$14::jsonb,
              lease_token=null,lease_expires_at=null,last_error=null,updated_at=now()
        where id=$1::uuid and lease_token=$2::uuid
          and remote_started_at is null
          and request_snapshot_version=0
          and stripe_request_snapshot is null
        returning *`,
      [
        changeId,
        leaseToken,
        decision.timing,
        context.currentPeriodEnd.toString(),
        prorationDate?.toString() ?? null,
        estimate?.amountDue.toString() ?? null,
        estimate?.prorationCredit.toString() ?? null,
        estimate?.customerBalanceCredit.toString() ?? null,
        estimate?.currency ?? null,
        estimate?.sourceProrationAmount.toString() ?? null,
        estimate?.targetProrationAmount.toString() ?? null,
        estimate?.periodStart?.toString() ?? null,
        estimate?.periodEnd?.toString() ?? null,
        JSON.stringify(requestSnapshot),
      ],
    );
    const stored = result.rows[0] ?? (await this.#get(changeId));
    this.#validatedRequestSnapshot(stored);
    return stored;
  }

  async #revalidateBeforeRemote(
    reserved: PlanChangeRow,
    context: PlanChangeContext,
    targetLookupKey: string,
  ): Promise<void> {
    const expectedLookupKey = this.#catalog.lookupKey(
      reserved.from_plan_key,
      reserved.from_interval,
    );
    if (context.subscriptionId !== reserved.stripe_subscription_id) {
      throw new PlanChangeConflictError("Stripe subscription identity changed");
    }
    const remoteStarted = reserved.remote_started_at !== null;
    const lookupAllowed = remoteStarted
      ? context.currentLookupKey === expectedLookupKey ||
        context.currentLookupKey === targetLookupKey
      : context.currentLookupKey === expectedLookupKey;
    if (!lookupAllowed) {
      throw new PlanChangeConflictError(
        "Stripe price drifted outside this transition",
      );
    }
    const expectedActive = reserved.expected_subscription_status === "active";
    const observedActive =
      context.subscriptionStatus === "active" ||
      context.subscriptionStatus === "trialing";
    if (observedActive !== expectedActive) {
      throw new PlanChangeConflictError("Stripe subscription status drifted");
    }
    if (context.cancelAtPeriodEnd !== reserved.expected_cancel_at_period_end) {
      throw new PlanChangeConflictError("Stripe cancellation state drifted");
    }
    const remoteTargetRecovery =
      remoteStarted &&
      reserved.transition_policy === "full_period_reset" &&
      context.currentLookupKey === targetLookupKey;
    if (
      reserved.expected_entitlement_period_end !== null &&
      !timestampEqualsEpoch(
        reserved.expected_entitlement_period_end,
        context.currentPeriodEnd,
      ) &&
      !remoteTargetRecovery
    ) {
      throw new PlanChangeConflictError(
        "Stripe billing period drifted; reconcile before changing plans",
      );
    }
    if (
      !remoteStarted &&
      (context.pendingUpdate || context.scheduleId !== null)
    ) {
      throw new PlanChangeConflictError(
        "Stripe already has an unrelated pending change",
      );
    }
    await this.#database.transaction(async (transaction) => {
      const accountResult = await transaction.query<BillingAccountRow>(
        "select * from billing_accounts where id=$1::uuid for update",
        [reserved.account_id],
      );
      const changeResult = await transaction.query<PlanChangeRow>(
        "select * from billing_plan_changes where id=$1::uuid for update",
        [reserved.id],
      );
      const account = accountResult.rows[0];
      const change = changeResult.rows[0];
      if (account === undefined || change === undefined) {
        throw new PlanChangeUnavailableError("plan change state disappeared");
      }
      if (!PlanChangeCoordinator.#accountMatchesSnapshot(account, reserved)) {
        throw new PlanChangeConflictError("local billing state changed");
      }
      if (
        reserved.transition_policy === "prorated_delta" &&
        reserved.effective_mode === "immediate"
      ) {
        const latest = await PlanChangeCoordinator.#latestFundingInvoice(
          transaction,
          account.id,
          pgBigInt(account.grant_epoch, "account grant_epoch"),
        );
        if (latest !== reserved.expected_source_invoice_id) {
          throw new PlanChangeConflictError(
            "entitlement funding lineage changed",
          );
        }
      }
      if (change.status === "completed") {
        return;
      }
    });
  }

  async #finish(
    changeId: string,
    leaseToken: string,
    input: {
      readonly status: PlanChangeStatus;
      readonly effectiveAtEpoch: bigint | null;
      readonly scheduleId: string | null;
      readonly pendingExpiresAtEpoch: bigint | null;
      readonly recoveryUrl: string | null;
      readonly settlementInvoiceId: string | null;
    },
  ): Promise<PlanChangeRow> {
    const updated = await this.#database.transaction(async (transaction) => {
      const result = await transaction.query<PlanChangeRow>(
        `update billing_plan_changes
            set status=case when status='completed' then status else $3 end,
                effective_at=coalesce(to_timestamp($4::numeric),effective_at),
                stripe_schedule_id=coalesce($5,stripe_schedule_id),
                remote_pending_expires_at=to_timestamp($6::numeric),
                recovery_url=$7,
                settlement_invoice_id=coalesce(settlement_invoice_id,$8),
                lease_token=null,lease_expires_at=null,last_error=null,updated_at=now()
          where id=$1::uuid and lease_token=$2::uuid
            and ($8::text is null or settlement_invoice_id is null
                 or settlement_invoice_id=$8)
          returning *`,
        [
          changeId,
          leaseToken,
          input.status,
          input.effectiveAtEpoch?.toString() ?? null,
          input.scheduleId,
          input.pendingExpiresAtEpoch?.toString() ?? null,
          input.recoveryUrl,
          input.settlementInvoiceId,
        ],
      );
      const row = result.rows[0];
      if (
        row !== undefined &&
        input.settlementInvoiceId !== null &&
        row.settlement_invoice_id === input.settlementInvoiceId
      ) {
        await transaction.query(
          `update billing_incidents
              set resolved_at=clock_timestamp(),last_seen_at=clock_timestamp()
            where account_id=$1::uuid and invoice_id=$2 and resolved_at is null
              and kind='unbound_plan_change_payment_failed'`,
          [row.account_id, input.settlementInvoiceId],
        );
      }
      return row;
    });
    if (updated !== undefined) {
      return updated;
    }
    const row = await this.#get(changeId);
    if (
      input.settlementInvoiceId !== null &&
      row.settlement_invoice_id !== null &&
      row.settlement_invoice_id !== input.settlementInvoiceId
    ) {
      throw new PlanChangeConflictError(
        "Stripe returned a different settlement Invoice for this plan change",
      );
    }
    return row;
  }

  async #releaseAfterError(
    changeId: string,
    leaseToken: string,
    lastError: string,
  ): Promise<void> {
    await this.#database.query(
      `update billing_plan_changes
          set status=case when status='applying' and remote_started_at is null
                          then 'previewed' else status end,
              lease_token=null,lease_expires_at=null,last_error=$3,updated_at=now()
        where id=$1::uuid and lease_token=$2::uuid`,
      [changeId, leaseToken, lastError],
    );
  }

  async #databaseEpoch(): Promise<bigint> {
    const result = await this.#database.query<
      { readonly epoch: string } & QueryResultRow
    >("select extract(epoch from now())::bigint as epoch");
    return pgBigInt(result.rows[0]?.epoch, "database epoch");
  }

  async #assertRemoteRetryWindow(row: PlanChangeRow): Promise<void> {
    if (row.remote_started_at === null) {
      return;
    }
    const result = await this.#database.query<
      { readonly too_old: boolean } & QueryResultRow
    >("select now() - $1::timestamptz >= interval '23 hours' as too_old", [
      row.remote_started_at,
    ]);
    if (result.rows[0]?.too_old === true) {
      throw new PlanChangeUnavailableError(
        "Stripe call outcome is too old to retry safely; reconcile it manually",
      );
    }
  }

  async #assertAccountSnapshot(reserved: PlanChangeRow): Promise<void> {
    const mismatch = await this.#database.transaction(async (transaction) => {
      const accountResult = await transaction.query<BillingAccountRow>(
        "select * from billing_accounts where id=$1::uuid for update",
        [reserved.account_id],
      );
      const changeResult = await transaction.query<
        { readonly status: PlanChangeStatus } & QueryResultRow
      >(
        "select status from billing_plan_changes where id=$1::uuid for update",
        [reserved.id],
      );
      const account = accountResult.rows[0];
      if (account === undefined) {
        throw new PlanChangeUnavailableError("billing account disappeared");
      }
      if (changeResult.rows[0]?.status === "completed") {
        return false;
      }
      let lineageMatches = true;
      if (
        reserved.transition_policy === "prorated_delta" &&
        reserved.effective_mode === "immediate"
      ) {
        const latest = await PlanChangeCoordinator.#latestFundingInvoice(
          transaction,
          account.id,
          pgBigInt(account.grant_epoch, "account grant_epoch"),
        );
        lineageMatches = latest === reserved.expected_source_invoice_id;
      }
      if (
        PlanChangeCoordinator.#accountMatchesSnapshot(account, reserved) &&
        lineageMatches
      ) {
        return false;
      }
      await transaction.query(
        `insert into billing_incidents(kind,dedupe_key,account_id,detail)
         values('plan_change_account_race',$1,$2::uuid,$3::jsonb)
         on conflict(kind,dedupe_key) where resolved_at is null do update set
           detail=excluded.detail,
           seen_count=billing_incidents.seen_count+1,
           last_seen_at=clock_timestamp()`,
        [
          reserved.id,
          account.id,
          JSON.stringify({
            expected_subscription: reserved.stripe_subscription_id,
          }),
        ],
      );
      return true;
    });
    if (mismatch) {
      throw new PlanChangeConflictError(
        "billing account changed during the Stripe call",
      );
    }
  }

  static #accountMatchesSnapshot(
    account: BillingAccountRow,
    reserved: PlanChangeRow,
  ): boolean {
    return (
      account.stripe_subscription_id === reserved.stripe_subscription_id &&
      account.plan_key === reserved.from_plan_key &&
      account.plan_interval === reserved.from_interval &&
      pgBigInt(account.grant_epoch, "account grant_epoch") ===
        pgBigInt(reserved.expected_grant_epoch, "expected grant_epoch") &&
      account.entitlement_period_end ===
        reserved.expected_entitlement_period_end &&
      account.subscription_status === reserved.expected_subscription_status &&
      account.cancel_at_period_end === reserved.expected_cancel_at_period_end &&
      account.entitlement_revoked === reserved.expected_entitlement_revoked
    );
  }

  static async #latestFundingInvoice(
    transaction: TransactionClient,
    accountId: string,
    grantEpoch: bigint,
  ): Promise<string | null> {
    const ledger = await transaction.query<
      { readonly stripe_invoice_id: string | null } & QueryResultRow
    >(
      `select stripe_invoice_id from credit_ledger
        where account_id=$1::uuid and grant_epoch=$2::bigint
          and grant_slot is not null and entitlement_units > 0
          and reason in ('subscription_grant','upgrade_delta_grant')
        order by id desc limit 1`,
      [accountId, grantEpoch.toString()],
    );
    const invoiceId = ledger.rows[0]?.stripe_invoice_id;
    if (invoiceId !== undefined && invoiceId !== null && invoiceId.length > 0) {
      return invoiceId;
    }
    const allocation = await transaction.query<
      { readonly source_invoice_id: string } & QueryResultRow
    >(
      `select source_invoice_id from billing_funding_allocations
        where account_id=$1::uuid and grant_epoch=$2::bigint
          and status in ('closed','disputed')
        order by id desc limit 1`,
      [accountId, grantEpoch.toString()],
    );
    return allocation.rows[0]?.source_invoice_id ?? null;
  }

  async #get(changeId: string): Promise<PlanChangeRow> {
    const result = await this.#database.query<PlanChangeRow>(
      "select * from billing_plan_changes where id=$1::uuid",
      [changeId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new PlanChangeUnavailableError("plan change not found");
    }
    return row;
  }
}

export type { PlanChangeContext, PlanChangeEstimate, RemotePlanChange };
