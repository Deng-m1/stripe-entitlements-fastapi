import type { PlanChangeContext, RemotePlanChange } from "./stripe-gateway.js";
import type { BillingInterval, TransitionPolicy } from "./types.js";
import { isPlainRecord, isPrintable } from "./validation.js";

export const PLAN_CHANGE_SNAPSHOT_SCHEMA = "stripe.plan_change.request";
export const PLAN_CHANGE_SNAPSHOT_VERSION = 1;
export const CHECKOUT_SNAPSHOT_SCHEMA = "stripe.checkout.session.create";
export const CHECKOUT_SNAPSHOT_VERSION = 1;

const SECRET_MARKERS = [
  "sk_test_",
  "sk_live_",
  "rk_test_",
  "rk_live_",
  "whsec_",
] as const;
const MAX_STRIPE_TIMESTAMP = 253_402_300_799;
const MAX_STRIPE_AMOUNT = 99_999_999;

export class StripeRequestSnapshotError extends Error {}

export interface CheckoutRequestSnapshot
  extends Readonly<Record<string, unknown>> {
  readonly schema: typeof CHECKOUT_SNAPSHOT_SCHEMA;
  readonly version: typeof CHECKOUT_SNAPSHOT_VERSION;
  readonly kind: "subscription" | "credit_pack";
  readonly request_api_version: string;
  readonly idempotency_key: string;
  readonly customer_mode: "existing" | "create";
  readonly resolved_price: Readonly<Record<string, unknown>>;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface SubscriptionCheckoutSnapshotInput {
  readonly accountId: string;
  readonly claimToken: string;
  readonly customerId?: string;
  readonly priceId: string;
  readonly lookupKey: string;
  readonly currency: string;
  readonly unitAmount: bigint;
  readonly interval: BillingInterval;
  readonly planKey: string;
  readonly productLine: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly expiresAt: bigint;
  readonly requestApiVersion: string;
}

export interface CreditPackCheckoutSnapshotInput {
  readonly orderId: string;
  readonly accountId: string;
  readonly customerId?: string;
  readonly priceId: string;
  readonly lookupKey: string;
  readonly currency: string;
  readonly unitAmount: bigint;
  readonly packKey: string;
  readonly packCredits: string;
  readonly expiresDays: number;
  readonly productLine: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly expiresAt: bigint;
  readonly requestApiVersion: string;
}

export interface CheckoutSnapshotExpectation {
  readonly kind?: "subscription" | "credit_pack";
  readonly accountId?: string;
  readonly requestIdentity?: string;
  readonly lookupKey?: string;
  readonly currency?: string;
  readonly unitAmount?: bigint;
  readonly interval?: BillingInterval;
  readonly offeringKey?: string;
  readonly expiresAt?: bigint;
  readonly customerId?: string | null;
  readonly packCredits?: string;
  readonly expiresDays?: number;
  readonly productLine?: string;
}

export interface PlanChangeRequestSnapshot
  extends Readonly<Record<string, unknown>> {
  readonly schema: typeof PLAN_CHANGE_SNAPSHOT_SCHEMA;
  readonly version: typeof PLAN_CHANGE_SNAPSHOT_VERSION;
  readonly kind: "plan_change_immediate" | "plan_change_schedule";
  readonly request_api_version: string;
  readonly idempotency_key: string;
  readonly product_line: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly price_evidence: Readonly<Record<string, unknown>>;
  readonly policy: TransitionPolicy;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface PlanChangeSnapshotBuildInput {
  readonly context: PlanChangeContext;
  readonly timing: "immediate" | "period_end";
  readonly policy: TransitionPolicy;
  readonly prorationDate: bigint | null;
  readonly idempotencyKey: string;
  readonly requestApiVersion: string;
  readonly productLine: string;
  readonly sourceLookupKey: string;
  readonly targetLookupKey: string;
  readonly sourcePlanKey: string;
  readonly targetPlanKey: string;
  readonly sourceCurrency: string;
  readonly targetCurrency: string;
  readonly sourceUnitAmount: bigint;
  readonly targetUnitAmount: bigint;
}

export interface PlanChangeSnapshotExpectation {
  readonly idempotencyKey?: string;
  readonly subscriptionId?: string;
  readonly timing?: "immediate" | "period_end";
  readonly policy?: TransitionPolicy;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    throw new StripeRequestSnapshotError(`${field} has an unsupported shape`);
  }
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    observed.length !== expected.length ||
    observed.some((key, index) => key !== expected[index])
  ) {
    throw new StripeRequestSnapshotError(`${field} has an unsupported shape`);
  }
  return value;
}

