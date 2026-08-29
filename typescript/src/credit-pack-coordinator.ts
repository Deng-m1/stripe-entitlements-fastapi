import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import type { CreditPack, PlanCatalog } from "./catalog.js";
import type { Database } from "./database.js";
import { CreditAmount, creditDecimal } from "./credit-amount.js";
import { pgBigInt, type TransactionClient } from "./db-types.js";
import {
  type CheckoutRequestSnapshot,
  StripeRequestSnapshotError,
  validateCheckoutRequestSnapshot,
} from "./stripe-request-snapshots.js";
import type { PgTimestamp } from "./types.js";
import { isPlainRecord, requiredVisibleString } from "./validation.js";

export class CreditPackBusyError extends Error {}
export class CreditPackConflictError extends Error {}
export class CreditPackCheckoutRejected extends Error {}

export interface CreditPackReservation {
  readonly orderId: string;
  readonly accountId: string;
  readonly requestKey: string;
  readonly stripeRequestKey: string;
  readonly packKey: string;
  readonly credits: CreditAmount;
  readonly priceAmount: bigint;
  readonly currency: string;
  readonly expiresDays: number;
  readonly lookupKey: string;
  readonly requestCustomerId?: string;
  readonly claimExpiresAt: PgTimestamp;
  readonly claimExpiresAtEpoch: bigint;
  readonly sessionId?: string;
  readonly sessionUrl?: string;
  readonly requestSnapshotVersion: number | null;
  readonly stripeRequestSnapshot: unknown;
}

export interface CreditPackCheckoutCreator {
  prepareCreditPackCheckoutSession(input: {
    readonly orderId: string;
    readonly accountId: string;
    readonly customerId?: string;
    readonly lookupKey: string;
    readonly expectedCurrency: string;
    readonly expectedUnitAmount: bigint;
    readonly packKey: string;
    readonly packCredits: string;
    readonly expiresDays: number;
    readonly expiresAtEpoch: bigint;
  }): Promise<unknown>;
  createCheckoutSessionFromSnapshot(
    snapshot: CheckoutRequestSnapshot,
  ): Promise<readonly [sessionId: string, sessionUrl: string]>;
}

interface AccountRow extends QueryResultRow {
  readonly stripe_customer_id: string | null;
}

interface CreditPackOrderRow extends QueryResultRow {
  readonly id: string;
  readonly account_id: string;
  readonly client_idempotency_key: string;
  readonly stripe_request_key: string;
  readonly pack_key: string;
  readonly pack_credits: string;
  readonly price_amount: string;
  readonly currency: string;
  readonly expires_days: number;
  readonly price_lookup_key: string;
  readonly request_customer_id: string | null;
  readonly claim_expires_at_text: string;
  readonly claim_expires_at_epoch: string;
  readonly checkout_status: string;
  readonly stripe_checkout_session_id: string | null;
  readonly session_url: string | null;
  readonly claim_active: boolean;
  readonly request_snapshot_version: number | null;
  readonly stripe_request_snapshot: unknown;
}

function reservation(row: CreditPackOrderRow): CreditPackReservation {
  return {
    orderId: row.id,
    accountId: row.account_id,
    requestKey: row.client_idempotency_key,
    stripeRequestKey: row.stripe_request_key,
    packKey: row.pack_key,
    credits: CreditAmount.fromAtoms(pgBigInt(row.pack_credits, "pack credits")),
    priceAmount: pgBigInt(row.price_amount, "pack price amount"),
    currency: row.currency,
    expiresDays: row.expires_days,
    lookupKey: row.price_lookup_key,
    claimExpiresAt: row.claim_expires_at_text,
    claimExpiresAtEpoch: BigInt(row.claim_expires_at_epoch),
    requestSnapshotVersion: row.request_snapshot_version,
    stripeRequestSnapshot: row.stripe_request_snapshot,
    ...(row.request_customer_id === null
      ? {}
      : { requestCustomerId: row.request_customer_id }),
    ...(row.stripe_checkout_session_id === null
      ? {}
      : { sessionId: row.stripe_checkout_session_id }),
    ...(row.session_url === null ? {} : { sessionUrl: row.session_url }),
  };
}

