import type { QueryResultRow } from "pg";

import type { Plan, PlanCatalog } from "./catalog.js";
import { CreditPackEventProcessor } from "./credit-pack-events.js";
import type { Database } from "./database.js";
import { pgBigInt, type TransactionClient } from "./db-types.js";
import { redactedEventSnapshot } from "./event-audit.js";
import { eventWins, rankFor } from "./ordering.js";
import { catalogPriceMatches } from "./price-policy.js";
import {
  asStripeId,
  eventShapeError,
  linePriceId,
  subscriptionId,
  validEventIdentifier,
  type StripeObject,
} from "./processor-primitives.js";
import { SubscriptionEventProjector } from "./subscription-projector.js";
import type { ProcessResult } from "./types.js";
import { isPlainRecord } from "./validation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface BillingEventProjector {
  invoicePaid(
    transaction: TransactionClient,
    event: StripeObject,
    runtime: ProcessorRuntime,
  ): Promise<ProcessResult>;
  paymentFailed(
    transaction: TransactionClient,
    event: StripeObject,
    runtime: ProcessorRuntime,
  ): Promise<ProcessResult>;
  subscriptionUpdated(
    transaction: TransactionClient,
    event: StripeObject,
    runtime: ProcessorRuntime,
  ): Promise<ProcessResult>;
  subscriptionDeleted(
    transaction: TransactionClient,
    event: StripeObject,
    runtime: ProcessorRuntime,
  ): Promise<ProcessResult>;
  clawback(
    transaction: TransactionClient,
    event: StripeObject,
    runtime: ProcessorRuntime,
  ): Promise<ProcessResult>;
  checkoutCompleted(
    transaction: TransactionClient,
    event: StripeObject,
    runtime: ProcessorRuntime,
  ): Promise<ProcessResult>;
  checkoutExpired(
    transaction: TransactionClient,
    event: StripeObject,
    runtime: ProcessorRuntime,
  ): Promise<ProcessResult>;
}

export interface ProcessorAccountRow extends QueryResultRow {
  readonly id: string;
  readonly stripe_customer_id: string | null;
  readonly stripe_subscription_id: string | null;
  readonly event_created: string;
  readonly event_rank: number;
  readonly [column: string]: unknown;
}

export interface ProcessorRuntime {
  readonly catalog: PlanCatalog;
  readonly productLine: string;
  recordIncident(
    transaction: TransactionClient,
    input: {
      readonly kind: string;
      readonly event: StripeObject;
      readonly dedupeKey: string;
      readonly invoiceId?: string;
      readonly accountId?: string;
      readonly detail?: Readonly<Record<string, unknown>>;
    },
  ): Promise<void>;
  lockAccount(
    transaction: TransactionClient,
    object: StripeObject,
    metadata?: StripeObject,
  ): Promise<ProcessorAccountRow | undefined>;
  eventWinsAccount(account: ProcessorAccountRow, event: StripeObject): boolean;
  catalogLineMatches(
    line: StripeObject,
    plan: Plan,
    interval: "month" | "year",
  ): boolean;
}

interface EventInboxClaimRow extends QueryResultRow {
  readonly id: string;
}

