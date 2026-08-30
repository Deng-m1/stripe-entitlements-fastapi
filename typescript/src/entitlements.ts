import type { QueryResultRow } from "pg";

import { JSON_SAFE_INTEGER_MAX } from "./bounds.js";
import type { PlanCatalog } from "./catalog.js";
import { CREDIT_SCALE, CreditAmount } from "./credit-amount.js";
import {
  CreditAccountNotFoundError,
  CreditDebitNotFoundError,
  CreditDebitOwnerMismatchError,
  CreditService,
  CreditsUnavailableError,
  InsufficientCreditsError,
} from "./credits.js";
import type { CreditResult } from "./credits.js";
import type { Database } from "./database.js";
import { pgBigInt } from "./db-types.js";
import {
  spendableSubscriptionAtoms,
  subscriptionCreditsAreSpendable,
} from "./subscription-state.js";
import type { BillingInterval, PgTimestamp } from "./types.js";
import {
  InvalidOwnerReferenceError,
  validateOwnerExternalRef,
} from "./owner-reference.js";
import { isPlainRecord, isPrintable } from "./validation.js";

const ENTITLEMENT_KEY = /^[a-z][a-z0-9_]{0,63}$/u;

export type EntitlementReason =
  | "allowed"
  | "owner_not_found"
  | "entitlement_not_enforceable"
  | "feature_not_available"
  | "limit_not_available"
  | "limit_exceeded";

export type SubscriptionStatus = "none" | "active" | "past_due" | "canceled";

export class InvalidCreditRequestError extends Error {}
export class BillingOwnerNotFoundError extends Error {}
export class CreditOperationNotFoundError extends Error {}
export class CreditIdempotencyConflictError extends Error {}

export interface LimitDecision {
  readonly requested: number;
  readonly maximum: number | null;
  readonly allowed: boolean;
}

export class EntitlementCheck {
  public readonly allowed: boolean;
  public readonly reason: EntitlementReason;
  public readonly entitlementsEnforceable: boolean;
  public readonly planKey: string;
  public readonly planInterval: BillingInterval | null;
  public readonly subscriptionStatus: SubscriptionStatus;
  public readonly creditsSpendable: boolean;
  public readonly creditBalance: CreditAmount;
  public readonly creditExpiresAt: PgTimestamp | null;
  public readonly features: Readonly<Record<string, boolean>>;
  public readonly limits: Readonly<Record<string, LimitDecision>>;

  public constructor(input: {
    readonly allowed: boolean;
    readonly reason: EntitlementReason;
    readonly entitlementsEnforceable: boolean;
    readonly planKey: string;
    readonly planInterval: BillingInterval | null;
    readonly subscriptionStatus: SubscriptionStatus;
    readonly creditsSpendable: boolean;
    readonly creditBalance: CreditAmount;
    readonly creditExpiresAt: PgTimestamp | null;
    readonly features: Readonly<Record<string, boolean>>;
    readonly limits: Readonly<Record<string, LimitDecision>>;
  }) {
    this.allowed = input.allowed;
    this.reason = input.reason;
    this.entitlementsEnforceable = input.entitlementsEnforceable;
    this.planKey = input.planKey;
    this.planInterval = input.planInterval;
    this.subscriptionStatus = input.subscriptionStatus;
    this.creditsSpendable = input.creditsSpendable;
    this.creditBalance = input.creditBalance;
    this.creditExpiresAt = input.creditExpiresAt;
    this.features = input.features;
    this.limits = input.limits;
  }

  public get creditScale(): bigint {
    return CREDIT_SCALE;
  }
}

interface EntitlementAccountRow extends QueryResultRow {
  readonly id: string;
  readonly plan_key: string;
  readonly plan_interval: BillingInterval | null;
  readonly subscription_status: SubscriptionStatus;
  readonly credits_balance: string;
  readonly credit_expires_at: PgTimestamp | null;
  readonly entitlement_revoked: boolean;
  readonly database_now: PgTimestamp;
  readonly pack_balance: string;
  readonly next_pack_expiry: PgTimestamp | null;
  readonly combined_expiry: PgTimestamp | null;
}

function validateOperationKey(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > 200 ||
    !isPrintable(value)
  ) {
    throw new InvalidCreditRequestError("idempotency key is invalid");
  }
  return value;
}

function validateRequirements(
  requiredFeatures: readonly string[] | ReadonlySet<string>,
  requiredLimits: Readonly<Record<string, number>>,
): readonly [readonly string[], Readonly<Record<string, number>>] {
  const features = [...requiredFeatures];
  if (
    features.length > 64 ||
    features.length !== new Set(features).size ||
    features.some(
      (feature) =>
        typeof feature !== "string" || !ENTITLEMENT_KEY.test(feature),
    )
  ) {
    throw new TypeError(
      "requiredFeatures contains an invalid or duplicate key",
    );
  }
  if (!isPlainRecord(requiredLimits)) {
    throw new TypeError("requiredLimits must be a plain record");
  }
  const limits = { ...requiredLimits };
  const entries = Object.entries(limits);
  if (
    entries.length > 64 ||
    entries.some(
      ([key, value]) =>
        !ENTITLEMENT_KEY.test(key) ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > JSON_SAFE_INTEGER_MAX,
    )
  ) {
    throw new TypeError("requiredLimits contains an invalid key or value");
  }
  return [features, limits];
}

function accountView(
  account: EntitlementAccountRow,
): Readonly<Record<string, unknown>> {
  return {
    ...account,
    credits_balance: pgBigInt(
      account.credits_balance,
      "account credits_balance",
    ),
  };
}

/** Server-side entitlement decisions and owner-bound credit operations. */
export class EntitlementService {
  readonly #database: Database;
  readonly #catalog: PlanCatalog;
  readonly #credits: CreditService;

  public constructor(database: Database, catalog: PlanCatalog) {
    this.#database = database;
    this.#catalog = catalog;
    this.#credits = new CreditService(database);
  }

  public async check(
    ownerExternalRefInput: string,
    options: {
      readonly requiredFeatures?: readonly string[] | ReadonlySet<string>;
      readonly requiredLimits?: Readonly<Record<string, number>>;
    } = {},
  ): Promise<EntitlementCheck> {
    const ownerExternalRef = validateOwnerExternalRef(ownerExternalRefInput);
    const [features, limits] = validateRequirements(
      options.requiredFeatures ?? [],
      options.requiredLimits ?? {},
    );
    const accountResult = await this.#database.query<EntitlementAccountRow>(
      `with observed as materialized (
         select clock_timestamp() as database_now
       )
       select a.id,a.plan_key,a.plan_interval,a.subscription_status,
              a.credits_balance,a.credit_expires_at,a.entitlement_revoked,
              observed.database_now,
              coalesce(p.pack_balance,0) as pack_balance,
              p.next_pack_expiry,
              least(a.credit_expires_at,p.next_pack_expiry) as combined_expiry
         from billing_accounts a
         cross join observed
         left join lateral (
           select sum(l.remaining_credits) as pack_balance,
                  min(l.expires_at) as next_pack_expiry
             from credit_funding_lots l
            where l.account_id=a.id and l.status='active'
              and l.remaining_credits > 0
              and l.expires_at > observed.database_now
         ) p on true
        where a.external_ref=$1`,
      [ownerExternalRef],
    );
    const account = accountResult.rows[0];
    if (account === undefined) {
      return new EntitlementCheck({
        allowed: false,
        reason: "owner_not_found",
        entitlementsEnforceable: false,
        planKey: "free",
        planInterval: null,
        subscriptionStatus: "none",
        creditsSpendable: false,
        creditBalance: CreditAmount.fromAtoms(0n),
        creditExpiresAt: null,
        features: Object.fromEntries(
          features.map((feature) => [feature, false]),
        ),
        limits: Object.fromEntries(
          Object.entries(limits).map(([key, requested]) => [
            key,
            { requested, maximum: null, allowed: false },
          ]),
        ),
      });
    }

    const plan = this.#catalog.plans.get(account.plan_key);
    const view = accountView(account);
    const subscriptionSpendable = subscriptionCreditsAreSpendable(view, {
      asOf: account.database_now,
    });
    const enforceable = plan !== undefined && subscriptionSpendable;
    const subscriptionAtoms = spendableSubscriptionAtoms(view, {
      asOf: account.database_now,
    });
    const packAtoms = pgBigInt(account.pack_balance, "pack credit balance");
    const spendableAtoms = subscriptionAtoms + packAtoms;
    let nextFundingExpiry: PgTimestamp | null = null;
    if (subscriptionAtoms > 0n && packAtoms > 0n) {
      nextFundingExpiry = account.combined_expiry;
    } else if (subscriptionAtoms > 0n) {
      nextFundingExpiry = account.credit_expires_at;
    } else if (packAtoms > 0n) {
      nextFundingExpiry = account.next_pack_expiry;
    }

