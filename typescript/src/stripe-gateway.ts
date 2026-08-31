import Stripe from "stripe";

import { POSTGRES_BIGINT_MAX } from "./bounds.js";
import { CheckoutCreationRejected } from "./checkout.js";
import {
  checkoutSuccessBaseUrlIsSafe,
  publicHttpUrlIsStructurallySafe,
} from "./config.js";
import { hasUnsupportedInvoiceAdjustments } from "./invoice-policy.js";
import {
  portalConfigurationIdIsUsable,
  portalConfigurationIsSafe,
} from "./portal-policy.js";
import {
  buildCreditPackCheckoutRequestSnapshot,
  buildSubscriptionCheckoutRequestSnapshot,
  planChangeContextFromSnapshot,
  type CheckoutRequestSnapshot,
  validateCheckoutRequestSnapshot,
  validatePlanChangeRequestSnapshot,
} from "./stripe-request-snapshots.js";
import {
  catalogOneTimePriceMatches,
  catalogPriceMatches,
} from "./price-policy.js";
import {
  asStripeId,
  lineIsProration,
  lineLookup,
  linePriceId,
  stripeInteger,
  subscriptionId,
  type StripeObject,
} from "./processor-primitives.js";
import type {
  BillingInterval,
  PgTimestamp,
  SubscriptionSnapshot,
  TransitionPolicy,
} from "./types.js";
import { isPlainRecord, isPrintable } from "./validation.js";

const DEFAULT_API_VERSION = "2026-06-24.dahlia";
const MAX_STRIPE_TIMESTAMP = 253_402_300_799n;
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

class UnsupportedStripeShapeError extends Error {}

export class PortalConfigurationUnavailableError extends Error {}

function stripeObject(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error("Stripe returned a non-object response");
  }
  return { ...value };
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function cloneRemote(value: unknown): unknown {
  if (isUnknownArray(value)) {
    return value.map((item) => cloneRemote(item));
  }
  if (isPlainRecord(value)) {
    const cloned: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      cloned[key] = cloneRemote(item);
    }
    return cloned;
  }
  return value;
}

function stripUntrustedInternalFields(value: unknown): unknown {
  if (isUnknownArray(value)) {
    return value.map((item) => stripUntrustedInternalFields(item));
  }
  if (isPlainRecord(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (!key.startsWith("_")) {
        sanitized[key] = stripUntrustedInternalFields(item);
      }
    }
    return sanitized;
  }
  return value;
}

function requiredText(value: unknown, field: string, maxBytes = 2048): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    !isPrintable(value)
  ) {
    throw new Error(`Stripe returned an invalid ${field}`);
  }
  return value;
}

