import { createHash } from "node:crypto";

import type { QueryResultRow } from "pg";

import type { Database } from "./database.js";
import type { StripeObject } from "./processor-primitives.js";
import type { ProcessResult, PgTimestamp } from "./types.js";
import { isPlainRecord } from "./validation.js";

const PAID_CAS_RETRY_LIMIT = 3;
// PostgreSQL commonly renders UTC as `+00`, while callers may supply `Z`,
// `+00:00`, or `+0000`; all are explicit timezone offsets.
// The expression is anchored and every repetition has a fixed maximum.
// eslint-disable-next-line security/detect-unsafe-regex
const ZONED_INSTANT = /(?:Z|[+-][0-9]{2}(?::?[0-9]{2})?)$/u;

export interface ReconciliationGateway {
  subscriptionObject(subscriptionId: string): Promise<StripeObject>;
  latestPaidInvoiceEvent(
    subscriptionId: string,
  ): Promise<Record<string, unknown> | undefined>;
}

export interface ReconciliationProcessor {
  process(event: unknown): Promise<ProcessResult>;
}

interface ProjectionSnapshot {
  readonly stripe_subscription_id: string;
  readonly event_created: string;
  readonly event_rank: number;
}

interface ValidatedSubscription {
  readonly ok: true;
  readonly subscription: StripeObject;
  readonly status: string;
  readonly livemode: boolean;
}

interface InvalidSubscription {
  readonly ok: false;
  readonly result: ProcessResult;
}

type SubscriptionRetrieval = ValidatedSubscription | InvalidSubscription;

interface ReconciliationAccountRow extends QueryResultRow {
  readonly id: string;
  readonly stripe_subscription_id: string | null;
  readonly event_created: string;
  readonly event_rank: number;
}

interface AttemptRow extends QueryResultRow {
  readonly started_at: PgTimestamp;
  readonly database_epoch: string;
  readonly transaction_id: string;
}

interface CandidateRow extends QueryResultRow {
  readonly id: string;
  readonly stripe_subscription_id: string;
  readonly last_reconciled_at: PgTimestamp | null;
}

interface PendingPlanChangeRow extends QueryResultRow {
  readonly id: string;
  readonly status: string;
  readonly settlement_invoice_id: string | null;
  readonly updated_at: PgTimestamp;
}

function projectionCommitted(result: ProcessResult): boolean {
  return result.outcome === "handled" || result.outcome === "replayed";
}

function pythonScalarFingerprintValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "NoneType:None";
  }
  if (typeof value === "string") {
    return `str:${value}`;
  }
  if (typeof value === "boolean") {
    return `bool:${value ? "True" : "False"}`;
  }
  if (typeof value === "number") {
    return `${Number.isInteger(value) ? "int" : "float"}:${String(value)}`;
  }
  let typeName: string = typeof value;
  if (Array.isArray(value)) {
    typeName = "list";
  } else if (typeof value === "object") {
    typeName = value.constructor?.name ?? "object";
  }
  return `str:${typeName}`;
}

/** Hash only the customer identity fact used by cancellation projection. */
export function customerFactFingerprint(subscription: StripeObject): string {
  const customer = subscription["customer"];
  const identity = isPlainRecord(customer) ? customer["id"] : customer;
  return createHash("sha256")
    .update(pythonScalarFingerprintValue(identity))
    .digest("hex")
    .slice(0, 16);
}

function validatedInstant(
  value: PgTimestamp | undefined,
  field: string,
): PgTimestamp | undefined {
  if (
    value !== undefined &&
    (value.length === 0 || !ZONED_INSTANT.test(value))
  ) {
    throw new TypeError(`${field} must be a timezone-aware timestamp string`);
  }
  return value;
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      "reconciliation candidate limit must be a positive integer",
    );
  }
  return value;
}

function syntheticEvent(
  base: Record<string, unknown>,
): Record<string, unknown> {
  return { ...base };
}

/** Repairs webhook loss by comparing stale local accounts with Stripe truth. */
export class ReconciliationService {
  readonly #database: Database;
  readonly #processor: ReconciliationProcessor;
  readonly #gateway: ReconciliationGateway;

