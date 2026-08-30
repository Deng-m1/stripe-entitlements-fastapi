import type { QueryResultRow } from "pg";

import type { Plan } from "./catalog.js";
import { collectClawbackDebts } from "./clawbacks.js";
import { checkedAddAtoms, creditDecimal } from "./credit-amount.js";
import { collectPackDebtsFromSubscription } from "./credit-pack-funding.js";
import { pgBigInt, type TransactionClient } from "./db-types.js";
import type {
  BillingEventProjector,
  ProcessorAccountRow,
  ProcessorRuntime,
} from "./event-processor.js";
import {
  hasUnsupportedInvoiceAdjustments,
  hasUnsupportedInvoicePaymentShape,
} from "./invoice-policy.js";
import { rankFor } from "./ordering.js";
import {
  annualSlotsAllowed,
  asStripeId,
  ceilRatio,
  lineIsProration,
  lineLookup,
  projectionOrder,
  projectSubscriptionStatus,
  stripeInteger,
  stripeNonnegativeInteger,
  subscriptionId,
  subscriptionMetadata,
  type StripeObject,
} from "./processor-primitives.js";
import type { BillingInterval, ProcessResult } from "./types.js";
import { isPlainRecord } from "./validation.js";

const PAID_REASONS = new Set([
  "subscription_create",
  "subscription_cycle",
  "subscription_update",
]);
const CLAWBACK_REASONS = [
  "refund_clawback",
  "dispute_clawback",
  "clawback_debt_collection",
] as const;
const SUBSCRIPTION_STATUSES = new Set([
  "active",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "past_due",
  "paused",
  "trialing",
  "unpaid",
]);

type DynamicRow = QueryResultRow & Readonly<Record<string, unknown>>;

interface LockedAccount extends ProcessorAccountRow {
  readonly plan_key: string;
  readonly plan_interval: BillingInterval | null;
  readonly subscription_status: string;
  readonly credits_balance: string;
  readonly grant_epoch: string;
  readonly current_period_end: string | null;
  readonly entitlement_period_end: string | null;
  readonly credit_expires_at: string | null;
  readonly entitlement_revoked: boolean;
  readonly annual_anchor: string | null;
  readonly annual_grants_issued: number;
  readonly annual_grants_allowed: number;
  readonly funding_invoice_id: string | null;
  readonly cancel_at_period_end: boolean;
}

interface ProratedDeltaShape {
  readonly sourcePlan: Plan;
  readonly targetPlan: Plan;
  readonly sourceLineId: string;
  readonly targetLineId: string;
  readonly sourceCreditAmount: bigint;
  readonly targetChargeAmount: bigint;
  readonly amountPaid: bigint;
  readonly currency: string;
  readonly periodStart: bigint;
  readonly periodEnd: bigint;
}

function eventObject(event: StripeObject): StripeObject {
  const data = event["data"];
  if (!isPlainRecord(data) || !isPlainRecord(data["object"])) {
    throw new Error("validated Stripe Event has no data.object");
  }
  return data["object"];
}

function requiredEventId(event: StripeObject): string {
  const value = asStripeId(event["id"]);
  if (value === undefined) {
    throw new Error("validated Stripe Event has no identity");
  }
  return value;
}

function requiredObjectId(object: StripeObject): string {
  const value = asStripeId(object["id"]);
  if (value === undefined) {
    throw new Error("validated Stripe object has no identity");
  }
  return value;
}

function accountRow(value: ProcessorAccountRow): LockedAccount {
  return value as LockedAccount;
}

function rowBigInt(
  row: Readonly<Record<string, unknown>>,
  field: string,
): bigint {
  return pgBigInt(row[field], field);
}

function eventCreated(event: StripeObject): bigint {
  return stripeNonnegativeInteger(event["created"]) ?? 0n;
}

function projectedCursor(
  account: LockedAccount,
  event: StripeObject,
): {
  readonly created: bigint;
  readonly rank: number;
} {
  return projectionOrder(
    {
      created: pgBigInt(account.event_created, "account event_created"),
      rank: account.event_rank,
    },
    { created: event["created"], type: event["type"] },
  );
}

function orderingTie(account: LockedAccount, event: StripeObject): boolean {
  return (
    event["_remote_verified"] !== true &&
    pgBigInt(account.event_created, "account event_created") ===
      eventCreated(event) &&
    account.event_rank === rankFor(String(event["type"]))
  );
}

function stripeLines(
  invoice: StripeObject,
): readonly StripeObject[] | undefined {
  const container = invoice["lines"];
  if (!isPlainRecord(container) || !Array.isArray(container["data"])) {
    return undefined;
  }
  const lines = container["data"];
  return lines.every((line) => isPlainRecord(line)) ? lines : undefined;
}

function sameTimestamp(left: unknown, right: unknown): boolean {
  return (
    typeof left === "string" && typeof right === "string" && left === right
  );
}

