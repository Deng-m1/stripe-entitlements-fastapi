export type BillingInterval = "month" | "year";
export type TransitionPolicy = "full_period_reset" | "prorated_delta";
export type EffectiveMode = "immediate" | "period_end" | "noop";

/** PostgreSQL timestamptz text. It is deliberately not converted through Date. */
export type PgTimestamp = string;

export interface ProcessResult {
  readonly outcome: "handled" | "ignored" | "replayed" | "duplicate";
  readonly reason?: string;
  readonly accountId?: string;
}

export interface SubscriptionSnapshot {
  readonly subscriptionId: string;
  readonly status: string;
  readonly lookupKey?: string;
  readonly currentPeriodEnd?: PgTimestamp;
  readonly resolvedPrice?: Readonly<Record<string, unknown>>;
  readonly quantity?: bigint;
  readonly itemsComplete: boolean;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };
