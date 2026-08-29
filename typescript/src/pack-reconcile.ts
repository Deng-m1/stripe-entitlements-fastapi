import { createHash, randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import { POSTGRES_BIGINT_MAX } from "./bounds.js";
import { CreditAmount } from "./credit-amount.js";
import type { Database } from "./database.js";
import { pgBigInt } from "./db-types.js";
import type { StripeObject } from "./processor-primitives.js";
import type { ProcessResult } from "./types.js";
import { isPlainRecord, isPrintable } from "./validation.js";

const PACK_SCHEMA_VERSION = "1";
const RECONCILABLE_PAYMENT_STATUSES = new Set([
  "pending",
  "paid",
  "partially_refunded",
  "refunded",
  "disputed",
]);
const PAYMENT_INTENT_STATUSES = new Set([
  "canceled",
  "processing",
  "requires_action",
  "requires_capture",
  "requires_confirmation",
  "requires_payment_method",
  "succeeded",
]);
const CHECKOUT_STATUSES = new Set(["open", "complete", "expired"]);
const CHECKOUT_PAYMENT_STATUSES = new Set([
  "paid",
  "unpaid",
  "no_payment_required",
]);

export interface CreditPackReconciliationGateway {
  checkoutSessionObject(sessionId: string): Promise<StripeObject>;
  paymentIntentObject(paymentIntentId: string): Promise<StripeObject>;
  chargeObject(chargeId: string): Promise<StripeObject>;
}

export interface CreditPackReconciliationProcessor {
  readonly productLine: string;
  readonly expectedLivemode: boolean;
  process(event: unknown): Promise<ProcessResult>;
}

export class CreditPackRemoteContractError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export class CreditPackProjectionError extends Error {}
class LeaseLostError extends Error {}

export class CreditPackReconcileClaim {
  public readonly orderId: string;
  public readonly accountId: string;
  public readonly token: string;
  public readonly checkoutStatus: string;
  public readonly paymentStatus: string;
  public readonly sessionId: string | null;
  public readonly paymentIntentId: string | null;
  public readonly chargeId: string | null;
  public readonly accountCustomerId: string | null;
  public readonly orderCustomerId: string | null;
  public readonly requestCustomerId: string | null;
  public readonly packKey: string;
  public readonly packCredits: bigint;
  public readonly priceAmount: bigint;
  public readonly currency: string;
  public readonly expiresDays: number;
  public readonly lookupKey: string;
  public readonly amountPaid: bigint | null;
  public readonly amountRefunded: bigint;

  public constructor(input: {
    readonly orderId: string;
    readonly accountId: string;
    readonly token: string;
    readonly checkoutStatus: string;
    readonly paymentStatus: string;
    readonly sessionId: string | null;
    readonly paymentIntentId: string | null;
    readonly chargeId: string | null;
    readonly accountCustomerId: string | null;
    readonly orderCustomerId: string | null;
    readonly requestCustomerId: string | null;
    readonly packKey: string;
    readonly packCredits: bigint;
    readonly priceAmount: bigint;
    readonly currency: string;
    readonly expiresDays: number;
    readonly lookupKey: string;
    readonly amountPaid: bigint | null;
    readonly amountRefunded: bigint;
  }) {
    this.orderId = input.orderId;
    this.accountId = input.accountId;
    this.token = input.token;
    this.checkoutStatus = input.checkoutStatus;
    this.paymentStatus = input.paymentStatus;
    this.sessionId = input.sessionId;
    this.paymentIntentId = input.paymentIntentId;
    this.chargeId = input.chargeId;
    this.accountCustomerId = input.accountCustomerId;
    this.orderCustomerId = input.orderCustomerId;
    this.requestCustomerId = input.requestCustomerId;
    this.packKey = input.packKey;
    this.packCredits = input.packCredits;
    this.priceAmount = input.priceAmount;
    this.currency = input.currency;
    this.expiresDays = input.expiresDays;
    this.lookupKey = input.lookupKey;
    this.amountPaid = input.amountPaid;
    this.amountRefunded = input.amountRefunded;
  }
}

export type CreditPackReconcileOutcome =
  | "reconciled"
  | "idle"
  | "failed"
  | "lost_lease"
  | "unavailable";

export class CreditPackReconcileResult {
  public readonly orderId: string;
  public readonly outcome: CreditPackReconcileOutcome;
  public readonly projections: readonly ProcessResult[];
  public readonly errorCode: string | null;

  public constructor(
    orderId: string,
    outcome: CreditPackReconcileOutcome,
    options: {
      readonly projections?: readonly ProcessResult[];
      readonly errorCode?: string | null;
    } = {},
  ) {
    this.orderId = orderId;
    this.outcome = outcome;
    this.projections = options.projections ?? [];
    this.errorCode = options.errorCode ?? null;
  }
}

interface ClaimRow extends QueryResultRow {
  readonly id: string;
  readonly account_id: string;
  readonly reconcile_claim_token: string;
  readonly checkout_status: string;
  readonly payment_status: string;
  readonly stripe_checkout_session_id: string | null;
  readonly stripe_payment_intent_id: string | null;
  readonly stripe_charge_id: string | null;
  readonly account_customer_id: string | null;
  readonly stripe_customer_id: string | null;
  readonly request_customer_id: string | null;
  readonly pack_key: string;
  readonly pack_credits: string;
  readonly price_amount: string;
  readonly currency: string;
  readonly expires_days: number;
  readonly price_lookup_key: string;
  readonly amount_paid: string | null;
  readonly amount_refunded: string;
}

interface SessionFact {
  readonly raw: StripeObject;
  readonly status: string;
  readonly paymentStatus: string;
  readonly paymentIntentId: string | null;
  readonly customerId: string | null;
  readonly created: number;
}

interface PaymentIntentFact {
  readonly raw: StripeObject;
  readonly status: string;
  readonly customerId: string;
  readonly chargeId: string | null;
  readonly created: number;
}

interface ChargeFact {
  readonly raw: StripeObject;
  readonly customerId: string;
  readonly amountRefunded: bigint;
  readonly disputed: boolean;
  readonly created: number;
}

function remoteCopy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => remoteCopy(item));
  }
  if (isPlainRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (!key.startsWith("_")) {
        copy[key] = remoteCopy(item);
      }
    }
    return copy;
  }
  return value;
}