function textValue(value: unknown, field: string, maximum = 512): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > maximum ||
    !isPrintable(value)
  ) {
    throw new StripeRequestSnapshotError(`${field} is invalid`);
  }
  if (SECRET_MARKERS.some((marker) => value.includes(marker))) {
    throw new StripeRequestSnapshotError(
      `${field} contains a prohibited secret marker`,
    );
  }
  return value;
}

function stripeId(value: unknown, prefix: string, field: string): string {
  const result = textValue(value, field, 255);
  if (!result.startsWith(prefix)) {
    throw new StripeRequestSnapshotError(`${field} is invalid`);
  }
  return result;
}

function boundedInteger(
  value: unknown,
  field: string,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new StripeRequestSnapshotError(`${field} is invalid`);
  }
  return value;
}

function stripeTimestamp(value: unknown, field: string): number {
  return boundedInteger(value, field, MAX_STRIPE_TIMESTAMP);
}

function stripeAmount(value: unknown, field: string): number {
  return boundedInteger(value, field, MAX_STRIPE_AMOUNT);
}

function bigintNumber(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new StripeRequestSnapshotError(`${field} is invalid`);
  }
  return Number(value);
}

function bigintAmount(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(MAX_STRIPE_AMOUNT)) {
    throw new StripeRequestSnapshotError(`${field} is invalid`);
  }
  return Number(value);
}

function httpUrl(value: unknown, field: string): string {
  const result = textValue(value, field, 2048);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    throw new StripeRequestSnapshotError(
      `${field} is not an origin-safe HTTP(S) URL`,
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.host.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new StripeRequestSnapshotError(
      `${field} is not an origin-safe HTTP(S) URL`,
    );
  }
  return result;
}

function safeJson(value: unknown): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new StripeRequestSnapshotError(
      "request snapshot is not JSON serializable",
      { cause: error },
    );
  }
  if (typeof encoded !== "string") {
    throw new StripeRequestSnapshotError(
      "request snapshot is not JSON serializable",
    );
  }
  if (Buffer.byteLength(encoded, "utf8") > 32 * 1024) {
    throw new StripeRequestSnapshotError("request snapshot exceeds 32 KiB");
  }
  if (SECRET_MARKERS.some((marker) => encoded.includes(marker))) {
    throw new StripeRequestSnapshotError(
      "request snapshot contains a prohibited secret marker",
    );
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonEqual(item, right[index]))
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
        key === rightKeys[index] && jsonEqual(left[key], right[key]),
    )
  );
}

export function buildSubscriptionCheckoutRequestSnapshot(
  input: SubscriptionCheckoutSnapshotInput,
): CheckoutRequestSnapshot {
  const metadata = {
    claim_token: input.claimToken,
    account_id: input.accountId,
    product_line: input.productLine,
  };
  const params = {
    mode: "subscription",
    client_reference_id: input.accountId,
    line_items: [{ price: input.priceId, quantity: 1 }],
    subscription_data: { metadata },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_at: bigintNumber(input.expiresAt, "Checkout expiry"),
    metadata,
    ...(input.customerId === undefined ? {} : { customer: input.customerId }),
  };
  return validateCheckoutRequestSnapshot({
    schema: CHECKOUT_SNAPSHOT_SCHEMA,
    version: CHECKOUT_SNAPSHOT_VERSION,
    kind: "subscription",
    request_api_version: input.requestApiVersion,
    idempotency_key: `checkout:${input.accountId}:${input.claimToken}`,
    customer_mode: input.customerId === undefined ? "create" : "existing",
    resolved_price: {
      price_id: input.priceId,
      lookup_key: input.lookupKey,
      currency: input.currency,
      unit_amount: bigintAmount(input.unitAmount, "Checkout unit amount"),
      price_type: "recurring",
      interval: input.interval,
      product_line: input.productLine,
      offering_key: input.planKey,
    },
    params,
  });
}