function canonicalUuid(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value : undefined;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

export interface EventProcessorOptions {
  readonly expectedLivemode?: boolean;
  readonly expectedApiVersion?: string;
  readonly projector?: BillingEventProjector;
}

export class EventProcessor implements ProcessorRuntime {
  readonly #database: Database;
  readonly #projector: BillingEventProjector;
  readonly #creditPackEvents: CreditPackEventProcessor;
  readonly #expectedLivemode: boolean;
  readonly #expectedApiVersion?: string;

  public readonly catalog: PlanCatalog;
  public readonly productLine: string;

  public get expectedLivemode(): boolean {
    return this.#expectedLivemode;
  }

  public constructor(
    database: Database,
    catalog: PlanCatalog,
    productLine: string,
    options: EventProcessorOptions = {},
  ) {
    this.#database = database;
    this.catalog = catalog;
    this.productLine = productLine;
    this.#projector = options.projector ?? new SubscriptionEventProjector();
    this.#creditPackEvents = new CreditPackEventProcessor(catalog, productLine);
    this.#expectedLivemode = options.expectedLivemode ?? false;
    if (options.expectedApiVersion !== undefined) {
      this.#expectedApiVersion = options.expectedApiVersion;
    }
  }

  public async hasCommittedEvent(eventId: unknown): Promise<boolean> {
    if (!validEventIdentifier(eventId, 512)) {
      return false;
    }
    const result = await this.#database.query<
      { readonly exists: boolean } & QueryResultRow
    >(
      "select exists(select 1 from stripe_webhook_events where id=$1) as exists",
      [eventId],
    );
    return result.rows[0]?.exists === true;
  }

  async #creditPackReconcileClaimCurrent(
    transaction: TransactionClient,
    event: StripeObject,
  ): Promise<boolean> {
    const rawGuard = event["_credit_pack_reconcile_claim"];
    if (rawGuard === undefined || rawGuard === null) {
      return true;
    }
    if (event["_remote_verified"] !== true || !isPlainRecord(rawGuard)) {
      return false;
    }
    const orderId = canonicalUuid(rawGuard["order_id"]);
    const accountId = canonicalUuid(rawGuard["account_id"]);
    const token = canonicalUuid(rawGuard["token"]);
    if (
      orderId === undefined ||
      accountId === undefined ||
      token === undefined
    ) {
      return false;
    }
    const owner = await transaction.query<
      { readonly account_id: string } & QueryResultRow
    >("select account_id::text from credit_pack_orders where id=$1::uuid", [
      orderId,
    ]);
    if (owner.rows[0]?.account_id !== accountId) {
      return false;
    }
    const account = await transaction.query<
      { readonly id: string } & QueryResultRow
    >("select id::text from billing_accounts where id=$1::uuid for update", [
      accountId,
    ]);
    if (account.rows[0] === undefined) {
      return false;
    }
    const order = await transaction.query<
      { readonly id: string } & QueryResultRow
    >(
      `select id::text from credit_pack_orders
        where id=$1::uuid and account_id=$2::uuid
          and reconcile_claim_token=$3::uuid
          and reconcile_claim_expires_at>clock_timestamp()
        for update`,
      [orderId, accountId, token],
    );
    return order.rows[0] !== undefined;
  }

  public async process(eventInput: unknown): Promise<ProcessResult> {
    if (!isPlainRecord(eventInput)) {
      return {
        outcome: "ignored",
        reason: "Stripe Event requires a stable visible string id",
      };
    }
    const event: StripeObject = eventInput;
    const eventId = event["id"];
    if (!validEventIdentifier(eventId, 512)) {
      return {
        outcome: "ignored",
        reason: "Stripe Event requires a stable visible string id",
      };
    }
    const eventType = event["type"];
    if (!validEventIdentifier(eventType, 255)) {
      return {
        outcome: "ignored",
        reason: "Stripe Event requires a stable visible string type",
      };
    }
    const auditPayload = redactedEventSnapshot(event);
    return this.#database.transaction(async (transaction) => {
      if (!(await this.#creditPackReconcileClaimCurrent(transaction, event))) {
        return {
          outcome: "ignored",
          reason: "credit-pack reconciliation lease lost",
        };
      }
      const claim = await transaction.query<EventInboxClaimRow>(
        `insert into stripe_webhook_events(id,event_type,livemode,payload)
         values($1,$2,$3,$4::jsonb)
         on conflict do nothing returning id`,
        [
          eventId,
          eventType,
          typeof event["livemode"] === "boolean" ? event["livemode"] : false,
          safeJson(auditPayload),
        ],
      );
      if (claim.rows[0] === undefined) {
        return { outcome: "duplicate", reason: "event id already committed" };
      }
      const shapeError = eventShapeError(event);
      if (shapeError !== undefined) {
        await this.recordIncident(transaction, {
          kind: "invalid_event_shape",
          event,
          dedupeKey: eventId,
          detail: { event_type: eventType, reason: shapeError },
        });
        await transaction.query(
          `update stripe_webhook_events set outcome='ignored',reason=$2,
             processed_at=clock_timestamp() where id=$1`,
          [eventId, shapeError],
        );
        return { outcome: "ignored", reason: shapeError };
      }
      if (event["_remote_verified"] !== true) {
        let mismatch: string | undefined;
        if (event["livemode"] !== this.#expectedLivemode) {
          mismatch =
            "event livemode does not match the configured Stripe key mode";
        } else if (
          this.#expectedApiVersion !== undefined &&
          event["api_version"] !== this.#expectedApiVersion
        ) {
          mismatch =
            "event API version does not match the pinned webhook endpoint";
        }
        if (mismatch !== undefined) {
          await this.recordIncident(transaction, {
            kind: "webhook_contract_mismatch",
            event,
            dedupeKey: eventId,
            detail: {
              expected_livemode: this.#expectedLivemode,
              expected_api_version: this.#expectedApiVersion ?? null,
              event_api_version: event["api_version"] ?? null,
            },
          });
          await transaction.query(
            `update stripe_webhook_events set outcome='ignored',reason=$2,
               processed_at=clock_timestamp() where id=$1`,
            [eventId, mismatch],
          );
          return { outcome: "ignored", reason: mismatch };
        }
      }
      const result = await this.#dispatch(transaction, event);
      await transaction.query(
        `update stripe_webhook_events set outcome=$2,reason=$3,
           processed_at=clock_timestamp() where id=$1`,
        [eventId, result.outcome, result.reason ?? null],
      );
      return result;
    });
  }

  async #dispatch(
    transaction: TransactionClient,
    event: StripeObject,
  ): Promise<ProcessResult> {
    switch (event["type"]) {
      case "payment_intent.succeeded":
        return this.#creditPackEvents.paymentSucceeded(transaction, event);
      case "invoice.paid":
        return this.#projector.invoicePaid(transaction, event, this);
      case "invoice.payment_failed":
        return this.#projector.paymentFailed(transaction, event, this);
      case "customer.subscription.updated":
        return this.#projector.subscriptionUpdated(transaction, event, this);
      case "customer.subscription.deleted":
        return this.#projector.subscriptionDeleted(transaction, event, this);
      case "charge.refunded":
      case "charge.dispute.created": {
        const pack = await this.#creditPackEvents.clawback(transaction, event);
        return pack ?? this.#projector.clawback(transaction, event, this);
      }
      case "checkout.session.completed": {
        const pack = await this.#creditPackEvents.checkoutEvent(
          transaction,
          event,
        );
        return (
          pack ?? this.#projector.checkoutCompleted(transaction, event, this)
        );
      }
      case "checkout.session.expired": {
        const pack = await this.#creditPackEvents.checkoutEvent(
          transaction,
          event,
        );
        return (
          pack ?? this.#projector.checkoutExpired(transaction, event, this)
        );
      }
      default:
        return {
          outcome: "ignored",
          reason: "event type is outside the reference contract",
        };
    }
  }

  public async recordIncident(
    transaction: TransactionClient,
    input: {
      readonly kind: string;
      readonly event: StripeObject;
      readonly dedupeKey: string;
      readonly invoiceId?: string;
      readonly accountId?: string;
      readonly detail?: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    await transaction.query(
      `insert into billing_incidents(
         kind,dedupe_key,stripe_event_id,invoice_id,account_id,detail)
       values($1,$2,$3,$4,$5::uuid,$6::jsonb)
       on conflict(kind,dedupe_key) where resolved_at is null do update set
         stripe_event_id=excluded.stripe_event_id,
         invoice_id=coalesce(excluded.invoice_id,billing_incidents.invoice_id),
         account_id=coalesce(excluded.account_id,billing_incidents.account_id),
         detail=excluded.detail,
         seen_count=billing_incidents.seen_count+1,
         last_seen_at=clock_timestamp()`,
      [
        input.kind,
        input.dedupeKey,
        typeof input.event["id"] === "string" ? input.event["id"] : null,
        input.invoiceId ?? null,
        input.accountId ?? null,
        safeJson(input.detail ?? {}),
      ],
    );
  }

  public async lockAccount(
    transaction: TransactionClient,
    object: StripeObject,
    suppliedMetadata?: StripeObject,
  ): Promise<ProcessorAccountRow | undefined> {
    const rawMetadata = suppliedMetadata ?? object["metadata"];
    const values = isPlainRecord(rawMetadata) ? rawMetadata : {};
    const accountId = canonicalUuid(values["account_id"]);
    if (accountId !== undefined) {
      const result = await transaction.query<ProcessorAccountRow>(
        "select * from billing_accounts where id=$1::uuid for update",
        [accountId],
      );
      return result.rows[0];
    }
    const externalRef = values["external_ref"] ?? object["client_reference_id"];
    if (typeof externalRef === "string" && externalRef.length > 0) {
      const result = await transaction.query<ProcessorAccountRow>(
        "select * from billing_accounts where external_ref=$1 for update",
        [externalRef],
      );
      if (result.rows[0] !== undefined) {
        return result.rows[0];
      }
    }
    const candidateSubscription =
      subscriptionId(object) ?? asStripeId(object["id"]);
    if (candidateSubscription !== undefined) {
      const result = await transaction.query<ProcessorAccountRow>(
        "select * from billing_accounts where stripe_subscription_id=$1 for update",
        [candidateSubscription],
      );
      if (result.rows[0] !== undefined) {
        return result.rows[0];
      }
    }
    const customerId = asStripeId(object["customer"]);
    if (customerId !== undefined) {
      const result = await transaction.query<ProcessorAccountRow>(
        "select * from billing_accounts where stripe_customer_id=$1 for update",
        [customerId],
      );
      return result.rows[0];
    }
    return undefined;
  }

  public eventWinsAccount(
    account: ProcessorAccountRow,
    event: StripeObject,
  ): boolean {
    if (event["_remote_verified"] === true) {
      const expected = event["_expected_account"];
      const expectedCreated = isPlainRecord(expected)
        ? expected["event_created"]
        : undefined;
      const expectedRank = isPlainRecord(expected)
        ? expected["event_rank"]
        : undefined;
      return (
        isPlainRecord(expected) &&
        typeof expectedCreated === "string" &&
        typeof expectedRank === "number" &&
        account.stripe_subscription_id === expected["stripe_subscription_id"] &&
        pgBigInt(account.event_created) ===
          pgBigInt(expectedCreated, "expected event_created") &&
        account.event_rank === expectedRank
      );
    }
    const created = event["created"];
    return (
      typeof created === "number" &&
      Number.isSafeInteger(created) &&
      eventWins({
        currentCreated: pgBigInt(account.event_created),
        currentRank: account.event_rank,
        eventCreated: BigInt(created),
        eventRank: rankFor(String(event["type"])),
      })
    );
  }

  public catalogLineMatches(
    line: StripeObject,
    plan: Plan,
    interval: "month" | "year",
  ): boolean {
    const price = line["_resolved_price"];
    const priceId = linePriceId(line);
    if (!isPlainRecord(price) || priceId === undefined) {
      return false;
    }
    const expectedAmount =
      (interval === "month" ? plan.monthUsd : plan.yearUsd) * 100;
    return catalogPriceMatches(price, {
      expectedCurrency: plan.currency,
      expectedUnitAmount: expectedAmount,
      expectedInterval: interval,
      expectedProductLine: this.productLine,
      expectedPlanKey: plan.key,
      expectedLookupKey: this.catalog.lookupKey(plan.key, interval),
      expectedPriceId: priceId,
      requireActive: false,
    });
  }
}