function requiredHttpsUrl(value: unknown, field: string): string {
  const url = requiredText(value, field);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Stripe returned a non-HTTPS ${field}`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.host.length === 0 ||
    parsed.username.length !== 0 ||
    parsed.password.length !== 0
  ) {
    throw new Error(`Stripe returned a non-HTTPS ${field}`);
  }
  return url;
}

function bigintToSafeNumber(
  value: bigint,
  field: string,
  minimum = 0n,
): number {
  if (
    typeof value !== "bigint" ||
    value < minimum ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new RangeError(
      `${field} must fit a non-negative JavaScript safe integer`,
    );
  }
  return Number(value);
}

function remoteInteger(value: unknown): bigint | undefined {
  const parsed = stripeInteger(value);
  return parsed !== undefined &&
    parsed >= -POSTGRES_BIGINT_MAX &&
    parsed <= POSTGRES_BIGINT_MAX
    ? parsed
    : undefined;
}

function remoteNonnegativeInteger(value: unknown): bigint | undefined {
  const parsed = remoteInteger(value);
  return parsed !== undefined && parsed >= 0n ? parsed : undefined;
}

function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  const remainder = value % divisor;
  return remainder < 0n ? quotient - 1n : quotient;
}

function civilFromDays(daysSinceEpoch: bigint): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
} {
  const shifted = daysSinceEpoch + 719_468n;
  const era = floorDiv(shifted, 146_097n);
  const dayOfEra = shifted - era * 146_097n;
  const yearOfEra =
    (dayOfEra - dayOfEra / 1460n + dayOfEra / 36_524n - dayOfEra / 146_096n) /
    365n;
  let year = yearOfEra + era * 400n;
  const dayOfYear =
    dayOfEra - (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n);
  const shiftedMonth = (5n * dayOfYear + 2n) / 153n;
  const day = dayOfYear - (153n * shiftedMonth + 2n) / 5n + 1n;
  const month = shiftedMonth + (shiftedMonth < 10n ? 3n : -9n);
  year += month <= 2n ? 1n : 0n;
  return { year: Number(year), month: Number(month), day: Number(day) };
}

function daysFromCivil(year: number, month: number, day: number): bigint {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const shiftedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return BigInt(era * 146_097 + dayOfEra - 719_468);
}

function epochParts(value: bigint): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
} {
  if (value < 0n || value > MAX_STRIPE_TIMESTAMP) {
    throw new RangeError("Stripe timestamp is outside the supported UTC range");
  }
  const days = value / 86_400n;
  const remainder = value % 86_400n;
  const civil = civilFromDays(days);
  return {
    ...civil,
    hour: Number(remainder / 3600n),
    minute: Number((remainder % 3600n) / 60n),
    second: Number(remainder % 60n),
  };
}

function epochTimestamp(value: bigint): PgTimestamp {
  const parts = epochParts(value);
  const pad = (part: number, width = 2): string =>
    part.toString().padStart(width, "0");
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.000000Z`;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function addCalendarInterval(
  boundary: bigint,
  interval: BillingInterval,
): bigint {
  const parts = epochParts(boundary);
  let year = parts.year;
  let month = parts.month;
  if (interval === "month") {
    if (month === 12) {
      year += 1;
      month = 1;
    } else {
      month += 1;
    }
  } else {
    year += 1;
  }
  const day = Math.min(parts.day, daysInMonth(year, month));
  return (
    daysFromCivil(year, month, day) * 86_400n +
    BigInt(parts.hour * 3600 + parts.minute * 60 + parts.second)
  );
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (isUnknownArray(left) || isUnknownArray(right)) {
    return (
      isUnknownArray(left) &&
      isUnknownArray(right) &&
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && deepEqual(left[key], right[key]),
    )
  );
}

function collection(
  value: unknown,
  field: string,
): {
  readonly data: readonly unknown[];
  readonly hasMore: boolean;
} {
  if (
    !isPlainRecord(value) ||
    !isUnknownArray(value["data"]) ||
    typeof value["has_more"] !== "boolean"
  ) {
    throw new Error(`Stripe returned an invalid ${field} collection`);
  }
  return { data: value["data"], hasMore: value["has_more"] };
}

function listData(value: unknown, field: string): readonly unknown[] {
  if (!isPlainRecord(value) || !isUnknownArray(value["data"])) {
    throw new Error(`Stripe returned an invalid ${field} collection`);
  }
  return value["data"];
}

function recordHasValues(value: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(value).length > 0;
}

export interface StripeGatewayOptions {
  readonly productLine?: string;
  readonly apiVersion?: string;
  readonly portalConfigurationId?: string | null;
  readonly checkoutSuccessUrl?: string;
  readonly checkoutCancelUrl?: string;
  readonly portalReturnUrl?: string;
  /** Dependency injection seam for deterministic unit tests. */
  readonly client?: Stripe;
}

export interface CreateCheckoutSessionInput {
  readonly accountId: string;
  readonly customerId?: string;
  readonly lookupKey: string;
  readonly expectedCurrency: string;
  readonly expectedUnitAmount: bigint;
  readonly expectedInterval: BillingInterval;
  readonly claimToken: string;
  readonly expiresAtEpoch: bigint;
  readonly customerEmail?: string;
  readonly planKey: string;
  readonly interval: BillingInterval;
}

export interface CreateCreditPackCheckoutSessionInput {
  readonly orderId: string;
  readonly accountId: string;
  readonly customerId?: string;
  readonly customerEmail?: string;
  readonly lookupKey: string;
  readonly expectedCurrency: string;
  readonly expectedUnitAmount: bigint;
  readonly packKey: string;
  readonly packCredits: string;
  readonly expiresDays: number;
  readonly expiresAtEpoch: bigint;
}

export interface PreparePlanChangeInput {
  readonly subscriptionId: string;
  readonly targetLookupKey: string;
  readonly expectedCurrency: string;
  readonly expectedUnitAmount: bigint;
  readonly expectedPlanKey: string;
  readonly targetInterval: BillingInterval;
  readonly expectedSourceLookupKey: string;
  readonly expectedSourceCurrency: string;
  readonly expectedSourceUnitAmount: bigint;
  readonly expectedSourcePlanKey: string;
  readonly sourceInterval: BillingInterval;
}

export interface PlanChangeContext {
  readonly subscriptionId: string;
  readonly subscriptionItemId: string;
  readonly currentPriceId: string;
  readonly currentLookupKey: string;
  readonly targetPriceId: string;
  readonly targetInterval: BillingInterval;
  readonly currentPeriodStart: bigint;
  readonly currentPeriodEnd: bigint;
  readonly scheduleId: string | null;
  readonly subscriptionStatus: string;
  readonly cancelAtPeriodEnd: boolean;
  readonly pendingUpdate: boolean;
  readonly pendingExpiresAt: bigint | null;
  readonly recoveryUrl: string | null;
  readonly clientSecret: string | null;
}

export interface PlanChangeEstimate {
  readonly amountDue: bigint;
  readonly prorationCredit: bigint;
  readonly customerBalanceCredit: bigint;
  readonly currency: string;
  readonly safeInvoiceShape: boolean;
  readonly sourceProrationAmount: bigint;
  readonly targetProrationAmount: bigint;
  readonly taxAmount: bigint;
  readonly discountAmount: bigint;
  readonly periodStart: bigint | null;
  readonly periodEnd: bigint | null;
}

export interface RemotePlanChange {
  readonly remoteId: string;
  readonly pendingUpdate: boolean;
  readonly pendingExpiresAt: bigint | null;
  readonly recoveryUrl: string | null;
  readonly clientSecret: string | null;
  readonly settlementInvoiceId: string | null;
}

/**
 * Transaction-free Stripe network adapter. Coordinators persist/lease work before
 * invoking this class; no method accepts a database client or opens a transaction.
 */
export class StripeGateway {
  readonly #stripe: Stripe;
  readonly #secretKey: string;
  readonly #webhookSecret: string;
  readonly #productLine: string;
  readonly #apiVersion: string;
  readonly #portalConfigurationId: string | null;
  readonly #checkoutSuccessUrl: string;
  readonly #checkoutCancelUrl: string;
  readonly #portalReturnUrl: string;

  public constructor(
    secretKey: string,
    webhookSecret: string,
    options: StripeGatewayOptions = {},
  ) {
    if (
      !secretKey.startsWith("sk_test_") &&
      !secretKey.startsWith("sk_live_")
    ) {
      throw new TypeError(
        "Stripe secret key must be an sk_test_ or sk_live_ key",
      );
    }
    if (!webhookSecret.startsWith("whsec_")) {
      throw new TypeError("Stripe webhook secret must start with whsec_");
    }
    const checkoutSuccessUrl =
      options.checkoutSuccessUrl ?? "http://localhost:3000/billing/success";
    const checkoutCancelUrl =
      options.checkoutCancelUrl ?? "http://localhost:3000/pricing";
    const portalReturnUrl =
      options.portalReturnUrl ?? "http://localhost:3000/account";
    for (const [field, value] of [
      ["checkoutSuccessUrl", checkoutSuccessUrl],
      ["checkoutCancelUrl", checkoutCancelUrl],
      ["portalReturnUrl", portalReturnUrl],
    ] as const) {
      if (!publicHttpUrlIsStructurallySafe(value)) {
        throw new TypeError(`${field} must be an origin-safe HTTP(S) URL`);
      }
    }
    if (!checkoutSuccessBaseUrlIsSafe(checkoutSuccessUrl)) {
      throw new TypeError(
        "checkoutSuccessUrl must not include a query or fragment",
      );
    }
    const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.#stripe =
      options.client ??
      new Stripe(secretKey, {
        apiVersion: apiVersion as Stripe.LatestApiVersion,
      });
    this.#secretKey = secretKey;
    this.#webhookSecret = webhookSecret;
    this.#productLine = options.productLine ?? "example-entitlements";
    this.#apiVersion = apiVersion;
    this.#portalConfigurationId = options.portalConfigurationId ?? null;
    this.#checkoutSuccessUrl = checkoutSuccessUrl;
    this.#checkoutCancelUrl = checkoutCancelUrl;
    this.#portalReturnUrl = portalReturnUrl;
  }

  public get apiVersion(): string {
    return this.#apiVersion;
  }

  public get productLine(): string {
    return this.#productLine;
  }

  public get portalConfigurationId(): string | null {
    return this.#portalConfigurationId;
  }

  public get checkoutSuccessUrl(): string {
    return this.#checkoutSuccessUrl;
  }

  public get checkoutCancelUrl(): string {
    return this.#checkoutCancelUrl;
  }

  public get portalReturnUrl(): string {
    return this.#portalReturnUrl;
  }

  /** Stripe mode is part of the kernel-wide request/webhook contract. */
  public get testMode(): boolean {
    return this.#secretKey.startsWith("sk_test_");
  }

  public constructEvent(
    payload: Buffer | string,
    signature: string,
  ): Record<string, unknown> {
    const event: unknown = this.#stripe.webhooks.constructEvent(
      payload,
      signature,
      this.#webhookSecret,
    );
    const sanitized = stripUntrustedInternalFields(event);
    if (!isPlainRecord(sanitized)) {
      throw new Error("Stripe returned a non-object Event");
    }
    return sanitized;
  }

  /** Resolve every mutable Stripe reference before a caller opens a DB transaction. */
  public async prepareEvent(
    event: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const cloned = cloneRemote(event);
    if (!isPlainRecord(cloned)) {
      throw new TypeError("Stripe Event must be an object");
    }
    const prepared = cloned;
    const data = prepared["data"];
    if (!isPlainRecord(data)) {
      return prepared;
    }
    const object = data["object"];
    if (!isPlainRecord(object) || asStripeId(object["id"]) === undefined) {
      return prepared;
    }
    const eventType = prepared["type"];
    if (eventType === "invoice.paid") {
      await this.#prepareInvoiceLines(object);
      const invoiceId = asStripeId(object["id"]);
      if (
        invoiceId !== undefined &&
        (await this.#unsupportedInvoicePaymentCollection(invoiceId))
      ) {
        object["_unsupported_invoice_payment_shape"] = true;
      }
    } else if (eventType === "customer.subscription.updated") {
      const items = object["items"];
      const rawItems = isPlainRecord(items) ? items["data"] : undefined;
      if (isUnknownArray(rawItems)) {
        await this.#resolveLookups(rawItems);
      }
    } else if (
      eventType === "charge.refunded" ||
      eventType === "charge.dispute.created"
    ) {
      await this.#prepareChargeEvent(object, eventType);
    }
    return prepared;
  }

  async #prepareChargeEvent(
    object: Record<string, unknown>,
    eventType: "charge.refunded" | "charge.dispute.created",
  ): Promise<void> {
    let charge: Record<string, unknown>;
    if (eventType === "charge.dispute.created") {
      const chargeId = asStripeId(object["charge"]);
      if (chargeId === undefined) {
        return;
      }
      charge = stripeObject(await this.#stripe.charges.retrieve(chargeId));
      if (asStripeId(charge["id"]) !== chargeId) {
        throw new Error("Stripe returned a conflicting Charge identity");
      }
      object["_resolved_charge"] = charge;
    } else {
      charge = object;
    }

    let invoiceId = asStripeId(charge["invoice"]);
    const paymentIntentId = asStripeId(charge["payment_intent"]);
    if (paymentIntentId !== undefined) {
      const paymentIntent = stripeObject(
        await this.#stripe.paymentIntents.retrieve(paymentIntentId),
      );
      if (asStripeId(paymentIntent["id"]) !== paymentIntentId) {
        throw new Error("Stripe returned a conflicting PaymentIntent identity");
      }
      object["_resolved_payment_intent"] = paymentIntent;
      const metadata = paymentIntent["metadata"];
      if (
        invoiceId === undefined &&
        isPlainRecord(metadata) &&
        metadata["billing_kind"] === "credit_pack"
      ) {
        return;
      }
    }

    if (invoiceId === undefined && paymentIntentId !== undefined) {
      const mappings = collection(
        await this.#stripe.invoicePayments.list({
          payment: { type: "payment_intent", payment_intent: paymentIntentId },
          limit: 2,
        }),
        "InvoicePayment",
      );
      if (mappings.hasMore || mappings.data.length > 1) {
        object["_unsupported_invoice_payment_shape"] = true;
        return;
      }
      const rawPayment = mappings.data[0];
      if (rawPayment === undefined) {
        throw new Error(
          "Stripe has not exposed the InvoicePayment mapping yet",
        );
      }
      const payment = stripeObject(rawPayment);
      const details = payment["payment"];
      if (
        !isPlainRecord(details) ||
        details["type"] !== "payment_intent" ||
        asStripeId(details["payment_intent"]) !== paymentIntentId
      ) {
        throw new Error("Stripe returned a conflicting InvoicePayment mapping");
      }
      invoiceId = asStripeId(payment["invoice"]);
      if (invoiceId === undefined) {
        throw new Error(
          "Stripe InvoicePayment mapping has no Invoice identity",
        );
      }
    }

    if (invoiceId !== undefined) {
      object["_resolved_invoice_id"] = invoiceId;
      if (
        await this.#unsupportedInvoicePaymentCollection(
          invoiceId,
          paymentIntentId,
        )
      ) {
        object["_unsupported_invoice_payment_shape"] = true;
      }
    }
  }

  async #unsupportedInvoicePaymentCollection(
    invoiceId: string,
    expectedPaymentIntentId?: string,
  ): Promise<boolean> {
    const payments = collection(
      await this.#stripe.invoicePayments.list({
        invoice: invoiceId,
        status: "paid",
        limit: 2,
      }),
      "InvoicePayment",
    );
    if (payments.hasMore || payments.data.length > 1) {
      return true;
    }
    const rawPayment = payments.data[0];
    if (rawPayment === undefined) {
      throw new Error("Stripe has not exposed the InvoicePayment mapping yet");
    }
    const payment = stripeObject(rawPayment);
    const paymentId = asStripeId(payment["id"]);
    const mappedInvoiceId = asStripeId(payment["invoice"]);
    const details = payment["payment"];
    if (mappedInvoiceId !== undefined && mappedInvoiceId !== invoiceId) {
      throw new Error("Stripe returned a conflicting InvoicePayment mapping");
    }
    if (!isPlainRecord(details)) {
      return true;
    }
    const paymentIntentId = asStripeId(details["payment_intent"]);
    if (
      paymentId === undefined ||
      mappedInvoiceId === undefined ||
      payment["status"] !== "paid" ||
      details["type"] !== "payment_intent" ||
      paymentIntentId === undefined
    ) {
      return true;
    }
    if (
      expectedPaymentIntentId !== undefined &&
      paymentIntentId !== expectedPaymentIntentId
    ) {
      throw new Error(
        "Stripe returned a conflicting InvoicePayment payment identity",
      );
    }
    return false;
  }

  async #prepareInvoiceLines(invoice: Record<string, unknown>): Promise<void> {
    const container = invoice["lines"];
    if (!isPlainRecord(container) || !isUnknownArray(container["data"])) {
      return;
    }
    let lines: unknown[] = [...container["data"]];
    if (container["has_more"]) {
      const invoiceId = asStripeId(invoice["id"]);
      if (invoiceId === undefined) {
        return;
      }
      try {
        lines = await this.#listInvoiceLines(invoiceId);
      } catch (error: unknown) {
        if (!(error instanceof UnsupportedStripeShapeError)) {
          throw error;
        }
        invoice["_preparation_error"] = error.message;
        invoice["lines"] = {
          ...container,
          has_more: true,
          _all_lines_loaded: false,
        };
        return;
      }
    }
    await this.#resolveLookups(lines);
    invoice["lines"] = {
      ...container,
      data: lines,
      has_more: false,
      _all_lines_loaded: true,
    };
  }

  async #listInvoiceLines(
    invoiceId: string,
  ): Promise<Record<string, unknown>[]> {
    const lines: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let startingAfter: string | undefined;
    for (;;) {
      const rawPage: unknown = await this.#stripe.invoices.listLineItems(
        invoiceId,
        {
          limit: 100,
          ...(startingAfter === undefined
            ? {}
            : { starting_after: startingAfter }),
        },
      );
      let page;
      try {
        page = collection(rawPage, "Invoice line page");
      } catch {
        throw new UnsupportedStripeShapeError(
          "Stripe Invoice line page has an invalid shape",
        );
      }
      const pageLines: Record<string, unknown>[] = [];
      for (const rawLine of page.data) {
        let line: Record<string, unknown>;
        try {
          line = stripeObject(rawLine);
        } catch {
          throw new UnsupportedStripeShapeError(
            "Stripe Invoice line page contains a non-object line",
          );
        }
        const lineId = asStripeId(line["id"]);
        if (lineId === undefined || seen.has(lineId)) {
          throw new UnsupportedStripeShapeError(
            "Stripe Invoice line pagination contains missing or duplicate identity",
          );
        }
        seen.add(lineId);
        pageLines.push(line);
      }
      lines.push(...pageLines);
      if (lines.length > 1000) {
        throw new UnsupportedStripeShapeError(
          "Invoice has more than the supported 1000 lines",
        );
      }
      if (!page.hasMore) {
        return lines;
      }
      const nextCursor = asStripeId(pageLines.at(-1)?.["id"]);
      if (
        pageLines.length === 0 ||
        nextCursor === undefined ||
        nextCursor === startingAfter
      ) {
        throw new UnsupportedStripeShapeError(
          "Stripe Invoice line pagination did not advance",
        );
      }
      startingAfter = nextCursor;
    }
  }

  async #resolveLookups(lines: readonly unknown[]): Promise<void> {
    const unresolved = new Map<string, Record<string, unknown>[]>();
    for (const rawLine of lines) {
      if (!isPlainRecord(rawLine)) {
        continue;
      }
      const resolvedPrice = rawLine["_resolved_price"];
      if (isPlainRecord(resolvedPrice)) {
        const lookup = resolvedPrice["lookup_key"];
        if (typeof lookup === "string" && lookup.length > 0) {
          rawLine["_resolved_lookup_key"] = lookup;
        }
        continue;
      }
      const priceId = linePriceId(rawLine);
      if (priceId !== undefined) {
        const owners = unresolved.get(priceId) ?? [];
        owners.push(rawLine);
        unresolved.set(priceId, owners);
      }
    }
    const entries = [...unresolved.entries()];
    for (let offset = 0; offset < entries.length; offset += 8) {
      const batch = entries.slice(offset, offset + 8);
      const resolved = await Promise.all(
        batch.map(async ([priceId, owners]) => {
          const price = stripeObject(
            await this.#stripe.prices.retrieve(priceId, {
              expand: ["product", "currency_options"],
            }),
          );
          return { owners, price };
        }),
      );
      for (const { owners, price } of resolved) {
        const lookup = price["lookup_key"];
        for (const owner of owners) {
          owner["_resolved_price"] = price;
          owner["_resolved_lookup_key"] =
            typeof lookup === "string" && lookup.length > 0 ? lookup : null;
        }
      }
    }
  }

  public async subscriptionObject(
    subscriptionIdValue: string,
    options: { readonly expand?: readonly string[] } = {},
  ): Promise<Record<string, unknown>> {
    const subscriptionIdText = requiredText(
      subscriptionIdValue,
      "Subscription id",
      255,
    );
    if (!subscriptionIdText.startsWith("sub_")) {
      throw new TypeError("Subscription id must start with sub_");
    }
    const subscription = stripeObject(
      await this.#stripe.subscriptions.retrieve(
        subscriptionIdText,
        options.expand === undefined ? {} : { expand: [...options.expand] },
      ),
    );
    if (asStripeId(subscription["id"]) !== subscriptionIdText) {
      throw new Error("Stripe returned a different Subscription identity");
    }
    this.#assertMode(subscription, "Subscription");
    const items = subscription["items"];
    const rawItems = isPlainRecord(items) ? items["data"] : undefined;
    if (isUnknownArray(rawItems)) {
      await this.#resolveLookups(rawItems);
    }
    return subscription;
  }

  public async subscriptionSnapshot(
    subscriptionIdValue: string,
  ): Promise<SubscriptionSnapshot> {
    const subscription = await this.subscriptionObject(subscriptionIdValue);
    const container = subscription["items"];
    const rawItems = isPlainRecord(container) ? container["data"] : undefined;
    const complete =
      isPlainRecord(container) &&
      (container["has_more"] === undefined ||
        container["has_more"] === null ||
        container["has_more"] === false) &&
      isUnknownArray(rawItems) &&
      rawItems.length === 1 &&
      isPlainRecord(rawItems[0]);
    const item: Record<string, unknown> | undefined =
      complete && isUnknownArray(rawItems) && isPlainRecord(rawItems[0])
        ? rawItems[0]
        : undefined;
    const status = subscription["status"];
    if (item === undefined) {
      return {
        subscriptionId: subscriptionIdValue,
        status: typeof status === "string" ? status : "",
        itemsComplete: false,
      };
    }
    const lookup = lineLookup(item);
    const periodRaw = Object.hasOwn(item, "current_period_end")
      ? item["current_period_end"]
      : subscription["current_period_end"];
    const period = remoteNonnegativeInteger(periodRaw);
    let currentPeriodEnd: PgTimestamp | undefined;
    try {
      currentPeriodEnd =
        period === undefined ? undefined : epochTimestamp(period);
    } catch {
      currentPeriodEnd = undefined;
    }
    const resolved = item["_resolved_price"];
    const quantity = remoteNonnegativeInteger(item["quantity"]);
    return {
      subscriptionId: subscriptionIdValue,
      status: typeof status === "string" ? status : "",
      ...(lookup === undefined ? {} : { lookupKey: lookup }),
      ...(currentPeriodEnd === undefined ? {} : { currentPeriodEnd }),
      ...(isPlainRecord(resolved) ? { resolvedPrice: { ...resolved } } : {}),
      ...(quantity === undefined ? {} : { quantity }),
      itemsComplete: true,
    };
  }

  public async checkoutSessionObject(
    sessionIdValue: string,
  ): Promise<Record<string, unknown>> {
    const sessionId = requiredText(sessionIdValue, "Checkout Session id", 255);
    if (!sessionId.startsWith("cs_")) {
      throw new TypeError("Checkout Session id must start with cs_");
    }
    const session = stripeObject(
      await this.#stripe.checkout.sessions.retrieve(sessionId),
    );
    if (asStripeId(session["id"]) !== sessionId) {
      throw new Error("Stripe returned a different Checkout Session identity");
    }
    this.#assertMode(session, "Checkout Session");
    return session;
  }

  public async paymentIntentObject(
    paymentIntentIdValue: string,
  ): Promise<Record<string, unknown>> {
    const paymentIntentId = requiredText(
      paymentIntentIdValue,
      "PaymentIntent id",
      255,
    );
    if (!paymentIntentId.startsWith("pi_")) {
      throw new TypeError("PaymentIntent id must start with pi_");
    }
    const paymentIntent = stripeObject(
      await this.#stripe.paymentIntents.retrieve(paymentIntentId),
    );
    if (asStripeId(paymentIntent["id"]) !== paymentIntentId) {
      throw new Error("Stripe returned a different PaymentIntent identity");
    }
    this.#assertMode(paymentIntent, "PaymentIntent");
    return paymentIntent;
  }

  public async chargeObject(
    chargeIdValue: string,
  ): Promise<Record<string, unknown>> {
    const chargeId = requiredText(chargeIdValue, "Charge id", 255);
    if (!chargeId.startsWith("ch_")) {
      throw new TypeError("Charge id must start with ch_");
    }
    const charge = stripeObject(await this.#stripe.charges.retrieve(chargeId));
    if (asStripeId(charge["id"]) !== chargeId) {
      throw new Error("Stripe returned a different Charge identity");
    }
    this.#assertMode(charge, "Charge");
    return charge;
  }

  #assertMode(object: StripeObject, field: string): void {
    if (
      typeof object["livemode"] !== "boolean" ||
      object["livemode"] !== this.#secretKey.startsWith("sk_live_")
    ) {
      throw new Error(`Stripe ${field} mode does not match the configured key`);
    }
  }

  public async latestPaidInvoiceEvent(
    subscriptionIdValue: string,
  ): Promise<Record<string, unknown> | undefined> {
    const rawInvoices = await this.#stripe.invoices.list({
      subscription: subscriptionIdValue,
      status: "paid",
      limit: 1,
    });
    const invoices = listData(rawInvoices, "Invoice");
    const first = invoices[0];
    if (first === undefined) {
      return undefined;
    }
    const invoice = stripeObject(first);
    const invoiceId = asStripeId(invoice["id"]);
    if (invoiceId === undefined) {
      throw new Error("Stripe returned a paid Invoice without stable identity");
    }
    if (subscriptionId(invoice) !== subscriptionIdValue) {
      throw new Error(
        "Stripe returned a paid Invoice for a different Subscription",
      );
    }
    if (
      invoice["status"] !== undefined &&
      invoice["status"] !== null &&
      invoice["status"] !== "paid"
    ) {
      throw new Error("Stripe returned an Invoice that is not paid");
    }
    this.#assertMode(invoice, "paid Invoice");
    const transitions = invoice["status_transitions"];
    const paidAt = isPlainRecord(transitions)
      ? transitions["paid_at"]
      : undefined;
    const created =
      remoteNonnegativeInteger(paidAt) ??
      remoteNonnegativeInteger(invoice["created"]);
    if (created === undefined) {
      throw new Error("Stripe paid Invoice has an invalid creation timestamp");
    }
    const createdNumber = bigintToSafeNumber(
      created,
      "Invoice creation timestamp",
    );
    return this.prepareEvent({
      id: `reconcile:${invoiceId}`,
      object: "event",
      type: "invoice.paid",
      created: createdNumber,
      livemode: invoice["livemode"],
      _remote_verified: true,
      data: { object: invoice },
    });
  }

  async #activePrice(lookupKey: string): Promise<Record<string, unknown>> {
    const rawPrices = await this.#stripe.prices.list({
      lookup_keys: [lookupKey],
      active: true,
      limit: 2,
      expand: ["data.currency_options", "data.product"],
    });
    const prices = listData(rawPrices, "Price");
    if (prices.length !== 1 || rawPrices.has_more) {
      throw new CheckoutCreationRejected(
        `expected exactly one active Stripe price for ${JSON.stringify(lookupKey)}`,
      );
    }
    return stripeObject(prices[0]);
  }

  public async prepareCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<CheckoutRequestSnapshot> {
    if (input.interval !== input.expectedInterval) {
      throw new CheckoutCreationRejected(
        "Checkout interval does not match the catalog expectation",
      );
    }
    const expectedAmount = bigintToSafeNumber(
      input.expectedUnitAmount,
      "expected unit amount",
    );
    const price = await this.#activePrice(input.lookupKey);
    if (
      !catalogPriceMatches(price, {
        expectedCurrency: input.expectedCurrency,
        expectedUnitAmount: expectedAmount,
        expectedInterval: input.expectedInterval,
        expectedProductLine: this.#productLine,
        expectedPlanKey: input.planKey,
        expectedLookupKey: input.lookupKey,
      })
    ) {
      throw new CheckoutCreationRejected(
        `Stripe price ${JSON.stringify(input.lookupKey)} drifted from the catalog`,
      );
    }
    const priceId = requiredText(asStripeId(price["id"]), "Price id", 255);
    return buildSubscriptionCheckoutRequestSnapshot({
      accountId: input.accountId,
      claimToken: input.claimToken,
      ...(input.customerId === undefined
        ? {}
        : { customerId: input.customerId }),
      priceId,
      lookupKey: input.lookupKey,
      currency: input.expectedCurrency,
      unitAmount: input.expectedUnitAmount,
      interval: input.expectedInterval,
      planKey: input.planKey,
      productLine: this.#productLine,
      successUrl: this.#checkoutSuccessUrlFor(input.planKey, input.interval),
      cancelUrl: this.#checkoutCancelUrl,
      expiresAt: input.expiresAtEpoch,
      requestApiVersion: this.#apiVersion,
    });
  }

  public async prepareCreditPackCheckoutSession(
    input: CreateCreditPackCheckoutSessionInput,
  ): Promise<CheckoutRequestSnapshot> {
    const expectedAmount = bigintToSafeNumber(
      input.expectedUnitAmount,
      "expected unit amount",
    );
    if (!Number.isSafeInteger(input.expiresDays) || input.expiresDays <= 0) {
      throw new RangeError("expiresDays must be a positive safe integer");
    }
    const price = await this.#activePrice(input.lookupKey);
    if (
      !catalogOneTimePriceMatches(price, {
        expectedCurrency: input.expectedCurrency,
        expectedUnitAmount: expectedAmount,
        expectedProductLine: this.#productLine,
        expectedPackKey: input.packKey,
        expectedLookupKey: input.lookupKey,
      })
    ) {
      throw new CheckoutCreationRejected(
        `Stripe price ${JSON.stringify(input.lookupKey)} drifted from the catalog`,
      );
    }
    const priceId = requiredText(asStripeId(price["id"]), "Price id", 255);
    return buildCreditPackCheckoutRequestSnapshot({
      orderId: input.orderId,
      accountId: input.accountId,
      ...(input.customerId === undefined
        ? {}
        : { customerId: input.customerId }),
      priceId,
      lookupKey: input.lookupKey,
      currency: input.expectedCurrency,
      unitAmount: input.expectedUnitAmount,
      packKey: input.packKey,
      packCredits: input.packCredits,
      expiresDays: input.expiresDays,
      productLine: this.#productLine,
      successUrl: this.#creditPackSuccessUrl(input.packKey),
      cancelUrl: this.#checkoutCancelUrl,
      expiresAt: input.expiresAtEpoch,
      requestApiVersion: this.#apiVersion,
    });
  }

  public async createCheckoutSessionFromSnapshot(
    rawSnapshot: unknown,
  ): Promise<readonly [sessionId: string, sessionUrl: string]> {
    const snapshot = validateCheckoutRequestSnapshot(rawSnapshot);
    const session = stripeObject(
      await this.#stripe.checkout.sessions.create(
        snapshot.params as Stripe.Checkout.SessionCreateParams,
        {
          idempotencyKey: snapshot.idempotency_key,
          apiVersion: snapshot.request_api_version,
        },
      ),
    );
    return [
      requiredText(session["id"], "Checkout Session id", 255),
      requiredHttpsUrl(session["url"], "Checkout Session URL"),
    ];
  }

  public async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<readonly [sessionId: string, sessionUrl: string]> {
    return this.createCheckoutSessionFromSnapshot(
      await this.prepareCheckoutSession(input),
    );
  }

  public async createCreditPackCheckoutSession(
    input: CreateCreditPackCheckoutSessionInput,
  ): Promise<readonly [sessionId: string, sessionUrl: string]> {
    return this.createCheckoutSessionFromSnapshot(
      await this.prepareCreditPackCheckoutSession(input),
    );
  }

  #checkoutSuccessUrlFor(planKey: string, interval: BillingInterval): string {
    const query = new URLSearchParams({
      expected_plan: planKey,
      expected_interval: interval,
      checkout_session_id: "{CHECKOUT_SESSION_ID}",
    });
    return `${this.#checkoutSuccessUrl}?${query.toString()}`.replace(
      "%7BCHECKOUT_SESSION_ID%7D",
      "{CHECKOUT_SESSION_ID}",
    );
  }

  #creditPackSuccessUrl(packKey: string): string {
    const query = new URLSearchParams({
      expected_credit_pack: packKey,
      checkout_session_id: "{CHECKOUT_SESSION_ID}",
    });
    return `${this.#checkoutSuccessUrl}?${query.toString()}`.replace(
      "%7BCHECKOUT_SESSION_ID%7D",
      "{CHECKOUT_SESSION_ID}",
    );
  }

  public async createPortalSession(input: {
    readonly customerId: string;
    readonly idempotencyKey: string;
  }): Promise<readonly [sessionId: string, sessionUrl: string]> {
    const configurationId = this.#portalConfigurationId;
    if (!portalConfigurationIdIsUsable(configurationId)) {
      throw new PortalConfigurationUnavailableError(
        "Stripe Portal configuration is missing or invalid",
      );
    }
    const config = stripeObject(
      await this.#stripe.billingPortal.configurations.retrieve(configurationId),
    );
    if (
      !portalConfigurationIsSafe(config, {
        expectedLivemode: this.#secretKey.startsWith("sk_live_"),
        expectedProductLine: this.#productLine,
      })
    ) {
      throw new Error(
        "Portal configuration drifted from the server safety policy",
      );
    }
    const session = stripeObject(
      await this.#stripe.billingPortal.sessions.create(
        {
          customer: input.customerId,
          configuration: configurationId,
          return_url: this.#portalReturnUrl,
        },
        { idempotencyKey: input.idempotencyKey },
      ),
    );
    const sessionId = requiredText(session["id"], "Portal Session id", 255);
    const sessionUrl = requiredHttpsUrl(session["url"], "Portal Session URL");
    if (
      !sessionId.startsWith("bps_") ||
      session["object"] !== "billing_portal.session" ||
      asStripeId(session["customer"]) !== input.customerId ||
      asStripeId(session["configuration"]) !== configurationId ||
      session["return_url"] !== this.#portalReturnUrl ||
      typeof session["livemode"] !== "boolean" ||
      session["livemode"] !== this.#secretKey.startsWith("sk_live_")
    ) {
      throw new Error(
        "Stripe returned a Portal Session outside the requested contract",
      );
    }
    return [sessionId, sessionUrl];
  }

  public async preparePlanChange(
    input: PreparePlanChangeInput,
  ): Promise<PlanChangeContext> {
    const targetAmount = bigintToSafeNumber(
      input.expectedUnitAmount,
      "target unit amount",
    );
    const sourceAmount = bigintToSafeNumber(
      input.expectedSourceUnitAmount,
      "source unit amount",
    );
    let targetPrice: Record<string, unknown>;
    try {
      targetPrice = await this.#activePrice(input.targetLookupKey);
    } catch (error: unknown) {
      if (error instanceof CheckoutCreationRejected) {
        throw new Error(error.message);
      }
      throw error;
    }
    if (
      !catalogPriceMatches(targetPrice, {
        expectedCurrency: input.expectedCurrency,
        expectedUnitAmount: targetAmount,
        expectedInterval: input.targetInterval,
        expectedProductLine: this.#productLine,
        expectedPlanKey: input.expectedPlanKey,
        expectedLookupKey: input.targetLookupKey,
      })
    ) {
      throw new Error(
        `Stripe price ${JSON.stringify(input.targetLookupKey)} drifted from the catalog`,
      );
    }
    const subscription = await this.subscriptionObject(input.subscriptionId, {
      expand: ["latest_invoice.confirmation_secret"],
    });
    const container = subscription["items"];
    const rawItems = isPlainRecord(container) ? container["data"] : undefined;
    if (
      !isPlainRecord(container) ||
      !(
        container["has_more"] === undefined ||
        container["has_more"] === null ||
        container["has_more"] === false
      ) ||
      !isUnknownArray(rawItems) ||
      rawItems.length !== 1 ||
      !isPlainRecord(rawItems[0])
    ) {
      throw new Error("subscription must contain exactly one item object");
    }
    const item = rawItems[0];
    if (remoteInteger(item["quantity"]) !== 1n) {
      throw new Error("subscription item quantity must be exactly one");
    }
    const subscriptionItemId = requiredText(
      asStripeId(item["id"]),
      "Subscription item id",
      255,
    );
    const currentLookup = lineLookup(item);
    const currentPriceId = linePriceId(item);
    const currentPrice = item["_resolved_price"];
    if (
      currentLookup === undefined ||
      currentPriceId === undefined ||
      !isPlainRecord(currentPrice) ||
      !catalogPriceMatches(currentPrice, {
        expectedCurrency: input.expectedSourceCurrency,
        expectedUnitAmount: sourceAmount,
        expectedInterval: input.sourceInterval,
        expectedProductLine: this.#productLine,
        expectedPlanKey: input.expectedSourcePlanKey,
        expectedLookupKey: input.expectedSourceLookupKey,
        expectedPriceId: currentPriceId,
        requireActive: false,
      })
    ) {
      throw new Error(
        "subscription item Price drifted from the authorized source plan",
      );
    }
    const startRaw = Object.hasOwn(item, "current_period_start")
      ? item["current_period_start"]
      : subscription["current_period_start"];
    const endRaw = Object.hasOwn(item, "current_period_end")
      ? item["current_period_end"]
      : subscription["current_period_end"];
    const currentPeriodStart = remoteNonnegativeInteger(startRaw);
    const currentPeriodEnd = remoteNonnegativeInteger(endRaw);
    if (currentPeriodStart === undefined || currentPeriodEnd === undefined) {
      throw new Error("subscription item period must use integer timestamps");
    }
    if (
      currentPeriodEnd <= currentPeriodStart ||
      currentPeriodEnd > MAX_STRIPE_TIMESTAMP
    ) {
      throw new Error("subscription item period is invalid");
    }
    const scheduleRaw = subscription["schedule"];
    const scheduleId =
      scheduleRaw === undefined || scheduleRaw === null
        ? null
        : (asStripeId(scheduleRaw) ?? null);
    if (
      scheduleRaw !== undefined &&
      scheduleRaw !== null &&
      scheduleId === null
    ) {
      throw new Error(
        "Stripe returned an invalid Subscription Schedule identity",
      );
    }
    const status = subscription["status"];
    if (typeof status !== "string" || !SUBSCRIPTION_STATUSES.has(status)) {
      throw new Error("Stripe returned an unsupported Subscription status");
    }
    const cancelAtPeriodEnd = subscription["cancel_at_period_end"];
    if (typeof cancelAtPeriodEnd !== "boolean") {
      throw new Error("Stripe returned an invalid cancel_at_period_end value");
    }
    const pendingRaw = subscription["pending_update"];
    const pending =
      pendingRaw === undefined || pendingRaw === null
        ? {}
        : isPlainRecord(pendingRaw)
          ? pendingRaw
          : undefined;
    if (pending === undefined) {
      throw new Error("Stripe returned an invalid pending_update shape");
    }
    const pendingActive = recordHasValues(pending);
    const pendingExpiresAt =
      pending["expires_at"] === undefined || pending["expires_at"] === null
        ? null
        : (remoteNonnegativeInteger(pending["expires_at"]) ?? null);
    if (pendingActive && pendingExpiresAt === null) {
      throw new Error("Stripe pending_update is missing an integer expiry");
    }
    const latestRaw = subscription["latest_invoice"];
    const latest =
      latestRaw === undefined || latestRaw === null
        ? {}
        : isPlainRecord(latestRaw)
          ? latestRaw
          : undefined;
    if (latest === undefined) {
      throw new Error("Stripe did not expand the latest Invoice");
    }
    const confirmationRaw = latest["confirmation_secret"];
    const confirmation =
      confirmationRaw === undefined || confirmationRaw === null
        ? {}
        : isPlainRecord(confirmationRaw)
          ? confirmationRaw
          : undefined;
    if (confirmation === undefined) {
      throw new Error("Stripe returned an invalid confirmation_secret shape");
    }
    const clientSecret =
      confirmation["client_secret"] === undefined ||
      confirmation["client_secret"] === null
        ? null
        : requiredText(
            confirmation["client_secret"],
            "payment client secret",
            512,
          );
    const recoveryUrl =
      latest["hosted_invoice_url"] === undefined ||
      latest["hosted_invoice_url"] === null
        ? null
        : requiredHttpsUrl(latest["hosted_invoice_url"], "hosted Invoice URL");
    const targetPriceId = requiredText(
      asStripeId(targetPrice["id"]),
      "target Price id",
      255,
    );
    return {
      subscriptionId: input.subscriptionId,
      subscriptionItemId,
      currentPriceId,
      currentLookupKey: currentLookup,
      targetPriceId,
      targetInterval: input.targetInterval,
      currentPeriodStart,
      currentPeriodEnd,
      scheduleId,
      subscriptionStatus: status,
      cancelAtPeriodEnd,
      pendingUpdate: pendingActive,
      pendingExpiresAt,
      recoveryUrl,
      clientSecret,
    };
  }

  public async previewImmediatePlanChange(
    context: PlanChangeContext,
    options: {
      readonly policy?: TransitionPolicy;
      readonly prorationDate?: bigint;
    } = {},
  ): Promise<PlanChangeEstimate> {
    const policy = options.policy ?? "full_period_reset";
    const subscriptionDetails: Record<string, unknown> = {
      items: [{ id: context.subscriptionItemId, price: context.targetPriceId }],
    };
    if (policy === "full_period_reset") {
      subscriptionDetails["billing_cycle_anchor"] = "now";
      subscriptionDetails["proration_behavior"] = "none";
    } else {
      if (options.prorationDate === undefined) {
        throw new Error("prorated_delta requires a fixed prorationDate");
      }
      subscriptionDetails["proration_behavior"] = "always_invoice";
      subscriptionDetails["proration_date"] = bigintToSafeNumber(
        options.prorationDate,
        "prorationDate",
      );
    }
    const raw = stripeObject(
      await this.#stripe.invoices.createPreview({
        subscription: context.subscriptionId,
        subscription_details:
          subscriptionDetails as Stripe.InvoiceCreatePreviewParams.SubscriptionDetails,
      }),
    );
    return this.#planChangeEstimate(
      raw,
      context,
      policy,
      options.prorationDate,
    );
  }

  #planChangeEstimate(
    raw: Record<string, unknown>,
    context: PlanChangeContext,
    policy: TransitionPolicy,
    prorationDate: bigint | undefined,
  ): PlanChangeEstimate {
    const container = raw["lines"];
    const rawLines = isPlainRecord(container) ? container["data"] : undefined;
    const validLines =
      isUnknownArray(rawLines) && rawLines.every((line) => isPlainRecord(line));
    const lines: Record<string, unknown>[] =
      validLines && isUnknownArray(rawLines)
        ? rawLines.filter((line): line is Record<string, unknown> =>
            isPlainRecord(line),
          )
        : [];
    const hasMore =
      !validLines ||
      !isPlainRecord(container) ||
      Boolean(container["has_more"]);
    const invoiceCurrency =
      typeof raw["currency"] === "string" ? raw["currency"].toLowerCase() : "";
    const totalValue = remoteInteger(raw["total"]);
    const amountDueValue = remoteInteger(raw["amount_due"]);
    const subtotalValue = remoteInteger(raw["subtotal"]);
    const numericTotalsValid =
      totalValue !== undefined &&
      amountDueValue !== undefined &&
      subtotalValue !== undefined;
    const total = totalValue ?? 0n;
    const amountDue = amountDueValue ?? 0n;
    const subtotal = subtotalValue ?? 0n;
    const targetNonProration = lines.filter(
      (line) =>
        !lineIsProration(line) && linePriceId(line) === context.targetPriceId,
    );
    const startingBalanceValue = Object.hasOwn(raw, "starting_balance")
      ? remoteInteger(raw["starting_balance"])
      : 0n;
    const endingBalanceValue = Object.hasOwn(raw, "ending_balance")
      ? remoteInteger(raw["ending_balance"])
      : 0n;
    const startingBalance = startingBalanceValue ?? 0n;
    const endingBalance = endingBalanceValue ?? 0n;
    const sourceProrations = lines.filter((line) => {
      const amount = remoteInteger(line["amount"]);
      return (
        lineIsProration(line) &&
        linePriceId(line) === context.currentPriceId &&
        amount !== undefined &&
        amount < 0n
      );
    });
    const targetProrations = lines.filter((line) => {
      const amount = remoteInteger(line["amount"]);
      return (
        lineIsProration(line) &&
        linePriceId(line) === context.targetPriceId &&
        amount !== undefined &&
        amount > 0n
      );
    });
    const prorationCredit = lines.reduce((sum, line) => {
      const amount = remoteInteger(line["amount"]);
      return lineIsProration(line) && amount !== undefined && amount < 0n
        ? sum - amount
        : sum;
    }, 0n);

    const array = (value: unknown): readonly unknown[] =>
      isUnknownArray(value) ? value : [];
    const sumAmounts = (items: readonly unknown[]): bigint =>
      items.reduce<bigint>((sum, item) => {
        const amount = isPlainRecord(item)
          ? remoteInteger(item["amount"])
          : undefined;
        return amount === undefined ? sum : sum + amount;
      }, 0n);
    const taxItems: unknown[] = [
      ...array(raw["total_tax_amounts"]),
      ...array(raw["total_taxes"]),
    ];
    const discountItems: unknown[] = [...array(raw["total_discount_amounts"])];
    let unsupportedLineAdjustment = false;
    for (const line of lines) {
      taxItems.push(...array(line["tax_amounts"]), ...array(line["taxes"]));
      discountItems.push(...array(line["discount_amounts"]));
      for (const item of array(line["pretax_credit_amounts"])) {
        if (isPlainRecord(item)) {
          const amount = remoteInteger(item["amount"]);
          if (amount === undefined || amount !== 0n) {
            unsupportedLineAdjustment = true;
          }
        }
      }
    }
    const taxAmount = sumAmounts(taxItems);
    let discountAmount = sumAmounts(discountItems);
    // Stripe serializes the supported no-discount Dahlia shape as `discounts:
    // []`. Unlike Python, an empty array is truthy in JavaScript, so testing the
    // container directly would misclassify every current test-mode preview as
    // discounted and defer otherwise safe upgrades. Non-empty participation is
    // still represented by a sentinel when its computed amount is zero, while
    // malformed containers remain fail-closed in hasUnsupportedInvoiceAdjustments.
    if (
      isUnknownArray(raw["discounts"]) &&
      raw["discounts"].length > 0 &&
      discountAmount === 0n
    ) {
      discountAmount = 1n;
    }
    const preCreditNotes = Object.hasOwn(raw, "pre_payment_credit_notes_amount")
      ? remoteInteger(raw["pre_payment_credit_notes_amount"])
      : 0n;
    const postCreditNotes = Object.hasOwn(
      raw,
      "post_payment_credit_notes_amount",
    )
      ? remoteInteger(raw["post_payment_credit_notes_amount"])
      : 0n;
    const commonSafe =
      !hasMore &&
      numericTotalsValid &&
      [
        startingBalanceValue,
        endingBalanceValue,
        preCreditNotes,
        postCreditNotes,
      ].every((value) => value === 0n) &&
      taxAmount === 0n &&
      discountAmount === 0n &&
      !unsupportedLineAdjustment &&
      !hasUnsupportedInvoiceAdjustments(raw, lines);

    let periodStart: bigint | null = null;
    let periodEnd: bigint | null = null;
    let sourceProrationAmount = 0n;
    let targetProrationAmount = 0n;
    let safeInvoiceShape: boolean;
    if (policy === "prorated_delta") {
      if (sourceProrations.length === 1 && targetProrations.length === 1) {
        const sourcePeriod = sourceProrations[0]?.["period"];
        const targetPeriod = targetProrations[0]?.["period"];
        if (
          isPlainRecord(sourcePeriod) &&
          isPlainRecord(targetPeriod) &&
          deepEqual(sourcePeriod, targetPeriod)
        ) {
          periodStart = remoteNonnegativeInteger(targetPeriod["start"]) ?? null;
          periodEnd = remoteNonnegativeInteger(targetPeriod["end"]) ?? null;
        }
      }
      const sourceAmount =
        sourceProrations.length === 1
          ? remoteInteger(sourceProrations[0]?.["amount"])
          : undefined;
      const targetAmount =
        targetProrations.length === 1
          ? remoteInteger(targetProrations[0]?.["amount"])
          : undefined;
      sourceProrationAmount = sourceAmount ?? 0n;
      targetProrationAmount = targetAmount ?? 0n;
      safeInvoiceShape =
        commonSafe &&
        lines.length === 2 &&
        sourceProrations.length === 1 &&
        targetProrations.length === 1 &&
        lines.every(
          (line) => typeof line["id"] === "string" && line["id"].length > 0,
        ) &&
        lines.every((line) => remoteInteger(line["quantity"]) === 1n) &&
        sourceAmount !== undefined &&
        targetAmount !== undefined &&
        sourceProrationAmount < 0n &&
        targetProrationAmount > -sourceProrationAmount &&
        sourceProrationAmount + targetProrationAmount === total &&
        total === amountDue &&
        amountDue === subtotal &&
        invoiceCurrency.length > 0 &&
        lines.every((line) => {
          const currency = line["currency"] ?? invoiceCurrency;
          return (
            typeof currency === "string" &&
            currency.toLowerCase() === invoiceCurrency
          );
        }) &&
        periodStart !== null &&
        periodEnd !== null &&
        periodEnd > periodStart &&
        prorationDate !== undefined &&
        periodStart === prorationDate &&
        periodEnd === context.currentPeriodEnd;
    } else {
      const targetLine =
        targetNonProration.length === 1 ? targetNonProration[0] : undefined;
      const targetPeriod = targetLine?.["period"];
      const fullStart = isPlainRecord(targetPeriod)
        ? remoteNonnegativeInteger(targetPeriod["start"])
        : undefined;
      const fullEnd = isPlainRecord(targetPeriod)
        ? remoteNonnegativeInteger(targetPeriod["end"])
        : undefined;
      const targetQuantity =
        targetLine === undefined
          ? undefined
          : remoteInteger(targetLine["quantity"]);
      const targetAmount =
        targetLine === undefined
          ? undefined
          : remoteInteger(targetLine["amount"]);
      safeInvoiceShape =
        commonSafe &&
        lines.length === 1 &&
        targetLine !== undefined &&
        typeof targetLine["id"] === "string" &&
        targetLine["id"].length > 0 &&
        targetQuantity === 1n &&
        targetAmount !== undefined &&
        targetAmount > 0n &&
        targetAmount === total &&
        total === amountDue &&
        amountDue === subtotal &&
        (() => {
          const currency = targetLine["currency"] ?? invoiceCurrency;
          return (
            typeof currency === "string" &&
            currency.toLowerCase() === invoiceCurrency
          );
        })() &&
        invoiceCurrency.length > 0 &&
        fullStart !== undefined &&
        fullEnd !== undefined &&
        fullEnd > fullStart;
    }
    const customerBalanceCredit = [-startingBalance, -endingBalance, 0n].reduce(
      (highest, candidate) => (candidate > highest ? candidate : highest),
      0n,
    );
    return {
      amountDue,
      prorationCredit,
      customerBalanceCredit,
      currency: typeof raw["currency"] === "string" ? raw["currency"] : "usd",
      safeInvoiceShape,
      sourceProrationAmount: -sourceProrationAmount,
      targetProrationAmount,
      taxAmount,
      discountAmount,
      periodStart,
      periodEnd,
    };
  }

  public async applyImmediatePlanChange(
    context: PlanChangeContext,
    input: {
      readonly idempotencyKey: string;
      readonly policy?: TransitionPolicy;
      readonly prorationDate?: bigint;
    },
  ): Promise<RemotePlanChange> {
    const policy = input.policy ?? "full_period_reset";
    const settlement: Record<string, unknown> =
      policy === "full_period_reset"
        ? { billing_cycle_anchor: "now", proration_behavior: "none" }
        : input.prorationDate === undefined
          ? (() => {
              throw new Error("prorated_delta requires a fixed prorationDate");
            })()
          : {
              proration_behavior: "always_invoice",
              proration_date: bigintToSafeNumber(
                input.prorationDate,
                "prorationDate",
              ),
            };
    const params = {
      items: [{ id: context.subscriptionItemId, price: context.targetPriceId }],
      ...settlement,
      payment_behavior: "pending_if_incomplete",
      expand: ["latest_invoice.confirmation_secret"],
    } as Stripe.SubscriptionUpdateParams;
    const subscription = stripeObject(
      await this.#stripe.subscriptions.update(context.subscriptionId, params, {
        idempotencyKey: input.idempotencyKey,
      }),
    );
    return this.#remotePlanChangeFromSubscription(context, subscription);
  }

  #remotePlanChangeFromSubscription(
    context: PlanChangeContext,
    subscription: Readonly<Record<string, unknown>>,
  ): RemotePlanChange {
    if (asStripeId(subscription["id"]) !== context.subscriptionId) {
      throw new Error(
        "Stripe returned a different Subscription after plan mutation",
      );
    }
    this.#assertMode(subscription, "plan mutation");
    const status = subscription["status"];
    if (typeof status !== "string" || !SUBSCRIPTION_STATUSES.has(status)) {
      throw new Error(
        "Stripe plan mutation returned an unsupported Subscription status",
      );
    }
    const pendingRaw = subscription["pending_update"];
    const pending =
      pendingRaw === undefined || pendingRaw === null
        ? {}
        : isPlainRecord(pendingRaw)
          ? pendingRaw
          : undefined;
    if (pending === undefined) {
      throw new Error("Stripe returned an invalid pending_update shape");
    }
    const invoice = subscription["latest_invoice"];
    if (!isPlainRecord(invoice)) {
      throw new Error(
        "Stripe plan mutation did not return an expanded latest Invoice",
      );
    }
    const settlementInvoiceId = asStripeId(invoice);
    if (settlementInvoiceId === undefined) {
      throw new Error(
        "Stripe plan mutation returned an Invoice without identity",
      );
    }
    const confirmationRaw = invoice["confirmation_secret"];
    const confirmation =
      confirmationRaw === undefined || confirmationRaw === null
        ? {}
        : isPlainRecord(confirmationRaw)
          ? confirmationRaw
          : undefined;
    if (confirmation === undefined) {
      throw new Error("Stripe returned an invalid confirmation_secret shape");
    }
    const clientSecret =
      confirmation["client_secret"] === undefined ||
      confirmation["client_secret"] === null
        ? null
        : requiredText(
            confirmation["client_secret"],
            "payment client secret",
            512,
          );
    const pendingActive = recordHasValues(pending);
    const pendingExpiresAt =
      pending["expires_at"] === undefined || pending["expires_at"] === null
        ? null
        : (remoteNonnegativeInteger(pending["expires_at"]) ?? null);
    if (pendingActive && pendingExpiresAt === null) {
      throw new Error("Stripe pending_update is missing an integer expiry");
    }
    const recoveryUrl =
      invoice["hosted_invoice_url"] === undefined ||
      invoice["hosted_invoice_url"] === null
        ? null
        : requiredHttpsUrl(invoice["hosted_invoice_url"], "hosted Invoice URL");
    return {
      remoteId: context.subscriptionId,
      pendingUpdate: pendingActive,
      pendingExpiresAt: pendingActive ? pendingExpiresAt : null,
      recoveryUrl: pendingActive ? recoveryUrl : null,
      clientSecret: pendingActive ? clientSecret : null,
      settlementInvoiceId,
    };
  }

  public async executePlanChangeRequestSnapshot(
    rawSnapshot: unknown,
  ): Promise<RemotePlanChange> {
    const snapshot = validatePlanChangeRequestSnapshot(rawSnapshot);
    const context = planChangeContextFromSnapshot(snapshot);
    if (snapshot.kind === "plan_change_schedule") {
      return this.#schedulePlanChangePrepared(context, {
        idempotencyKey: snapshot.idempotency_key,
        requestApiVersion: snapshot.request_api_version,
        productLine: snapshot.product_line,
      });
    }
    const subscription = stripeObject(
      await this.#stripe.subscriptions.update(
        context.subscriptionId,
        snapshot.params as Stripe.SubscriptionUpdateParams,
        {
          idempotencyKey: snapshot.idempotency_key,
          apiVersion: snapshot.request_api_version,
        },
      ),
    );
    return this.#remotePlanChangeFromSubscription(context, subscription);
  }

  public async verifyPlanChangeRequestSnapshot(
    rawSnapshot: unknown,
  ): Promise<PlanChangeContext> {
    const snapshot = validatePlanChangeRequestSnapshot(rawSnapshot);
    const frozen = planChangeContextFromSnapshot(snapshot);
    const subscription = stripeObject(
      await this.#stripe.subscriptions.retrieve(
        frozen.subscriptionId,
        { expand: ["latest_invoice.confirmation_secret"] },
        { apiVersion: snapshot.request_api_version },
      ),
    );
    if (asStripeId(subscription["id"]) !== frozen.subscriptionId) {
      throw new Error("Stripe returned a different Subscription identity");
    }
    this.#assertMode(subscription, "Subscription");
    const container = subscription["items"];
    const rawItems = isPlainRecord(container) ? container["data"] : undefined;
    if (
      !isPlainRecord(container) ||
      (container["has_more"] !== undefined &&
        container["has_more"] !== null &&
        container["has_more"] !== false) ||
      !isUnknownArray(rawItems) ||
      rawItems.length !== 1 ||
      !isPlainRecord(rawItems[0])
    ) {
      throw new Error("subscription must contain exactly one item object");
    }
    const item = rawItems[0];
    if (remoteNonnegativeInteger(item["quantity"]) !== 1n) {
      throw new Error("subscription item quantity must be exactly one");
    }
    const itemId = requiredText(
      asStripeId(item["id"]),
      "Subscription item id",
      255,
    );
    const currentPriceId = linePriceId(item);
    const start = remoteNonnegativeInteger(
      item["current_period_start"] ?? subscription["current_period_start"],
    );
    const end = remoteNonnegativeInteger(
      item["current_period_end"] ?? subscription["current_period_end"],
    );
    if (
      currentPriceId === undefined ||
      start === undefined ||
      end === undefined
    ) {
      throw new Error("Stripe Subscription snapshot is incomplete");
    }
    const scheduleRaw = subscription["schedule"];
    const scheduleId =
      scheduleRaw === undefined || scheduleRaw === null
        ? null
        : asStripeId(scheduleRaw);
    if (
      scheduleRaw !== undefined &&
      scheduleRaw !== null &&
      scheduleId === undefined
    ) {
      throw new Error(
        "Stripe returned an invalid Subscription Schedule identity",
      );
    }
    const status = subscription["status"];
    const cancelAtPeriodEnd = subscription["cancel_at_period_end"];
    const pendingRaw = subscription["pending_update"];
    if (
      typeof status !== "string" ||
      !SUBSCRIPTION_STATUSES.has(status) ||
      typeof cancelAtPeriodEnd !== "boolean" ||
      (pendingRaw !== undefined &&
        pendingRaw !== null &&
        !isPlainRecord(pendingRaw))
    ) {
      throw new Error("Stripe Subscription snapshot has an invalid state");
    }
    return {
      ...frozen,
      subscriptionItemId: itemId,
      currentPriceId,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      scheduleId: scheduleId ?? null,
      subscriptionStatus: status,
      cancelAtPeriodEnd,
      pendingUpdate:
        isPlainRecord(pendingRaw) && Object.keys(pendingRaw).length > 0,
    };
  }

  public async schedulePlanChange(
    context: PlanChangeContext,
    input: { readonly idempotencyKey: string },
  ): Promise<RemotePlanChange> {
    return this.#schedulePlanChangePrepared(context, {
      idempotencyKey: input.idempotencyKey,
      productLine: this.#productLine,
    });
  }

  async #schedulePlanChangePrepared(
    context: PlanChangeContext,
    input: {
      readonly idempotencyKey: string;
      readonly requestApiVersion?: string;
      readonly productLine: string;
    },
  ): Promise<RemotePlanChange> {
    const schedule = stripeObject(
      await this.#stripe.subscriptionSchedules.create(
        { from_subscription: context.subscriptionId },
        {
          idempotencyKey: `${input.idempotencyKey}:create`,
          ...(input.requestApiVersion === undefined
            ? {}
            : { apiVersion: input.requestApiVersion }),
        },
      ),
    );
    const scheduleId = requiredText(
      asStripeId(schedule["id"]),
      "Subscription Schedule id",
      255,
    );
    if (context.scheduleId !== null && scheduleId !== context.scheduleId) {
      throw new Error(
        "subscription is controlled by an unrelated Stripe Schedule",
      );
    }
    const rawPhases = schedule["phases"];
    const phases: unknown[] = isUnknownArray(rawPhases) ? rawPhases : [];
    if (phases.length === 2) {
      if (
        !this.configuredScheduleMatches(
          schedule,
          context,
          input.idempotencyKey,
          input.productLine,
        )
      ) {
        throw new Error(
          "existing Stripe Schedule differs from this plan change",
        );
      }
      return this.#remoteSchedule(scheduleId);
    }
    if (phases.length !== 1) {
      throw new Error(
        "new subscription schedule must contain one current phase",
      );
    }
    const firstPhase = phases[0];
    if (!isPlainRecord(firstPhase)) {
      throw new Error("new Subscription Schedule phase must be an object");
    }
    const boundary = bigintToSafeNumber(
      context.currentPeriodEnd,
      "current period end",
    );
    const currentPhase = this.#schedulePhasePayload(firstPhase);
    currentPhase["end_date"] = boundary;
    const targetPhase = cloneRemote(currentPhase);
    if (!isPlainRecord(targetPhase)) {
      throw new Error("cannot clone Subscription Schedule phase");
    }
    targetPhase["start_date"] = boundary;
    delete targetPhase["end_date"];
    targetPhase["items"] = [{ price: context.targetPriceId, quantity: 1 }];
    targetPhase["duration"] = {
      interval: context.targetInterval,
      interval_count: 1,
    };
    currentPhase["proration_behavior"] = "none";
    targetPhase["proration_behavior"] = "none";
    const configured = stripeObject(
      await this.#stripe.subscriptionSchedules.update(
        scheduleId,
        {
          phases: [
            currentPhase,
            targetPhase,
          ] as unknown as Stripe.SubscriptionScheduleUpdateParams.Phase[],
          end_behavior: "release",
          proration_behavior: "none",
          metadata: {
            product_line: input.productLine,
            plan_change_key: input.idempotencyKey,
          },
        },
        {
          idempotencyKey: `${input.idempotencyKey}:configure`,
          ...(input.requestApiVersion === undefined
            ? {}
            : { apiVersion: input.requestApiVersion }),
        },
      ),
    );
    const configuredId = requiredText(
      asStripeId(configured["id"]),
      "configured Subscription Schedule id",
      255,
    );
    if (configuredId !== scheduleId) {
      throw new Error("Stripe configured a different Subscription Schedule");
    }
    const verified = stripeObject(
      await this.#stripe.subscriptionSchedules.retrieve(
        configuredId,
        {},
        input.requestApiVersion === undefined
          ? {}
          : { apiVersion: input.requestApiVersion },
      ),
    );
    if (
      asStripeId(verified["id"]) !== configuredId ||
      !this.configuredScheduleMatches(
        verified,
        context,
        input.idempotencyKey,
        input.productLine,
      )
    ) {
      throw new Error("configured Stripe Schedule failed policy verification");
    }
    return this.#remoteSchedule(configuredId);
  }

  #remoteSchedule(scheduleId: string): RemotePlanChange {
    return {
      remoteId: scheduleId,
      pendingUpdate: false,
      pendingExpiresAt: null,
      recoveryUrl: null,
      clientSecret: null,
      settlementInvoiceId: null,
    };
  }

  public configuredScheduleMatches(
    schedule: Readonly<Record<string, unknown>>,
    context: PlanChangeContext,
    planChangeKey: string,
    productLine = this.#productLine,
  ): boolean {
    try {
      const rawPhases = schedule["phases"];
      if (
        !isUnknownArray(rawPhases) ||
        rawPhases.length !== 2 ||
        !rawPhases.every((phase) => isPlainRecord(phase))
      ) {
        return false;
      }
      const currentPhase = rawPhases[0];
      const targetPhase = rawPhases[1];
      if (!isPlainRecord(currentPhase) || !isPlainRecord(targetPhase)) {
        return false;
      }
      const metadata = schedule["metadata"];
      const currentItems = currentPhase["items"];
      const targetItems = targetPhase["items"];
      if (
        !isPlainRecord(metadata) ||
        !isUnknownArray(currentItems) ||
        !isUnknownArray(targetItems) ||
        ![...currentItems, ...targetItems].every((item) => isPlainRecord(item))
      ) {
        return false;
      }
      const boundary = context.currentPeriodEnd;
      return (
        asStripeId(schedule["subscription"]) === context.subscriptionId &&
        schedule["end_behavior"] === "release" &&
        metadata["product_line"] === productLine &&
        metadata["plan_change_key"] === planChangeKey &&
        remoteInteger(currentPhase["end_date"]) === boundary &&
        remoteInteger(targetPhase["start_date"]) === boundary &&
        this.#phaseDurationMatches(
          targetPhase,
          boundary,
          context.targetInterval,
        ) &&
        currentPhase["proration_behavior"] === "none" &&
        targetPhase["proration_behavior"] === "none" &&
        currentItems.length === 1 &&
        targetItems.length === 1 &&
        linePriceId(currentItems[0] as StripeObject) ===
          context.currentPriceId &&
        linePriceId(targetItems[0] as StripeObject) === context.targetPriceId &&
        remoteInteger((currentItems[0] as StripeObject)["quantity"]) === 1n &&
        remoteInteger((targetItems[0] as StripeObject)["quantity"]) === 1n
      );
    } catch {
      return false;
    }
  }

  #phaseDurationMatches(
    phase: Readonly<Record<string, unknown>>,
    boundary: bigint,
    interval: BillingInterval,
  ): boolean {
    const duration = phase["duration"];
    if (isPlainRecord(duration)) {
      return (
        Object.keys(duration).length === 2 &&
        duration["interval"] === interval &&
        remoteInteger(duration["interval_count"]) === 1n
      );
    }
    const endDate = remoteNonnegativeInteger(phase["end_date"]);
    return (
      endDate !== undefined &&
      endDate === addCalendarInterval(boundary, interval)
    );
  }

  #schedulePhasePayload(
    phase: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    const allowed = new Set([
      "application_fee_percent",
      "automatic_tax",
      "billing_cycle_anchor",
      "collection_method",
      "currency",
      "default_payment_method",
      "default_tax_rates",
      "description",
      "discounts",
      "end_date",
      "invoice_settings",
      "items",
      "metadata",
      "on_behalf_of",
      "proration_behavior",
      "start_date",
      "transfer_data",
      "trial_end",
    ]);
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(phase)) {
      // Stripe can render unset optional phase fields as null or an empty
      // string. Sending those values back means "unset" and some immutable
      // defaults (for example collection_method) reject that mutation.
      if (
        allowed.has(key) &&
        value !== undefined &&
        value !== null &&
        value !== ""
      ) {
        payload[key] = cloneRemote(value);
      }
    }
    const rawItems = payload["items"];
    if (!isUnknownArray(rawItems) || rawItems.length !== 1) {
      throw new Error("schedule phase must contain exactly one item");
    }
    const item = rawItems[0];
    if (!isPlainRecord(item)) {
      throw new Error("schedule phase item must be an object");
    }
    const priceId = linePriceId(item);
    if (priceId === undefined || remoteInteger(item["quantity"]) !== 1n) {
      throw new Error("schedule phase item must have one resolvable Price");
    }
    payload["items"] = [{ price: priceId, quantity: 1 }];
    const automaticTax = payload["automatic_tax"];
    if (automaticTax !== undefined) {
      if (
        !isPlainRecord(automaticTax) ||
        typeof automaticTax["enabled"] !== "boolean"
      ) {
        throw new Error(
          "schedule phase automatic tax policy must contain an enabled flag",
        );
      }
      const sanitizedAutomaticTax: Record<string, unknown> = {
        enabled: automaticTax["enabled"],
      };
      const liability = automaticTax["liability"];
      if (liability !== undefined && liability !== null) {
        if (
          !isPlainRecord(liability) ||
          typeof liability["type"] !== "string" ||
          liability["type"].length === 0
        ) {
          throw new Error(
            "schedule phase automatic tax liability is malformed",
          );
        }
        const sanitizedLiability: Record<string, unknown> = {
          type: liability["type"],
        };
        const liabilityAccount = liability["account"];
        if (liabilityAccount !== undefined && liabilityAccount !== null) {
          const accountId = asStripeId(liabilityAccount);
          if (accountId === undefined) {
            throw new Error(
              "schedule phase automatic tax liability account is malformed",
            );
          }
          sanitizedLiability["account"] = accountId;
        }
        sanitizedAutomaticTax["liability"] = sanitizedLiability;
      }
      // `disabled_reason` and any later response-only fields must never be
      // reflected into SubscriptionSchedule.update. Rebuild the nested request
      // object from the documented writable contract instead of cloning it.
      payload["automatic_tax"] = sanitizedAutomaticTax;
    }
    return payload;
  }
}