export function buildCreditPackCheckoutRequestSnapshot(
  input: CreditPackCheckoutSnapshotInput,
): CheckoutRequestSnapshot {
  const metadata = {
    billing_kind: "credit_pack",
    pack_schema_version: "1",
    product_line: input.productLine,
    credit_pack_order_id: input.orderId,
    account_id: input.accountId,
    pack_key: input.packKey,
    pack_credits: input.packCredits,
    price_amount: input.unitAmount.toString(),
    currency: input.currency,
    expires_days: input.expiresDays.toString(),
    lookup_key: input.lookupKey,
  };
  const params = {
    mode: "payment",
    payment_method_types: ["card"],
    client_reference_id: input.accountId,
    line_items: [{ price: input.priceId, quantity: 1 }],
    payment_intent_data: { metadata },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_at: bigintNumber(input.expiresAt, "Checkout expiry"),
    metadata,
    ...(input.customerId === undefined
      ? { customer_creation: "always" }
      : { customer: input.customerId }),
  };
  return validateCheckoutRequestSnapshot({
    schema: CHECKOUT_SNAPSHOT_SCHEMA,
    version: CHECKOUT_SNAPSHOT_VERSION,
    kind: "credit_pack",
    request_api_version: input.requestApiVersion,
    idempotency_key: `credit-pack:${input.orderId}`,
    customer_mode: input.customerId === undefined ? "create" : "existing",
    resolved_price: {
      price_id: input.priceId,
      lookup_key: input.lookupKey,
      currency: input.currency,
      unit_amount: bigintAmount(input.unitAmount, "Checkout unit amount"),
      price_type: "one_time",
      interval: null,
      product_line: input.productLine,
      offering_key: input.packKey,
    },
    params,
  });
}

