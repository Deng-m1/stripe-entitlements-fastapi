import type { PoolClient, QueryResult, QueryResultRow } from "pg";

declare const pgInt8Brand: unique symbol;
declare const pgTimestampBrand: unique symbol;
declare const transactionClientBrand: unique symbol;

/** Exact textual representation returned for PostgreSQL int8/numeric values. */
export type PgInt8 = string & { readonly [pgInt8Brand]: "PgInt8" };

/** Exact PostgreSQL timestamptz text. Never round-trip this through JavaScript Date. */
export type PgTimestamp = string & {
  readonly [pgTimestampBrand]: "PgTimestamp";
};

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

/** A query-only view of one checked-out client while its transaction is active. */
export interface TransactionClient extends Queryable {
  readonly [transactionClientBrand]: "TransactionClient";
}

export interface BillingAccountRow extends QueryResultRow {
  readonly id: string;
  readonly external_ref: string;
  readonly stripe_customer_id: string | null;
  readonly stripe_subscription_id: string | null;
  readonly plan_key: string;
  readonly plan_interval: "month" | "year" | null;
  readonly subscription_status: "none" | "active" | "past_due" | "canceled";
  readonly credits_balance: PgInt8;
  readonly grant_epoch: PgInt8;
  readonly event_created: PgInt8;
  readonly event_rank: number;
  readonly current_period_end: PgTimestamp | null;
  readonly annual_anchor: PgTimestamp | null;
  readonly annual_grants_issued: number;
  readonly annual_grants_allowed: number;
  readonly funding_invoice_id: string | null;
  readonly cancel_at_period_end: boolean;
  readonly pending_free_at: PgTimestamp | null;
  readonly entitlement_period_end: PgTimestamp | null;
  readonly credit_expires_at: PgTimestamp | null;
  readonly entitlement_revoked: boolean;
  readonly last_reconciled_at: PgTimestamp | null;
  readonly created_at: PgTimestamp;
  readonly updated_at: PgTimestamp;
  readonly database_now?: PgTimestamp;
}

export interface BillingPlanChangeRow extends QueryResultRow {
  readonly id: string;
  readonly account_id: string;
  readonly idempotency_key: string;
  readonly status: string;
  readonly [column: string]: unknown;
}

export type PgPoolClient = PoolClient;

export function pgBigInt(value: unknown, field = "PostgreSQL bigint"): bigint {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`${field} must be an exact PostgreSQL integer string`);
  }
  return BigInt(value);
}

export function pgTimestamp(
  value: unknown,
  field = "PostgreSQL timestamptz",
): PgTimestamp {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be exact PostgreSQL timestamp text`);
  }
  return value as PgTimestamp;
}

export function asTransactionClient(client: PoolClient): {
  readonly view: TransactionClient;
  deactivate(): void;
} {
  let active = true;
  const view = {
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      if (!active) {
        throw new Error("transaction client is no longer active");
      }
      return client.query<R>(text, [...values]);
    },
  } as TransactionClient;
  return {
    view,
    deactivate(): void {
      active = false;
    },
  };
}