  public constructor(
    database: Database,
    processor: ReconciliationProcessor,
    gateway: ReconciliationGateway,
  ) {
    this.#database = database;
    this.#processor = processor;
    this.#gateway = gateway;
  }

  public async databaseNow(): Promise<PgTimestamp> {
    const result = await this.#database.query<
      { readonly value: PgTimestamp } & QueryResultRow
    >("select clock_timestamp() as value");
    const value = result.rows[0]?.value;
    if (value === undefined) {
      throw new Error("database clock query returned no row");
    }
    return value;
  }

  async #accountProjectionSnapshot(
    accountId: string,
    subscriptionId: string,
  ): Promise<ProjectionSnapshot | undefined> {
    const result = await this.#database.query<ReconciliationAccountRow>(
      `select stripe_subscription_id,event_created,event_rank
         from billing_accounts where id=$1::uuid`,
      [accountId],
    );
    const row = result.rows[0];
    if (row === undefined || row.stripe_subscription_id !== subscriptionId) {
      return undefined;
    }
    return {
      stripe_subscription_id: subscriptionId,
      event_created: row.event_created,
      event_rank: row.event_rank,
    };
  }

  async #validatedSubscriptionObject(
    accountId: string,
    subscriptionId: string,
  ): Promise<SubscriptionRetrieval> {
    let subscription: StripeObject;
    try {
      subscription = await this.#gateway.subscriptionObject(subscriptionId);
    } catch (error) {
      await this.#incident(
        accountId,
        subscriptionId,
        `subscription retrieval failed: ${
          error instanceof Error ? error.constructor.name : "UnknownError"
        }`,
      );
      throw error;
    }
    const status = subscription["status"];
    const livemode = subscription["livemode"];
    if (subscription["id"] !== subscriptionId) {
      await this.#incident(
        accountId,
        subscriptionId,
        "Stripe returned a different subscription",
      );
      return {
        ok: false,
        result: {
          outcome: "ignored",
          reason: "Stripe returned a different subscription",
          accountId,
        },
      };
    }
    if (typeof status !== "string" || status.length === 0) {
      await this.#incident(
        accountId,
        subscriptionId,
        "Stripe returned an invalid subscription status",
      );
      return {
        ok: false,
        result: {
          outcome: "ignored",
          reason: "Stripe returned an invalid subscription status",
          accountId,
        },
      };
    }
    if (typeof livemode !== "boolean") {
      await this.#incident(
        accountId,
        subscriptionId,
        "Stripe returned an invalid subscription mode",
      );
      return {
        ok: false,
        result: {
          outcome: "ignored",
          reason: "Stripe returned an invalid subscription mode",
          accountId,
        },
      };
    }
    return { ok: true, subscription, status, livemode };
  }

  public async candidates(
    now?: PgTimestamp,
    options: {
      readonly limit?: number;
      readonly attemptedBefore?: PgTimestamp;
      readonly excludeAccountIds?: ReadonlySet<string>;
    } = {},
  ): Promise<readonly CandidateRow[]> {
    const effectiveNow = validatedInstant(now, "reconciliation time");
    const attemptedBefore = validatedInstant(
      options.attemptedBefore,
      "reconciliation attempted-before time",
    );
    const limit = positiveLimit(options.limit ?? 100);
    const excluded = [...(options.excludeAccountIds ?? [])];
    const result = await this.#database.query<CandidateRow>(
      `with observed as materialized (
         select coalesce($1::timestamptz,clock_timestamp()) as effective_now
       ), cutoffs as materialized (
         select effective_now-interval '3 days' as stale_before,
                effective_now-interval '5 minutes' as pending_before,
                coalesce($2::timestamptz,effective_now) as attempted_before,
                effective_now
           from observed
       )
       select distinct a.id::text,a.stripe_subscription_id,a.last_reconciled_at
         from billing_accounts a cross join cutoffs
         left join billing_incidents i
           on i.account_id=a.id and i.resolved_at is null
        where a.stripe_subscription_id is not null
          and (a.last_reconciled_at is null
               or a.last_reconciled_at < cutoffs.attempted_before)
          and not (a.id=any($4::uuid[]))
          and (
            a.subscription_status='past_due'
            or (a.subscription_status='active'
                and a.current_period_end < cutoffs.stale_before)
            or (a.subscription_status='active'
                and a.entitlement_period_end < cutoffs.effective_now)
            or i.kind in (
              'stale_paid_event','annual_plan_mismatch',
              'reconciliation_failed','event_order_tie'
            )
            or exists(
              select 1 from billing_plan_changes p
               where p.account_id=a.id
                 and p.status in ('applying','applied','requires_action')
                 and p.updated_at < cutoffs.pending_before
            )
          )
        order by a.last_reconciled_at nulls first,a.id::text limit $3`,
      [effectiveNow ?? null, attemptedBefore ?? null, limit, excluded],
    );
    return result.rows;
  }

  public async reconcileAccount(accountId: string): Promise<ProcessResult> {
    const accountResult = await this.#database.query<ReconciliationAccountRow>(
      "select id::text,stripe_subscription_id,event_created,event_rank from billing_accounts where id=$1::uuid",
      [accountId],
    );
    const account = accountResult.rows[0];
    if (account === undefined || account.stripe_subscription_id === null) {
      return {
        outcome: "ignored",
        reason: "account has no subscription",
        accountId,
      };
    }
    const attemptResult = await this.#database.query<AttemptRow>(
      `update billing_accounts set last_reconciled_at=clock_timestamp()
         where id=$1::uuid returning
           last_reconciled_at as started_at,
           extract(epoch from last_reconciled_at)::bigint as database_epoch,
           txid_current()::text as transaction_id`,
      [accountId],
    );
    const attempt = attemptResult.rows[0];
    if (attempt === undefined) {
      return { outcome: "ignored", reason: "account disappeared", accountId };
    }
    const attemptFingerprint = createHash("sha256")
      .update(`${attempt.started_at}:${attempt.transaction_id}`)
      .digest("hex")
      .slice(0, 16);
    const expectedSubscription = account.stripe_subscription_id;
    let expectedAccount: ProjectionSnapshot = {
      stripe_subscription_id: expectedSubscription,
      event_created: account.event_created,
      event_rank: account.event_rank,
    };

    const initialSubscription = await this.#validatedSubscriptionObject(
      accountId,
      expectedSubscription,
    );
    if (!initialSubscription.ok) {
      return initialSubscription.result;
    }
    let { subscription, status, livemode } = initialSubscription;

    if (status === "canceled" || status === "incomplete_expired") {
      return this.#reconcileCancellation({
        accountId,
        subscriptionId: expectedSubscription,
        subscription,
        expectedAccount,
        attempt,
        attemptFingerprint,
        livemode,
        allowFreshRetry: true,
      });
    }

    let statusEvent = syntheticEvent({
      id: `reconcile:${expectedSubscription}:status:${status}:${attempt.database_epoch}:${expectedAccount.event_created}:${expectedAccount.event_rank}`,
      object: "event",
      type: "customer.subscription.updated",
      created: Number(attempt.database_epoch),
      livemode,
      _remote_verified: true,
      _expected_account: expectedAccount,
      data: { object: subscription },
    });
    let statusResult = await this.#process(
      statusEvent,
      accountId,
      expectedSubscription,
    );
    if (
      !projectionCommitted(statusResult) &&
      statusResult.reason === "older or weaker than the applied state"
    ) {
      const refreshed = await this.#accountProjectionSnapshot(
        accountId,
        expectedSubscription,
      );
      if (refreshed !== undefined) {
        expectedAccount = refreshed;
        const freshSubscription = await this.#validatedSubscriptionObject(
          accountId,
          expectedSubscription,
        );
        if (!freshSubscription.ok) {
          return freshSubscription.result;
        }
        ({ subscription, status, livemode } = freshSubscription);
        if (status === "canceled" || status === "incomplete_expired") {
          return this.#reconcileCancellation({
            accountId,
            subscriptionId: expectedSubscription,
            subscription,
            expectedAccount,
            attempt,
            attemptFingerprint,
            livemode,
            allowFreshRetry: false,
          });
        }
        statusEvent = {
          ...statusEvent,
          id: `reconcile:${expectedSubscription}:status:${status}:${attempt.database_epoch}:${expectedAccount.event_created}:${expectedAccount.event_rank}`,
          livemode,
          _expected_account: expectedAccount,
          data: { object: subscription },
        };
        statusResult = await this.#process(
          statusEvent,
          accountId,
          expectedSubscription,
        );
      }
    }
    if (!projectionCommitted(statusResult)) {
      await this.#incident(
        accountId,
        expectedSubscription,
        `status projection did not commit: ${statusResult.reason ?? statusResult.outcome}`,
      );
      return statusResult;
    }
    await this.#resolveStatusIncidents(accountId, attempt.started_at);

    if (status !== "active" && status !== "trialing") {
      return statusResult;
    }
    const refreshed = await this.#accountProjectionSnapshot(
      accountId,
      expectedSubscription,
    );
    if (refreshed === undefined) {
      await this.#incident(
        accountId,
        expectedSubscription,
        "local subscription changed during status reconciliation",
      );
      return {
        outcome: "ignored",
        reason: "local subscription changed during reconciliation",
        accountId,
      };
    }
    expectedAccount = refreshed;
    let paid: Record<string, unknown> | undefined;
    try {
      paid = await this.#gateway.latestPaidInvoiceEvent(expectedSubscription);
    } catch (error) {
      await this.#incident(
        accountId,
        expectedSubscription,
        `paid Invoice retrieval failed: ${
          error instanceof Error ? error.constructor.name : "UnknownError"
        }`,
      );
      throw error;
    }
    if (paid === undefined) {
      await this.#incident(accountId, expectedSubscription, "no paid invoice");
      return {
        outcome: "ignored",
        reason: "active subscription has no paid invoice",
        accountId,
      };
    }
    const data = paid["data"];
    const object = isPlainRecord(data) ? data["object"] : undefined;
    const rawInvoiceId = isPlainRecord(object) ? object["id"] : undefined;
    const invoiceId =
      typeof rawInvoiceId === "string" && rawInvoiceId.length > 0
        ? rawInvoiceId
        : "unknown";
    const failedEventIds: string[] = [];
    let result: ProcessResult = {
      outcome: "ignored",
      reason: "paid projection was not attempted",
      accountId,
    };
    for (let retry = 0; retry <= PAID_CAS_RETRY_LIMIT; retry += 1) {
      const eventId = `reconcile:${invoiceId}:${expectedSubscription}:${expectedAccount.event_created}:${expectedAccount.event_rank}`;
      const paidEvent = {
        ...paid,
        id: eventId,
        _remote_verified: true,
        _expected_account: expectedAccount,
      };
      result = await this.#process(paidEvent, accountId, expectedSubscription);
      if (
        projectionCommitted(result) ||
        result.reason !== "older than the paid entitlement period" ||
        retry === PAID_CAS_RETRY_LIMIT
      ) {
        break;
      }
      const next = await this.#accountProjectionSnapshot(
        accountId,
        expectedSubscription,
      );
      if (
        next === undefined ||
        this.#sameProjectionSnapshot(next, expectedAccount)
      ) {
        break;
      }
      failedEventIds.push(eventId);
      expectedAccount = next;
    }
    if (projectionCommitted(result) && failedEventIds.length > 0) {
      await this.#resolveStalePaidAttempts(
        accountId,
        invoiceId,
        failedEventIds,
      );
    }
    const pending = await this.#pendingPlanChange(accountId);
    if (pending !== undefined) {
      await this.#planChangeRecoveryIncident(
        accountId,
        expectedSubscription,
        pending,
      );
    } else if (projectionCommitted(result)) {
      await this.#resolveIncidents(accountId, attempt.started_at);
    } else if (result.reason !== "older than the paid entitlement period") {
      await this.#incident(
        accountId,
        expectedSubscription,
        `paid projection did not commit: ${result.reason ?? result.outcome}`,
      );
    }
    return result;
  }

  async #reconcileCancellation(input: {
    readonly accountId: string;
    readonly subscriptionId: string;
    readonly subscription: StripeObject;
    readonly expectedAccount: ProjectionSnapshot;
    readonly attempt: AttemptRow;
    readonly attemptFingerprint: string;
    readonly livemode: boolean;
    readonly allowFreshRetry: boolean;
  }): Promise<ProcessResult> {
    const canceledAt = input.subscription["canceled_at"];
    if (
      canceledAt !== undefined &&
      canceledAt !== null &&
      (typeof canceledAt !== "number" ||
        !Number.isSafeInteger(canceledAt) ||
        canceledAt < 0)
    ) {
      await this.#incident(
        input.accountId,
        input.subscriptionId,
        "Stripe returned an invalid cancellation timestamp",
      );
      return {
        outcome: "ignored",
        reason: "Stripe returned an invalid cancellation timestamp",
        accountId: input.accountId,
      };
    }
    const created =
      typeof canceledAt === "number"
        ? canceledAt
        : Number(input.attempt.database_epoch);
    const customerFingerprint = customerFactFingerprint(input.subscription);
    let expected = input.expectedAccount;
    let event = syntheticEvent({
      id: `reconcile:${input.subscriptionId}:deleted:${created}:${expected.event_created}:${expected.event_rank}:${input.attemptFingerprint}:${customerFingerprint}`,
      object: "event",
      type: "customer.subscription.deleted",
      created,
      livemode: input.livemode,
      _remote_verified: true,
      _expected_account: expected,
      data: { object: input.subscription },
    });
    let result = await this.#process(
      event,
      input.accountId,
      input.subscriptionId,
    );
    if (
      input.allowFreshRetry &&
      !projectionCommitted(result) &&
      result.reason === "older than the applied state"
    ) {
      const refreshed = await this.#accountProjectionSnapshot(
        input.accountId,
        input.subscriptionId,
      );
      if (refreshed !== undefined) {
        expected = refreshed;
        const fresh = await this.#validatedSubscriptionObject(
          input.accountId,
          input.subscriptionId,
        );
        if (!fresh.ok) {
          return fresh.result;
        }
        if (
          fresh.status !== "canceled" &&
          fresh.status !== "incomplete_expired"
        ) {
          await this.#incident(
            input.accountId,
            input.subscriptionId,
            "remote subscription changed during cancellation reconciliation",
          );
          return {
            outcome: "ignored",
            reason: "remote subscription changed during reconciliation",
            accountId: input.accountId,
          };
        }
        const freshCanceledAt = fresh.subscription["canceled_at"];
        if (
          freshCanceledAt !== undefined &&
          freshCanceledAt !== null &&
          (typeof freshCanceledAt !== "number" ||
            !Number.isSafeInteger(freshCanceledAt) ||
            freshCanceledAt < 0)
        ) {
          await this.#incident(
            input.accountId,
            input.subscriptionId,
            "Stripe returned an invalid cancellation timestamp",
          );
          return {
            outcome: "ignored",
            reason: "Stripe returned an invalid cancellation timestamp",
            accountId: input.accountId,
          };
        }
        const freshCreated =
          typeof freshCanceledAt === "number"
            ? freshCanceledAt
            : Number(input.attempt.database_epoch);
        const freshCustomerFingerprint = customerFactFingerprint(
          fresh.subscription,
        );
        event = {
          ...event,
          id: `reconcile:${input.subscriptionId}:deleted:${freshCreated}:${expected.event_created}:${expected.event_rank}:${input.attemptFingerprint}:${freshCustomerFingerprint}`,
          created: freshCreated,
          livemode: fresh.livemode,
          _expected_account: expected,
          data: { object: fresh.subscription },
        };
        result = await this.#process(
          event,
          input.accountId,
          input.subscriptionId,
        );
      }
    }
    if (projectionCommitted(result)) {
      await this.#resolveIncidents(input.accountId, input.attempt.started_at);
    } else {
      await this.#incident(
        input.accountId,
        input.subscriptionId,
        `cancellation projection did not commit: ${result.reason ?? result.outcome}`,
      );
    }
    return result;
  }

  #sameProjectionSnapshot(
    left: ProjectionSnapshot,
    right: ProjectionSnapshot,
  ): boolean {
    return (
      left.stripe_subscription_id === right.stripe_subscription_id &&
      left.event_created === right.event_created &&
      left.event_rank === right.event_rank
    );
  }

  async #process(
    event: Record<string, unknown>,
    accountId: string,
    subscriptionId: string,
  ): Promise<ProcessResult> {
    try {
      const result = await this.#processor.process(event);
      if (
        result.outcome !== "duplicate" ||
        result.reason !== "event id already committed"
      ) {
        return result;
      }
      const committed = await this.#database.query<
        {
          readonly outcome: string | null;
          readonly reason: string | null;
        } & QueryResultRow
      >("select outcome,reason from stripe_webhook_events where id=$1", [
        event["id"],
      ]);
      const row = committed.rows[0];
      if (row === undefined) {
        throw new Error("committed reconciliation Event audit row disappeared");
      }
      if (row.outcome === "handled" || row.outcome === "replayed") {
        return {
          outcome: "replayed",
          reason: "synthetic Event already committed a projection",
          accountId,
        };
      }
      return {
        outcome: "ignored",
        reason: row.reason ?? row.outcome ?? "incomplete",
        accountId,
      };
    } catch (error) {
      await this.#incident(
        accountId,
        subscriptionId,
        `projection failed: ${error instanceof Error ? error.constructor.name : "UnknownError"}`,
      );
      throw error;
    }
  }

  async #pendingPlanChange(
    accountId: string,
  ): Promise<PendingPlanChangeRow | undefined> {
    const result = await this.#database.query<PendingPlanChangeRow>(
      `select id::text,status,settlement_invoice_id,updated_at
         from billing_plan_changes where account_id=$1::uuid
          and status in ('applying','applied','requires_action')
        order by updated_at,id limit 1`,
      [accountId],
    );
    return result.rows[0];
  }

  async #planChangeRecoveryIncident(
    accountId: string,
    subscriptionId: string,
    change: PendingPlanChangeRow,
  ): Promise<void> {
    await this.#database.query(
      `insert into billing_incidents(kind,dedupe_key,account_id,invoice_id,detail)
       values('plan_change_recovery_required',$1,$2::uuid,$3,$4::jsonb)
       on conflict(kind,dedupe_key) where resolved_at is null do update set
         invoice_id=coalesce(excluded.invoice_id,billing_incidents.invoice_id),
         detail=excluded.detail,seen_count=billing_incidents.seen_count+1,
         last_seen_at=clock_timestamp()`,
      [
        `${accountId}:${change.id}`,
        accountId,
        change.settlement_invoice_id,
        JSON.stringify({
          subscription_id: subscriptionId,
          plan_change_id: change.id,
          status: change.status,
          updated_at: change.updated_at,
          recovery:
            "retry the same preview id or inspect its exact settlement invoice",
        }),
      ],
    );
  }

  async #incident(
    accountId: string,
    subscriptionId: string,
    reason: string,
  ): Promise<void> {
    await this.#database.query(
      `insert into billing_incidents(kind,dedupe_key,account_id,detail)
       values('reconciliation_failed',$1,$2::uuid,$3::jsonb)
       on conflict(kind,dedupe_key) where resolved_at is null do update set
         detail=excluded.detail,seen_count=billing_incidents.seen_count+1,
         last_seen_at=clock_timestamp()`,
      [`${accountId}:${subscriptionId}`, accountId, JSON.stringify({ reason })],
    );
  }

  async #resolveStalePaidAttempts(
    accountId: string,
    invoiceId: string,
    failedEventIds: readonly string[],
  ): Promise<void> {
    await this.#database.query(
      `update billing_incidents set resolved_at=clock_timestamp()
         where account_id=$1::uuid and invoice_id=$2
           and kind='stale_paid_event' and resolved_at is null
           and stripe_event_id=any($3::text[])`,
      [accountId, invoiceId, failedEventIds],
    );
  }

  async #resolveStatusIncidents(
    accountId: string,
    attemptStartedAt: PgTimestamp,
  ): Promise<void> {
    await this.#database.query(
      `update billing_incidents set resolved_at=now()
         where account_id=$1::uuid and resolved_at is null
           and last_seen_at < $2::timestamptz
           and kind in ('reconciliation_failed','event_order_tie')`,
      [accountId, attemptStartedAt],
    );
  }

  async #resolveIncidents(
    accountId: string,
    attemptStartedAt: PgTimestamp,
  ): Promise<void> {
    await this.#database.query(
      `update billing_incidents set resolved_at=now()
         where account_id=$1::uuid and resolved_at is null
           and last_seen_at < $2::timestamptz
           and kind in (
             'stale_paid_event','annual_plan_mismatch','reconciliation_failed',
             'event_order_tie','plan_change_recovery_required'
           )`,
      [accountId, attemptStartedAt],
    );
  }
}
