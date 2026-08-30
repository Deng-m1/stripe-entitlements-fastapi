import type { QueryResultRow } from "pg";

import type { PlanCatalog } from "./catalog.js";
import { collectPackDebtsFromSubscription } from "./credit-pack-funding.js";
import type { Database } from "./database.js";
import { pgBigInt, type TransactionClient } from "./db-types.js";
import { catalogPriceMatches } from "./price-policy.js";
import type {
  ProcessResult,
  PgTimestamp,
  SubscriptionSnapshot,
} from "./types.js";

const ZONED_INSTANT = /(?:Z|[+-][0-9]{2}:[0-9]{2})$/u;

interface AnnualRuntime {
  readonly productLine: string;
}

interface AnnualAccountRow extends QueryResultRow {
  readonly id: string;
  readonly stripe_subscription_id: string | null;
  readonly subscription_status: string;
  readonly plan_key: string;
  readonly plan_interval: string | null;
  readonly credits_balance: string;
  readonly grant_epoch: string;
  readonly current_period_end: PgTimestamp | null;
  readonly annual_anchor: PgTimestamp | null;
  readonly annual_grants_issued: number;
  readonly annual_grants_allowed: number;
  readonly funding_invoice_id: string | null;
  readonly entitlement_period_end: PgTimestamp | null;
  readonly entitlement_revoked: boolean;
}

interface AnnualCandidateRow extends QueryResultRow {
  readonly id: string;
  readonly stripe_subscription_id: string;
}

interface InvoiceStateRow extends QueryResultRow {
  readonly fully_refunded: boolean;
  readonly disputed: boolean;
}

function validatedWorkerTime(
  value: PgTimestamp | undefined,
): PgTimestamp | undefined {
  if (
    value !== undefined &&
    (value.length === 0 || !ZONED_INSTANT.test(value))
  ) {
    throw new TypeError(
      "annual worker time must be a timezone-aware timestamp string",
    );
  }
  return value;
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      "annual worker candidate limit must be a positive integer",
    );
  }
  return value;
}

/**
 * Distributed-safe annual-plan monthly grant worker.
 *
 * Stripe retrieval must happen before `grantDue`. The billing-account row lock,
 * invoice lock, and `(invoice, slot)` unique index converge concurrent workers.
 */
export class AnnualGrantService {
  readonly #database: Database;
  readonly #catalog: PlanCatalog;
  readonly #runtime: AnnualRuntime;

  public constructor(
    database: Database,
    catalog: PlanCatalog,
    runtime: AnnualRuntime,
  ) {
    this.#database = database;
    this.#catalog = catalog;
    this.#runtime = runtime;
  }

