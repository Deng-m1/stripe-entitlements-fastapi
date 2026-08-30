import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import type { Database } from "./database.js";
import type { TransactionClient } from "./db-types.js";
import {
  type CheckoutRequestSnapshot,
  StripeRequestSnapshotError,
  validateCheckoutRequestSnapshot,
} from "./stripe-request-snapshots.js";
import type { BillingInterval, PgTimestamp } from "./types.js";
import { isPlainRecord, requiredVisibleString } from "./validation.js";

export class CheckoutBusyError extends Error {}
export class CheckoutCreationRejected extends Error {}
export class CheckoutActiveSubscriptionError extends Error {}
export class CheckoutReplayUnsafeError extends Error {}

export interface CheckoutReservation {
  readonly accountId: string;
  readonly claimToken: string;
  readonly planKey: string;
  readonly interval: BillingInterval;
  readonly expiresAt: PgTimestamp;
  readonly expiresAtEpoch: bigint;
  readonly requestKey: string;
  readonly requestCustomerId?: string;
  readonly sessionId?: string;
  readonly sessionUrl?: string;
  readonly requestSnapshotVersion: number | null;
  readonly stripeRequestSnapshot: unknown;
}

export interface CheckoutCreator {
  prepareCheckoutSession(input: {
    readonly accountId: string;
    readonly customerId?: string;
    readonly lookupKey: string;
    readonly expectedCurrency: string;
    readonly expectedUnitAmount: bigint;
    readonly expectedInterval: BillingInterval;
    readonly claimToken: string;
    readonly expiresAtEpoch: bigint;
    readonly planKey: string;
    readonly interval: BillingInterval;
  }): Promise<unknown>;
  createCheckoutSessionFromSnapshot(
    snapshot: CheckoutRequestSnapshot,
  ): Promise<readonly [sessionId: string, sessionUrl: string]>;
}

interface AccountRow extends QueryResultRow {
  readonly stripe_customer_id: string | null;
  readonly stripe_subscription_id: string | null;
  readonly subscription_status: string;
}

interface ClockRow extends QueryResultRow {
  readonly effective_now: string;
  readonly expires_at: string;
  readonly expires_at_epoch: string;
}

interface ClaimRow extends QueryResultRow {
  readonly claim_token: string;
  readonly plan_key: string;
  readonly plan_interval: BillingInterval;
  readonly request_customer_id: string | null;
  readonly client_request_key: string | null;
  readonly session_id: string | null;
  readonly session_url: string | null;
  readonly active: boolean;
  readonly expires_at_text: string;
  readonly expires_at_epoch: string;
  readonly request_snapshot_version: number | null;
  readonly stripe_request_snapshot: unknown;
}

function reservationFromRow(
  accountId: string,
  requestKey: string,
  row: ClaimRow,
): CheckoutReservation {
  const base = {
    accountId,
    claimToken: row.claim_token,
    planKey: row.plan_key,
    interval: row.plan_interval,
    expiresAt: row.expires_at_text,
    expiresAtEpoch: BigInt(row.expires_at_epoch),
    requestKey,
    requestSnapshotVersion: row.request_snapshot_version,
    stripeRequestSnapshot: row.stripe_request_snapshot,
  } satisfies CheckoutReservation;
  return {
    ...base,
    ...(row.request_customer_id === null
      ? {}
      : { requestCustomerId: row.request_customer_id }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.session_url === null ? {} : { sessionUrl: row.session_url }),
  };
}

