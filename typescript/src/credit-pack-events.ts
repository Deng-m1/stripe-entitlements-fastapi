import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import type { PlanCatalog } from "./catalog.js";
import { checkedAddAtoms, creditDecimal } from "./credit-amount.js";
import { collectPackDebtsFromLot } from "./credit-pack-funding.js";
import { pgBigInt, type TransactionClient } from "./db-types.js";
import {
  asStripeId,
  stripeNonnegativeInteger,
  type StripeObject,
} from "./processor-primitives.js";
import type { ProcessResult } from "./types.js";
import { isPlainRecord } from "./validation.js";

const PACK_SCHEMA_VERSION = "1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface DynamicRow extends QueryResultRow {
  readonly [column: string]: unknown;
}

interface IdentityRow extends QueryResultRow {
  readonly id: string;
  readonly account_id: string;
}

interface LockedAccount extends DynamicRow {
  readonly id: string;
  readonly stripe_customer_id: string | null;
}

interface LockedOrder extends DynamicRow {
  readonly id: string;
  readonly account_id: string;
  readonly pack_key: string;
  readonly pack_credits: string;
  readonly price_amount: string;
  readonly currency: string;
  readonly expires_days: number;
  readonly price_lookup_key: string;
  readonly request_customer_id: string | null;
  readonly stripe_checkout_session_id: string | null;
  readonly stripe_payment_intent_id: string | null;
  readonly stripe_charge_id: string | null;
  readonly stripe_customer_id: string | null;
  readonly checkout_status: string;
  readonly payment_status: string;
  readonly amount_refunded: string;
  readonly refunded_credits: string;
}

interface FundingLot extends DynamicRow {
  readonly id: string;
  readonly order_id: string;
  readonly account_id: string;
  readonly original_credits: string;
  readonly remaining_credits: string;
  readonly expired_credits: string;
  readonly cash_clawed_back_credits: string;
  readonly status: string;
}

function metadata(value: unknown): StripeObject {
  return isPlainRecord(value) ? value : {};
}

function stripeId(value: unknown, prefix: string): string | undefined {
  const candidate = asStripeId(value);
  return candidate?.startsWith(prefix) === true ? candidate : undefined;
}

function canonicalUuid(value: unknown): string | undefined {
  if (typeof value !== "string" || !UUID.test(value)) {
    return undefined;
  }
  return value.toLowerCase();
}

function eventObject(event: StripeObject): StripeObject | undefined {
  const data = event["data"];
  return isPlainRecord(data) && isPlainRecord(data["object"])
    ? data["object"]
    : undefined;
}

function nullableMatches(observed: unknown, expected: string): boolean {
  return observed === null || observed === undefined || observed === expected;
}

function requiredBigInt(row: DynamicRow, field: string): bigint {
  return pgBigInt(row[field], field);
}

export class CreditPackEventProcessor {
  readonly #productLine: string;

  public constructor(_catalog: PlanCatalog, productLine: string) {
    this.#productLine = productLine;
  }