export function validateCheckoutRequestSnapshot(
  value: unknown,
  expected: CheckoutSnapshotExpectation = {},
): CheckoutRequestSnapshot {
  safeJson(value);
  const root = exactRecord(
    value,
    [
      "schema",
      "version",
      "kind",
      "request_api_version",
      "idempotency_key",
      "customer_mode",
      "resolved_price",
      "params",
    ],
    "Checkout request snapshot",
  );
  if (
    root["schema"] !== CHECKOUT_SNAPSHOT_SCHEMA ||
    root["version"] !== CHECKOUT_SNAPSHOT_VERSION
  ) {
    throw new StripeRequestSnapshotError(
      "unsupported Checkout request snapshot version",
    );
  }
  const kind = root["kind"];
  if (kind !== "subscription" && kind !== "credit_pack") {
    throw new StripeRequestSnapshotError(
      "unsupported Checkout request snapshot kind",
    );
  }
  textValue(root["request_api_version"], "request API version", 64);
  const idempotencyKey = textValue(
    root["idempotency_key"],
    "Stripe idempotency key",
    255,
  );
  const customerMode = root["customer_mode"];
  if (customerMode !== "existing" && customerMode !== "create") {
    throw new StripeRequestSnapshotError("Checkout customer mode is invalid");
  }
  const evidence = exactRecord(
    root["resolved_price"],
    [
      "price_id",
      "lookup_key",
      "currency",
      "unit_amount",
      "price_type",
      "interval",
      "product_line",
      "offering_key",
    ],
    "Checkout resolved Price evidence",
  );
  const priceId = stripeId(evidence["price_id"], "price_", "Checkout Price id");
  const lookupKey = textValue(
    evidence["lookup_key"],
    "Checkout lookup key",
    200,
  );
  const currency = textValue(evidence["currency"], "Checkout currency", 3);
  if (currency.length !== 3 || currency !== currency.toLowerCase()) {
    throw new StripeRequestSnapshotError("Checkout currency is invalid");
  }
  const unitAmount = stripeAmount(
    evidence["unit_amount"],
    "Checkout unit amount",
  );
  const productLine = textValue(evidence["product_line"], "product line", 200);
  const offeringKey = textValue(evidence["offering_key"], "offering key", 64);
  const checkoutInterval = evidence["interval"];
  if (kind === "subscription") {
    if (
      evidence["price_type"] !== "recurring" ||
      (checkoutInterval !== "month" && checkoutInterval !== "year")
    ) {
      throw new StripeRequestSnapshotError(
        "subscription Price evidence is invalid",
      );
    }
  } else if (
    evidence["price_type"] !== "one_time" ||
    checkoutInterval !== null
  ) {
    throw new StripeRequestSnapshotError(
      "credit-pack Price evidence is invalid",
    );
  }
  const keys = [
    "mode",
    "client_reference_id",
    "line_items",
    "success_url",
    "cancel_url",
    "expires_at",
    "metadata",
    kind === "subscription" ? "subscription_data" : "payment_intent_data",
    ...(kind === "credit_pack" ? ["payment_method_types"] : []),
    ...(customerMode === "existing"
      ? ["customer"]
      : kind === "credit_pack"
        ? ["customer_creation"]
        : []),
  ];
  const params = exactRecord(
    root["params"],
    keys,
    "Checkout Session create params",
  );
  const accountId = textValue(
    params["client_reference_id"],
    "Checkout account id",
    64,
  );
  if (!jsonEqual(params["line_items"], [{ price: priceId, quantity: 1 }])) {
    throw new StripeRequestSnapshotError("Checkout line item drifted");
  }
  httpUrl(params["success_url"], "Checkout success URL");
  httpUrl(params["cancel_url"], "Checkout cancel URL");
  const expiresAt = stripeTimestamp(params["expires_at"], "Checkout expiry");
  let customerId: string | null = null;
  if (customerMode === "existing") {
    customerId = stripeId(params["customer"], "cus_", "Checkout Customer id");
  } else if (
    kind === "credit_pack" &&
    params["customer_creation"] !== "always"
  ) {
    throw new StripeRequestSnapshotError(
      "credit-pack Customer create mode drifted",
    );
  }
  const branch =
    kind === "subscription" ? "subscription_data" : "payment_intent_data";
  const wrapper = exactRecord(params[branch], ["metadata"], branch);
  if (!jsonEqual(params["metadata"], wrapper["metadata"])) {
    throw new StripeRequestSnapshotError("Checkout metadata copies drifted");
  }
  const metadata = params["metadata"];
  let requestIdentity: string;
  let derivedKey: string;
  if (kind === "subscription") {
    const prefix = `checkout:${accountId}:`;
    if (!idempotencyKey.startsWith(prefix)) {
      throw new StripeRequestSnapshotError(
        "Checkout Stripe idempotency identity drifted",
      );
    }
    requestIdentity = idempotencyKey.slice(prefix.length);
    const expectedMetadata = {
      claim_token: requestIdentity,
      account_id: accountId,
      product_line: productLine,
    };
    if (
      params["mode"] !== "subscription" ||
      !jsonEqual(metadata, expectedMetadata)
    ) {
      throw new StripeRequestSnapshotError(
        "subscription Checkout metadata drifted",
      );
    }
    derivedKey = `${prefix}${requestIdentity}`;
  } else {
    if (
      params["mode"] !== "payment" ||
      !jsonEqual(params["payment_method_types"], ["card"]) ||
      !isPlainRecord(metadata)
    ) {
      throw new StripeRequestSnapshotError(
        "credit-pack Checkout payment policy drifted",
      );
    }
    requestIdentity = textValue(
      metadata["credit_pack_order_id"],
      "credit-pack order id",
      64,
    );
    const packCredits = textValue(metadata["pack_credits"], "pack credits", 64);
    const expiresDays = textValue(metadata["expires_days"], "pack expiry", 16);
    const expectedMetadata = {
      billing_kind: "credit_pack",
      pack_schema_version: "1",
      product_line: productLine,
      credit_pack_order_id: requestIdentity,
      account_id: accountId,
      pack_key: offeringKey,
      pack_credits: packCredits,
      price_amount: unitAmount.toString(),
      currency,
      expires_days: expiresDays,
      lookup_key: lookupKey,
    };
    if (!jsonEqual(metadata, expectedMetadata)) {
      throw new StripeRequestSnapshotError(
        "credit-pack Checkout metadata drifted",
      );
    }
    derivedKey = `credit-pack:${requestIdentity}`;
  }
  if (idempotencyKey !== derivedKey) {
    throw new StripeRequestSnapshotError(
      "Checkout Stripe idempotency identity drifted",
    );
  }
  const comparisons: ReadonlyArray<readonly [unknown, unknown, string]> = [
    [expected.kind, kind, "kind"],
    [expected.accountId, accountId, "account"],
    [expected.requestIdentity, requestIdentity, "request identity"],
    [expected.lookupKey, lookupKey, "lookup key"],
    [expected.currency, currency, "currency"],
    [
      expected.unitAmount === undefined
        ? undefined
        : bigintAmount(expected.unitAmount, "expected unit amount"),
      unitAmount,
      "unit amount",
    ],
    [expected.interval, checkoutInterval, "interval"],
    [expected.offeringKey, offeringKey, "offering key"],
    [expected.productLine, productLine, "product line"],
    [
      expected.expiresAt === undefined
        ? undefined
        : bigintNumber(expected.expiresAt, "expected expiry"),
      expiresAt,
      "expiry",
    ],
  ];
  for (const [expectedValue, observed, field] of comparisons) {
    if (expectedValue !== undefined && expectedValue !== observed) {
      throw new StripeRequestSnapshotError(`Checkout ${field} drifted`);
    }
  }
  if (Object.hasOwn(expected, "customerId")) {
    const expectedCustomer = expected.customerId ?? null;
    if (expectedCustomer !== customerId) {
      throw new StripeRequestSnapshotError("Checkout Customer drifted");
    }
    if (expectedCustomer === null && customerMode !== "create") {
      throw new StripeRequestSnapshotError("Checkout Customer mode drifted");
    }
  }
  if (expected.packCredits !== undefined) {
    if (kind !== "credit_pack" || !isPlainRecord(metadata)) {
      throw new StripeRequestSnapshotError("Checkout pack credits drifted");
    }
    const observed = textValue(metadata["pack_credits"], "pack credits", 64);
    if (observed !== expected.packCredits) {
      throw new StripeRequestSnapshotError("Checkout pack credits drifted");
    }
  }
  if (expected.expiresDays !== undefined) {
    if (
      kind !== "credit_pack" ||
      !Number.isSafeInteger(expected.expiresDays) ||
      expected.expiresDays <= 0 ||
      !isPlainRecord(metadata) ||
      metadata["expires_days"] !== expected.expiresDays.toString()
    ) {
      throw new StripeRequestSnapshotError("Checkout pack expiry drifted");
    }
  }
  return cloneJson(root) as CheckoutRequestSnapshot;
}