export function validateCheckoutSessionIdentity(
  sessionId: string,
  sessionUrl: string,
): void {
  requiredVisibleString(sessionId, "Checkout Session id", 255);
  requiredVisibleString(sessionUrl, "Checkout Session URL", 2048);
  let parsed: URL;
  try {
    parsed = new URL(sessionUrl);
  } catch {
    throw new TypeError(
      "Checkout Session URL must be an origin-safe HTTPS URL",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.host.length === 0 ||
    parsed.username.length !== 0 ||
    parsed.password.length !== 0
  ) {
    throw new TypeError(
      "Checkout Session URL must be an origin-safe HTTPS URL",
    );
  }
}

async function databaseClock(
  tx: TransactionClient,
  ttlSeconds: number,
): Promise<ClockRow> {
  const result = await tx.query<ClockRow>(
    `with sampled as (select clock_timestamp() as effective_now),
          bounded as (
            select effective_now,
                   effective_now + make_interval(secs => $1::double precision) as expires_at
              from sampled
          )
     select to_char(effective_now at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as effective_now,
            to_char(expires_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as expires_at,
            floor(extract(epoch from expires_at))::bigint::text as expires_at_epoch
       from bounded`,
    [ttlSeconds],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("database clock query returned no row");
  }
  return row;
}

export class CheckoutCoordinator {
  readonly #database: Database;

  public constructor(database: Database) {
    this.#database = database;
  }

  public async reserve(
    accountId: string,
    planKeyInput: string,
    interval: BillingInterval,
    options: {
      readonly requestKey?: string;
      readonly ttlSeconds?: number;
    } = {},
  ): Promise<CheckoutReservation> {
    const ttlSeconds = options.ttlSeconds ?? 35 * 60;
    if (
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds <= 0 ||
      ttlSeconds > 86_400
    ) {
      throw new RangeError(
        "Checkout claim TTL must be a positive integer up to one day",
      );
    }
    const planKey = requiredVisibleString(planKeyInput, "plan_key", 64);
    if (planKey.includes("_")) {
      throw new TypeError("plan_key cannot contain an underscore");
    }
    if (interval !== "month" && interval !== "year") {
      throw new TypeError("interval must be month or year");
    }
    const token = randomUUID();
    const requestKey =
      options.requestKey === undefined
        ? token
        : requiredVisibleString(options.requestKey, "request_key", 200);

    return this.#database.transaction(async (tx) => {
      const accountResult = await tx.query<AccountRow>(
        "select * from billing_accounts where id=$1::uuid for update",
        [accountId],
      );
      const account = accountResult.rows[0];
      if (account === undefined) {
        throw new Error("billing account not found");
      }
      const clock = await databaseClock(tx, ttlSeconds);
      if (
        account.stripe_subscription_id !== null ||
        account.subscription_status === "active" ||
        account.subscription_status === "past_due"
      ) {
        throw new CheckoutActiveSubscriptionError(
          "an existing subscription must use the plan-change API",
        );
      }
      if (account.stripe_customer_id === null) {
        const pack = await tx.query<
          { readonly busy: boolean } & QueryResultRow
        >(
          `select exists(
             select 1 from credit_pack_orders
              where account_id=$1::uuid and payment_status='pending'
                and checkout_status <> 'expired'
                and claim_expires_at > $2::timestamptz
           ) as busy`,
          [accountId, clock.effective_now],
        );
        if (pack.rows[0]?.busy === true) {
          throw new CheckoutBusyError(
            "the first Stripe Customer Checkout is already in progress",
          );
        }
      }
      const existingResult = await tx.query<ClaimRow>(
        `select *, expires_at > $2::timestamptz as active,
                to_char(expires_at at time zone 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as expires_at_text,
                floor(extract(epoch from expires_at))::bigint::text as expires_at_epoch
           from checkout_claims where account_id=$1::uuid for update`,
        [accountId, clock.effective_now],
      );
      const existing = existingResult.rows[0];
      if (existing !== undefined && existing.active) {
        if (
          existing.client_request_key === requestKey &&
          existing.plan_key === planKey &&
          existing.plan_interval === interval
        ) {
          return reservationFromRow(accountId, requestKey, existing);
        }
        throw new CheckoutBusyError(
          "an unexpired Checkout claim already exists",
        );
      }
      if (existing !== undefined) {
        await tx.query(
          "delete from checkout_claims where account_id=$1::uuid",
          [accountId],
        );
      }
      await tx.query(
        `insert into checkout_claims
           (account_id,claim_token,plan_key,plan_interval,expires_at,
            client_request_key,request_customer_id,request_snapshot_version)
         values($1::uuid,$2::uuid,$3,$4,$5::timestamptz,$6,$7,0)`,
        [
          accountId,
          token,
          planKey,
          interval,
          clock.expires_at,
          requestKey,
          account.stripe_customer_id,
        ],
      );
      return {
        accountId,
        claimToken: token,
        planKey,
        interval,
        expiresAt: clock.expires_at,
        expiresAtEpoch: BigInt(clock.expires_at_epoch),
        requestKey,
        requestSnapshotVersion: 0,
        stripeRequestSnapshot: null,
        ...(account.stripe_customer_id === null
          ? {}
          : { requestCustomerId: account.stripe_customer_id }),
      };
    });
  }

  public async freezeRequestSnapshot(
    reservation: CheckoutReservation,
    snapshot: CheckoutRequestSnapshot,
  ): Promise<unknown> {
    let result = await this.#database.query<
      {
        readonly request_snapshot_version: number | null;
        readonly stripe_request_snapshot: unknown;
      } & QueryResultRow
    >(
      `update checkout_claims set request_snapshot_version=1,
              stripe_request_snapshot=$3::jsonb
        where account_id=$1::uuid and claim_token=$2::uuid
          and request_snapshot_version=0 and stripe_request_snapshot is null
        returning request_snapshot_version,stripe_request_snapshot`,
      [reservation.accountId, reservation.claimToken, snapshot],
    );
    if (result.rows[0] === undefined) {
      result = await this.#database.query<
        {
          readonly request_snapshot_version: number | null;
          readonly stripe_request_snapshot: unknown;
        } & QueryResultRow
      >(
        `select request_snapshot_version,stripe_request_snapshot
           from checkout_claims
          where account_id=$1::uuid and claim_token=$2::uuid`,
        [reservation.accountId, reservation.claimToken],
      );
    }
    const frozen = result.rows[0];
    if (
      frozen?.request_snapshot_version !== 1 ||
      !isPlainRecord(frozen.stripe_request_snapshot)
    ) {
      throw new CheckoutReplayUnsafeError(
        "Checkout request snapshot could not be frozen safely",
      );
    }
    return frozen.stripe_request_snapshot;
  }

  public async attachSession(
    reservation: CheckoutReservation,
    sessionId: string,
    sessionUrl: string,
  ): Promise<boolean> {
    validateCheckoutSessionIdentity(sessionId, sessionUrl);
    const result = await this.#database.query<
      { readonly account_id: string } & QueryResultRow
    >(
      `update checkout_claims set session_id=$3,session_url=$4
         where account_id=$1::uuid and claim_token=$2::uuid
           and request_snapshot_version=1 and stripe_request_snapshot is not null
         returning account_id::text`,
      [reservation.accountId, reservation.claimToken, sessionId, sessionUrl],
    );
    return result.rowCount === 1;
  }

  public async release(reservation: CheckoutReservation): Promise<boolean> {
    const result = await this.#database.query<
      { readonly account_id: string } & QueryResultRow
    >(
      `delete from checkout_claims
         where account_id=$1::uuid and claim_token=$2::uuid
           and request_snapshot_version=0 and stripe_request_snapshot is null
           and session_id is null
         returning account_id::text`,
      [reservation.accountId, reservation.claimToken],
    );
    return result.rowCount === 1;
  }

  public async completedDuringCreation(
    reservation: CheckoutReservation,
  ): Promise<boolean> {
    const result = await this.#database.query<
      {
        readonly stripe_subscription_id: string | null;
        readonly claim_token: string | null;
      } & QueryResultRow
    >(
      `select a.stripe_subscription_id,c.claim_token::text
         from billing_accounts a
         left join checkout_claims c on c.account_id=a.id
        where a.id=$1::uuid`,
      [reservation.accountId],
    );
    const row = result.rows[0];
    return (
      row !== undefined &&
      row.stripe_subscription_id !== null &&
      row.claim_token === null
    );
  }

  #validatedFrozenSnapshot(
    reservation: CheckoutReservation,
  ): CheckoutRequestSnapshot {
    if (reservation.requestSnapshotVersion !== 1) {
      throw new CheckoutReplayUnsafeError(
        reservation.requestSnapshotVersion === null
          ? "this Checkout claim predates durable request snapshots; operator reconciliation is required"
          : "Checkout request snapshot state is invalid",
      );
    }
    try {
      return validateCheckoutRequestSnapshot(
        reservation.stripeRequestSnapshot,
        {
          kind: "subscription",
          accountId: reservation.accountId,
          requestIdentity: reservation.claimToken,
          interval: reservation.interval,
          offeringKey: reservation.planKey,
          expiresAt: reservation.expiresAtEpoch,
          customerId: reservation.requestCustomerId ?? null,
        },
      );
    } catch (error: unknown) {
      if (error instanceof StripeRequestSnapshotError) {
        throw new CheckoutReplayUnsafeError(
          "the persisted Checkout request snapshot is invalid; operator reconciliation is required",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async #executeFrozen(
    creator: CheckoutCreator,
    reservation: CheckoutReservation,
    snapshot: CheckoutRequestSnapshot,
  ): Promise<readonly [sessionId: string, sessionUrl: string]> {
    if (
      reservation.sessionId !== undefined &&
      reservation.sessionUrl !== undefined
    ) {
      return [reservation.sessionId, reservation.sessionUrl];
    }
    const created = await creator.createCheckoutSessionFromSnapshot(snapshot);
    const [sessionId, sessionUrl] = created;
    try {
      validateCheckoutSessionIdentity(sessionId, sessionUrl);
    } catch (error: unknown) {
      throw new Error("Checkout creator returned an invalid Session identity", {
        cause: error,
      });
    }
    if (!(await this.attachSession(reservation, sessionId, sessionUrl))) {
      if (await this.completedDuringCreation(reservation)) {
        return created;
      }
      throw new Error(
        "Checkout claim identity changed while Stripe was creating a session",
      );
    }
    return created;
  }

  public async recoverFrozen(
    creator: CheckoutCreator,
    input: {
      readonly accountId: string;
      readonly planKey: string;
      readonly interval: BillingInterval;
      readonly requestKey: string;
    },
  ): Promise<readonly [sessionId: string, sessionUrl: string] | undefined> {
    const planKey = requiredVisibleString(input.planKey, "plan_key", 64);
    const requestKey = requiredVisibleString(
      input.requestKey,
      "request_key",
      200,
    );
    if (
      planKey.includes("_") ||
      (input.interval !== "month" && input.interval !== "year")
    ) {
      throw new TypeError("invalid frozen Checkout recovery identity");
    }
    const result = await this.#database.query<ClaimRow>(
      `select *,true as active,
              to_char(expires_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as expires_at_text,
              floor(extract(epoch from expires_at))::bigint::text as expires_at_epoch
         from checkout_claims
        where account_id=$1::uuid and client_request_key=$2
          and plan_key=$3 and plan_interval=$4
          and expires_at>clock_timestamp()
          and request_snapshot_version=1 and stripe_request_snapshot is not null`,
      [input.accountId, requestKey, planKey, input.interval],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    const reservation = reservationFromRow(input.accountId, requestKey, row);
    return this.#executeFrozen(
      creator,
      reservation,
      this.#validatedFrozenSnapshot(reservation),
    );
  }

  public async create(
    creator: CheckoutCreator,
    input: {
      readonly accountId: string;
      readonly planKey: string;
      readonly interval: BillingInterval;
      readonly lookupKey: string;
      readonly expectedCurrency: string;
      readonly expectedUnitAmount: bigint;
      readonly expectedInterval: BillingInterval;
      readonly requestKey?: string;
    },
  ): Promise<readonly [sessionId: string, sessionUrl: string]> {
    if (input.interval !== input.expectedInterval) {
      throw new CheckoutCreationRejected(
        "Checkout interval does not match the catalog expectation",
      );
    }
    const reservation = await this.reserve(
      input.accountId,
      input.planKey,
      input.interval,
      {
        ...(input.requestKey === undefined
          ? {}
          : { requestKey: input.requestKey }),
      },
    );
    let snapshot: CheckoutRequestSnapshot;
    if (reservation.requestSnapshotVersion === null) {
      throw new CheckoutReplayUnsafeError(
        "this Checkout claim predates durable request snapshots; operator reconciliation is required",
      );
    }
    if (reservation.requestSnapshotVersion === 1) {
      snapshot = this.#validatedFrozenSnapshot(reservation);
    } else if (
      reservation.requestSnapshotVersion !== 0 ||
      reservation.stripeRequestSnapshot !== null
    ) {
      throw new CheckoutReplayUnsafeError(
        "Checkout request snapshot state is invalid",
      );
    } else {
      let prepared: CheckoutRequestSnapshot;
      try {
        prepared = validateCheckoutRequestSnapshot(
          await creator.prepareCheckoutSession({
            accountId: reservation.accountId,
            ...(reservation.requestCustomerId === undefined
              ? {}
              : { customerId: reservation.requestCustomerId }),
            lookupKey: input.lookupKey,
            expectedCurrency: input.expectedCurrency,
            expectedUnitAmount: input.expectedUnitAmount,
            expectedInterval: input.expectedInterval,
            claimToken: reservation.claimToken,
            expiresAtEpoch: reservation.expiresAtEpoch,
            planKey: reservation.planKey,
            interval: reservation.interval,
          }),
          {
            kind: "subscription",
            accountId: reservation.accountId,
            requestIdentity: reservation.claimToken,
            lookupKey: input.lookupKey,
            currency: input.expectedCurrency,
            unitAmount: input.expectedUnitAmount,
            interval: input.expectedInterval,
            offeringKey: reservation.planKey,
            expiresAt: reservation.expiresAtEpoch,
            customerId: reservation.requestCustomerId ?? null,
          },
        );
      } catch (error: unknown) {
        if (error instanceof CheckoutCreationRejected) {
          await this.release(reservation);
        }
        throw error;
      }
      const frozen = await this.freezeRequestSnapshot(reservation, prepared);
      snapshot = this.#validatedFrozenSnapshot({
        ...reservation,
        requestSnapshotVersion: 1,
        stripeRequestSnapshot: frozen,
      });
    }
    return this.#executeFrozen(creator, reservation, snapshot);
  }
}