    const featureDecisions = Object.fromEntries(
      features.map((feature) => [
        feature,
        enforceable && plan.features.has(feature),
      ]),
    );
    const limitDecisions: Record<string, LimitDecision> = {};
    for (const [key, requested] of Object.entries(limits)) {
      const maximum = plan?.limits[key] ?? null;
      limitDecisions[key] = {
        requested,
        maximum,
        allowed: enforceable && maximum !== null && requested <= maximum,
      };
    }

    let reason: EntitlementReason = "allowed";
    let allowed = enforceable;
    if (!enforceable) {
      reason = "entitlement_not_enforceable";
    } else if (Object.values(featureDecisions).some((value) => !value)) {
      reason = "feature_not_available";
      allowed = false;
    } else if (
      Object.values(limitDecisions).some(
        (decision) => decision.maximum === null,
      )
    ) {
      reason = "limit_not_available";
      allowed = false;
    } else if (
      Object.values(limitDecisions).some((decision) => !decision.allowed)
    ) {
      reason = "limit_exceeded";
      allowed = false;
    }

    return new EntitlementCheck({
      allowed,
      reason,
      entitlementsEnforceable: enforceable,
      planKey: account.plan_key,
      planInterval: account.plan_interval,
      subscriptionStatus: account.subscription_status,
      creditsSpendable: spendableAtoms > 0n,
      creditBalance: CreditAmount.fromAtoms(spendableAtoms),
      creditExpiresAt: nextFundingExpiry,
      features: featureDecisions,
      limits: limitDecisions,
    });
  }

  public async charge(
    ownerExternalRefInput: string,
    amount: string,
    idempotencyKeyInput: string,
  ): Promise<CreditResult> {
    const ownerExternalRef = validateOwnerExternalRef(ownerExternalRefInput);
    const idempotencyKey = validateOperationKey(idempotencyKeyInput);
    if (typeof amount !== "string") {
      throw new InvalidCreditRequestError(
        "credit amount must be an exact decimal string",
      );
    }
    let normalized: CreditAmount;
    try {
      normalized = CreditAmount.parse(amount, {
        field: "credit amount",
        allowZero: false,
      });
    } catch (error) {
      throw new InvalidCreditRequestError("credit amount is invalid", {
        cause: error,
      });
    }
    const accountResult = await this.#database.query<
      { readonly id: string } & QueryResultRow
    >("select id from billing_accounts where external_ref=$1", [
      ownerExternalRef,
    ]);
    const accountId = accountResult.rows[0]?.id;
    if (accountId === undefined) {
      throw new BillingOwnerNotFoundError("billing owner not found");
    }
    try {
      return await this.#credits.charge(accountId, normalized, idempotencyKey);
    } catch (error) {
      if (error instanceof CreditAccountNotFoundError) {
        throw new BillingOwnerNotFoundError("billing owner not found", {
          cause: error,
        });
      }
      if (
        error instanceof TypeError &&
        error.message ===
          "idempotency key was already used with different parameters"
      ) {
        throw new CreditIdempotencyConflictError("idempotency key conflict", {
          cause: error,
        });
      }
      throw error;
    }
  }

  public async refund(
    ownerExternalRefInput: string,
    idempotencyKeyInput: string,
  ): Promise<CreditResult> {
    const ownerExternalRef = validateOwnerExternalRef(ownerExternalRefInput);
    const idempotencyKey = validateOperationKey(idempotencyKeyInput);
    const accountResult = await this.#database.query<
      { readonly id: string } & QueryResultRow
    >("select id from billing_accounts where external_ref=$1", [
      ownerExternalRef,
    ]);
    const accountId = accountResult.rows[0]?.id;
    if (accountId === undefined) {
      throw new CreditOperationNotFoundError("credit operation not found");
    }
    try {
      return await this.#credits.refund(idempotencyKey, {
        expectedAccountId: accountId,
      });
    } catch (error) {
      if (
        error instanceof CreditDebitOwnerMismatchError ||
        error instanceof CreditDebitNotFoundError ||
        error instanceof CreditAccountNotFoundError
      ) {
        throw new CreditOperationNotFoundError("credit operation not found", {
          cause: error,
        });
      }
      throw error;
    }
  }
}

export {
  CreditsUnavailableError,
  InsufficientCreditsError,
  InvalidOwnerReferenceError,
  validateOwnerExternalRef,
};