export function buildPlanChangeRequestSnapshot(
  input: PlanChangeSnapshotBuildInput,
): PlanChangeRequestSnapshot {
  const context = input.context;
  let kind: PlanChangeRequestSnapshot["kind"];
  let params: Readonly<Record<string, unknown>>;
  if (input.timing === "immediate") {
    const settlement =
      input.policy === "full_period_reset"
        ? { billing_cycle_anchor: "now", proration_behavior: "none" }
        : input.prorationDate === null
          ? (() => {
              throw new StripeRequestSnapshotError(
                "prorated_delta requires a proration date",
              );
            })()
          : {
              proration_behavior: "always_invoice",
              proration_date: bigintNumber(
                input.prorationDate,
                "proration date",
              ),
            };
    kind = "plan_change_immediate";
    params = {
      items: [
        {
          id: context.subscriptionItemId,
          price: context.targetPriceId,
        },
      ],
      ...settlement,
      payment_behavior: "pending_if_incomplete",
      expand: ["latest_invoice.confirmation_secret"],
    };
  } else {
    kind = "plan_change_schedule";
    params = {
      create: { from_subscription: context.subscriptionId },
      configure: {
        boundary: bigintNumber(context.currentPeriodEnd, "current period end"),
        target_price_id: context.targetPriceId,
        target_interval: context.targetInterval,
        end_behavior: "release",
        proration_behavior: "none",
        metadata: {
          product_line: input.productLine,
          plan_change_key: input.idempotencyKey,
        },
      },
    };
  }
  return validatePlanChangeRequestSnapshot({
    schema: PLAN_CHANGE_SNAPSHOT_SCHEMA,
    version: PLAN_CHANGE_SNAPSHOT_VERSION,
    kind,
    request_api_version: input.requestApiVersion,
    idempotency_key: input.idempotencyKey,
    product_line: input.productLine,
    context: {
      subscription_id: context.subscriptionId,
      subscription_item_id: context.subscriptionItemId,
      current_price_id: context.currentPriceId,
      current_lookup_key: context.currentLookupKey,
      target_price_id: context.targetPriceId,
      target_interval: context.targetInterval,
      current_period_start: bigintNumber(
        context.currentPeriodStart,
        "current period start",
      ),
      current_period_end: bigintNumber(
        context.currentPeriodEnd,
        "current period end",
      ),
      schedule_id: context.scheduleId,
      subscription_status: context.subscriptionStatus,
      cancel_at_period_end: context.cancelAtPeriodEnd,
      pending_update: context.pendingUpdate,
    },
    price_evidence: {
      source_price_id: context.currentPriceId,
      source_lookup_key: input.sourceLookupKey,
      source_plan_key: input.sourcePlanKey,
      source_currency: input.sourceCurrency,
      source_unit_amount: bigintAmount(
        input.sourceUnitAmount,
        "source unit amount",
      ),
      target_price_id: context.targetPriceId,
      target_lookup_key: input.targetLookupKey,
      target_plan_key: input.targetPlanKey,
      target_currency: input.targetCurrency,
      target_unit_amount: bigintAmount(
        input.targetUnitAmount,
        "target unit amount",
      ),
    },
    policy: input.policy,
    params,
  });
}