function stripeId(
  value: unknown,
  prefix: string,
  code: string,
  optional = false,
): string | null {
  const candidate = isPlainRecord(value) ? value["id"] : value;
  if ((candidate === undefined || candidate === null) && optional) {
    return null;
  }
  if (
    typeof candidate !== "string" ||
    !candidate.startsWith(prefix) ||
    candidate !== candidate.trim() ||
    Buffer.byteLength(candidate, "utf8") > 255 ||
    !isPrintable(candidate)
  ) {
    throw new CreditPackRemoteContractError(code);
  }
  return candidate;
}

function remoteInteger(value: unknown, code: string, minimum = 0n): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CreditPackRemoteContractError(code);
  }
  const parsed = BigInt(value);
  if (parsed < minimum || parsed > POSTGRES_BIGINT_MAX) {
    throw new CreditPackRemoteContractError(code);
  }
  return parsed;
}

function created(value: unknown, code: string): number {
  const parsed = remoteInteger(value, code);
  return Number(parsed);
}

export function creditPackFactEventId(
  kind: string,
  ...identity: readonly unknown[]
): string {
  const fingerprint = createHash("sha256")
    .update(identity.map((value) => String(value)).join("\u001f"), "utf8")
    .digest("hex");
  return `reconcile:credit-pack:${kind}:${fingerprint}`;
}

function boundedDuration(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(
      `credit-pack reconciliation ${name} is outside its safe bound`,
    );
  }
  return value;
}