function safeSessionUrl(value: string): string {
  requiredVisibleString(value, "Checkout Session URL", 2048);
  let parsed: URL;
  try {
    parsed = new URL(value);
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
  return value;
}

async function selectOrder(
  transaction: TransactionClient,
  accountId: string,
  requestKey: string,
  effectiveNow: PgTimestamp,
): Promise<CreditPackOrderRow | undefined> {
  const result = await transaction.query<CreditPackOrderRow>(
    `select o.*,
            to_char(o.claim_expires_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as claim_expires_at_text,
            floor(extract(epoch from o.claim_expires_at))::bigint::text
              as claim_expires_at_epoch,
            o.claim_expires_at > $3::timestamptz as claim_active
       from credit_pack_orders o
      where account_id=$1::uuid and client_idempotency_key=$2
      for update`,
    [accountId, requestKey, effectiveNow],
  );
  return result.rows[0];
}

export class CreditPackCoordinator {
  readonly #database: Database;
  readonly #catalog: PlanCatalog;

  public constructor(database: Database, catalog: PlanCatalog) {
    this.#database = database;
    this.#catalog = catalog;
  }

  public async reserve(
    accountId: string,
    pack: CreditPack,
    requestKeyInput: string,
    options: { readonly ttlSeconds?: number } = {},
  ): Promise<CreditPackReservation> {
    const requestKey = requiredVisibleString(
      requestKeyInput,
      "Idempotency-Key",
      200,
    );
    const ttlSeconds = options.ttlSeconds ?? 23 * 60 * 60;
    if (
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds <= 0 ||
      ttlSeconds > 23 * 60 * 60 + 59 * 60
    ) {
      throw new RangeError(
        "credit-pack Checkout TTL must be within Stripe's 24-hour bound",
      );
    }
    const orderId = randomUUID();
    return this.#database.transaction(async (transaction) => {
      const accountResult = await transaction.query<AccountRow>(
        "select * from billing_accounts where id=$1::uuid for update",
        [accountId],
      );
      const account = accountResult.rows[0];
      if (account === undefined) {
        throw new Error("billing account not found");
      }
      const clockResult = await transaction.query<
        {
          readonly database_now: string;
          readonly expires_at: string;
          readonly expires_epoch: string;
        } & QueryResultRow
      >(
        `with sampled as (select clock_timestamp() as database_now)
         select to_char(database_now at time zone 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as database_now,
                to_char((database_now+make_interval(secs=>$1::double precision))
                          at time zone 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as expires_at,
                floor(extract(epoch from
                  database_now+make_interval(secs=>$1::double precision)))::bigint::text
                  as expires_epoch
           from sampled`,
        [ttlSeconds],
      );
      const clock = clockResult.rows[0];
      if (clock === undefined) {
        throw new Error("database clock query returned no row");
      }
      const existing = await selectOrder(
        transaction,
        accountId,
        requestKey,
        clock.database_now,
      );
      const expectedLookup = this.#catalog.creditPackLookupKey(pack.key);
      const priceAmount = BigInt(pack.priceUsd) * 100n;
      if (existing !== undefined) {
        if (
          existing.pack_key !== pack.key ||
          pgBigInt(existing.pack_credits) !== pack.credits.atoms ||
          pgBigInt(existing.price_amount) !== priceAmount ||
          existing.currency !== pack.currency ||
          existing.expires_days !== pack.expiresDays ||
          existing.price_lookup_key !== expectedLookup
        ) {
          throw new CreditPackConflictError(
            "Idempotency-Key was already used for a different credit pack",
          );
        }
        if (existing.checkout_status === "expired") {
          throw new CreditPackConflictError(
            "this credit-pack Checkout expired; start a new intent with a new Idempotency-Key",
          );
        }
        if (!existing.claim_active) {
          throw new CreditPackConflictError(
            "the safe same-key Checkout recovery window expired; operator reconciliation is required before starting a new intent",
          );
        }
        return reservation(existing);
      }
      if (account.stripe_customer_id === null) {
        const busyResult = await transaction.query<
          {
            readonly checkout_busy: boolean;
            readonly pack_busy: boolean;
          } & QueryResultRow
        >(
          `select exists(
                    select 1 from checkout_claims
                     where account_id=$1::uuid and expires_at>$2::timestamptz
                  ) as checkout_busy,
                  exists(
                    select 1 from credit_pack_orders
                     where account_id=$1::uuid and payment_status='pending'
                       and checkout_status<>'expired'
                       and claim_expires_at>$2::timestamptz
                  ) as pack_busy`,
          [accountId, clock.database_now],
        );
        const busy = busyResult.rows[0];
        if (busy?.checkout_busy === true || busy?.pack_busy === true) {
          throw new CreditPackBusyError(
            "the first Stripe Customer Checkout is already in progress",
          );
        }
      }
      const stripeRequestKey = `credit-pack:${orderId}`;
      const inserted = await transaction.query<CreditPackOrderRow>(
        `insert into credit_pack_orders(
           id,account_id,client_idempotency_key,stripe_request_key,pack_key,
           pack_credits,price_amount,currency,expires_days,price_lookup_key,
           request_customer_id,claim_expires_at,request_snapshot_version)
         values($1::uuid,$2::uuid,$3,$4,$5,$6::bigint,$7::bigint,$8,$9,$10,$11,
                $12::timestamptz,0)
         returning *,
           to_char(claim_expires_at at time zone 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as claim_expires_at_text,
           floor(extract(epoch from claim_expires_at))::bigint::text as claim_expires_at_epoch,
           true as claim_active`,
        [
          orderId,
          accountId,
          requestKey,
          stripeRequestKey,
          pack.key,
          pack.credits.atoms.toString(),
          priceAmount.toString(),
          pack.currency,
          pack.expiresDays,
          expectedLookup,
          account.stripe_customer_id,
          clock.expires_at,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error("credit-pack reservation insert returned no row");
      }
      return reservation(row);
    });
  }

  async #existingForCreate(
    accountId: string,
    packKey: string,
    requestKey: string,
  ): Promise<CreditPackReservation | undefined> {
    const result = await this.#database.query<CreditPackOrderRow>(
      `select o.*,
              to_char(o.claim_expires_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as claim_expires_at_text,
              floor(extract(epoch from o.claim_expires_at))::bigint::text
                as claim_expires_at_epoch,
              o.claim_expires_at > clock_timestamp() as claim_active
         from credit_pack_orders o
        where account_id=$1::uuid and client_idempotency_key=$2`,
      [accountId, requestKey],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    if (row.pack_key !== packKey) {
      throw new CreditPackConflictError(
        "Idempotency-Key was already used for a different credit pack",
      );
    }
    if (row.checkout_status === "expired" || !row.claim_active) {
      throw new CreditPackConflictError(
        "the safe same-key Checkout recovery window expired; operator reconciliation is required before starting a new intent",
      );
    }
    return reservation(row);
  }

  public async freezeRequestSnapshot(
    value: CreditPackReservation,
    snapshot: CheckoutRequestSnapshot,
  ): Promise<unknown> {
    let result = await this.#database.query<
      {
        readonly request_snapshot_version: number | null;
        readonly stripe_request_snapshot: unknown;
      } & QueryResultRow
    >(
      `update credit_pack_orders set request_snapshot_version=1,
              stripe_request_snapshot=$2::jsonb,updated_at=now()
        where id=$1::uuid and request_snapshot_version=0
          and stripe_request_snapshot is null
        returning request_snapshot_version,stripe_request_snapshot`,
      [value.orderId, snapshot],
    );
    if (result.rows[0] === undefined) {
      result = await this.#database.query<
        {
          readonly request_snapshot_version: number | null;
          readonly stripe_request_snapshot: unknown;
        } & QueryResultRow
      >(
        `select request_snapshot_version,stripe_request_snapshot
           from credit_pack_orders where id=$1::uuid`,
        [value.orderId],
      );
    }
    const frozen = result.rows[0];
    if (
      frozen?.request_snapshot_version !== 1 ||
      !isPlainRecord(frozen.stripe_request_snapshot)
    ) {
      throw new CreditPackConflictError(
        "credit-pack Checkout request snapshot could not be frozen safely",
      );
    }
    return frozen.stripe_request_snapshot;
  }

  #validatedFrozenSnapshot(
    value: CreditPackReservation,
  ): CheckoutRequestSnapshot {
    if (value.requestSnapshotVersion !== 1) {
      throw new CreditPackConflictError(
        value.requestSnapshotVersion === null
          ? "this credit-pack order predates durable request snapshots; operator reconciliation is required"
          : "credit-pack Checkout request snapshot state is invalid",
      );
    }
    try {
      return validateCheckoutRequestSnapshot(value.stripeRequestSnapshot, {
        kind: "credit_pack",
        accountId: value.accountId,
        requestIdentity: value.orderId,
        lookupKey: value.lookupKey,
        currency: value.currency,
        unitAmount: value.priceAmount,
        offeringKey: value.packKey,
        expiresAt: value.claimExpiresAtEpoch,
        customerId: value.requestCustomerId ?? null,
        packCredits: creditDecimal(value.credits.atoms),
        expiresDays: value.expiresDays,
      });
    } catch (error: unknown) {
      if (error instanceof StripeRequestSnapshotError) {
        throw new CreditPackConflictError(
          "the persisted credit-pack Checkout request snapshot is invalid; operator reconciliation is required",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async #executeFrozen(
    creator: CreditPackCheckoutCreator,
    value: CreditPackReservation,
    snapshot: CheckoutRequestSnapshot,
  ): Promise<readonly [sessionId: string, sessionUrl: string]> {
    if (value.sessionId !== undefined && value.sessionUrl !== undefined) {
      return [value.sessionId, value.sessionUrl];
    }
    const [rawSessionId, rawSessionUrl] =
      await creator.createCheckoutSessionFromSnapshot(snapshot);
    const sessionId = requiredVisibleString(
      rawSessionId,
      "Checkout Session id",
      255,
    );
    const sessionUrl = safeSessionUrl(rawSessionUrl);
    const attached = await this.#database.query<
      { readonly id: string } & QueryResultRow
    >(
      `update credit_pack_orders
          set stripe_checkout_session_id=coalesce(stripe_checkout_session_id,$2),
              session_url=$3,
              checkout_status=case when checkout_status='reserved'
                                   then 'session_created' else checkout_status end,
              updated_at=now()
        where id=$1::uuid
          and request_snapshot_version=1 and stripe_request_snapshot is not null
          and (stripe_checkout_session_id is null or stripe_checkout_session_id=$2)
        returning id::text`,
      [value.orderId, sessionId, sessionUrl],
    );
    if (attached.rowCount !== 1) {
      const existing = await this.#database.query<
        { readonly stripe_checkout_session_id: string | null } & QueryResultRow
      >(
        "select stripe_checkout_session_id from credit_pack_orders where id=$1::uuid",
        [value.orderId],
      );
      if (existing.rows[0]?.stripe_checkout_session_id !== sessionId) {
        throw new Error("credit-pack order changed during Checkout creation");
      }
    }
    return [sessionId, sessionUrl];
  }

  public async recoverFrozen(
    creator: CreditPackCheckoutCreator,
    input: {
      readonly accountId: string;
      readonly packKey: string;
      readonly requestKey: string;
    },
  ): Promise<readonly [sessionId: string, sessionUrl: string] | undefined> {
    const requestKey = requiredVisibleString(
      input.requestKey,
      "Idempotency-Key",
      200,
    );
    const value = await this.#existingForCreate(
      input.accountId,
      input.packKey,
      requestKey,
    );
    if (value === undefined || value.requestSnapshotVersion !== 1) {
      return undefined;
    }
    return this.#executeFrozen(
      creator,
      value,
      this.#validatedFrozenSnapshot(value),
    );
  }

  public async create(
    creator: CreditPackCheckoutCreator,
    input: {
      readonly accountId: string;
      readonly packKey: string;
      readonly requestKey: string;
    },
  ): Promise<readonly [sessionId: string, sessionUrl: string]> {
    const requestKey = requiredVisibleString(
      input.requestKey,
      "Idempotency-Key",
      200,
    );
    let reserved = await this.#existingForCreate(
      input.accountId,
      input.packKey,
      requestKey,
    );
    if (reserved === undefined) {
      const pack = this.#catalog.requireCreditPack(input.packKey);
      reserved = await this.reserve(input.accountId, pack, requestKey);
    }
    const packCredits = creditDecimal(reserved.credits.atoms);
    const validateFrozen = (value: unknown): CheckoutRequestSnapshot =>
      validateCheckoutRequestSnapshot(value, {
        kind: "credit_pack",
        accountId: reserved.accountId,
        requestIdentity: reserved.orderId,
        lookupKey: reserved.lookupKey,
        currency: reserved.currency,
        unitAmount: reserved.priceAmount,
        offeringKey: reserved.packKey,
        expiresAt: reserved.claimExpiresAtEpoch,
        customerId: reserved.requestCustomerId ?? null,
        packCredits,
        expiresDays: reserved.expiresDays,
      });
    let snapshot: CheckoutRequestSnapshot;
    if (reserved.requestSnapshotVersion === null) {
      throw new CreditPackConflictError(
        "this credit-pack order predates durable request snapshots; operator reconciliation is required",
      );
    }
    if (reserved.requestSnapshotVersion === 1) {
      snapshot = this.#validatedFrozenSnapshot(reserved);
    } else if (
      reserved.requestSnapshotVersion !== 0 ||
      reserved.stripeRequestSnapshot !== null
    ) {
      throw new CreditPackConflictError(
        "credit-pack Checkout request snapshot state is invalid",
      );
    } else {
      const prepared = validateCheckoutRequestSnapshot(
        await creator.prepareCreditPackCheckoutSession({
          orderId: reserved.orderId,
          accountId: reserved.accountId,
          ...(reserved.requestCustomerId === undefined
            ? {}
            : { customerId: reserved.requestCustomerId }),
          lookupKey: reserved.lookupKey,
          expectedCurrency: reserved.currency,
          expectedUnitAmount: reserved.priceAmount,
          packKey: reserved.packKey,
          packCredits,
          expiresDays: reserved.expiresDays,
          expiresAtEpoch: reserved.claimExpiresAtEpoch,
        }),
        {
          kind: "credit_pack",
          accountId: reserved.accountId,
          requestIdentity: reserved.orderId,
          lookupKey: reserved.lookupKey,
          currency: reserved.currency,
          unitAmount: reserved.priceAmount,
          offeringKey: reserved.packKey,
          expiresAt: reserved.claimExpiresAtEpoch,
          customerId: reserved.requestCustomerId ?? null,
          packCredits,
          expiresDays: reserved.expiresDays,
        },
      );
      const frozen = await this.freezeRequestSnapshot(reserved, prepared);
      snapshot = validateFrozen(frozen);
    }
    return this.#executeFrozen(creator, reserved, snapshot);
  }
}