/** PostgreSQL-backed subscription funding projector. It performs no network calls. */
export class SubscriptionEventProjector implements BillingEventProjector {
  public async invoicePaid(
    transaction: TransactionClient,
    event: StripeObject,
    runtime: ProcessorRuntime,
  ): Promise<ProcessResult> {
    const invoice = eventObject(event);
    const invoiceId = requiredObjectId(invoice);
    const metadata = subscriptionMetadata(invoice);
    const rawAccount = await runtime.lockAccount(
      transaction,
      invoice,
      metadata,
    );
    if (rawAccount === undefined) {
      await runtime.recordIncident(transaction, {
        kind: "paid_unknown_account",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        detail: { customer: asStripeId(invoice["customer"]) ?? null },
      });
      return { outcome: "ignored", reason: "account not found" };
    }
    const account = accountRow(rawAccount);
    const accountId = account.id;
    const customerId = asStripeId(invoice["customer"]);
    if (
      customerId === undefined ||
      (account.stripe_customer_id !== null &&
        account.stripe_customer_id !== customerId)
    ) {
      await runtime.recordIncident(transaction, {
        kind: "paid_customer_identity_conflict",
        event,
        dedupeKey: `${accountId}:${invoiceId}`,
        invoiceId,
        accountId,
        detail: {
          bound: account.stripe_customer_id,
          incoming: customerId ?? null,
        },
      });
      return {
        outcome: "ignored",
        reason: "invoice customer identity is missing or conflicting",
        accountId,
      };
    }
    const billingReason = invoice["billing_reason"];
    if (typeof billingReason !== "string" || !PAID_REASONS.has(billingReason)) {
      await runtime.recordIncident(transaction, {
        kind: "unexpected_billing_reason",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
        detail: { billing_reason: billingReason ?? null },
      });
      return {
        outcome: "ignored",
        reason: "unexpected billing reason",
        accountId,
      };
    }
    if (
      invoice["_unsupported_invoice_payment_shape"] === true ||
      hasUnsupportedInvoicePaymentShape(invoice)
    ) {
      await runtime.recordIncident(transaction, {
        kind: "unsupported_invoice_payment_shape",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
      });
      return {
        outcome: "ignored",
        reason:
          "Invoice payment collection is outside the single-payment model",
        accountId,
      };
    }
    const preparationError = invoice["_preparation_error"];
    if (preparationError !== undefined && preparationError !== null) {
      const reason =
        typeof preparationError === "string"
          ? preparationError.slice(0, 500)
          : "invalid preparation error marker";
      await runtime.recordIncident(transaction, {
        kind: "invoice_preparation_failed",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
        detail: { reason },
      });
      return {
        outcome: "ignored",
        reason: "Invoice could not be materialized safely",
        accountId,
      };
    }
    const linesContainer = invoice["lines"];
    if (!isPlainRecord(linesContainer) || linesContainer["has_more"] === true) {
      await runtime.recordIncident(transaction, {
        kind: "incomplete_invoice_lines",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
      });
      return {
        outcome: "ignored",
        reason: "Invoice line pagination is incomplete",
        accountId,
      };
    }
    const lines = stripeLines(invoice);
    if (lines === undefined) {
      await runtime.recordIncident(transaction, {
        kind: "invalid_invoice_line_shape",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
      });
      return {
        outcome: "ignored",
        reason: "Invoice lines must be an array of objects",
        accountId,
      };
    }
    const lineIds = lines.map((line) => asStripeId(line["id"]));
    if (
      lineIds.some((lineId) => lineId === undefined) ||
      new Set(lineIds).size !== lineIds.length
    ) {
      await runtime.recordIncident(transaction, {
        kind: "invalid_invoice_line_shape",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
        detail: { reason: "line ids must be stable and unique" },
      });
      return {
        outcome: "ignored",
        reason: "Invoice lines require stable unique identities",
        accountId,
      };
    }
    const lineAmounts = lines.map((line) => stripeInteger(line["amount"]));
    if (lineAmounts.some((amount) => amount === undefined)) {
      await runtime.recordIncident(transaction, {
        kind: "invalid_invoice_line_shape",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
        detail: { reason: "line amount must be an integer" },
      });
      return {
        outcome: "ignored",
        reason: "Invoice line amounts must be integers",
        accountId,
      };
    }
    const nonzeroProrations = lines.filter(
      (line, index) => lineIsProration(line) && lineAmounts[index] !== 0n,
    );
    const subscription = subscriptionId(invoice);
    let proratedTransition: DynamicRow | undefined;
    if (billingReason === "subscription_update" && subscription !== undefined) {
      const result = await transaction.query<DynamicRow>(
        `select * from billing_plan_changes
           where account_id=$1::uuid and stripe_subscription_id=$2
             and transition_policy='prorated_delta'
             and (
               settlement_invoice_id=$3
               or (
                 settlement_invoice_id is null and effective_mode='immediate'
                 and status in ('applying','applied','requires_action')
               )
             )
           order by created_at desc limit 1 for update`,
        [accountId, subscription, invoiceId],
      );
      proratedTransition = result.rows[0];
    }
    if (proratedTransition !== undefined) {
      return this.#invoicePaidProratedDelta(
        transaction,
        event,
        invoice,
        account,
        proratedTransition,
        lines,
        runtime,
      );
    }
    return this.#invoicePaidFullPeriod(
      transaction,
      event,
      invoice,
      account,
      lines,
      {
        runtime,
        billingReason,
        subscription,
        customerId,
        nonzeroProrations,
      },
    );
  }

  async #invoicePaidFullPeriod(
    transaction: TransactionClient,
    event: StripeObject,
    invoice: StripeObject,
    account: LockedAccount,
    lines: readonly StripeObject[],
    context: {
      readonly runtime: ProcessorRuntime;
      readonly billingReason: string;
      readonly subscription: string | undefined;
      readonly customerId: string;
      readonly nonzeroProrations: readonly StripeObject[];
    },
  ): Promise<ProcessResult> {
    const {
      runtime,
      billingReason,
      subscription,
      customerId,
      nonzeroProrations,
    } = context;
    const invoiceId = requiredObjectId(invoice);
    const eventId = requiredEventId(event);
    const accountId = account.id;
    const grantLines = lines.filter((line) => !lineIsProration(line));
    if (grantLines.length !== 1) {
      await runtime.recordIncident(transaction, {
        kind: "ambiguous_invoice_lines",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
        detail: {
          grant_line_count: grantLines.length,
          line_count: lines.length,
        },
      });
      return {
        outcome: "ignored",
        reason: "invoice must have exactly one grant line",
        accountId,
      };
    }
    const line = grantLines[0];
    if (line === undefined) {
      throw new Error("single grant line disappeared");
    }
    const parsed = runtime.catalog.parseLookupKey(lineLookup(line));
    if (parsed === undefined) {
      await runtime.recordIncident(transaction, {
        kind: "unknown_price",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
        detail: { lookup_key: lineLookup(line) ?? null },
      });
      return {
        outcome: "ignored",
        reason: "price lookup key is not in the catalog",
        accountId,
      };
    }
    const [plan, interval] = parsed;
    if (!runtime.catalogLineMatches(line, plan, interval)) {
      await runtime.recordIncident(transaction, {
        kind: "invoice_price_identity_mismatch",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
        detail: {
          lookup_key: lineLookup(line) ?? null,
          price_id: asStripeId(line["price"]) ?? null,
          plan: plan.key,
          interval,
        },
      });
      return {
        outcome: "ignored",
        reason: "Invoice Price or Product identity does not match the catalog",
        accountId,
      };
    }
    const expectedAmount = BigInt(
      (interval === "month" ? plan.monthUsd : plan.yearUsd) * 100,
    );
    const invoiceCurrency =
      typeof invoice["currency"] === "string"
        ? invoice["currency"].toLowerCase()
        : "";
    const lineCurrency =
      typeof line["currency"] === "string"
        ? line["currency"].toLowerCase()
        : invoiceCurrency;
    const amountPaid = stripeInteger(invoice["amount_paid"]);
    const invoiceTotal = stripeInteger(invoice["total"]);
    const amountDue = Object.hasOwn(invoice, "amount_due")
      ? stripeInteger(invoice["amount_due"])
      : invoiceTotal;
    const subtotal = Object.hasOwn(invoice, "subtotal")
      ? stripeInteger(invoice["subtotal"])
      : invoiceTotal;
    const quantity = stripeInteger(line["quantity"]);
    const lineAmount = stripeInteger(line["amount"]);
    const unsupportedAdjustments = hasUnsupportedInvoiceAdjustments(
      invoice,
      lines,
    );
    if (
      quantity !== 1n ||
      lineAmount !== expectedAmount ||
      amountPaid !== expectedAmount ||
      invoiceTotal !== expectedAmount ||
      amountDue !== expectedAmount ||
      subtotal !== expectedAmount ||
      invoiceCurrency !== plan.currency ||
      lineCurrency !== plan.currency ||
      unsupportedAdjustments
    ) {
      await runtime.recordIncident(transaction, {
        kind: "invoice_catalog_amount_mismatch",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
        detail: {
          plan: plan.key,
          interval,
          expected_amount: expectedAmount.toString(),
          quantity: quantity?.toString() ?? null,
          unsupported_adjustments: unsupportedAdjustments,
        },
      });
      return {
        outcome: "ignored",
        reason: "invoice amount or currency does not match the catalog",
        accountId,
      };
    }
    const period = line["period"];
    const periodStart = isPlainRecord(period)
      ? stripeNonnegativeInteger(period["start"])
      : undefined;
    const periodEnd = isPlainRecord(period)
      ? stripeNonnegativeInteger(period["end"])
      : undefined;
    if (
      periodStart === undefined ||
      periodEnd === undefined ||
      periodEnd <= periodStart
    ) {
      await runtime.recordIncident(transaction, {
        kind: "invalid_entitlement_period",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
      });
      return {
        outcome: "ignored",
        reason: "invoice service period is invalid",
        accountId,
      };
    }

    const existing = await transaction.query<DynamicRow>(
      `select id,account_id::text from credit_ledger
         where stripe_invoice_id=$1 and grant_slot=1`,
      [invoiceId],
    );
    const existingGrant = existing.rows[0];
    if (existingGrant !== undefined) {
      if (existingGrant["account_id"] !== accountId) {
        await runtime.recordIncident(transaction, {
          kind: "invoice_grant_identity_conflict",
          event,
          dedupeKey: invoiceId,
          invoiceId,
          accountId,
        });
        return {
          outcome: "ignored",
          reason: "invoice grant belongs to another account",
        };
      }
      if (runtime.eventWinsAccount(account, event)) {
        const cursor = projectedCursor(account, event);
        await transaction.query(
          `update billing_accounts set event_created=$2::bigint,event_rank=$3,
             subscription_status='active',updated_at=now() where id=$1::uuid`,
          [accountId, cursor.created.toString(), cursor.rank],
        );
      }
      return {
        outcome: "replayed",
        reason: "invoice grant slot already exists",
        accountId,
      };
    }

    let transition: DynamicRow | undefined;
    const entitledSku = `${account.plan_key}:${account.plan_interval ?? ""}`;
    const incomingSku = `${plan.key}:${interval}`;
    const needsIntent =
      billingReason === "subscription_update" ||
      (billingReason === "subscription_cycle" && incomingSku !== entitledSku);
    if (billingReason === "subscription_create") {
      const claimResult = await transaction.query<DynamicRow>(
        "select * from checkout_claims where account_id=$1::uuid for update",
        [accountId],
      );
      const claim = claimResult.rows[0];
      const metadata = subscriptionMetadata(invoice);
      const checkoutAuthorized =
        (subscription !== undefined &&
          account.stripe_subscription_id === subscription) ||
        (claim !== undefined &&
          subscription !== undefined &&
          claim["plan_key"] === plan.key &&
          claim["plan_interval"] === interval &&
          typeof metadata["claim_token"] === "string" &&
          String(claim["claim_token"]) === metadata["claim_token"]);
      if (!checkoutAuthorized) {
        await runtime.recordIncident(transaction, {
          kind: "subscription_create_without_checkout",
          event,
          dedupeKey: invoiceId,
          invoiceId,
          accountId,
        });
        return {
          outcome: "ignored",
          reason: "subscription create lacks a live Checkout claim",
          accountId,
        };
      }
    }
    if (needsIntent) {
      const result = await transaction.query<DynamicRow>(
        `select * from billing_plan_changes
           where account_id=$1::uuid and stripe_subscription_id=$2
             and target_plan_key=$3 and target_interval=$4
             and (settlement_invoice_id is null or settlement_invoice_id=$5)
             and status in ('applying','scheduled','applied','requires_action')
           order by created_at desc limit 1 for update`,
        [accountId, subscription ?? null, plan.key, interval, invoiceId],
      );
      transition = result.rows[0];
      const wrongMode =
        transition !== undefined &&
        billingReason === "subscription_update" &&
        transition["effective_mode"] !== "immediate";
      if (transition === undefined || wrongMode) {
        await runtime.recordIncident(transaction, {
          kind: "paid_plan_change_without_intent",
          event,
          dedupeKey: invoiceId,
          invoiceId,
          accountId,
          detail: { plan: plan.key, interval },
        });
        return {
          outcome: "ignored",
          reason: "paid plan change lacks an authenticated intent",
          accountId,
        };
      }
    }
    if (nonzeroProrations.length > 0) {
      await runtime.recordIncident(transaction, {
        kind: "unsafe_cross_invoice_proration",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
        detail: { line_count: nonzeroProrations.length },
      });
      return {
        outcome: "ignored",
        reason: "cross-invoice proration is unsafe",
        accountId,
      };
    }
    if (lines.length !== 1) {
      await runtime.recordIncident(transaction, {
        kind: "ambiguous_invoice_lines",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
        detail: {
          grant_line_count: grantLines.length,
          line_count: lines.length,
        },
      });
      return {
        outcome: "ignored",
        reason: "invoice must have exactly one grant line",
        accountId,
      };
    }
    if (
      account.stripe_subscription_id !== null &&
      subscription !== account.stripe_subscription_id
    ) {
      await runtime.recordIncident(transaction, {
        kind: "paid_subscription_identity_conflict",
        event,
        dedupeKey: `${accountId}:${invoiceId}`,
        invoiceId,
        accountId,
        detail: {
          bound: account.stripe_subscription_id,
          incoming: subscription ?? null,
        },
      });
      return {
        outcome: "ignored",
        reason: "invoice belongs to a different subscription",
        accountId,
      };
    }
    const remoteCasFailed =
      event["_remote_verified"] === true &&
      !runtime.eventWinsAccount(account, event);
    const staleResult = await transaction.query<
      { readonly stale: boolean } & QueryResultRow
    >(
      `select $1::timestamptz is not null
              and to_timestamp($2::bigint) <= $1::timestamptz as stale`,
      [account.entitlement_period_end, periodEnd.toString()],
    );
    if (remoteCasFailed || staleResult.rows[0]?.stale === true) {
      await runtime.recordIncident(transaction, {
        kind: "stale_paid_event",
        event,
        dedupeKey: `${accountId}:${invoiceId}`,
        invoiceId,
        accountId,
        detail: { applied_created: account.event_created },
      });
      return {
        outcome: "ignored",
        reason: "older than the paid entitlement period",
        accountId,
      };
    }
    if (amountPaid <= 0n) {
      await runtime.recordIncident(transaction, {
        kind: "invoice_without_new_funding",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
        detail: { total: invoice["total"] ?? null },
      });
      return {
        outcome: "ignored",
        reason: "paid invoice has no new cash funding",
        accountId,
      };
    }
    const state = await this.#claimInvoiceState(
      transaction,
      event,
      runtime,
      accountId,
      invoiceId,
      amountPaid,
    );
    if (state === undefined) {
      return {
        outcome: "ignored",
        reason: "invoice is owned by another account",
        accountId,
      };
    }
    const closed =
      state["fully_refunded"] === true || state["disputed"] === true;
    const oldBalance = pgBigInt(
      account.credits_balance,
      "account credits_balance",
    );
    const credits = plan.monthlyCredits.atoms;
    let blocked: boolean;
    let allowed: number;
    if (interval === "year") {
      const fundedAllowed = closed
        ? 0
        : annualSlotsAllowed(
            rowBigInt(state, "amount_total"),
            rowBigInt(state, "amount_refunded"),
            0,
          );
      blocked = fundedAllowed < 1;
      allowed = Math.max(1, fundedAllowed);
    } else {
      blocked = closed;
      allowed = 12;
    }
    if (blocked) {
      await transaction.query(
        `insert into credit_ledger(
           account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
           stripe_event_id,stripe_invoice_id,grant_slot)
         values($1::uuid,0,$2::bigint,0,'subscription_grant_blocked',
                $3::bigint,$4,$5,1)`,
        [
          accountId,
          oldBalance.toString(),
          account.grant_epoch,
          eventId,
          invoiceId,
        ],
      );
      await transaction.query(
        `update stripe_invoice_state set grant_units_per_slot=$2::bigint,
           grants_issued=1,closure_applied=true,updated_at=now() where invoice_id=$1`,
        [invoiceId, credits.toString()],
      );
      if (transition !== undefined) {
        const bound = await transaction.query<DynamicRow>(
          `update billing_plan_changes set status='failed',
             settlement_invoice_id=coalesce(settlement_invoice_id,$2),
             last_error='invoice_funding_closed',completed_at=now(),
             lease_token=null,lease_expires_at=null,updated_at=now()
           where id=$1::uuid
             and (settlement_invoice_id is null or settlement_invoice_id=$2)
           returning id::text`,
          [transition["id"], invoiceId],
        );
        if (bound.rows[0] === undefined) {
          throw new Error("plan-change settlement Invoice binding changed");
        }
      }
      return {
        outcome: "ignored",
        reason: "invoice funding does not cover an entitlement slot",
        accountId,
      };
    }
    const newEpoch = pgBigInt(account.grant_epoch, "account grant_epoch") + 1n;
    const projectionWins = runtime.eventWinsAccount(account, event);
    const cursor = projectionWins
      ? projectedCursor(account, event)
      : {
          created: pgBigInt(account.event_created, "account event_created"),
          rank: account.event_rank,
        };
    await transaction.query(
      `update billing_accounts set
         stripe_customer_id=coalesce(stripe_customer_id,$2),
         stripe_subscription_id=coalesce($3,stripe_subscription_id),
         plan_key=$4,plan_interval=$5,subscription_status=$14,
         entitlement_revoked=false,
         credits_balance=$6::bigint,grant_epoch=$7::bigint,
         event_created=$8::bigint,event_rank=$9,
         current_period_end=to_timestamp($10::bigint),
         entitlement_period_end=to_timestamp($10::bigint),
         credit_expires_at=case when $5='year'
           then least(to_timestamp($10::bigint),to_timestamp($11::bigint)+interval '1 month')
           else to_timestamp($10::bigint) end,
         annual_anchor=case when $5='year' then to_timestamp($11::bigint) else null end,
         annual_grants_issued=case when $5='year' then 1 else 0 end,
         annual_grants_allowed=$12,
         funding_invoice_id=case when $5='year' then $13 else null end,
         updated_at=now()
       where id=$1::uuid`,
      [
        accountId,
        customerId,
        subscription ?? null,
        plan.key,
        interval,
        credits.toString(),
        newEpoch.toString(),
        cursor.created.toString(),
        cursor.rank,
        periodEnd.toString(),
        periodStart.toString(),
        allowed,
        invoiceId,
        projectionWins ? "active" : account.subscription_status,
      ],
    );
    const grant = await transaction.query<
      { readonly id: string } & QueryResultRow
    >(
      `insert into credit_ledger(
         account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
         stripe_event_id,stripe_invoice_id,grant_slot)
       values($1::uuid,$2::bigint,$3::bigint,$4::bigint,'subscription_grant',
              $5::bigint,$6,$7,1) returning id::text`,
      [
        accountId,
        (credits - oldBalance).toString(),
        credits.toString(),
        credits.toString(),
        newEpoch.toString(),
        eventId,
        invoiceId,
      ],
    );
    const grantId = grant.rows[0]?.id;
    if (grantId === undefined) {
      throw new Error("subscription grant insert returned no identity");
    }
    await transaction.query(
      `update stripe_invoice_state set grant_units_per_slot=$2::bigint,
         grants_issued=1,updated_at=now() where invoice_id=$1`,
      [invoiceId, credits.toString()],
    );
    if (interval === "month" && rowBigInt(state, "amount_refunded") > 0n) {
      await this.#applyClawbackToGrant(transaction, {
        accountId,
        invoiceId,
        grantId,
        entitlementUnits: credits,
        amount: rowBigInt(state, "amount_total"),
        amountRefunded: rowBigInt(state, "amount_refunded"),
        full: false,
        reason: "refund_clawback",
        eventId,
      });
    }
    await collectPackDebtsFromSubscription(transaction, {
      accountId,
      grantEpoch: newEpoch,
      eventId: `pack-debt:${eventId}`,
    });
    if (transition === undefined) {
      const result = await transaction.query<DynamicRow>(
        `select * from billing_plan_changes
           where account_id=$1::uuid and stripe_subscription_id=$2
             and target_plan_key=$3 and target_interval=$4
             and (settlement_invoice_id is null or settlement_invoice_id=$5)
             and status in ('scheduled','applied','requires_action')
           order by created_at desc limit 1 for update`,
        [accountId, subscription ?? null, plan.key, interval, invoiceId],
      );
      transition = result.rows[0];
    }
    if (transition !== undefined) {
      const bound = await transaction.query<DynamicRow>(
        `update billing_plan_changes set status='completed',completed_at=now(),
           settlement_invoice_id=coalesce(settlement_invoice_id,$2),
           lease_token=null,lease_expires_at=null,updated_at=now()
         where id=$1::uuid and (settlement_invoice_id is null or settlement_invoice_id=$2)
         returning id::text`,
        [transition["id"], invoiceId],
      );
      if (bound.rows[0] === undefined) {
        throw new Error("plan-change settlement Invoice binding changed");
      }
      await this.#resolvePlanChangeIncidents(
        transaction,
        accountId,
        invoiceId,
        String(transition["id"]),
      );
    }
    return { outcome: "handled", accountId };
  }

  async #claimInvoiceState(
    transaction: TransactionClient,
    event: StripeObject,
    runtime: ProcessorRuntime,
    accountId: string,
    invoiceId: string,
    amountTotal: bigint,
  ): Promise<DynamicRow | undefined> {
    const existing = await transaction.query<DynamicRow>(
      "select * from stripe_invoice_state where invoice_id=$1 for update",
      [invoiceId],
    );
    const prior = existing.rows[0];
    if (
      prior !== undefined &&
      prior["account_id"] !== null &&
      prior["account_id"] !== accountId
    ) {
      await runtime.recordIncident(transaction, {
        kind: "invoice_account_identity_conflict",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
      });
      return undefined;
    }
    const result = await transaction.query<DynamicRow>(
      `insert into stripe_invoice_state(invoice_id,account_id,amount_total)
       values($1,$2::uuid,$3::bigint)
       on conflict(invoice_id) do update set
         account_id=coalesce(stripe_invoice_state.account_id,excluded.account_id),
         amount_total=greatest(stripe_invoice_state.amount_total,excluded.amount_total),
         updated_at=now()
       where stripe_invoice_state.account_id is null
          or stripe_invoice_state.account_id=excluded.account_id
       returning stripe_invoice_state.*`,
      [invoiceId, accountId, amountTotal.toString()],
    );
    const state = result.rows[0];
    if (state === undefined) {
      await runtime.recordIncident(transaction, {
        kind: "invoice_account_identity_conflict",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
      });
    }
    return state;
  }

  async #resolvePlanChangeIncidents(
    transaction: TransactionClient,
    accountId: string,
    invoiceId: string,
    planChangeId: string,
  ): Promise<void> {
    await transaction.query(
      `update billing_incidents set resolved_at=clock_timestamp(),
         last_seen_at=clock_timestamp()
       where account_id=$1::uuid and resolved_at is null and (
         (invoice_id=$2 and kind in (
           'plan_change_payment_failed','unbound_plan_change_payment_failed'
         ))
         or (kind='plan_change_recovery_required' and detail->>'plan_change_id'=$3)
       )`,
      [accountId, invoiceId, planChangeId],
    );
  }

  async #invoicePaidProratedDelta(
    transaction: TransactionClient,
    event: StripeObject,
    invoice: StripeObject,
    account: LockedAccount,
    transition: DynamicRow,
    lines: readonly StripeObject[],
    runtime: ProcessorRuntime,
  ): Promise<ProcessResult> {
    const invoiceId = requiredObjectId(invoice);
    const eventId = requiredEventId(event);
    const accountId = account.id;
    const existing = await transaction.query<DynamicRow>(
      `select id,account_id::text from credit_ledger
         where stripe_invoice_id=$1 and grant_slot=1`,
      [invoiceId],
    );
    const existingGrant = existing.rows[0];
    if (existingGrant !== undefined) {
      if (existingGrant["account_id"] !== accountId) {
        await runtime.recordIncident(transaction, {
          kind: "invoice_grant_identity_conflict",
          event,
          dedupeKey: invoiceId,
          invoiceId,
          accountId,
        });
        return {
          outcome: "ignored",
          reason: "invoice grant belongs to another account",
        };
      }
      return {
        outcome: "replayed",
        reason: "invoice grant slot already exists",
        accountId,
      };
    }

    const snapshotMatches =
      account.stripe_subscription_id === transition["stripe_subscription_id"] &&
      account.plan_key === transition["from_plan_key"] &&
      account.plan_interval === transition["from_interval"] &&
      pgBigInt(account.grant_epoch, "account grant_epoch") ===
        rowBigInt(transition, "expected_grant_epoch") &&
      sameTimestamp(
        account.entitlement_period_end,
        transition["expected_entitlement_period_end"],
      ) &&
      !account.entitlement_revoked &&
      transition["expected_entitlement_revoked"] === false;
    const latestFunding = await this.#latestFundingInvoice(
      transaction,
      accountId,
      pgBigInt(account.grant_epoch, "account grant_epoch"),
    );
    if (
      !snapshotMatches ||
      latestFunding !== transition["expected_source_invoice_id"]
    ) {
      await runtime.recordIncident(transaction, {
        kind: "stale_prorated_delta_invoice",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
        detail: {
          expected_source_invoice:
            transition["expected_source_invoice_id"] ?? null,
          observed_source_invoice: latestFunding,
        },
      });
      return {
        outcome: "ignored",
        reason: "entitlement snapshot or funding lineage changed",
        accountId,
      };
    }

    let shape: ProratedDeltaShape;
    try {
      shape = await this.#parseProratedDeltaShape(
        transaction,
        invoice,
        transition,
        lines,
        runtime,
      );
    } catch (error: unknown) {
      const reason =
        error instanceof Error
          ? error.message
          : "invalid prorated delta Invoice";
      await runtime.recordIncident(transaction, {
        kind: "invalid_prorated_delta_invoice",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
        detail: { reason },
      });
      return { outcome: "ignored", reason, accountId };
    }
    const expectedDelta = rowBigInt(transition, "expected_credit_delta");
    const actualDelta =
      shape.targetPlan.monthlyCredits.atoms -
      shape.sourcePlan.monthlyCredits.atoms;
    if (expectedDelta <= 0n || actualDelta !== expectedDelta) {
      await runtime.recordIncident(transaction, {
        kind: "prorated_delta_entitlement_mismatch",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
        detail: {
          expected_delta_atoms: expectedDelta.toString(),
          actual_delta_atoms: actualDelta.toString(),
        },
      });
      return {
        outcome: "ignored",
        reason: "entitlement delta does not match intent",
        accountId,
      };
    }
    const state = await this.#claimInvoiceState(
      transaction,
      event,
      runtime,
      accountId,
      invoiceId,
      shape.amountPaid,
    );
    if (state === undefined) {
      return {
        outcome: "ignored",
        reason: "invoice is owned by another account",
        accountId,
      };
    }
    const closed =
      state["fully_refunded"] === true || state["disputed"] === true;
    const refundUnits = closed
      ? expectedDelta
      : ceilRatio(
          expectedDelta,
          rowBigInt(state, "amount_refunded"),
          rowBigInt(state, "amount_total"),
        );
    const allocationStatus =
      state["disputed"] === true
        ? "disputed"
        : state["fully_refunded"] === true
          ? "closed"
          : refundUnits > 0n
            ? "partially_refunded"
            : "active";
    const allocation = await transaction.query<DynamicRow>(
      `insert into billing_funding_allocations(
         account_id,plan_change_id,stripe_invoice_id,source_invoice_id,
         stripe_event_id,transition_policy,source_plan_key,source_interval,
         target_plan_key,target_interval,source_line_id,target_line_id,
         entitlement_delta,refunded_units,source_credit_amount,
         target_charge_amount,amount_paid,currency,period_start,period_end,
         grant_epoch,status)
       values($1::uuid,$2::uuid,$3,$4,$5,'prorated_delta',$6,'month',$7,'month',
              $8,$9,$10::bigint,$11::bigint,$12::bigint,$13::bigint,$14::bigint,
              $15,to_timestamp($16::bigint),to_timestamp($17::bigint),$18::bigint,$19)
       on conflict(stripe_invoice_id) do nothing returning id::text`,
      [
        accountId,
        transition["id"],
        invoiceId,
        transition["expected_source_invoice_id"],
        eventId,
        shape.sourcePlan.key,
        shape.targetPlan.key,
        shape.sourceLineId,
        shape.targetLineId,
        expectedDelta.toString(),
        refundUnits.toString(),
        shape.sourceCreditAmount.toString(),
        shape.targetChargeAmount.toString(),
        shape.amountPaid.toString(),
        shape.currency,
        shape.periodStart.toString(),
        shape.periodEnd.toString(),
        account.grant_epoch,
        allocationStatus,
      ],
    );
    if (allocation.rows[0] === undefined) {
      await runtime.recordIncident(transaction, {
        kind: "funding_allocation_conflict",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
      });
      return {
        outcome: "ignored",
        reason: "funding allocation already exists",
        accountId,
      };
    }
    const oldBalance = pgBigInt(
      account.credits_balance,
      "account credits_balance",
    );
    if (closed) {
      await transaction.query(
        `insert into credit_ledger(
           account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
           stripe_event_id,stripe_invoice_id,grant_slot)
         values($1::uuid,0,$2::bigint,0,'upgrade_delta_blocked',$3::bigint,$4,$5,1)`,
        [
          accountId,
          oldBalance.toString(),
          account.grant_epoch,
          eventId,
          invoiceId,
        ],
      );
      await transaction.query(
        `update stripe_invoice_state set grant_units_per_slot=$2::bigint,
           grants_issued=1,closure_applied=true,updated_at=now() where invoice_id=$1`,
        [invoiceId, expectedDelta.toString()],
      );
      await transaction.query(
        `update billing_plan_changes set status='failed',settlement_invoice_id=$2,
           last_error='invoice_funding_closed',completed_at=now(),lease_token=null,
           lease_expires_at=null,updated_at=now() where id=$1::uuid`,
        [transition["id"], invoiceId],
      );
      await runtime.recordIncident(transaction, {
        kind: "prorated_delta_funding_closed",
        event,
        dedupeKey: invoiceId,
        invoiceId,
        accountId,
      });
      return {
        outcome: "ignored",
        reason: "upgrade invoice funding was already closed",
        accountId,
      };
    }
    const projectionWins = runtime.eventWinsAccount(account, event);
    const cursor = projectionWins
      ? projectedCursor(account, event)
      : {
          created: pgBigInt(account.event_created, "account event_created"),
          rank: account.event_rank,
        };
    const newBalance = checkedAddAtoms(
      oldBalance,
      expectedDelta,
      "prorated upgrade credit balance",
    );
    await transaction.query(
      `update billing_accounts set
         stripe_customer_id=coalesce(stripe_customer_id,$2),
         plan_key=$3,plan_interval='month',subscription_status=$4,
         credits_balance=$5::bigint,entitlement_revoked=false,
         event_created=$6::bigint,event_rank=$7,updated_at=now()
       where id=$1::uuid`,
      [
        accountId,
        asStripeId(invoice["customer"]) ?? null,
        shape.targetPlan.key,
        projectionWins ? "active" : account.subscription_status,
        newBalance.toString(),
        cursor.created.toString(),
        cursor.rank,
      ],
    );
    const grant = await transaction.query<
      { readonly id: string } & QueryResultRow
    >(
      `insert into credit_ledger(
         account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
         stripe_event_id,stripe_invoice_id,grant_slot)
       values($1::uuid,$2::bigint,$3::bigint,$2::bigint,'upgrade_delta_grant',
              $4::bigint,$5,$6,1) returning id::text`,
      [
        accountId,
        expectedDelta.toString(),
        newBalance.toString(),
        account.grant_epoch,
        eventId,
        invoiceId,
      ],
    );
    const grantId = grant.rows[0]?.id;
    if (grantId === undefined) {
      throw new Error("upgrade delta grant insert returned no identity");
    }
    await transaction.query(
      `update stripe_invoice_state set grant_units_per_slot=$2::bigint,
         grants_issued=1,updated_at=now() where invoice_id=$1`,
      [invoiceId, expectedDelta.toString()],
    );
    const grantEpoch = pgBigInt(account.grant_epoch, "account grant_epoch");
    await collectClawbackDebts(transaction, { accountId, grantEpoch, eventId });
    await collectPackDebtsFromSubscription(transaction, {
      accountId,
      grantEpoch,
      eventId: `pack-debt:${eventId}`,
    });
    if (refundUnits > 0n) {
      await this.#applyClawbackToGrant(transaction, {
        accountId,
        invoiceId,
        grantId,
        entitlementUnits: expectedDelta,
        amount: rowBigInt(state, "amount_total"),
        amountRefunded: rowBigInt(state, "amount_refunded"),
        full: false,
        reason: "refund_clawback",
        eventId,
      });
    }
    await transaction.query(
      `update billing_plan_changes set status='completed',settlement_invoice_id=$2,
         completed_at=now(),lease_token=null,lease_expires_at=null,updated_at=now()
       where id=$1::uuid`,
      [transition["id"], invoiceId],
    );
    await this.#resolvePlanChangeIncidents(
      transaction,
      accountId,
      invoiceId,
      String(transition["id"]),
    );
    return { outcome: "handled", accountId };
  }

  async #parseProratedDeltaShape(
    transaction: TransactionClient,
    invoice: StripeObject,
    transition: DynamicRow,
    lines: readonly StripeObject[],
    runtime: ProcessorRuntime,
  ): Promise<ProratedDeltaShape> {
    const container = invoice["lines"];
    if (isPlainRecord(container) && container["has_more"] === true) {
      throw new Error("Invoice line pagination was not completed");
    }
    if (lines.length !== 2) {
      throw new Error("prorated delta requires exactly two Invoice lines");
    }
    let sourceLine: StripeObject | undefined;
    let targetLine: StripeObject | undefined;
    let sourcePlan: Plan | undefined;
    let targetPlan: Plan | undefined;
    for (const line of lines) {
      if (!lineIsProration(line)) {
        throw new Error("both prorated delta lines must be prorations");
      }
      if (
        stripeInteger(line["quantity"]) !== 1n ||
        asStripeId(line["id"]) === undefined
      ) {
        throw new Error(
          "prorated delta lines require identity and quantity one",
        );
      }
      const parsed = runtime.catalog.parseLookupKey(lineLookup(line));
      if (parsed === undefined) {
        throw new Error("every prorated delta line must use a catalog Price");
      }
      const [plan, interval] = parsed;
      if (interval !== "month") {
        throw new Error("prorated delta is supported only for monthly Prices");
      }
      if (!runtime.catalogLineMatches(line, plan, interval)) {
        throw new Error(
          "Invoice Price or Product identity differs from the catalog",
        );
      }
      if (plan.key === transition["from_plan_key"]) {
        if (sourceLine !== undefined) {
          throw new Error("multiple source Price lines are ambiguous");
        }
        sourceLine = line;
        sourcePlan = plan;
      } else if (plan.key === transition["target_plan_key"]) {
        if (targetLine !== undefined) {
          throw new Error("multiple target Price lines are ambiguous");
        }
        targetLine = line;
        targetPlan = plan;
      } else {
        throw new Error(
          "Invoice contains a Price outside the authorized transition",
        );
      }
    }
    if (
      sourceLine === undefined ||
      targetLine === undefined ||
      sourcePlan === undefined ||
      targetPlan === undefined
    ) {
      throw new Error(
        "Invoice is missing the authorized source or target Price line",
      );
    }
    if (
      transition["from_interval"] !== "month" ||
      transition["target_interval"] !== "month" ||
      targetPlan.rank <= sourcePlan.rank
    ) {
      throw new Error("intent is not a supported monthly tier upgrade");
    }
    const sourceAmount = stripeInteger(sourceLine["amount"]);
    const targetAmount = stripeInteger(targetLine["amount"]);
    if (sourceAmount === undefined || targetAmount === undefined) {
      throw new Error("prorated delta amounts must be integers");
    }
    if (
      sourceAmount >= 0n ||
      targetAmount <= 0n ||
      targetAmount <= -sourceAmount
    ) {
      throw new Error(
        "Invoice does not contain a positive net upgrade difference",
      );
    }
    const sourceCatalogAmount = BigInt(sourcePlan.monthUsd * 100);
    const targetCatalogAmount = BigInt(targetPlan.monthUsd * 100);
    if (
      -sourceAmount > sourceCatalogAmount ||
      targetAmount > targetCatalogAmount
    ) {
      throw new Error(
        "proration amounts cannot exceed one complete monthly Price",
      );
    }
    const ratioError =
      -sourceAmount * targetCatalogAmount - targetAmount * sourceCatalogAmount <
      0n
        ? -(
            -sourceAmount * targetCatalogAmount -
            targetAmount * sourceCatalogAmount
          )
        : -sourceAmount * targetCatalogAmount -
          targetAmount * sourceCatalogAmount;
    if (
      ratioError >
      (sourceCatalogAmount > targetCatalogAmount
        ? sourceCatalogAmount
        : targetCatalogAmount)
    ) {
      throw new Error(
        "source and target prorations use inconsistent period fractions",
      );
    }
    const invoiceCurrency =
      typeof invoice["currency"] === "string"
        ? invoice["currency"].toLowerCase()
        : "";
    if (invoiceCurrency.length === 0) {
      throw new Error("source and target Prices must use one currency");
    }
    if (
      lines.some((line) => {
        const currency =
          typeof line["currency"] === "string"
            ? line["currency"].toLowerCase()
            : invoiceCurrency;
        return currency !== invoiceCurrency;
      }) ||
      invoiceCurrency !== targetPlan.currency
    ) {
      throw new Error("Invoice and line currencies do not match the catalog");
    }
    const total = stripeInteger(invoice["total"]);
    const amountPaid = stripeInteger(invoice["amount_paid"]);
    const amountDue = Object.hasOwn(invoice, "amount_due")
      ? stripeInteger(invoice["amount_due"])
      : total;
    const subtotal = Object.hasOwn(invoice, "subtotal")
      ? stripeInteger(invoice["subtotal"])
      : total;
    if (
      total === undefined ||
      amountPaid === undefined ||
      amountDue === undefined ||
      subtotal === undefined ||
      amountPaid <= 0n ||
      total !== amountPaid ||
      amountDue !== amountPaid ||
      subtotal !== total ||
      sourceAmount + targetAmount !== total
    ) {
      throw new Error("Invoice net total must be fully paid by new cash");
    }
    if (hasUnsupportedInvoiceAdjustments(invoice, lines)) {
      throw new Error(
        "balance, credit notes, taxes and discounts are not supported",
      );
    }
    const sourcePeriod = sourceLine["period"];
    const targetPeriod = targetLine["period"];
    if (!isPlainRecord(sourcePeriod) || !isPlainRecord(targetPeriod)) {
      throw new Error("source and target proration periods must match");
    }
    const sourceStart = stripeNonnegativeInteger(sourcePeriod["start"]);
    const sourceEnd = stripeNonnegativeInteger(sourcePeriod["end"]);
    const periodStart = stripeNonnegativeInteger(targetPeriod["start"]);
    const periodEnd = stripeNonnegativeInteger(targetPeriod["end"]);
    if (
      sourceStart === undefined ||
      sourceEnd === undefined ||
      periodStart === undefined ||
      periodEnd === undefined ||
      sourceStart !== periodStart ||
      sourceEnd !== periodEnd
    ) {
      throw new Error("source and target proration periods must match");
    }
    if (periodEnd <= periodStart) {
      throw new Error("proration service period is invalid");
    }
    const prorationDate = rowBigInt(transition, "proration_date");
    if (periodStart !== prorationDate) {
      throw new Error(
        "Invoice proration date differs from the durable preview",
      );
    }
    const timestamps = await transaction.query<
      {
        readonly funded_end_matches: boolean;
        readonly preview_start_matches: boolean;
        readonly preview_end_matches: boolean;
      } & QueryResultRow
    >(
      `select
         to_timestamp($1::bigint)=$2::timestamptz as funded_end_matches,
         to_timestamp($3::bigint)=$4::timestamptz as preview_start_matches,
         to_timestamp($1::bigint)=$5::timestamptz as preview_end_matches`,
      [
        periodEnd.toString(),
        transition["expected_entitlement_period_end"],
        periodStart.toString(),
        transition["estimated_period_start"],
        transition["estimated_period_end"],
      ],
    );
    const timestampFacts = timestamps.rows[0];
    if (timestampFacts?.funded_end_matches !== true) {
      throw new Error(
        "Invoice period end differs from the funded entitlement period",
      );
    }
    const previewFields = [
      "estimated_source_proration",
      "estimated_target_proration",
      "estimated_amount_due",
      "estimated_period_start",
      "estimated_period_end",
      "estimate_currency",
    ] as const;
    if (
      previewFields.some(
        (field) =>
          transition[field] === null || transition[field] === undefined,
      )
    ) {
      throw new Error("durable prorated preview facts are incomplete");
    }
    if (
      rowBigInt(transition, "estimated_source_proration") !== -sourceAmount ||
      rowBigInt(transition, "estimated_target_proration") !== targetAmount ||
      rowBigInt(transition, "estimated_amount_due") !== amountPaid ||
      !timestampFacts.preview_start_matches ||
      !timestampFacts.preview_end_matches ||
      String(transition["estimate_currency"]).toLowerCase() !== invoiceCurrency
    ) {
      throw new Error("paid Invoice differs from the durable prorated preview");
    }
    return {
      sourcePlan,
      targetPlan,
      sourceLineId: requiredObjectId(sourceLine),
      targetLineId: requiredObjectId(targetLine),
      sourceCreditAmount: -sourceAmount,
      targetChargeAmount: targetAmount,
      amountPaid,
      currency: invoiceCurrency,
      periodStart,
      periodEnd,
    };
  }

  async #latestFundingInvoice(
    transaction: TransactionClient,
    accountId: string,
    grantEpoch: bigint,
  ): Promise<string | null> {
    const latest = await transaction.query<
      { readonly stripe_invoice_id: string } & QueryResultRow
    >(
      `select stripe_invoice_id from credit_ledger
         where account_id=$1::uuid and grant_epoch=$2::bigint and grant_slot is not null
           and entitlement_units>0
           and reason in ('subscription_grant','upgrade_delta_grant')
         order by id desc limit 1`,
      [accountId, grantEpoch.toString()],
    );
    if (latest.rows[0] !== undefined) {
      return latest.rows[0].stripe_invoice_id;
    }
    const closed = await transaction.query<
      { readonly source_invoice_id: string } & QueryResultRow
    >(
      `select source_invoice_id from billing_funding_allocations
         where account_id=$1::uuid and grant_epoch=$2::bigint
           and status in ('closed','disputed')
         order by id desc limit 1`,
      [accountId, grantEpoch.toString()],
    );
    return closed.rows[0]?.source_invoice_id ?? null;
  }

  async #applyClawbackToGrant(
    transaction: TransactionClient,
    input: {
      readonly accountId: string;
      readonly invoiceId: string;
      readonly grantId: string;
      readonly entitlementUnits: bigint;
      readonly amount: bigint;
      readonly amountRefunded: bigint;
      readonly full: boolean;
      readonly reason: "refund_clawback" | "dispute_clawback";
      readonly eventId: string;
    },
  ): Promise<bigint> {
    const target = input.full
      ? input.entitlementUnits
      : ceilRatio(input.entitlementUnits, input.amountRefunded, input.amount);
    const prior = await transaction.query<
      { readonly amount: string } & QueryResultRow
    >(
      `select coalesce(sum(-delta),0)::text as amount from credit_ledger
         where stripe_invoice_id=$1 and id>$2::bigint and reason=any($3::text[])`,
      [input.invoiceId, input.grantId, [...CLAWBACK_REASONS]],
    );
    const already = pgBigInt(
      prior.rows[0]?.amount ?? "0",
      "prior clawback amount",
    );
    const locked = await transaction.query<DynamicRow>(
      "select credits_balance,grant_epoch from billing_accounts where id=$1::uuid for update",
      [input.accountId],
    );
    const account = locked.rows[0];
    if (account === undefined) {
      throw new Error("account disappeared while applying a clawback");
    }
    const balance = rowBigInt(account, "credits_balance");
    const outstanding = target > already ? target - already : 0n;
    const removed = outstanding < balance ? outstanding : balance;
    if (removed > 0n) {
      const next = balance - removed;
      await transaction.query(
        "update billing_accounts set credits_balance=$2::bigint,updated_at=now() where id=$1::uuid",
        [input.accountId, next.toString()],
      );
      await transaction.query(
        `insert into credit_ledger(
           account_id,delta,balance_after,reason,grant_epoch,stripe_event_id,
           stripe_invoice_id)
         values($1::uuid,$2::bigint,$3::bigint,$4,$5::bigint,$6,$7)`,
        [
          input.accountId,
          (-removed).toString(),
          next.toString(),
          input.reason,
          account["grant_epoch"],
          input.eventId,
          input.invoiceId,
        ],
      );
    }
    if (target > 0n) {
      const collected = target < already + removed ? target : already + removed;
      await transaction.query(
        `insert into billing_clawback_debts(
           account_id,grant_epoch,stripe_invoice_id,target_units,collected_units)
         values($1::uuid,$2::bigint,$3,$4::bigint,$5::bigint)
         on conflict(account_id,grant_epoch,stripe_invoice_id) do update set
           target_units=greatest(billing_clawback_debts.target_units,excluded.target_units),
           collected_units=greatest(
             billing_clawback_debts.collected_units,excluded.collected_units
           ),updated_at=now()`,
        [
          input.accountId,
          account["grant_epoch"],
          input.invoiceId,
          target.toString(),
          collected.toString(),
        ],
      );
    }
    return removed;
  }

  public async clawback(
    transaction: TransactionClient,
    event: StripeObject,
    runtime: ProcessorRuntime,
  ): Promise<ProcessResult> {
    const raw = eventObject(event);
    const dispute = event["type"] === "charge.dispute.created";
    const resolvedCharge = raw["_resolved_charge"];
    const charge =
      dispute && isPlainRecord(resolvedCharge) ? resolvedCharge : raw;
    const invoiceId =
      asStripeId(raw["_resolved_invoice_id"]) ?? asStripeId(charge["invoice"]);
    const chargeId =
      asStripeId(charge["id"]) ??
      asStripeId(raw["id"]) ??
      requiredEventId(event);
    if (raw["_unsupported_invoice_payment_shape"] === true) {
      await runtime.recordIncident(transaction, {
        kind: "unsupported_invoice_payment_shape",
        event,
        dedupeKey: invoiceId ?? chargeId,
        ...(invoiceId === undefined ? {} : { invoiceId }),
        detail: { charge: chargeId, operation: "clawback" },
      });
      return {
        outcome: "ignored",
        reason:
          "Invoice payment collection is outside the single-payment model",
      };
    }
    if (invoiceId === undefined) {
      await runtime.recordIncident(transaction, {
        kind: "clawback_without_invoice",
        event,
        dedupeKey: chargeId,
        detail: { charge: chargeId },
      });
      return {
        outcome: "ignored",
        reason: "charge cannot be attributed to an invoice",
      };
    }
    const customerId = asStripeId(charge["customer"]);
    const amount = stripeInteger(charge["amount"]);
    const amountRefunded = dispute
      ? amount
      : stripeInteger(charge["amount_refunded"]);
    const refundedFlag = charge["refunded"];
    const invalidShape =
      customerId === undefined ||
      amount === undefined ||
      amount <= 0n ||
      amountRefunded === undefined ||
      amountRefunded < 0n ||
      amountRefunded > amount ||
      (refundedFlag !== undefined &&
        refundedFlag !== null &&
        typeof refundedFlag !== "boolean");
    if (invalidShape) {
      await runtime.recordIncident(transaction, {
        kind: "invalid_clawback_shape",
        event,
        dedupeKey: chargeId,
        invoiceId,
        detail: {
          customer_present: customerId !== undefined,
          amount_is_integer: amount !== undefined,
          amount_refunded_is_integer: amountRefunded !== undefined,
        },
      });
      return { outcome: "ignored", reason: "clawback Charge shape is invalid" };
    }
    let account: LockedAccount | undefined;
    const byCustomer = await transaction.query<ProcessorAccountRow>(
      "select * from billing_accounts where stripe_customer_id=$1 for update",
      [customerId],
    );
    if (byCustomer.rows[0] !== undefined) {
      account = accountRow(byCustomer.rows[0]);
    } else {
      const owner = await transaction.query<
        { readonly account_id: string | null } & QueryResultRow
      >(
        "select account_id::text from stripe_invoice_state where invoice_id=$1",
        [invoiceId],
      );
      const knownId = owner.rows[0]?.account_id;
      if (knownId !== undefined && knownId !== null) {
        const byOwner = await transaction.query<ProcessorAccountRow>(
          "select * from billing_accounts where id=$1::uuid for update",
          [knownId],
        );
        if (byOwner.rows[0] !== undefined) {
          account = accountRow(byOwner.rows[0]);
        }
      }
    }
    const full = dispute || refundedFlag === true || amountRefunded === amount;
    if (account === undefined) {
      await transaction.query(
        `insert into stripe_invoice_state(
           invoice_id,amount_total,amount_refunded,fully_refunded,disputed)
         values($1,$2::bigint,$3::bigint,$4,$5)
         on conflict(invoice_id) do update set
           amount_total=greatest(stripe_invoice_state.amount_total,excluded.amount_total),
           amount_refunded=greatest(
             stripe_invoice_state.amount_refunded,excluded.amount_refunded
           ),
           fully_refunded=stripe_invoice_state.fully_refunded or excluded.fully_refunded,
           disputed=stripe_invoice_state.disputed or excluded.disputed,
           updated_at=now()`,
        [
          invoiceId,
          amount.toString(),
          amountRefunded.toString(),
          full,
          dispute,
        ],
      );
      await runtime.recordIncident(transaction, {
        kind: "clawback_unknown_account",
        event,
        dedupeKey: `${customerId}:${invoiceId}`,
        invoiceId,
        detail: { customer: customerId },
      });
      return {
        outcome: "ignored",
        reason: "account not found; invoice flag retained",
      };
    }
    const accountId = account.id;
    if (account.stripe_customer_id !== customerId) {
      await runtime.recordIncident(transaction, {
        kind: "clawback_customer_identity_conflict",
        event,
        dedupeKey: `${accountId}:${invoiceId}`,
        invoiceId,
        accountId,
        detail: { bound: account.stripe_customer_id, incoming: customerId },
      });
      return {
        outcome: "ignored",
        reason: "clawback belongs to a different customer",
        accountId,
      };
    }
    const known = await transaction.query<
      { readonly account_id: string | null } & QueryResultRow
    >(
      "select account_id::text from stripe_invoice_state where invoice_id=$1 for update",
      [invoiceId],
    );
    const knownState = known.rows[0];
    if (
      knownState !== undefined &&
      knownState.account_id !== null &&
      knownState.account_id !== accountId
    ) {
      await runtime.recordIncident(transaction, {
        kind: "clawback_invoice_identity_conflict",
        event,
        dedupeKey: `${accountId}:${invoiceId}`,
        invoiceId,
        accountId,
        detail: { invoice_account_id: knownState.account_id },
      });
      return {
        outcome: "ignored",
        reason: "invoice belongs to a different account",
        accountId,
      };
    }
    const stateResult = await transaction.query<DynamicRow>(
      `insert into stripe_invoice_state(
         invoice_id,account_id,amount_total,amount_refunded,fully_refunded,disputed)
       values($1,$2::uuid,$3::bigint,$4::bigint,$5,$6)
       on conflict(invoice_id) do update set
         account_id=coalesce(stripe_invoice_state.account_id,excluded.account_id),
         amount_total=greatest(stripe_invoice_state.amount_total,excluded.amount_total),
         amount_refunded=greatest(
           stripe_invoice_state.amount_refunded,excluded.amount_refunded
         ),
         fully_refunded=stripe_invoice_state.fully_refunded or excluded.fully_refunded,
         disputed=stripe_invoice_state.disputed or excluded.disputed,
         updated_at=now()
       where stripe_invoice_state.account_id is null
          or stripe_invoice_state.account_id=excluded.account_id
       returning stripe_invoice_state.*`,
      [
        invoiceId,
        accountId,
        amount.toString(),
        amountRefunded.toString(),
        full,
        dispute,
      ],
    );
    const state = stateResult.rows[0];
    if (state === undefined) {
      const owner = await transaction.query<
        { readonly account_id: string | null } & QueryResultRow
      >(
        "select account_id::text from stripe_invoice_state where invoice_id=$1",
        [invoiceId],
      );
      await runtime.recordIncident(transaction, {
        kind: "clawback_invoice_identity_conflict",
        event,
        dedupeKey: `${accountId}:${invoiceId}`,
        invoiceId,
        accountId,
        detail: { invoice_account_id: owner.rows[0]?.account_id ?? null },
      });
      return {
        outcome: "ignored",
        reason: "invoice belongs to a different account",
        accountId,
      };
    }
    const closed =
      state["fully_refunded"] === true || state["disputed"] === true;
    if (closed && state["closure_applied"] === true) {
      return {
        outcome: "replayed",
        reason: "invoice closure was already applied",
        accountId,
      };
    }
    const grants = await transaction.query<DynamicRow>(
      `select id::text,account_id::text,entitlement_units::text,grant_epoch::text,reason
         from credit_ledger where stripe_invoice_id=$1 and grant_slot is not null
         order by id desc limit 1`,
      [invoiceId],
    );
    const grant = grants.rows[0];
    if (grant === undefined) {
      return {
        outcome: "ignored",
        reason: "clawback stored before grant",
        accountId,
      };
    }
    if (grant["account_id"] !== accountId) {
      await runtime.recordIncident(transaction, {
        kind: "clawback_grant_identity_conflict",
        event,
        dedupeKey: `${accountId}:${invoiceId}`,
        invoiceId,
        accountId,
        detail: { grant_account_id: String(grant["account_id"]) },
      });
      return {
        outcome: "ignored",
        reason: "invoice grant belongs to a different account",
        accountId,
      };
    }
    const allocations = await transaction.query<DynamicRow>(
      "select * from billing_funding_allocations where stripe_invoice_id=$1 for update",
      [invoiceId],
    );
    const allocation = allocations.rows[0];
    if (allocation !== undefined) {
      if (allocation["account_id"] !== accountId) {
        await runtime.recordIncident(transaction, {
          kind: "clawback_allocation_identity_conflict",
          event,
          dedupeKey: `${accountId}:${invoiceId}`,
          invoiceId,
          accountId,
          detail: { allocation_account_id: String(allocation["account_id"]) },
        });
        return {
          outcome: "ignored",
          reason: "funding allocation belongs to a different account",
          accountId,
        };
      }
      const allocationAlreadyClosed =
        allocation["status"] === "closed" ||
        allocation["status"] === "disputed";
      const refundedUnits = closed
        ? rowBigInt(allocation, "entitlement_delta")
        : ceilRatio(
            rowBigInt(allocation, "entitlement_delta"),
            rowBigInt(state, "amount_refunded"),
            rowBigInt(state, "amount_total"),
          );
      const status =
        state["disputed"] === true
          ? "disputed"
          : state["fully_refunded"] === true
            ? "closed"
            : refundedUnits > 0n
              ? "partially_refunded"
              : "active";
      await transaction.query(
        `update billing_funding_allocations set
           refunded_units=greatest(refunded_units,$2::bigint),status=$3,updated_at=now()
         where id=$1::bigint`,
        [allocation["id"], refundedUnits.toString(), status],
      );
      if (closed && allocationAlreadyClosed) {
        return {
          outcome: "replayed",
          reason: "clawback was already applied",
          accountId,
        };
      }
    }
    const activeLineage = await this.#invoiceInActiveLineage(
      transaction,
      accountId,
      pgBigInt(account.grant_epoch, "account grant_epoch"),
      invoiceId,
    );
    if (
      rowBigInt(grant, "grant_epoch") !==
        pgBigInt(account.grant_epoch, "account grant_epoch") &&
      account.funding_invoice_id !== invoiceId &&
      !activeLineage
    ) {
      return {
        outcome: "ignored",
        reason: "the refunded invoice belongs to an older entitlement epoch",
        accountId,
      };
    }
    const annualFunding = account.funding_invoice_id === invoiceId;
    let removed = 0n;
    if (annualFunding && !closed) {
      const allowed = annualSlotsAllowed(
        rowBigInt(state, "amount_total"),
        rowBigInt(state, "amount_refunded"),
        0,
      );
      const target =
        BigInt(Math.max(account.annual_grants_issued - allowed, 0)) *
        rowBigInt(state, "grant_units_per_slot");
      const prior = await transaction.query<
        { readonly amount: string } & QueryResultRow
      >(
        `select coalesce(sum(-delta),0)::text as amount from credit_ledger
           where stripe_invoice_id=$1 and reason='annual_refund_overgrant'`,
        [invoiceId],
      );
      const already = pgBigInt(
        prior.rows[0]?.amount ?? "0",
        "annual refund overgrant",
      );
      const outstanding = target > already ? target - already : 0n;
      const balance = pgBigInt(
        account.credits_balance,
        "account credits_balance",
      );
      removed = outstanding < balance ? outstanding : balance;
      if (removed > 0n) {
        const next = balance - removed;
        await transaction.query(
          "update billing_accounts set credits_balance=$2::bigint,updated_at=now() where id=$1::uuid",
          [accountId, next.toString()],
        );
        await transaction.query(
          `insert into credit_ledger(
             account_id,delta,balance_after,reason,grant_epoch,
             stripe_event_id,stripe_invoice_id)
           values($1::uuid,$2::bigint,$3::bigint,'annual_refund_overgrant',
                  $4::bigint,$5,$6)`,
          [
            accountId,
            (-removed).toString(),
            next.toString(),
            account.grant_epoch,
            requiredEventId(event),
            invoiceId,
          ],
        );
      }
    } else {
      removed = await this.#applyClawbackToGrant(transaction, {
        accountId,
        invoiceId,
        grantId: String(grant["id"]),
        entitlementUnits: rowBigInt(grant, "entitlement_units"),
        amount: rowBigInt(state, "amount_total"),
        amountRefunded: rowBigInt(state, "amount_refunded"),
        full: closed,
        reason: dispute ? "dispute_clawback" : "refund_clawback",
        eventId: requiredEventId(event),
      });
    }
    let downstream = 0;
    let leafDeltaRevert = false;
    if (allocation !== undefined && closed) {
      downstream = await this.#downstreamAllocationCount(
        transaction,
        accountId,
        invoiceId,
      );
      leafDeltaRevert =
        downstream === 0 &&
        account.plan_key === allocation["target_plan_key"] &&
        account.plan_interval === allocation["target_interval"] &&
        pgBigInt(account.grant_epoch, "account grant_epoch") ===
          rowBigInt(allocation, "grant_epoch");
      if (leafDeltaRevert) {
        const newEpoch =
          pgBigInt(account.grant_epoch, "account grant_epoch") + 1n;
        const current = await transaction.query<
          { readonly credits_balance: string } & QueryResultRow
        >(
          "select credits_balance::text from billing_accounts where id=$1::uuid",
          [accountId],
        );
        const currentBalance = current.rows[0]?.credits_balance;
        if (currentBalance === undefined) {
          throw new Error("account disappeared during delta funding reversion");
        }
        await transaction.query(
          `update billing_accounts set plan_key=$2,plan_interval=$3,
             grant_epoch=$4::bigint,entitlement_revoked=false,updated_at=now()
           where id=$1::uuid`,
          [
            accountId,
            allocation["source_plan_key"],
            allocation["source_interval"],
            newEpoch.toString(),
          ],
        );
        await transaction.query(
          `update billing_funding_allocations set grant_epoch=$2::bigint,updated_at=now()
           where id=$1::bigint`,
          [allocation["id"], newEpoch.toString()],
        );
        await transaction.query(
          `insert into credit_ledger(
             account_id,delta,balance_after,entitlement_units,reason,
             grant_epoch,stripe_event_id,stripe_invoice_id)
           values($1::uuid,0,$2::bigint,0,'upgrade_funding_reverted',
                  $3::bigint,$4,$5)`,
          [
            accountId,
            currentBalance,
            newEpoch.toString(),
            requiredEventId(event),
            invoiceId,
          ],
        );
        await transaction.query(
          `update billing_plan_changes set status='failed',
             last_error='settlement_funding_closed',updated_at=now()
           where id=$1::uuid`,
          [allocation["plan_change_id"]],
        );
        await runtime.recordIncident(transaction, {
          kind: "upgrade_funding_closed_reverted",
          event,
          dedupeKey: invoiceId,
          invoiceId,
          accountId,
          detail: {
            reverted_to: allocation["source_plan_key"],
            disputed: state["disputed"] === true,
          },
        });
      }
    }
    if (closed && downstream === 0) {
      downstream = await this.#downstreamAllocationCount(
        transaction,
        accountId,
        invoiceId,
      );
    }
    if (annualFunding) {
      const fundedAllowed = closed
        ? account.annual_grants_issued
        : annualSlotsAllowed(
            rowBigInt(state, "amount_total"),
            rowBigInt(state, "amount_refunded"),
            0,
          );
      const allowed = Math.max(account.annual_grants_issued, fundedAllowed);
      await transaction.query(
        `update billing_accounts set
           annual_grants_allowed=least(annual_grants_allowed,$2),updated_at=now()
         where id=$1::uuid`,
        [accountId, allowed],
      );
    }
    const annualOvergrant =
      annualFunding &&
      !closed &&
      annualSlotsAllowed(
        rowBigInt(state, "amount_total"),
        rowBigInt(state, "amount_refunded"),
        0,
      ) < account.annual_grants_issued;
    const revokeEntitlement = (closed && !leafDeltaRevert) || annualOvergrant;
    if (revokeEntitlement && !account.entitlement_revoked) {
      await transaction.query(
        `update billing_accounts set grant_epoch=grant_epoch+1,
           entitlement_revoked=true,
           credit_expires_at=least(coalesce(credit_expires_at,now()),now()),
           updated_at=now() where id=$1::uuid`,
        [accountId],
      );
      if (downstream > 0) {
        await runtime.recordIncident(transaction, {
          kind: "funding_lineage_closed",
          event,
          dedupeKey: `${invoiceId}:${String(grant["grant_epoch"])}`,
          invoiceId,
          accountId,
          detail: { downstream_allocations: downstream },
        });
      }
    }
    if (closed) {
      await transaction.query(
        "update stripe_invoice_state set closure_applied=true,updated_at=now() where invoice_id=$1",
        [invoiceId],
      );
    }
    return {
      outcome: "handled",
      reason: `removed ${creditDecimal(removed)} credits`,
      accountId,
    };
  }

  async #downstreamAllocationCount(
    transaction: TransactionClient,
    accountId: string,
    invoiceId: string,
  ): Promise<number> {
    const result = await transaction.query<
      { readonly count: string } & QueryResultRow
    >(
      `select count(*)::text as count from billing_funding_allocations
         where account_id=$1::uuid and source_invoice_id=$2 and stripe_invoice_id<>$2`,
      [accountId, invoiceId],
    );
    return Number.parseInt(result.rows[0]?.count ?? "0", 10);
  }

  async #invoiceInActiveLineage(
    transaction: TransactionClient,
    accountId: string,
    grantEpoch: bigint,
    invoiceId: string,
  ): Promise<boolean> {
    const result = await transaction.query<
      { readonly exists: boolean } & QueryResultRow
    >(
      `with recursive funding_chain as (
         select stripe_invoice_id,source_invoice_id
           from billing_funding_allocations
          where account_id=$1::uuid and grant_epoch=$2::bigint
         union
         select parent.stripe_invoice_id,parent.source_invoice_id
           from billing_funding_allocations parent
           join funding_chain child
             on parent.stripe_invoice_id=child.source_invoice_id
          where parent.account_id=$1::uuid
       )
       select exists(
         select 1 from funding_chain where stripe_invoice_id=$3 or source_invoice_id=$3
       ) as exists`,
      [accountId, grantEpoch.toString(), invoiceId],
    );
    return result.rows[0]?.exists === true;
  }

  public async paymentFailed(
    transaction: TransactionClient,
    event: StripeObject,
    runtime: ProcessorRuntime,
  ): Promise<ProcessResult> {
    const invoice = eventObject(event);
    const metadata = subscriptionMetadata(invoice);
    const rawAccount = await runtime.lockAccount(
      transaction,
      invoice,
      metadata,
    );
    if (rawAccount === undefined) {
      return { outcome: "ignored", reason: "account not found" };
    }
    const account = accountRow(rawAccount);
    const accountId = account.id;
    const invoiceId = asStripeId(invoice["id"]);
    const subscription = subscriptionId(invoice);
    const customerId = asStripeId(invoice["customer"]);
    if (
      customerId === undefined ||
      (account.stripe_customer_id !== null &&
        account.stripe_customer_id !== customerId)
    ) {
      await runtime.recordIncident(transaction, {
        kind: "payment_failed_customer_identity_conflict",
        event,
        dedupeKey: `${accountId}:${invoiceId ?? requiredEventId(event)}`,
        ...(invoiceId === undefined ? {} : { invoiceId }),
        accountId,
        detail: {
          bound: account.stripe_customer_id,
          incoming: customerId ?? null,
        },
      });
      return {
        outcome: "ignored",
        reason: "failed invoice customer identity is missing or conflicting",
        accountId,
      };
    }
    if (
      subscription === undefined ||
      subscription !== account.stripe_subscription_id
    ) {
      await runtime.recordIncident(transaction, {
        kind: "payment_failed_subscription_identity_conflict",
        event,
        dedupeKey: `${accountId}:${invoiceId ?? requiredEventId(event)}`,
        ...(invoiceId === undefined ? {} : { invoiceId }),
        accountId,
        detail: {
          bound: account.stripe_subscription_id,
          incoming: subscription ?? null,
        },
      });
      return {
        outcome: "ignored",
        reason: "failed invoice belongs to a different subscription",
        accountId,
      };
    }
    const billingReason = invoice["billing_reason"];
    if (typeof billingReason !== "string" || !PAID_REASONS.has(billingReason)) {
      await runtime.recordIncident(transaction, {
        kind: "unexpected_payment_failed_reason",
        event,
        dedupeKey: invoiceId ?? requiredEventId(event),
        ...(invoiceId === undefined ? {} : { invoiceId }),
        accountId,
        detail: {
          billing_reason:
            typeof billingReason === "string" ? billingReason : null,
        },
      });
      return {
        outcome: "ignored",
        reason: "failed Invoice has an unsupported billing reason",
        accountId,
      };
    }
    if (billingReason === "subscription_update") {
      const pendingResult = await transaction.query<DynamicRow>(
        `select * from billing_plan_changes
           where account_id=$1::uuid and stripe_subscription_id=$2
             and settlement_invoice_id=$3 and effective_mode='immediate'
             and status in ('applying','applied','requires_action','completed')
           order by created_at desc limit 1 for update`,
        [accountId, subscription, invoiceId ?? null],
      );
      const pending = pendingResult.rows[0];
      if (pending?.["status"] === "completed") {
        const committed = await transaction.query<
          { readonly exists: boolean } & QueryResultRow
        >(
          `select exists(
             select 1 from credit_ledger
              where account_id=$1::uuid and stripe_invoice_id=$2 and grant_slot=1
           ) as exists`,
          [accountId, invoiceId ?? null],
        );
        if (committed.rows[0]?.exists === true) {
          return {
            outcome: "replayed",
            reason: "settlement invoice already granted",
            accountId,
          };
        }
      }
      if (pending !== undefined && pending["status"] !== "completed") {
        await transaction.query(
          "update billing_plan_changes set status='requires_action',updated_at=now() where id=$1::uuid",
          [pending["id"]],
        );
        await runtime.recordIncident(transaction, {
          kind: "plan_change_payment_failed",
          event,
          dedupeKey: invoiceId ?? requiredEventId(event),
          ...(invoiceId === undefined ? {} : { invoiceId }),
          accountId,
          detail: { subscription },
        });
        return {
          outcome: "ignored",
          reason:
            "optional plan change payment failed; paid entitlement retained",
          accountId,
        };
      }
      const unboundResult = await transaction.query<DynamicRow>(
        `select id::text from billing_plan_changes
           where account_id=$1::uuid and stripe_subscription_id=$2
             and effective_mode='immediate'
             and status in ('applying','applied','requires_action')
           order by created_at desc limit 1 for update`,
        [accountId, subscription],
      );
      await runtime.recordIncident(transaction, {
        kind: "unbound_plan_change_payment_failed",
        event,
        dedupeKey: invoiceId ?? requiredEventId(event),
        ...(invoiceId === undefined ? {} : { invoiceId }),
        accountId,
        detail: {
          subscription,
          pending_change_id: unboundResult.rows[0]?.["id"] ?? null,
        },
      });
      return {
        outcome: "ignored",
        reason:
          "subscription-update failure is not bound to the current plan change",
        accountId,
      };
    }
    if (!runtime.eventWinsAccount(account, event)) {
      return {
        outcome: "ignored",
        reason: "older or weaker than the applied state",
        accountId,
      };
    }
    const cursor = projectedCursor(account, event);
    await transaction.query(
      `update billing_accounts set subscription_status='past_due',
         event_created=$2::bigint,event_rank=$3,updated_at=now() where id=$1::uuid`,
      [accountId, cursor.created.toString(), cursor.rank],
    );
    return { outcome: "handled", accountId };
  }

  #subscriptionPlan(
    subscription: StripeObject,
    runtime: ProcessorRuntime,
  ): readonly [Plan, BillingInterval] | undefined {
    const container = subscription["items"];
    const rawItems = isPlainRecord(container) ? container["data"] : undefined;
    if (
      !isPlainRecord(container) ||
      (container["has_more"] !== undefined &&
        container["has_more"] !== false) ||
      !Array.isArray(rawItems) ||
      rawItems.length !== 1
    ) {
      return undefined;
    }
    const item: unknown = rawItems[0] as unknown;
    if (!isPlainRecord(item) || stripeInteger(item["quantity"]) !== 1n) {
      return undefined;
    }
    const parsed = runtime.catalog.parseLookupKey(lineLookup(item));
    return parsed !== undefined &&
      runtime.catalogLineMatches(item, parsed[0], parsed[1])
      ? parsed
      : undefined;
  }

  #subscriptionPeriodEnd(subscription: StripeObject): bigint | undefined {
    const container = subscription["items"];
    const rawItems = isPlainRecord(container) ? container["data"] : undefined;
    const item =
      isPlainRecord(container) &&
      (container["has_more"] === undefined ||
        container["has_more"] === false) &&
      Array.isArray(rawItems) &&
      rawItems.length === 1 &&
      isPlainRecord(rawItems[0])
        ? rawItems[0]
        : undefined;
    const itemEnd = item?.["current_period_end"];
    return stripeNonnegativeInteger(
      itemEnd ?? subscription["current_period_end"],
    );
  }

  public async subscriptionUpdated(
    transaction: TransactionClient,
    event: StripeObject,
    runtime: ProcessorRuntime,
  ): Promise<ProcessResult> {
    const subscription = eventObject(event);
    const rawAccount = await runtime.lockAccount(transaction, subscription);
    if (rawAccount === undefined) {
      return { outcome: "ignored", reason: "account not found" };
    }
    const account = accountRow(rawAccount);
    const accountId = account.id;
    const currentSubscription = account.stripe_subscription_id;
    const incomingSubscription = requiredObjectId(subscription);
    const customerId = asStripeId(subscription["customer"]);
    const metadata = isPlainRecord(subscription["metadata"])
      ? subscription["metadata"]
      : {};
    if (
      customerId === undefined ||
      (account.stripe_customer_id !== null &&
        account.stripe_customer_id !== customerId)
    ) {
      await runtime.recordIncident(transaction, {
        kind: "subscription_customer_identity_conflict",
        event,
        dedupeKey: `${accountId}:${incomingSubscription}`,
        accountId,
        detail: {
          bound: account.stripe_customer_id,
          incoming: customerId ?? null,
        },
      });
      return {
        outcome: "ignored",
        reason: "subscription customer identity is missing or conflicting",
        accountId,
      };
    }
    const status = subscription["status"];
    const cancelAtPeriodEnd = subscription["cancel_at_period_end"];
    const periodEnd = this.#subscriptionPeriodEnd(subscription);
    if (
      typeof status !== "string" ||
      !SUBSCRIPTION_STATUSES.has(status) ||
      typeof cancelAtPeriodEnd !== "boolean" ||
      periodEnd === undefined
    ) {
      await runtime.recordIncident(transaction, {
        kind: "invalid_subscription_projection",
        event,
        dedupeKey: `${accountId}:${incomingSubscription}`,
        accountId,
        detail: {
          status: typeof status === "string" ? status : null,
          cancel_at_period_end_is_boolean:
            typeof cancelAtPeriodEnd === "boolean",
          period_end_present: periodEnd !== undefined,
        },
      });
      return {
        outcome: "ignored",
        reason: "Subscription projection shape is invalid",
        accountId,
      };
    }
    if (
      currentSubscription !== null &&
      currentSubscription !== incomingSubscription
    ) {
      await runtime.recordIncident(transaction, {
        kind: "subscription_identity_conflict",
        event,
        dedupeKey: `${accountId}:${incomingSubscription}`,
        accountId,
        detail: { bound: currentSubscription, incoming: incomingSubscription },
      });
      return {
        outcome: "ignored",
        reason: "a different subscription is already bound",
        accountId,
      };
    }
    const parsed = this.#subscriptionPlan(subscription, runtime);
    if (parsed === undefined) {
      await runtime.recordIncident(transaction, {
        kind: "ambiguous_subscription_items",
        event,
        dedupeKey: `${accountId}:${incomingSubscription}`,
        accountId,
      });
      return {
        outcome: "ignored",
        reason: "subscription must contain one catalog item",
        accountId,
      };
    }
    let claim: DynamicRow | undefined;
    if (currentSubscription === null) {
      const result = await transaction.query<DynamicRow>(
        "select * from checkout_claims where account_id=$1::uuid for update",
        [accountId],
      );
      claim = result.rows[0];
      const authorized =
        claim !== undefined &&
        typeof metadata["claim_token"] === "string" &&
        String(claim["claim_token"]) === metadata["claim_token"] &&
        claim["plan_key"] === parsed[0].key &&
        claim["plan_interval"] === parsed[1];
      if (!authorized) {
        await runtime.recordIncident(transaction, {
          kind: "subscription_update_without_authority",
          event,
          dedupeKey: `${accountId}:${incomingSubscription}`,
          accountId,
        });
        return {
          outcome: "ignored",
          reason: "unbound subscription lacks a live Checkout claim",
          accountId,
        };
      }
    }
    if (!runtime.eventWinsAccount(account, event)) {
      if (orderingTie(account, event)) {
        await runtime.recordIncident(transaction, {
          kind: "event_order_tie",
          event,
          dedupeKey: `${accountId}:${String(event["type"])}:${String(event["created"])}:${String(account.event_rank)}`,
          accountId,
          detail: {
            subscription_id: incomingSubscription,
            status,
            cancel_at_period_end: cancelAtPeriodEnd,
          },
        });
      }
      return {
        outcome: "ignored",
        reason: "older or weaker than the applied state",
        accountId,
      };
    }
    const cursor = projectedCursor(account, event);
    await transaction.query(
      `update billing_accounts set
         stripe_customer_id=coalesce(stripe_customer_id,$2),
         stripe_subscription_id=$3,subscription_status=$4,
         current_period_end=to_timestamp($5::bigint),cancel_at_period_end=$6,
         pending_free_at=case when $6 then to_timestamp($5::bigint) else null end,
         event_created=$7::bigint,event_rank=$8,updated_at=now()
       where id=$1::uuid`,
      [
        accountId,
        customerId,
        incomingSubscription,
        projectSubscriptionStatus(status),
        periodEnd.toString(),
        cancelAtPeriodEnd,
        cursor.created.toString(),
        cursor.rank,
      ],
    );
    if (currentSubscription === null) {
      if (claim === undefined) {
        throw new Error("authorized Checkout claim disappeared");
      }
      await transaction.query(
        "delete from checkout_claims where account_id=$1::uuid and claim_token=$2::uuid",
        [accountId, claim["claim_token"]],
      );
    }
    return { outcome: "handled", accountId };
  }

  public async subscriptionDeleted(
    transaction: TransactionClient,
    event: StripeObject,
    runtime: ProcessorRuntime,
  ): Promise<ProcessResult> {
    const subscription = eventObject(event);
    const rawAccount = await runtime.lockAccount(transaction, subscription);
    if (rawAccount === undefined) {
      return { outcome: "ignored", reason: "account not found" };
    }
    const account = accountRow(rawAccount);
    const accountId = account.id;
    const incomingSubscription = asStripeId(subscription["id"]);
    const customerId = asStripeId(subscription["customer"]);
    if (
      incomingSubscription === undefined ||
      account.stripe_subscription_id !== incomingSubscription
    ) {
      await runtime.recordIncident(transaction, {
        kind: "subscription_deleted_identity_conflict",
        event,
        dedupeKey: `${accountId}:${incomingSubscription ?? requiredEventId(event)}`,
        accountId,
        detail: {
          bound: account.stripe_subscription_id,
          incoming: incomingSubscription ?? null,
        },
      });
      return {
        outcome: "ignored",
        reason: "deleted event belongs to an unbound subscription",
        accountId,
      };
    }
    if (
      customerId === undefined ||
      (account.stripe_customer_id !== null &&
        account.stripe_customer_id !== customerId)
    ) {
      await runtime.recordIncident(transaction, {
        kind: "subscription_customer_identity_conflict",
        event,
        dedupeKey: `${accountId}:${incomingSubscription}`,
        accountId,
        detail: {
          bound: account.stripe_customer_id,
          incoming: customerId ?? null,
        },
      });
      return {
        outcome: "ignored",
        reason:
          "deleted subscription customer identity is missing or conflicting",
        accountId,
      };
    }
    if (!runtime.eventWinsAccount(account, event)) {
      return {
        outcome: "ignored",
        reason: "older than the applied state",
        accountId,
      };
    }
    const oldBalance = pgBigInt(
      account.credits_balance,
      "account credits_balance",
    );
    const newEpoch = pgBigInt(account.grant_epoch, "account grant_epoch") + 1n;
    const cursor = projectedCursor(account, event);
    await transaction.query(
      "delete from checkout_claims where account_id=$1::uuid",
      [accountId],
    );
    await transaction.query(
      `update billing_accounts set stripe_subscription_id=null,plan_key='free',
         plan_interval=null,subscription_status='canceled',credits_balance=0,
         grant_epoch=$2::bigint,event_created=$3::bigint,event_rank=$4,
         current_period_end=null,entitlement_period_end=null,credit_expires_at=null,
         entitlement_revoked=true,cancel_at_period_end=false,pending_free_at=null,
         annual_anchor=null,annual_grants_issued=0,annual_grants_allowed=12,
         funding_invoice_id=null,updated_at=now() where id=$1::uuid`,
      [accountId, newEpoch.toString(), cursor.created.toString(), cursor.rank],
    );
    if (oldBalance > 0n) {
      await transaction.query(
        `insert into credit_ledger(
           account_id,delta,balance_after,reason,grant_epoch,stripe_event_id)
         values($1::uuid,$2::bigint,0,'subscription_ended',$3::bigint,$4)`,
        [
          accountId,
          (-oldBalance).toString(),
          newEpoch.toString(),
          requiredEventId(event),
        ],
      );
    }
    await transaction.query(
      `update billing_plan_changes set status='failed',
         last_error='subscription_deleted',completed_at=coalesce(completed_at,now()),
         lease_token=null,lease_expires_at=null,updated_at=now()
       where account_id=$1::uuid and stripe_subscription_id=$2
         and status in (
           'reserved','previewed','applying','scheduled','applied','requires_action'
         )`,
      [accountId, incomingSubscription],
    );
    await transaction.query(
      `update billing_incidents set resolved_at=clock_timestamp(),
         last_seen_at=clock_timestamp()
       where account_id=$1::uuid and resolved_at is null
         and kind in (
           'plan_change_payment_failed','unbound_plan_change_payment_failed',
           'plan_change_recovery_required'
         )`,
      [accountId],
    );
    return { outcome: "handled", accountId };
  }

  public async checkoutCompleted(
    transaction: TransactionClient,
    event: StripeObject,
    runtime: ProcessorRuntime,
  ): Promise<ProcessResult> {
    const session = eventObject(event);
    const rawAccount = await runtime.lockAccount(transaction, session);
    if (rawAccount === undefined) {
      return { outcome: "ignored", reason: "account not found" };
    }
    const account = accountRow(rawAccount);
    const accountId = account.id;
    const claims = await transaction.query<DynamicRow>(
      "select * from checkout_claims where account_id=$1::uuid for update",
      [accountId],
    );
    const claim = claims.rows[0];
    const sessionId = requiredObjectId(session);
    const incomingSubscription = asStripeId(session["subscription"]);
    const incomingCustomer = asStripeId(session["customer"]);
    const metadata = isPlainRecord(session["metadata"])
      ? session["metadata"]
      : {};
    if (incomingSubscription === undefined) {
      await runtime.recordIncident(transaction, {
        kind: "checkout_completed_without_subscription",
        event,
        dedupeKey: `${accountId}:${sessionId}`,
        accountId,
      });
      return {
        outcome: "ignored",
        reason: "completed Checkout has no subscription",
        accountId,
      };
    }
    if (
      incomingCustomer === undefined ||
      (account.stripe_customer_id !== null &&
        account.stripe_customer_id !== incomingCustomer)
    ) {
      await runtime.recordIncident(transaction, {
        kind: "checkout_customer_identity_conflict",
        event,
        dedupeKey: `${accountId}:${sessionId}`,
        accountId,
        detail: {
          bound: account.stripe_customer_id,
          incoming: incomingCustomer ?? null,
        },
      });
      return {
        outcome: "ignored",
        reason: "Checkout customer identity is missing or conflicting",
        accountId,
      };
    }
    if (claim === undefined) {
      if (incomingSubscription === account.stripe_subscription_id) {
        return {
          outcome: "replayed",
          reason: "subscription is already bound",
          accountId,
        };
      }
      await runtime.recordIncident(transaction, {
        kind: "checkout_completed_without_claim",
        event,
        dedupeKey: `${accountId}:${sessionId}`,
        accountId,
      });
      return {
        outcome: "ignored",
        reason: "checkout claim is missing",
        accountId,
      };
    }
    const matchingUnattachedClaim =
      claim["session_id"] === null &&
      typeof metadata["claim_token"] === "string" &&
      String(claim["claim_token"]) === metadata["claim_token"];
    if (claim["session_id"] !== sessionId && !matchingUnattachedClaim) {
      await runtime.recordIncident(transaction, {
        kind: "stale_checkout_completion",
        event,
        dedupeKey: `${accountId}:${sessionId}`,
        accountId,
        detail: { active_session: claim["session_id"] ?? null },
      });
      return {
        outcome: "ignored",
        reason: "another checkout owns the active claim",
        accountId,
      };
    }
    if (
      account.stripe_subscription_id !== null &&
      account.stripe_subscription_id !== incomingSubscription
    ) {
      await runtime.recordIncident(transaction, {
        kind: "multiple_subscriptions",
        event,
        dedupeKey: `${accountId}:${incomingSubscription}`,
        accountId,
      });
      return {
        outcome: "ignored",
        reason: "a different subscription is already bound",
        accountId,
      };
    }
    await transaction.query(
      `update billing_accounts set
         stripe_customer_id=coalesce(stripe_customer_id,$2),
         event_created=case when stripe_subscription_id is null then 0 else event_created end,
         event_rank=case when stripe_subscription_id is null then 0 else event_rank end,
         stripe_subscription_id=coalesce($3,stripe_subscription_id),updated_at=now()
       where id=$1::uuid`,
      [accountId, incomingCustomer, incomingSubscription],
    );
    await transaction.query(
      `delete from checkout_claims
         where account_id=$1::uuid and (session_id=$2 or claim_token=$3::uuid)`,
      [accountId, sessionId, claim["claim_token"]],
    );
    return { outcome: "handled", accountId };
  }

  public async checkoutExpired(
    transaction: TransactionClient,
    event: StripeObject,
  ): Promise<ProcessResult> {
    const session = eventObject(event);
    const sessionId = requiredObjectId(session);
    const result = await transaction.query<
      { readonly account_id: string } & QueryResultRow
    >(
      "delete from checkout_claims where session_id=$1 returning account_id::text",
      [sessionId],
    );
    const accountId = result.rows[0]?.account_id;
    return accountId === undefined
      ? { outcome: "ignored", reason: "session no longer owns a claim" }
      : { outcome: "handled", accountId };
  }
}