/**
 * Rebuilds missed credit-pack facts from Stripe current state with a fenced lease.
 * Stripe calls are always outside database transactions.
 */
export class CreditPackReconciliationService {
  readonly #database: Database;
  readonly #processor: CreditPackReconciliationProcessor;
  readonly #gateway: CreditPackReconciliationGateway;
  readonly #leaseMs: number;
  readonly #pendingIntervalMs: number;
  readonly #paidIntervalMs: number;

  public constructor(
    database: Database,
    processor: CreditPackReconciliationProcessor,
    gateway: CreditPackReconciliationGateway,
    options: {
      readonly leaseMs?: number;
      readonly pendingIntervalMs?: number;
      readonly paidIntervalMs?: number;
    } = {},
  ) {
    this.#database = database;
    this.#processor = processor;
    this.#gateway = gateway;
    this.#leaseMs = boundedDuration(
      options.leaseMs ?? 5 * 60_000,
      60 * 60_000,
      "lease",
    );
    this.#pendingIntervalMs = boundedDuration(
      options.pendingIntervalMs ?? 5 * 60_000,
      24 * 60 * 60_000,
      "pending interval",
    );
    this.#paidIntervalMs = boundedDuration(
      options.paidIntervalMs ?? 6 * 60 * 60_000,
      30 * 24 * 60 * 60_000,
      "paid interval",
    );
  }

  static #claim(row: ClaimRow): CreditPackReconcileClaim {
    return new CreditPackReconcileClaim({
      orderId: row.id,
      accountId: row.account_id,
      token: row.reconcile_claim_token,
      checkoutStatus: row.checkout_status,
      paymentStatus: row.payment_status,
      sessionId: row.stripe_checkout_session_id,
      paymentIntentId: row.stripe_payment_intent_id,
      chargeId: row.stripe_charge_id,
      accountCustomerId: row.account_customer_id,
      orderCustomerId: row.stripe_customer_id,
      requestCustomerId: row.request_customer_id,
      packKey: row.pack_key,
      packCredits: pgBigInt(row.pack_credits, "pack credits"),
      priceAmount: pgBigInt(row.price_amount, "pack price amount"),
      currency: row.currency,
      expiresDays: row.expires_days,
      lookupKey: row.price_lookup_key,
      amountPaid:
        row.amount_paid === null
          ? null
          : pgBigInt(row.amount_paid, "pack amount paid"),
      amountRefunded: pgBigInt(row.amount_refunded, "pack amount refunded"),
    });
  }

  async #claimNext(): Promise<CreditPackReconcileClaim | undefined> {
    const token = randomUUID();
    const row = await this.#database.transaction(async (transaction) => {
      const result = await transaction.query<ClaimRow>(
        `with candidate as (
           select o.id from credit_pack_orders o
            where (
              o.payment_status in ('pending','paid','partially_refunded')
              or (
                o.payment_status in ('refunded','disputed')
                and not exists(
                  select 1 from credit_funding_lots l where l.order_id=o.id
                )
              )
            )
              and (
                o.reconcile_claim_token is null
                or o.reconcile_claim_expires_at <= clock_timestamp()
              )
              and (
                o.last_reconciled_at is null
                or o.last_reconciled_at < clock_timestamp() -
                  case when o.payment_status='pending'
                    then $1::bigint * interval '1 millisecond'
                    else $2::bigint * interval '1 millisecond' end
              )
            order by o.last_reconciled_at nulls first,
                     case when o.payment_status='pending' then 0 else 1 end,
                     o.id
            for update skip locked limit 1
         ), claimed as (
           update credit_pack_orders o set
             reconcile_claim_token=$3::uuid,
             reconcile_claim_expires_at=clock_timestamp()+
               $4::bigint * interval '1 millisecond',
             updated_at=clock_timestamp()
             from candidate c where o.id=c.id returning o.*
         )
         select c.*,a.stripe_customer_id as account_customer_id
           from claimed c join billing_accounts a on a.id=c.account_id`,
        [this.#pendingIntervalMs, this.#paidIntervalMs, token, this.#leaseMs],
      );
      return result.rows[0];
    });
    return row === undefined
      ? undefined
      : CreditPackReconciliationService.#claim(row);
  }

  async #claimOrder(
    orderId: string,
  ): Promise<CreditPackReconcileClaim | undefined> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        orderId,
      )
    ) {
      return undefined;
    }
    const token = randomUUID();
    const row = await this.#database.transaction(async (transaction) => {
      const result = await transaction.query<ClaimRow>(
        `with claimed as (
           update credit_pack_orders o set
             reconcile_claim_token=$2::uuid,
             reconcile_claim_expires_at=clock_timestamp()+
               $3::bigint * interval '1 millisecond',
             updated_at=clock_timestamp()
            where o.id=$1::uuid
              and o.payment_status in (
                'pending','paid','partially_refunded','refunded','disputed'
              )
              and (
                o.reconcile_claim_token is null
                or o.reconcile_claim_expires_at <= clock_timestamp()
              )
            returning o.*
         )
         select c.*,a.stripe_customer_id as account_customer_id
           from claimed c join billing_accounts a on a.id=c.account_id`,
        [orderId, token, this.#leaseMs],
      );
      return result.rows[0];
    });
    return row === undefined
      ? undefined
      : CreditPackReconciliationService.#claim(row);
  }

  async #renew(claim: CreditPackReconcileClaim): Promise<boolean> {
    const result = await this.#database.query<
      { readonly id: string } & QueryResultRow
    >(
      `update credit_pack_orders set
         reconcile_claim_expires_at=clock_timestamp()+
           $3::bigint * interval '1 millisecond',updated_at=clock_timestamp()
        where id=$1::uuid and reconcile_claim_token=$2::uuid
          and reconcile_claim_expires_at > clock_timestamp()
        returning id::text`,
      [claim.orderId, claim.token, this.#leaseMs],
    );
    return result.rows[0] !== undefined;
  }

  async #remote<T>(
    claim: CreditPackReconcileClaim,
    call: () => Promise<T>,
  ): Promise<T> {
    if (!(await this.#renew(claim))) {
      throw new LeaseLostError();
    }
    const result = await call();
    if (!(await this.#renew(claim))) {
      throw new LeaseLostError();
    }
    return result;
  }

  #metadataMatches(
    claim: CreditPackReconcileClaim,
    raw: StripeObject,
  ): boolean {
    const metadata = raw["metadata"];
    if (!isPlainRecord(metadata)) {
      return false;
    }
    const expected: Readonly<Record<string, string>> = {
      billing_kind: "credit_pack",
      pack_schema_version: PACK_SCHEMA_VERSION,
      product_line: this.#processor.productLine,
      credit_pack_order_id: claim.orderId,
      account_id: claim.accountId,
      pack_key: claim.packKey,
      pack_credits: CreditAmount.fromAtoms(claim.packCredits).toString(),
      price_amount: claim.priceAmount.toString(),
      currency: claim.currency,
      expires_days: claim.expiresDays.toString(),
      lookup_key: claim.lookupKey,
    };
    return Object.entries(expected).every(
      ([key, value]) => metadata[key] === value,
    );
  }

  #modeMatches(raw: StripeObject): boolean {
    return raw["livemode"] === this.#processor.expectedLivemode;
  }

  #validateSession(
    claim: CreditPackReconcileClaim,
    rawValue: StripeObject,
  ): SessionFact {
    const copied = remoteCopy(rawValue);
    if (!isPlainRecord(copied)) {
      throw new CreditPackRemoteContractError("checkout_shape_invalid");
    }
    const raw: StripeObject = copied;
    const sessionId = stripeId(raw["id"], "cs_", "checkout_identity_invalid");
    const status = raw["status"];
    const paymentStatus = raw["payment_status"];
    if (
      sessionId !== claim.sessionId ||
      raw["object"] !== "checkout.session" ||
      raw["mode"] !== "payment" ||
      typeof status !== "string" ||
      !CHECKOUT_STATUSES.has(status) ||
      typeof paymentStatus !== "string" ||
      !CHECKOUT_PAYMENT_STATUSES.has(paymentStatus) ||
      !this.#modeMatches(raw) ||
      raw["client_reference_id"] !== claim.accountId ||
      !this.#metadataMatches(claim, raw) ||
      remoteInteger(raw["amount_total"], "checkout_amount_invalid") !==
        claim.priceAmount ||
      raw["currency"] !== claim.currency
    ) {
      throw new CreditPackRemoteContractError("checkout_contract_mismatch");
    }
    const paymentIntentId = stripeId(
      raw["payment_intent"],
      "pi_",
      "checkout_payment_identity_invalid",
      true,
    );
    const customerId = stripeId(
      raw["customer"],
      "cus_",
      "checkout_customer_identity_invalid",
      true,
    );
    if (
      claim.paymentIntentId !== null &&
      claim.paymentIntentId !== paymentIntentId
    ) {
      throw new CreditPackRemoteContractError(
        "checkout_payment_identity_conflict",
      );
    }
    if (
      [
        claim.requestCustomerId,
        claim.orderCustomerId,
        claim.accountCustomerId,
      ].some((expected) => expected !== null && expected !== customerId)
    ) {
      throw new CreditPackRemoteContractError(
        "checkout_customer_identity_conflict",
      );
    }
    if (
      status === "complete" &&
      (paymentIntentId === null || customerId === null)
    ) {
      throw new CreditPackRemoteContractError("checkout_completion_incomplete");
    }
    if (status === "complete" && paymentStatus === "no_payment_required") {
      throw new CreditPackRemoteContractError(
        "checkout_payment_contract_mismatch",
      );
    }
    return {
      raw,
      status,
      paymentStatus,
      paymentIntentId,
      customerId,
      created: created(raw["created"], "checkout_created_invalid"),
    };
  }

  #validatePaymentIntent(
    claim: CreditPackReconcileClaim,
    rawValue: StripeObject,
    expectedId: string,
    sessionCustomerId: string | null,
  ): PaymentIntentFact {
    const copied = remoteCopy(rawValue);
    if (!isPlainRecord(copied)) {
      throw new CreditPackRemoteContractError("payment_intent_shape_invalid");
    }
    const raw: StripeObject = copied;
    const paymentIntentId = stripeId(
      raw["id"],
      "pi_",
      "payment_intent_identity_invalid",
    );
    const status = raw["status"];
    const customerId = stripeId(
      raw["customer"],
      "cus_",
      "payment_intent_customer_invalid",
    );
    const amount = remoteInteger(
      raw["amount"],
      "payment_intent_amount_invalid",
    );
    const amountReceived = remoteInteger(
      raw["amount_received"],
      "payment_intent_received_invalid",
    );
    if (
      paymentIntentId !== expectedId ||
      raw["object"] !== "payment_intent" ||
      typeof status !== "string" ||
      !PAYMENT_INTENT_STATUSES.has(status) ||
      !this.#modeMatches(raw) ||
      !this.#metadataMatches(claim, raw) ||
      amount !== claim.priceAmount ||
      amountReceived > amount ||
      raw["currency"] !== claim.currency
    ) {
      throw new CreditPackRemoteContractError(
        "payment_intent_contract_mismatch",
      );
    }
    if (
      [
        claim.requestCustomerId,
        claim.orderCustomerId,
        claim.accountCustomerId,
        sessionCustomerId,
      ].some((expected) => expected !== null && expected !== customerId)
    ) {
      throw new CreditPackRemoteContractError(
        "payment_intent_customer_conflict",
      );
    }
    if (status === "succeeded" && amountReceived !== amount) {
      throw new CreditPackRemoteContractError(
        "payment_intent_settlement_mismatch",
      );
    }
    if (claim.amountPaid !== null && claim.amountPaid !== amountReceived) {
      throw new CreditPackRemoteContractError(
        "payment_intent_settlement_regressed",
      );
    }
    if (claim.paymentStatus !== "pending" && status !== "succeeded") {
      throw new CreditPackRemoteContractError(
        "payment_intent_status_regressed",
      );
    }
    const chargeId = stripeId(
      raw["latest_charge"],
      "ch_",
      "payment_intent_charge_invalid",
      true,
    );
    if (claim.chargeId !== null && claim.chargeId !== chargeId) {
      throw new CreditPackRemoteContractError("payment_intent_charge_conflict");
    }
    if (status === "succeeded" && chargeId === null) {
      throw new CreditPackRemoteContractError("payment_intent_charge_missing");
    }
    if (customerId === null) {
      throw new CreditPackRemoteContractError(
        "payment_intent_customer_invalid",
      );
    }
    return {
      raw,
      status,
      customerId,
      chargeId,
      created: created(raw["created"], "payment_intent_created_invalid"),
    };
  }

  #validateCharge(
    claim: CreditPackReconcileClaim,
    rawValue: StripeObject,
    expectedId: string,
    paymentIntentId: string,
    customerId: string,
  ): ChargeFact {
    const copied = remoteCopy(rawValue);
    if (!isPlainRecord(copied)) {
      throw new CreditPackRemoteContractError("charge_shape_invalid");
    }
    const raw: StripeObject = copied;
    const chargeId = stripeId(raw["id"], "ch_", "charge_identity_invalid");
    const remotePayment = stripeId(
      raw["payment_intent"],
      "pi_",
      "charge_payment_identity_invalid",
    );
    const remoteCustomer = stripeId(
      raw["customer"],
      "cus_",
      "charge_customer_identity_invalid",
    );
    const amount = remoteInteger(raw["amount"], "charge_amount_invalid");
    const amountRefunded = remoteInteger(
      raw["amount_refunded"],
      "charge_refund_amount_invalid",
    );
    const disputed = raw["disputed"];
    const refunded = raw["refunded"];
    if (
      chargeId !== expectedId ||
      remotePayment !== paymentIntentId ||
      remoteCustomer !== customerId ||
      raw["object"] !== "charge" ||
      raw["paid"] !== true ||
      typeof disputed !== "boolean" ||
      typeof refunded !== "boolean" ||
      !this.#modeMatches(raw) ||
      amount !== claim.priceAmount ||
      amountRefunded > amount ||
      (!disputed && amountRefunded < claim.amountRefunded) ||
      refunded !== (amountRefunded === amount) ||
      raw["currency"] !== claim.currency
    ) {
      throw new CreditPackRemoteContractError("charge_contract_mismatch");
    }
    if (remoteCustomer === null) {
      throw new CreditPackRemoteContractError(
        "charge_customer_identity_invalid",
      );
    }
    return {
      raw,
      customerId: remoteCustomer,
      amountRefunded,
      disputed,
      created: created(raw["created"], "charge_created_invalid"),
    };
  }

  #event(
    claim: CreditPackReconcileClaim,
    input: {
      readonly eventId: string;
      readonly eventType: string;
      readonly created: number;
      readonly object: StripeObject;
    },
  ): Record<string, unknown> {
    return {
      id: input.eventId,
      object: "event",
      type: input.eventType,
      created: input.created,
      livemode: this.#processor.expectedLivemode,
      _remote_verified: true,
      _credit_pack_reconcile_claim: {
        order_id: claim.orderId,
        account_id: claim.accountId,
        token: claim.token,
      },
      data: { object: { ...input.object } },
    };
  }

  async #project(
    claim: CreditPackReconcileClaim,
    event: Record<string, unknown>,
  ): Promise<ProcessResult> {
    if (!(await this.#renew(claim))) {
      throw new LeaseLostError();
    }
    const result = await this.#processor.process(event);
    if (
      result.outcome === "ignored" &&
      result.reason === "credit-pack reconciliation lease lost"
    ) {
      throw new LeaseLostError();
    }
    if (result.outcome === "handled" || result.outcome === "replayed") {
      return result;
    }
    if (result.outcome === "duplicate") {
      const prior = await this.#database.query<
        { readonly outcome: string | null } & QueryResultRow
      >("select outcome from stripe_webhook_events where id=$1", [event["id"]]);
      if (
        prior.rows[0]?.outcome === "handled" ||
        prior.rows[0]?.outcome === "replayed"
      ) {
        return result;
      }
    }
    throw new CreditPackProjectionError(
      "remote-verified credit-pack fact was not committed",
    );
  }

  async #finish(
    claim: CreditPackReconcileClaim,
    errorCode: string | null,
  ): Promise<boolean> {
    const result = await this.#database.query<
      { readonly id: string } & QueryResultRow
    >(
      `update credit_pack_orders set
         reconcile_claim_token=null,reconcile_claim_expires_at=null,
         last_reconciled_at=clock_timestamp(),last_reconcile_error=$3,
         updated_at=clock_timestamp()
        where id=$1::uuid and reconcile_claim_token=$2::uuid
          and reconcile_claim_expires_at > clock_timestamp()
        returning id::text`,
      [claim.orderId, claim.token, errorCode],
    );
    return result.rows[0] !== undefined;
  }

  static #errorCode(error: unknown): string {
    if (error instanceof CreditPackRemoteContractError) {
      return error.code;
    }
    return (
      error instanceof Error ? error.constructor.name : "UnknownError"
    ).slice(0, 255);
  }

  async #reconcileClaim(
    claim: CreditPackReconcileClaim,
  ): Promise<CreditPackReconcileResult> {
    const projections: ProcessResult[] = [];
    try {
      let session: SessionFact | undefined;
      let paymentIntentId = claim.paymentIntentId;
      let sessionCustomerId: string | null = null;
      if (claim.sessionId !== null) {
        const remoteSession = await this.#remote(claim, () =>
          this.#gateway.checkoutSessionObject(claim.sessionId ?? ""),
        );
        session = this.#validateSession(claim, remoteSession);
        paymentIntentId ??= session.paymentIntentId;
        sessionCustomerId = session.customerId;
      }

      let paymentIntent: PaymentIntentFact | undefined;
      let charge: ChargeFact | undefined;
      let chargeId = claim.chargeId;
      if (paymentIntentId !== null) {
        const remotePaymentIntent = await this.#remote(claim, () =>
          this.#gateway.paymentIntentObject(paymentIntentId ?? ""),
        );
        paymentIntent = this.#validatePaymentIntent(
          claim,
          remotePaymentIntent,
          paymentIntentId,
          sessionCustomerId,
        );
        if (
          session?.paymentStatus === "paid" &&
          paymentIntent.status !== "succeeded"
        ) {
          throw new CreditPackRemoteContractError(
            "checkout_payment_status_mismatch",
          );
        }
        chargeId ??= paymentIntent.chargeId;
        if (chargeId !== null) {
          const remoteCharge = await this.#remote(claim, () =>
            this.#gateway.chargeObject(chargeId ?? ""),
          );
          charge = this.#validateCharge(
            claim,
            remoteCharge,
            chargeId,
            paymentIntentId,
            paymentIntent.customerId,
          );
        }
      }

      if (
        session !== undefined &&
        (session.status === "complete" || session.status === "expired")
      ) {
        projections.push(
          await this.#project(
            claim,
            this.#event(claim, {
              eventId: creditPackFactEventId(
                "checkout",
                claim.orderId,
                claim.sessionId,
                session.status,
                session.paymentIntentId,
              ),
              eventType:
                session.status === "complete"
                  ? "checkout.session.completed"
                  : "checkout.session.expired",
              created: session.created,
              object: session.raw,
            }),
          ),
        );
      }

      if (paymentIntent?.status === "succeeded") {
        projections.push(
          await this.#project(
            claim,
            this.#event(claim, {
              eventId: creditPackFactEventId(
                "payment",
                claim.orderId,
                paymentIntentId,
                paymentIntent.chargeId,
              ),
              eventType: "payment_intent.succeeded",
              created: charge?.created ?? paymentIntent.created,
              object: paymentIntent.raw,
            }),
          ),
        );
      }

      if (
        charge !== undefined &&
        (charge.disputed || charge.amountRefunded > 0n)
      ) {
        if (paymentIntent === undefined) {
          throw new Error("charge reconciliation has no PaymentIntent fact");
        }
        let eventType: string;
        let eventObject: StripeObject;
        let eventId: string;
        if (charge.disputed) {
          eventType = "charge.dispute.created";
          eventId = creditPackFactEventId(
            "dispute",
            claim.orderId,
            paymentIntentId,
            chargeId,
          );
          const digest = eventId.slice(eventId.lastIndexOf(":") + 1);
          eventObject = {
            id: `dp_reconcile_${digest.slice(0, 32)}`,
            object: "dispute",
            charge: chargeId,
            amount: Number(claim.priceAmount),
            currency: claim.currency,
            _resolved_charge: charge.raw,
            _resolved_payment_intent: paymentIntent.raw,
          };
        } else {
          eventType = "charge.refunded";
          eventObject = {
            ...charge.raw,
            _resolved_payment_intent: paymentIntent.raw,
          };
          eventId = creditPackFactEventId(
            "refund",
            claim.orderId,
            paymentIntentId,
            chargeId,
            charge.amountRefunded,
          );
        }
        projections.push(
          await this.#project(
            claim,
            this.#event(claim, {
              eventId,
              eventType,
              created: charge.created,
              object: eventObject,
            }),
          ),
        );
      }

      const idleCode =
        projections.length === 0 &&
        claim.checkoutStatus === "reserved" &&
        claim.sessionId === null &&
        claim.paymentIntentId === null &&
        claim.chargeId === null
          ? "checkout_replay_required"
          : null;
      if (!(await this.#finish(claim, idleCode))) {
        throw new LeaseLostError();
      }
      return new CreditPackReconcileResult(
        claim.orderId,
        projections.length > 0 ? "reconciled" : "idle",
        { projections, errorCode: idleCode },
      );
    } catch (error) {
      if (error instanceof LeaseLostError) {
        return new CreditPackReconcileResult(claim.orderId, "lost_lease", {
          projections,
          errorCode: "lease_lost",
        });
      }
      const errorCode = CreditPackReconciliationService.#errorCode(error);
      if (!(await this.#finish(claim, errorCode))) {
        return new CreditPackReconcileResult(claim.orderId, "lost_lease", {
          projections,
          errorCode: "lease_lost",
        });
      }
      return new CreditPackReconcileResult(claim.orderId, "failed", {
        projections,
        errorCode,
      });
    }
  }

  public async reconcileDue(
    options: { readonly limit?: number } = {},
  ): Promise<readonly CreditPackReconcileResult[]> {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
      throw new RangeError(
        "credit-pack reconciliation limit must be between 1 and 10000",
      );
    }
    const results: CreditPackReconcileResult[] = [];
    for (let index = 0; index < limit; index += 1) {
      const claim = await this.#claimNext();
      if (claim === undefined) {
        break;
      }
      results.push(await this.#reconcileClaim(claim));
    }
    return results;
  }

  public async reconcileOrder(
    orderId: string,
  ): Promise<CreditPackReconcileResult> {
    const claim = await this.#claimOrder(orderId);
    if (claim === undefined) {
      return new CreditPackReconcileResult(String(orderId), "unavailable");
    }
    return this.#reconcileClaim(claim);
  }
}

export { RECONCILABLE_PAYMENT_STATUSES };