  async #incident(
    transaction: TransactionClient,
    input: {
      readonly kind: string;
      readonly event: StripeObject;
      readonly dedupeKey: string;
      readonly accountId?: string;
      readonly detail?: StripeObject;
    },
  ): Promise<void> {
    await transaction.query(
      `insert into billing_incidents(
         kind,dedupe_key,stripe_event_id,account_id,detail)
       values($1,$2,$3,$4::uuid,$5::jsonb)
       on conflict(kind,dedupe_key) where resolved_at is null do update set
         stripe_event_id=excluded.stripe_event_id,
         account_id=coalesce(excluded.account_id,billing_incidents.account_id),
         detail=excluded.detail,
         seen_count=billing_incidents.seen_count+1,
         last_seen_at=clock_timestamp()`,
      [
        input.kind,
        input.dedupeKey,
        typeof input.event["id"] === "string" ? input.event["id"] : null,
        input.accountId ?? null,
        JSON.stringify(input.detail ?? {}),
      ],
    );
  }

  #orderMetadata(
    object: StripeObject,
  ): readonly [string, string, string] | undefined {
    const values = metadata(object["metadata"]);
    if (
      values["billing_kind"] !== "credit_pack" ||
      values["pack_schema_version"] !== PACK_SCHEMA_VERSION ||
      values["product_line"] !== this.#productLine
    ) {
      return undefined;
    }
    const orderId = canonicalUuid(values["credit_pack_order_id"]);
    const accountId = canonicalUuid(values["account_id"]);
    const packKey = values["pack_key"];
    return orderId === undefined ||
      accountId === undefined ||
      typeof packKey !== "string"
      ? undefined
      : [orderId, accountId, packKey];
  }

  #metadataMatchesOrder(object: StripeObject, order: LockedOrder): boolean {
    const values = metadata(object["metadata"]);
    const expected: Readonly<Record<string, string>> = {
      billing_kind: "credit_pack",
      pack_schema_version: PACK_SCHEMA_VERSION,
      product_line: this.#productLine,
      credit_pack_order_id: order.id,
      account_id: order.account_id,
      pack_key: order.pack_key,
      pack_credits: creditDecimal(
        pgBigInt(order.pack_credits, "order pack_credits"),
      ),
      price_amount: order.price_amount,
      currency: order.currency,
      expires_days: String(order.expires_days),
      lookup_key: order.price_lookup_key,
    };
    return Object.entries(expected).every(
      ([key, value]) => values[key] === value,
    );
  }

  async #lockedOrder(
    transaction: TransactionClient,
    orderId: string,
    accountId: string,
  ): Promise<readonly [LockedAccount, LockedOrder] | undefined> {
    const snapshot = await transaction.query<
      { readonly account_id: string } & QueryResultRow
    >("select account_id::text from credit_pack_orders where id=$1::uuid", [
      orderId,
    ]);
    if (snapshot.rows[0]?.account_id !== accountId) {
      return undefined;
    }
    const accounts = await transaction.query<LockedAccount>(
      "select * from billing_accounts where id=$1::uuid for update",
      [accountId],
    );
    const account = accounts.rows[0];
    if (account === undefined) {
      return undefined;
    }
    const orders = await transaction.query<LockedOrder>(
      "select * from credit_pack_orders where id=$1::uuid for update",
      [orderId],
    );
    const order = orders.rows[0];
    return order === undefined || order.account_id !== account.id
      ? undefined
      : [account, order];
  }

  public async paymentSucceeded(
    transaction: TransactionClient,
    event: StripeObject,
  ): Promise<ProcessResult> {
    const object = eventObject(event);
    if (object === undefined) {
      return {
        outcome: "ignored",
        reason: "PaymentIntent is not an authorized credit-pack payment",
      };
    }
    const identity = this.#orderMetadata(object);
    const paymentIntentId = stripeId(object["id"], "pi_");
    if (identity === undefined) {
      const values = metadata(object["metadata"]);
      if (
        values["billing_kind"] === "credit_pack" &&
        paymentIntentId !== undefined
      ) {
        await this.#incident(transaction, {
          kind: "credit_pack_payment_metadata_invalid",
          event,
          dedupeKey: paymentIntentId,
        });
      }
      return {
        outcome: "ignored",
        reason: "PaymentIntent is not an authorized credit-pack payment",
      };
    }
    if (paymentIntentId === undefined) {
      return {
        outcome: "ignored",
        reason: "PaymentIntent is not an authorized credit-pack payment",
      };
    }
    const [orderId, accountId, packKey] = identity;
    const locked = await this.#lockedOrder(transaction, orderId, accountId);
    if (locked === undefined) {
      await this.#incident(transaction, {
        kind: "credit_pack_payment_identity_conflict",
        event,
        dedupeKey: paymentIntentId,
        detail: { order_id: orderId },
      });
      return {
        outcome: "ignored",
        reason: "credit-pack order identity is missing or conflicting",
      };
    }
    const [account, order] = locked;
    const customerId = stripeId(object["customer"], "cus_");
    const chargeId = stripeId(object["latest_charge"], "ch_");
    const authorizedAmount = stripeNonnegativeInteger(object["amount"]);
    const amount = stripeNonnegativeInteger(object["amount_received"]);
    const priceAmount = pgBigInt(order.price_amount, "order price_amount");
    const shapeMatches =
      object["object"] === "payment_intent" &&
      object["status"] === "succeeded" &&
      customerId !== undefined &&
      chargeId !== undefined &&
      authorizedAmount === priceAmount &&
      amount === priceAmount &&
      object["currency"] === order.currency &&
      packKey === order.pack_key &&
      this.#metadataMatchesOrder(object, order) &&
      nullableMatches(order.stripe_payment_intent_id, paymentIntentId) &&
      nullableMatches(order.stripe_charge_id, chargeId) &&
      nullableMatches(order.request_customer_id, customerId) &&
      nullableMatches(order.stripe_customer_id, customerId) &&
      nullableMatches(account.stripe_customer_id, customerId);
    if (
      !shapeMatches ||
      customerId === undefined ||
      chargeId === undefined ||
      amount === undefined
    ) {
      await this.#incident(transaction, {
        kind: "credit_pack_payment_contract_mismatch",
        event,
        dedupeKey: paymentIntentId,
        accountId: account.id,
        detail: { order_id: orderId },
      });
      return {
        outcome: "ignored",
        reason: "credit-pack PaymentIntent does not match its order",
      };
    }
    const existingLot = await transaction.query<FundingLot>(
      "select * from credit_funding_lots where order_id=$1::uuid for update",
      [orderId],
    );
    const eventCreated = stripeNonnegativeInteger(event["created"]);
    if (eventCreated === undefined) {
      return {
        outcome: "ignored",
        reason: "credit-pack payment has no valid creation time",
      };
    }
    const paymentStatus =
      order.payment_status === "pending" ? "paid" : order.payment_status;
    await transaction.query(
      `update credit_pack_orders set
         stripe_payment_intent_id=$2,
         stripe_charge_id=coalesce(stripe_charge_id,$3),
         stripe_customer_id=$4,amount_paid=$5::bigint,payment_status=$6,
         paid_at=coalesce(paid_at,to_timestamp($7::bigint)),
         checkout_status=case
           when stripe_checkout_session_id is null then checkout_status
           when checkout_status='expired' then checkout_status
           else 'completed' end,
         updated_at=now()
       where id=$1::uuid`,
      [
        order.id,
        paymentIntentId,
        chargeId,
        customerId,
        amount.toString(),
        paymentStatus,
        eventCreated.toString(),
      ],
    );
    if (account.stripe_customer_id === null) {
      await transaction.query(
        "update billing_accounts set stripe_customer_id=$2,updated_at=now() where id=$1::uuid",
        [account.id, customerId],
      );
    }
    if (existingLot.rows[0] !== undefined) {
      return {
        outcome: "replayed",
        reason: "credit-pack funding lot already exists",
        accountId,
      };
    }
    const packAtoms = pgBigInt(order.pack_credits, "order pack_credits");
    const refundedAtoms = pgBigInt(
      order.refunded_credits,
      "order refunded_credits",
    );
    const remaining = packAtoms - refundedAtoms;
    const fundingTerminal =
      refundedAtoms === packAtoms || paymentStatus === "disputed";
    const fundingStatus =
      paymentStatus === "disputed" ? "disputed" : "refunded";
    const timing = await transaction.query<
      { readonly financially_expired: boolean } & QueryResultRow
    >(
      `select not $1::boolean and
              to_timestamp($2::bigint)+make_interval(days=>$3::integer)
                <= clock_timestamp() as financially_expired`,
      [fundingTerminal, eventCreated.toString(), order.expires_days],
    );
    const financiallyExpired = timing.rows[0]?.financially_expired === true;
    const lotId = randomUUID();
    const insertedLot = await transaction.query<FundingLot>(
      `insert into credit_funding_lots(
         id,order_id,account_id,original_credits,remaining_credits,
         expired_credits,cash_clawed_back_credits,expires_at,status,closed_at)
       values($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::bigint,$6::bigint,$7::bigint,
              to_timestamp($8::bigint)+make_interval(days=>$9::integer),$10,
              case when $11::boolean then to_timestamp($8::bigint)
                   when $12::boolean then clock_timestamp() else null end)
       returning *`,
      [
        lotId,
        order.id,
        account.id,
        packAtoms.toString(),
        fundingTerminal || financiallyExpired ? "0" : remaining.toString(),
        financiallyExpired ? remaining.toString() : "0",
        refundedAtoms.toString(),
        eventCreated.toString(),
        order.expires_days,
        fundingTerminal
          ? fundingStatus
          : financiallyExpired
            ? "expired"
            : "active",
        fundingTerminal,
        financiallyExpired,
      ],
    );
    const lot = insertedLot.rows[0];
    if (lot === undefined) {
      throw new Error("credit-pack funding insert returned no row");
    }
    if (!fundingTerminal && !financiallyExpired && remaining > 0n) {
      await collectPackDebtsFromLot(transaction, {
        accountId: account.id,
        lotId: lot.id,
        availableAtoms: remaining,
      });
    }
    return {
      outcome: "handled",
      reason: "credit-pack funding granted",
      accountId,
    };
  }

  public async checkoutEvent(
    transaction: TransactionClient,
    event: StripeObject,
  ): Promise<ProcessResult | undefined> {
    const object = eventObject(event);
    if (object === undefined) {
      return undefined;
    }
    const sessionId = stripeId(object["id"], "cs_");
    if (sessionId === undefined) {
      return undefined;
    }
    let snapshot = await transaction.query<IdentityRow>(
      "select id::text,account_id::text from credit_pack_orders where stripe_checkout_session_id=$1",
      [sessionId],
    );
    const metadataIdentity = this.#orderMetadata(object);
    if (snapshot.rows[0] === undefined) {
      if (metadataIdentity === undefined) {
        return undefined;
      }
      const [metadataOrderId, metadataAccountId] = metadataIdentity;
      snapshot = await transaction.query<IdentityRow>(
        `select id::text,account_id::text from credit_pack_orders
          where id=$1::uuid and account_id=$2::uuid`,
        [metadataOrderId, metadataAccountId],
      );
      if (snapshot.rows[0] === undefined) {
        return {
          outcome: "ignored",
          reason: "credit-pack Checkout order is missing",
        };
      }
    }
    const identity = snapshot.rows[0];
    if (identity === undefined) {
      return {
        outcome: "ignored",
        reason: "credit-pack Checkout order is missing",
      };
    }
    const accounts = await transaction.query<LockedAccount>(
      "select * from billing_accounts where id=$1::uuid for update",
      [identity.account_id],
    );
    const orders = await transaction.query<LockedOrder>(
      "select * from credit_pack_orders where id=$1::uuid for update",
      [identity.id],
    );
    const account = accounts.rows[0];
    const order = orders.rows[0];
    if (account === undefined || order === undefined) {
      return {
        outcome: "ignored",
        reason: "credit-pack Checkout order is missing",
      };
    }
    if (!nullableMatches(order.stripe_checkout_session_id, sessionId)) {
      return {
        outcome: "ignored",
        reason: "credit-pack Checkout Session identity is conflicting",
      };
    }
    const expectedStatus =
      event["type"] === "checkout.session.expired" ? "expired" : "complete";
    const paymentStatus = object["payment_status"];
    const customerId = stripeId(object["customer"], "cus_");
    const amountTotal = stripeNonnegativeInteger(object["amount_total"]);
    const sessionContractMatches =
      object["object"] === "checkout.session" &&
      object["mode"] === "payment" &&
      object["status"] === expectedStatus &&
      (expectedStatus === "expired"
        ? paymentStatus === "unpaid"
        : paymentStatus === "paid" || paymentStatus === "unpaid") &&
      object["client_reference_id"] === account.id &&
      amountTotal === pgBigInt(order.price_amount, "order price_amount") &&
      object["currency"] === order.currency &&
      metadataIdentity !== undefined &&
      metadataIdentity[0] === order.id &&
      metadataIdentity[1] === account.id &&
      metadataIdentity[2] === order.pack_key &&
      this.#metadataMatchesOrder(object, order) &&
      customerId !== undefined &&
      nullableMatches(order.request_customer_id, customerId);
    if (!sessionContractMatches || customerId === undefined) {
      await this.#incident(transaction, {
        kind: "credit_pack_checkout_contract_mismatch",
        event,
        dedupeKey: sessionId,
        accountId: account.id,
      });
      return {
        outcome: "ignored",
        reason: "credit-pack Checkout contract is conflicting",
      };
    }
    if (order.stripe_checkout_session_id === null) {
      await transaction.query(
        `update credit_pack_orders set stripe_checkout_session_id=$2,
           checkout_status='session_created',updated_at=now() where id=$1::uuid`,
        [order.id, sessionId],
      );
    }
    if (event["type"] === "checkout.session.expired") {
      if (order.payment_status === "pending") {
        await transaction.query(
          `update credit_pack_orders set checkout_status='expired',session_url=null,
             updated_at=now() where id=$1::uuid`,
          [order.id],
        );
      }
      return {
        outcome: "handled",
        reason: "credit-pack Checkout expired",
        accountId: account.id,
      };
    }
    const paymentIntentId = stripeId(object["payment_intent"], "pi_");
    if (
      paymentIntentId === undefined ||
      !nullableMatches(order.stripe_payment_intent_id, paymentIntentId) ||
      !nullableMatches(order.stripe_customer_id, customerId) ||
      !nullableMatches(account.stripe_customer_id, customerId)
    ) {
      await this.#incident(transaction, {
        kind: "credit_pack_checkout_contract_mismatch",
        event,
        dedupeKey: sessionId,
        accountId: account.id,
      });
      return {
        outcome: "ignored",
        reason: "credit-pack Checkout identity is conflicting",
      };
    }
    await transaction.query(
      `update credit_pack_orders set checkout_status='completed',
         stripe_payment_intent_id=coalesce(stripe_payment_intent_id,$2),
         stripe_customer_id=coalesce(stripe_customer_id,$3),updated_at=now()
       where id=$1::uuid and
             (stripe_payment_intent_id is null or stripe_payment_intent_id=$2)`,
      [order.id, paymentIntentId, customerId],
    );
    if (account.stripe_customer_id === null) {
      await transaction.query(
        "update billing_accounts set stripe_customer_id=$2,updated_at=now() where id=$1::uuid",
        [account.id, customerId],
      );
    }
    return {
      outcome: "handled",
      reason:
        "credit-pack Checkout recorded; payment webhook remains authoritative",
      accountId: account.id,
    };
  }

  public async clawback(
    transaction: TransactionClient,
    event: StripeObject,
  ): Promise<ProcessResult | undefined> {
    const raw = eventObject(event);
    if (raw === undefined) {
      return undefined;
    }
    const dispute = event["type"] === "charge.dispute.created";
    const chargeValue = dispute ? raw["_resolved_charge"] : raw;
    const paymentIntentValue = raw["_resolved_payment_intent"];
    if (!isPlainRecord(chargeValue) || !isPlainRecord(paymentIntentValue)) {
      return undefined;
    }
    const charge = chargeValue;
    const paymentIntent = paymentIntentValue;
    const identity = this.#orderMetadata(paymentIntent);
    const paymentIntentId = stripeId(charge["payment_intent"], "pi_");
    if (
      identity === undefined ||
      paymentIntentId === undefined ||
      paymentIntentId !== stripeId(paymentIntent["id"], "pi_")
    ) {
      return undefined;
    }
    const [orderId, accountId, packKey] = identity;
    const locked = await this.#lockedOrder(transaction, orderId, accountId);
    if (locked === undefined) {
      return {
        outcome: "ignored",
        reason: "credit-pack clawback order is missing",
      };
    }
    const [account, order] = locked;
    const chargeId = stripeId(charge["id"], "ch_");
    const customerId = stripeId(charge["customer"], "cus_");
    const amount = stripeNonnegativeInteger(charge["amount"]);
    const chargeAmountRefunded = stripeNonnegativeInteger(
      charge["amount_refunded"],
    );
    const amountRefunded = dispute ? amount : chargeAmountRefunded;
    const paymentCustomerId = stripeId(paymentIntent["customer"], "cus_");
    const paymentChargeId = stripeId(paymentIntent["latest_charge"], "ch_");
    const paymentAmount = stripeNonnegativeInteger(paymentIntent["amount"]);
    const paymentAmountReceived = stripeNonnegativeInteger(
      paymentIntent["amount_received"],
    );
    let disputeContractMatches = true;
    if (dispute) {
      const disputeAmount = stripeNonnegativeInteger(raw["amount"]);
      disputeContractMatches =
        stripeId(raw["id"], "dp_") !== undefined &&
        raw["object"] === "dispute" &&
        stripeId(raw["charge"], "ch_") === chargeId &&
        disputeAmount !== undefined &&
        disputeAmount > 0n &&
        amount !== undefined &&
        disputeAmount <= amount &&
        raw["currency"] === order.currency &&
        charge["disputed"] === true;
    }
    const priceAmount = pgBigInt(order.price_amount, "order price_amount");
    const contractMatches =
      chargeId !== undefined &&
      customerId !== undefined &&
      amount !== undefined &&
      amountRefunded !== undefined &&
      chargeAmountRefunded !== undefined &&
      charge["object"] === "charge" &&
      charge["paid"] === true &&
      amount === priceAmount &&
      amountRefunded <= amount &&
      chargeAmountRefunded <= amount &&
      (dispute || amountRefunded > 0n) &&
      typeof charge["refunded"] === "boolean" &&
      charge["refunded"] === (chargeAmountRefunded === amount) &&
      typeof charge["disputed"] === "boolean" &&
      charge["currency"] === order.currency &&
      paymentIntent["object"] === "payment_intent" &&
      paymentIntent["status"] === "succeeded" &&
      paymentCustomerId === customerId &&
      paymentChargeId === chargeId &&
      paymentAmount === amount &&
      paymentAmountReceived === amount &&
      paymentIntent["currency"] === order.currency &&
      this.#metadataMatchesOrder(paymentIntent, order) &&
      disputeContractMatches &&
      packKey === order.pack_key &&
      nullableMatches(order.stripe_payment_intent_id, paymentIntentId) &&
      nullableMatches(order.stripe_charge_id, chargeId) &&
      nullableMatches(order.request_customer_id, customerId) &&
      nullableMatches(order.stripe_customer_id, customerId) &&
      nullableMatches(account.stripe_customer_id, customerId);
    if (
      !contractMatches ||
      chargeId === undefined ||
      customerId === undefined ||
      amount === undefined ||
      amountRefunded === undefined
    ) {
      await this.#incident(transaction, {
        kind: "credit_pack_clawback_contract_mismatch",
        event,
        dedupeKey: chargeId ?? String(event["id"]),
        accountId: account.id,
      });
      return {
        outcome: "ignored",
        reason: "credit-pack clawback does not match its order",
      };
    }
    if (account.stripe_customer_id === null) {
      await transaction.query(
        "update billing_accounts set stripe_customer_id=$2,updated_at=now() where id=$1::uuid",
        [account.id, customerId],
      );
    }
    const previousCash = pgBigInt(
      order.amount_refunded,
      "order amount_refunded",
    );
    const targetCash = dispute
      ? amount
      : previousCash > amountRefunded
        ? previousCash
        : amountRefunded;
    const packAtoms = pgBigInt(order.pack_credits, "order pack_credits");
    const targetAtoms =
      dispute || targetCash >= amount
        ? packAtoms
        : (packAtoms * targetCash + amount - 1n) / amount;
    const previousAtoms = pgBigInt(
      order.refunded_credits,
      "order refunded_credits",
    );
    const cashStatus = dispute
      ? "disputed"
      : targetCash >= amount
        ? "refunded"
        : "partially_refunded";
    if (targetAtoms <= previousAtoms) {
      if (targetCash > previousCash || cashStatus !== order.payment_status) {
        await transaction.query(
          `update credit_pack_orders set
             stripe_payment_intent_id=coalesce(stripe_payment_intent_id,$2),
             stripe_charge_id=coalesce(stripe_charge_id,$3),
             stripe_customer_id=coalesce(stripe_customer_id,$4),amount_paid=$5::bigint,
             amount_refunded=$6::bigint,payment_status=$7,updated_at=now()
           where id=$1::uuid`,
          [
            order.id,
            paymentIntentId,
            chargeId,
            customerId,
            amount.toString(),
            targetCash.toString(),
            cashStatus,
          ],
        );
        if (dispute) {
          await transaction.query(
            `update credit_funding_lots set status='disputed',
               closed_at=coalesce(closed_at,now()),updated_at=now()
             where order_id=$1::uuid and remaining_credits=0`,
            [order.id],
          );
        }
        return {
          outcome: "handled",
          reason: "credit-pack clawback cash facts advanced",
          accountId,
        };
      }
      return {
        outcome: "replayed",
        reason: "credit-pack clawback facts did not advance",
        accountId,
      };
    }
    const delta = targetAtoms - previousAtoms;
    const lots = await transaction.query<FundingLot>(
      "select * from credit_funding_lots where order_id=$1::uuid for update",
      [order.id],
    );
    let lot = lots.rows[0];
    let removed = 0n;
    if (lot !== undefined) {
      if (lot.status === "active") {
        const active = await transaction.query<
          { readonly active: boolean } & QueryResultRow
        >(
          "select $1::uuid in (select id from credit_funding_lots where expires_at>clock_timestamp()) as active",
          [lot.id],
        );
        if (active.rows[0]?.active !== true) {
          await transaction.query(
            `update credit_funding_lots
                set expired_credits=expired_credits+remaining_credits,
                    status='expired',remaining_credits=0,
                    closed_at=now(),updated_at=now()
              where id=$1::uuid`,
            [lot.id],
          );
          const refreshed = await transaction.query<FundingLot>(
            "select * from credit_funding_lots where id=$1::uuid for update",
            [lot.id],
          );
          lot = refreshed.rows[0];
        }
      }
      if (lot === undefined) {
        throw new Error("credit-pack funding lot disappeared while locked");
      }
      const remainingCredits = requiredBigInt(lot, "remaining_credits");
      const remainingRemoved =
        lot.status === "active"
          ? delta < remainingCredits
            ? delta
            : remainingCredits
          : 0n;
      const expiredCredits = requiredBigInt(lot, "expired_credits");
      const wantedExpired = delta - remainingRemoved;
      const expiredRemoved =
        wantedExpired < expiredCredits ? wantedExpired : expiredCredits;
      removed = remainingRemoved + expiredRemoved;
      const cashClawedBack = checkedAddAtoms(
        requiredBigInt(lot, "cash_clawed_back_credits"),
        removed,
        "cash-clawed-back pack credits",
      );
      const terminal = dispute || targetAtoms === packAtoms;
      await transaction.query(
        `update credit_funding_lots set
           remaining_credits=remaining_credits-$2::bigint,
           expired_credits=expired_credits-$3::bigint,
           cash_clawed_back_credits=$4::bigint,
           status=case when $5::boolean then $6 else status end,
           closed_at=case when $5::boolean then now() else closed_at end,
           updated_at=now()
         where id=$1::uuid`,
        [
          lot.id,
          remainingRemoved.toString(),
          expiredRemoved.toString(),
          cashClawedBack.toString(),
          terminal,
          dispute ? "disputed" : "refunded",
        ],
      );
    }
    const missing = lot === undefined ? 0n : delta - removed;
    if (missing > 0n) {
      const debt = await transaction.query<
        { readonly target_credits: string } & QueryResultRow
      >(
        "select target_credits from credit_pack_clawback_debts where order_id=$1::uuid for update",
        [order.id],
      );
      const existingDebt = debt.rows[0];
      if (existingDebt === undefined) {
        await transaction.query(
          `insert into credit_pack_clawback_debts(
             order_id,account_id,target_credits,collected_credits)
           values($1::uuid,$2::uuid,$3::bigint,0)`,
          [order.id, account.id, missing.toString()],
        );
      } else {
        const target = checkedAddAtoms(
          pgBigInt(existingDebt.target_credits, "pack clawback debt target"),
          missing,
          "credit-pack clawback debt target",
        );
        await transaction.query(
          `update credit_pack_clawback_debts set target_credits=$2::bigint,
             updated_at=now() where order_id=$1::uuid`,
          [order.id, target.toString()],
        );
      }
    }
    await transaction.query(
      `update credit_pack_orders set
         stripe_payment_intent_id=coalesce(stripe_payment_intent_id,$2),
         stripe_charge_id=coalesce(stripe_charge_id,$3),
         stripe_customer_id=coalesce(stripe_customer_id,$4),amount_paid=$5::bigint,
         amount_refunded=$6::bigint,refunded_credits=$7::bigint,
         payment_status=$8,updated_at=now()
       where id=$1::uuid`,
      [
        order.id,
        paymentIntentId,
        chargeId,
        customerId,
        amount.toString(),
        targetCash.toString(),
        targetAtoms.toString(),
        cashStatus,
      ],
    );
    return {
      outcome: "handled",
      reason: `credit-pack clawback removed ${creditDecimal(removed)} credits`,
      accountId,
    };
  }
}