export function validatePlanChangeRequestSnapshot(
  value: unknown,
  expected: PlanChangeSnapshotExpectation = {},
): PlanChangeRequestSnapshot {
  safeJson(value);
  const root = exactRecord(
    value,
    [
      "schema",
      "version",
      "kind",
      "request_api_version",
      "idempotency_key",
      "product_line",
      "context",
      "price_evidence",
      "policy",
      "params",
    ],
    "plan-change request snapshot",
  );
  if (
    root["schema"] !== PLAN_CHANGE_SNAPSHOT_SCHEMA ||
    root["version"] !== PLAN_CHANGE_SNAPSHOT_VERSION
  ) {
    throw new StripeRequestSnapshotError(
      "unsupported plan-change request snapshot version",
    );
  }
  const kind = root["kind"];
  if (kind !== "plan_change_immediate" && kind !== "plan_change_schedule") {
    throw new StripeRequestSnapshotError(
      "unsupported plan-change request snapshot kind",
    );
  }
  const timing = kind === "plan_change_immediate" ? "immediate" : "period_end";
  textValue(root["request_api_version"], "request API version", 64);
  const idempotencyKey = textValue(
    root["idempotency_key"],
    "Stripe idempotency key",
    255,
  );
  const productLine = textValue(root["product_line"], "product line", 200);
  const policy = root["policy"];
  if (policy !== "full_period_reset" && policy !== "prorated_delta") {
    throw new StripeRequestSnapshotError("plan-change policy is invalid");
  }
  const context = exactRecord(
    root["context"],
    [
      "subscription_id",
      "subscription_item_id",
      "current_price_id",
      "current_lookup_key",
      "target_price_id",
      "target_interval",
      "current_period_start",
      "current_period_end",
      "schedule_id",
      "subscription_status",
      "cancel_at_period_end",
      "pending_update",
    ],
    "plan-change context",
  );
  const subscriptionId = stripeId(
    context["subscription_id"],
    "sub_",
    "Subscription id",
  );
  const itemId = stripeId(
    context["subscription_item_id"],
    "si_",
    "Subscription item id",
  );
  const sourcePriceId = stripeId(
    context["current_price_id"],
    "price_",
    "source Price id",
  );
  const targetPriceId = stripeId(
    context["target_price_id"],
    "price_",
    "target Price id",
  );
  const sourceLookup = textValue(
    context["current_lookup_key"],
    "source lookup key",
    200,
  );
  const targetInterval = context["target_interval"];
  if (targetInterval !== "month" && targetInterval !== "year") {
    throw new StripeRequestSnapshotError("target interval is invalid");
  }
  const periodStart = stripeTimestamp(
    context["current_period_start"],
    "current period start",
  );
  const periodEnd = stripeTimestamp(
    context["current_period_end"],
    "current period end",
  );
  if (periodEnd <= periodStart) {
    throw new StripeRequestSnapshotError("plan-change period is invalid");
  }
  if (context["schedule_id"] !== null) {
    stripeId(context["schedule_id"], "sub_sched_", "Subscription Schedule id");
  }
  textValue(context["subscription_status"], "Subscription status", 64);
  if (
    typeof context["cancel_at_period_end"] !== "boolean" ||
    typeof context["pending_update"] !== "boolean"
  ) {
    throw new StripeRequestSnapshotError(
      "plan-change boolean context is invalid",
    );
  }
  const evidence = exactRecord(
    root["price_evidence"],
    [
      "source_price_id",
      "source_lookup_key",
      "source_plan_key",
      "source_currency",
      "source_unit_amount",
      "target_price_id",
      "target_lookup_key",
      "target_plan_key",
      "target_currency",
      "target_unit_amount",
    ],
    "plan-change price evidence",
  );
  if (
    stripeId(
      evidence["source_price_id"],
      "price_",
      "evidence source Price id",
    ) !== sourcePriceId ||
    stripeId(
      evidence["target_price_id"],
      "price_",
      "evidence target Price id",
    ) !== targetPriceId ||
    textValue(evidence["source_lookup_key"], "evidence source lookup", 200) !==
      sourceLookup
  ) {
    throw new StripeRequestSnapshotError(
      "plan-change price evidence conflicts with context",
    );
  }
  for (const field of ["source_plan_key", "target_plan_key"] as const) {
    textValue(evidence[field], field, 64);
  }
  for (const field of ["source_currency", "target_currency"] as const) {
    const currency = textValue(evidence[field], field, 3);
    if (currency.length !== 3 || currency !== currency.toLowerCase()) {
      throw new StripeRequestSnapshotError(`${field} is invalid`);
    }
  }
  for (const field of ["source_unit_amount", "target_unit_amount"] as const) {
    stripeAmount(evidence[field], field);
  }
  textValue(evidence["target_lookup_key"], "target lookup key", 200);
  if (
    expected.idempotencyKey !== undefined &&
    idempotencyKey !== expected.idempotencyKey
  ) {
    throw new StripeRequestSnapshotError(
      "plan-change Stripe idempotency identity drifted",
    );
  }
  if (
    expected.subscriptionId !== undefined &&
    subscriptionId !== expected.subscriptionId
  ) {
    throw new StripeRequestSnapshotError(
      "plan-change Subscription identity drifted",
    );
  }
  if (expected.timing !== undefined && timing !== expected.timing) {
    throw new StripeRequestSnapshotError("plan-change timing drifted");
  }
  if (expected.policy !== undefined && policy !== expected.policy) {
    throw new StripeRequestSnapshotError("plan-change policy drifted");
  }
  if (timing === "immediate") {
    const keys =
      policy === "full_period_reset"
        ? [
            "items",
            "billing_cycle_anchor",
            "proration_behavior",
            "payment_behavior",
            "expand",
          ]
        : [
            "items",
            "proration_behavior",
            "proration_date",
            "payment_behavior",
            "expand",
          ];
    const params = exactRecord(
      root["params"],
      keys,
      "immediate mutation params",
    );
    if (
      !jsonEqual(params["items"], [{ id: itemId, price: targetPriceId }]) ||
      params["payment_behavior"] !== "pending_if_incomplete" ||
      !jsonEqual(params["expand"], ["latest_invoice.confirmation_secret"])
    ) {
      throw new StripeRequestSnapshotError("immediate mutation policy drifted");
    }
    if (policy === "full_period_reset") {
      if (
        params["billing_cycle_anchor"] !== "now" ||
        params["proration_behavior"] !== "none"
      ) {
        throw new StripeRequestSnapshotError(
          "full-period mutation policy drifted",
        );
      }
    } else if (params["proration_behavior"] !== "always_invoice") {
      throw new StripeRequestSnapshotError("prorated mutation policy drifted");
    } else {
      stripeTimestamp(params["proration_date"], "proration date");
    }
  } else {
    const params = exactRecord(
      root["params"],
      ["create", "configure"],
      "schedule params",
    );
    if (!jsonEqual(params["create"], { from_subscription: subscriptionId })) {
      throw new StripeRequestSnapshotError("Schedule create params drifted");
    }
    const configure = exactRecord(
      params["configure"],
      [
        "boundary",
        "target_price_id",
        "target_interval",
        "end_behavior",
        "proration_behavior",
        "metadata",
      ],
      "Schedule configure params",
    );
    if (
      stripeTimestamp(configure["boundary"], "Schedule boundary") !==
        periodEnd ||
      configure["target_price_id"] !== targetPriceId ||
      configure["target_interval"] !== targetInterval ||
      configure["end_behavior"] !== "release" ||
      configure["proration_behavior"] !== "none" ||
      !jsonEqual(configure["metadata"], {
        product_line: productLine,
        plan_change_key: idempotencyKey,
      })
    ) {
      throw new StripeRequestSnapshotError("Schedule configure policy drifted");
    }
  }
  return cloneJson(root) as PlanChangeRequestSnapshot;
}

export function planChangeContextFromSnapshot(
  snapshot: unknown,
): PlanChangeContext {
  const validated = validatePlanChangeRequestSnapshot(snapshot);
  const context = validated.context;
  return {
    subscriptionId: String(context["subscription_id"]),
    subscriptionItemId: String(context["subscription_item_id"]),
    currentPriceId: String(context["current_price_id"]),
    currentLookupKey: String(context["current_lookup_key"]),
    targetPriceId: String(context["target_price_id"]),
    targetInterval: context["target_interval"] as BillingInterval,
    currentPeriodStart: BigInt(context["current_period_start"] as number),
    currentPeriodEnd: BigInt(context["current_period_end"] as number),
    scheduleId: context["schedule_id"] as string | null,
    subscriptionStatus: String(context["subscription_status"]),
    cancelAtPeriodEnd: Boolean(context["cancel_at_period_end"]),
    pendingUpdate: Boolean(context["pending_update"]),
    pendingExpiresAt: null,
    recoveryUrl: null,
    clientSecret: null,
  };
}

export type PlanChangeSnapshotExecutor = (
  snapshot: PlanChangeRequestSnapshot,
) => Promise<RemotePlanChange>;
