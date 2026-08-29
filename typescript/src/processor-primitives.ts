import { POSTGRES_BIGINT_MAX } from "./bounds.js";
import { rankFor } from "./ordering.js";
import { isPlainRecord, isPrintable } from "./validation.js";

export type StripeObject = Readonly<Record<string, unknown>>;

export const SUPPORTED_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "checkout.session.expired",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
  "charge.dispute.created",
  "payment_intent.succeeded",
]);

export function asStripeId(value: unknown): string | undefined {
  const candidate = isPlainRecord(value) ? value["id"] : value;
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate !== candidate.trim() ||
    Buffer.byteLength(candidate, "utf8") > 512 ||
    !isPrintable(candidate)
  ) {
    return undefined;
  }
  return candidate;
}

export function subscriptionId(object: StripeObject): string | undefined {
  const direct = asStripeId(object["subscription"]);
  if (direct !== undefined) {
    return direct;
  }
  const parent = object["parent"];
  if (!isPlainRecord(parent)) {
    return undefined;
  }
  const details = parent["subscription_details"];
  return isPlainRecord(details)
    ? asStripeId(details["subscription"])
    : undefined;
}

export function subscriptionMetadata(object: StripeObject): StripeObject {
  const parent = object["parent"];
  if (isPlainRecord(parent)) {
    const details = parent["subscription_details"];
    if (isPlainRecord(details)) {
      const metadata = details["metadata"];
      if (isPlainRecord(metadata) && Object.keys(metadata).length > 0) {
        return metadata;
      }
    }
  }
  const legacy = object["subscription_details"];
  if (isPlainRecord(legacy)) {
    const metadata = legacy["metadata"];
    if (isPlainRecord(metadata) && Object.keys(metadata).length > 0) {
      return metadata;
    }
  }
  const metadata = object["metadata"];
  return isPlainRecord(metadata) ? metadata : {};
}

export function lineLookup(line: StripeObject): string | undefined {
  const resolved = line["_resolved_lookup_key"];
  if (typeof resolved === "string" && resolved.length > 0) {
    return resolved;
  }
  const price = line["price"];
  if (
    isPlainRecord(price) &&
    typeof price["lookup_key"] === "string" &&
    price["lookup_key"].length > 0
  ) {
    return price["lookup_key"];
  }
  const pricing = line["pricing"];
  const details = isPlainRecord(pricing) ? pricing["price_details"] : undefined;
  if (
    isPlainRecord(details) &&
    typeof details["lookup_key"] === "string" &&
    details["lookup_key"].length > 0
  ) {
    return details["lookup_key"];
  }
  return undefined;
}

export function linePriceId(line: StripeObject): string | undefined {
  const legacy = asStripeId(line["price"]);
  if (legacy !== undefined) {
    return legacy;
  }
  const pricing = line["pricing"];
  const details = isPlainRecord(pricing) ? pricing["price_details"] : undefined;
  return isPlainRecord(details) ? asStripeId(details["price"]) : undefined;
}

export function lineIsProration(line: StripeObject): boolean {
  if (line["proration"] === true) {
    return true;
  }
  const parent = line["parent"];
  const details = isPlainRecord(parent)
    ? parent["subscription_item_details"]
    : undefined;
  return isPlainRecord(details) && details["proration"] === true;
}

export function stripeInteger(value: unknown): bigint | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return undefined;
  }
  return BigInt(value);
}

export function stripeNonnegativeInteger(value: unknown): bigint | undefined {
  const parsed = stripeInteger(value);
  return parsed !== undefined && parsed >= 0n ? parsed : undefined;
}

export function validEventIdentifier(
  value: unknown,
  maxBytes: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    isPrintable(value)
  );
}

export function eventShapeError(event: StripeObject): string | undefined {
  const eventId = event["id"];
  if (!validEventIdentifier(eventId, 512)) {
    return "Stripe Event requires a stable visible string id";
  }
  const eventType = event["type"];
  if (!validEventIdentifier(eventType, 255)) {
    return "Stripe Event requires a stable visible string type";
  }
  if (!SUPPORTED_EVENT_TYPES.has(eventType)) {
    return undefined;
  }
  const created = stripeNonnegativeInteger(event["created"]);
  if (created === undefined || created > POSTGRES_BIGINT_MAX) {
    return "supported Stripe Event requires a PostgreSQL-bigint created timestamp";
  }
  if (typeof event["livemode"] !== "boolean") {
    return "supported Stripe Event requires a boolean livemode value";
  }
  const data = event["data"];
  if (!isPlainRecord(data)) {
    return "supported Stripe Event requires a data object";
  }
  const object = data["object"];
  if (!isPlainRecord(object)) {
    return "supported Stripe Event requires data.object to be an object";
  }
  if (typeof object["id"] !== "string" || object["id"].length === 0) {
    return "supported Stripe Event object requires a stable string id";
  }
  return undefined;
}

export function projectSubscriptionStatus(
  status: unknown,
): "active" | "past_due" | "canceled" | "none" {
  if (status === "active" || status === "trialing") {
    return "active";
  }
  if (status === "past_due" || status === "unpaid" || status === "paused") {
    return "past_due";
  }
  if (status === "canceled" || status === "incomplete_expired") {
    return "canceled";
  }
  return "none";
}

export interface ProjectionCursor {
  readonly created: bigint;
  readonly rank: number;
}

export function projectionOrder(
  current: ProjectionCursor,
  event: Pick<StripeObject, "created" | "type">,
): ProjectionCursor {
  const incomingCreated = stripeNonnegativeInteger(event["created"]) ?? 0n;
  const incomingRank = rankFor(String(event["type"]));
  if (
    incomingCreated > current.created ||
    (incomingCreated === current.created && incomingRank > current.rank)
  ) {
    return { created: incomingCreated, rank: incomingRank };
  }
  return current;
}

export function ceilRatio(
  units: bigint,
  numerator: bigint,
  denominator: bigint,
): bigint {
  if (units <= 0n || numerator <= 0n) {
    return 0n;
  }
  if (denominator <= 0n || numerator >= denominator) {
    return units;
  }
  return (units * numerator + denominator - 1n) / denominator;
}

export function annualSlotsAllowed(
  amount: bigint,
  refunded: bigint,
  minimum: number,
): number {
  if (!Number.isInteger(minimum) || minimum < 0 || minimum > 12) {
    throw new RangeError(
      "minimum annual slots must be an integer between zero and twelve",
    );
  }
  if (amount <= 0n) {
    return minimum;
  }
  const remaining =
    amount - (refunded < 0n ? 0n : refunded > amount ? amount : refunded);
  const rounded = (24n * remaining + amount) / (2n * amount);
  const bounded =
    rounded < BigInt(minimum) ? BigInt(minimum) : rounded > 12n ? 12n : rounded;
  return Number(bounded);
}