  public async recordFailure(
    accountId: string,
    subscriptionId: string,
    reason: string,
  ): Promise<void> {
    await this.#database.query(
      `insert into billing_incidents(kind,dedupe_key,account_id,detail)
       values('annual_grant_failed',$1,$2::uuid,$3::jsonb)
       on conflict(kind,dedupe_key) where resolved_at is null do update set
         detail=excluded.detail,seen_count=billing_incidents.seen_count+1,
         last_seen_at=clock_timestamp()`,
      [
        `${accountId}:${subscriptionId}`,
        accountId,
        JSON.stringify({ subscription_id: subscriptionId, reason }),
      ],
    );
  }

  /** Move a no-grant candidate behind older accounts in bounded scans. */
  public async deferCandidate(accountId: string): Promise<void> {
    await this.#database.query(
      "update billing_accounts set updated_at=clock_timestamp() where id=$1::uuid",
      [accountId],
    );
  }

  public async dueAccounts(
    now?: PgTimestamp,
    options: {
      readonly limit?: number;
      readonly excludeAccountIds?: ReadonlySet<string>;
    } = {},
  ): Promise<readonly AnnualCandidateRow[]> {
    const effectiveNow = validatedWorkerTime(now);
    const limit = positiveLimit(options.limit ?? 100);
    const excluded = [...(options.excludeAccountIds ?? [])];
    const result = await this.#database.query<AnnualCandidateRow>(
      `with observed as materialized (
         select coalesce($1::timestamptz,clock_timestamp()) as effective_now
       )
       select id::text,stripe_subscription_id
         from billing_accounts cross join observed
        where plan_interval='year' and subscription_status='active'
          and not entitlement_revoked
          and entitlement_period_end > observed.effective_now
          and annual_anchor is not null and funding_invoice_id is not null
          and annual_grants_issued < annual_grants_allowed
          and annual_anchor + make_interval(months => annual_grants_issued)
              <= observed.effective_now
          and not (id=any($3::uuid[]))
        order by updated_at,id limit $2`,
      [effectiveNow ?? null, limit, excluded],
    );
    return result.rows;
  }

  public async grantDue(
    accountId: string,
    now: PgTimestamp | undefined,
    snapshot: SubscriptionSnapshot,
  ): Promise<ProcessResult> {
    const requestedNow = validatedWorkerTime(now);
    return this.#database.transaction(async (transaction) => {
      const accountResult = await transaction.query<AnnualAccountRow>(
        `select *,coalesce($2::timestamptz,clock_timestamp()) as effective_now
           from billing_accounts where id=$1::uuid for update`,
        [accountId, requestedNow ?? null],
      );
      const account = accountResult.rows[0];
      if (account === undefined) {
        return { outcome: "ignored", reason: "account not found" };
      }
      const effectiveNow = (
        account as AnnualAccountRow & { readonly effective_now: PgTimestamp }
      ).effective_now;
      if (
        account.subscription_status !== "active" ||
        account.plan_interval !== "year"
      ) {
        return {
          outcome: "ignored",
          reason: "account is not an active annual plan",
          accountId,
        };
      }
      if (account.entitlement_revoked) {
        return {
          outcome: "ignored",
          reason: "annual entitlement is revoked",
          accountId,
        };
      }
      if (
        account.entitlement_period_end === null ||
        !(await this.#timestampAfter(
          transaction,
          account.entitlement_period_end,
          effectiveNow,
        ))
      ) {
        return {
          outcome: "ignored",
          reason: "annual entitlement period has ended",
          accountId,
        };
      }
      if (snapshot.subscriptionId !== account.stripe_subscription_id) {
        return {
          outcome: "ignored",
          reason: "subscription changed during remote verification",
          accountId,
        };
      }
      if (snapshot.status !== "active" && snapshot.status !== "trialing") {
        return {
          outcome: "ignored",
          reason: "Stripe subscription is not active",
          accountId,
        };
      }

      const parsed = this.#catalog.parseLookupKey(snapshot.lookupKey);
      const periodMatches =
        snapshot.currentPeriodEnd !== undefined &&
        account.entitlement_period_end !== null &&
        account.current_period_end !== null &&
        (await this.#timestampsEqual(
          transaction,
          snapshot.currentPeriodEnd,
          account.entitlement_period_end,
          account.current_period_end,
        ));
      const priceMatches =
        snapshot.itemsComplete &&
        parsed !== undefined &&
        snapshot.quantity === 1n &&
        snapshot.resolvedPrice !== undefined &&
        catalogPriceMatches(snapshot.resolvedPrice, {
          expectedCurrency: parsed[0].currency,
          expectedUnitAmount: parsed[0].yearUsd * 100,
          expectedInterval: "year",
          expectedProductLine: this.#runtime.productLine,
          expectedPlanKey: parsed[0].key,
          expectedLookupKey: this.#catalog.lookupKey(parsed[0].key, "year"),
          requireActive: false,
        });
      if (
        parsed === undefined ||
        parsed[0].key !== account.plan_key ||
        parsed[1] !== "year" ||
        !periodMatches ||
        !priceMatches
      ) {
        await this.#recordMismatch(transaction, account, snapshot);
        return {
          outcome: "ignored",
          reason: "remote and local annual plans differ",
          accountId,
        };
      }

      const dedupeKey = `${accountId}:${account.stripe_subscription_id ?? ""}`;
      await transaction.query(
        `update billing_incidents set resolved_at=clock_timestamp(),
             last_seen_at=clock_timestamp()
           where kind='annual_plan_mismatch' and dedupe_key=$1
             and resolved_at is null`,
        [dedupeKey],
      );
      const boundaryResult = await transaction.query<
        { readonly target_slot: number } & QueryResultRow
      >(
        `select least(
             coalesce(max(slot),0)+1,
             $3::integer,
             12
           )::integer as target_slot
           from generate_series(1,12) slot
          where $1::timestamptz + make_interval(months => slot)
                <= $2::timestamptz`,
        [account.annual_anchor, effectiveNow, account.annual_grants_allowed],
      );
      const targetSlot = boundaryResult.rows[0]?.target_slot;
      if (targetSlot === undefined) {
        throw new Error("annual slot computation returned no row");
      }
      if (targetSlot <= account.annual_grants_issued) {
        await this.#resolveFailure(transaction, accountId);
        return {
          outcome: "replayed",
          reason: "the current annual slot was already granted",
          accountId,
        };
      }
      const invoiceId = account.funding_invoice_id;
      if (invoiceId === null) {
        return {
          outcome: "ignored",
          reason: "funding invoice state is missing",
          accountId,
        };
      }
      const invoiceResult = await transaction.query<InvoiceStateRow>(
        "select fully_refunded,disputed from stripe_invoice_state where invoice_id=$1 for update",
        [invoiceId],
      );
      const invoice = invoiceResult.rows[0];
      if (invoice === undefined) {
        return {
          outcome: "ignored",
          reason: "funding invoice state is missing",
          accountId,
        };
      }
      if (invoice.fully_refunded || invoice.disputed) {
        await transaction.query(
          `update billing_accounts set annual_grants_allowed=annual_grants_issued,
             updated_at=now() where id=$1::uuid`,
          [accountId],
        );
        return {
          outcome: "ignored",
          reason: "funding invoice is closed",
          accountId,
        };
      }

      const plan = parsed[0];
      const oldBalance = pgBigInt(
        account.credits_balance,
        "account credits_balance",
      );
      const newEpoch =
        pgBigInt(account.grant_epoch, "account grant_epoch") + 1n;
      const grantAtoms = plan.monthlyCredits.atoms;
      const eventId = `annual:${invoiceId}:${targetSlot}`;
      await transaction.query(
        `update billing_accounts set credits_balance=$2::bigint,
             grant_epoch=$3::bigint,annual_grants_issued=$4::smallint,
             credit_expires_at=least(
               entitlement_period_end,
               annual_anchor + make_interval(months => ($4::smallint)::integer)
             ),updated_at=now()
           where id=$1::uuid`,
        [accountId, grantAtoms.toString(), newEpoch.toString(), targetSlot],
      );
      await transaction.query(
        `insert into credit_ledger(
           account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
           stripe_event_id,stripe_invoice_id,grant_slot
         ) values(
           $1::uuid,$2::bigint,$3::bigint,$4::bigint,'subscription_grant',
           $5::bigint,$6,$7,$8
         )`,
        [
          accountId,
          (grantAtoms - oldBalance).toString(),
          grantAtoms.toString(),
          grantAtoms.toString(),
          newEpoch.toString(),
          eventId,
          invoiceId,
          targetSlot,
        ],
      );
      await transaction.query(
        `update stripe_invoice_state
            set grants_issued=greatest(grants_issued,$2::smallint),updated_at=now()
          where invoice_id=$1`,
        [invoiceId, targetSlot],
      );
      await collectPackDebtsFromSubscription(transaction, {
        accountId,
        grantEpoch: newEpoch,
        eventId: `pack-debt:${eventId}`,
      });
      await this.#resolveFailure(transaction, accountId);
      return {
        outcome: "handled",
        reason: `granted annual slot ${targetSlot}`,
        accountId,
      };
    });
  }

  async #timestampAfter(
    transaction: TransactionClient,
    left: PgTimestamp,
    right: PgTimestamp,
  ): Promise<boolean> {
    const result = await transaction.query<
      { readonly matches: boolean } & QueryResultRow
    >("select $1::timestamptz > $2::timestamptz as matches", [left, right]);
    return result.rows[0]?.matches === true;
  }

  async #timestampsEqual(
    transaction: TransactionClient,
    first: PgTimestamp,
    second: PgTimestamp,
    third: PgTimestamp,
  ): Promise<boolean> {
    const result = await transaction.query<
      { readonly matches: boolean } & QueryResultRow
    >(
      `select $1::timestamptz=$2::timestamptz
              and $1::timestamptz=$3::timestamptz as matches`,
      [first, second, third],
    );
    return result.rows[0]?.matches === true;
  }

  async #recordMismatch(
    transaction: TransactionClient,
    account: AnnualAccountRow,
    snapshot: SubscriptionSnapshot,
  ): Promise<void> {
    const priceId = snapshot.resolvedPrice?.["id"];
    await transaction.query(
      `insert into billing_incidents(kind,dedupe_key,account_id,invoice_id,detail)
       values('annual_plan_mismatch',$1,$2::uuid,$3,$4::jsonb)
       on conflict(kind,dedupe_key) where resolved_at is null do update set
         detail=excluded.detail,seen_count=billing_incidents.seen_count+1,
         last_seen_at=clock_timestamp()`,
      [
        `${account.id}:${account.stripe_subscription_id ?? ""}`,
        account.id,
        account.funding_invoice_id,
        JSON.stringify({
          remote_lookup_key: snapshot.lookupKey ?? null,
          remote_price_id: typeof priceId === "string" ? priceId : null,
          remote_quantity: snapshot.quantity?.toString() ?? null,
          remote_items_complete: snapshot.itemsComplete,
          remote_period_end: snapshot.currentPeriodEnd ?? null,
          local_plan: account.plan_key,
          local_period_end: account.entitlement_period_end,
        }),
      ],
    );
  }

  async #resolveFailure(
    transaction: TransactionClient,
    accountId: string,
  ): Promise<void> {
    await transaction.query(
      `update billing_incidents set resolved_at=clock_timestamp(),
           last_seen_at=clock_timestamp()
         where account_id=$1::uuid and resolved_at is null
           and kind='annual_grant_failed'`,
      [accountId],
    );
  }
}
