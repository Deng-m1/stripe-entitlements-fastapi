import type { JsonObject, JsonValue } from "./types.js";

const SECRET_VALUE =
  /(?<![A-Za-z0-9])(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|(?<![A-Za-z0-9])whsec_[A-Za-z0-9]+|[A-Za-z0-9]+_secret_[A-Za-z0-9]+/u;
const AUDIT_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SLUG = /^[a-z][a-z0-9_-]{0,127}$/u;
const CANONICAL_CREDITS = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,18}$/u;
const METADATA_PATTERNS = [
  ["account_id", UUID],
  ["billing_kind", /^credit_pack$/u],
  ["credit_pack_order_id", UUID],
  ["currency", /^[a-z]{3}$/u],
  ["expires_days", /^[1-9][0-9]{0,3}$/u],
  ["lookup_key", SLUG],
  ["pack_credits", CANONICAL_CREDITS],
  ["pack_key", SLUG],
  ["pack_schema_version", /^[1-9][0-9]{0,3}$/u],
  ["plan", SLUG],
  ["plan_key", SLUG],
  ["plan_interval", /^(?:month|year)$/u],
  ["price_amount", POSITIVE_INTEGER],
  ["product_line", SLUG],
  ["transition_policy", /^(?:full_period_reset|prorated_delta)$/u],
] as const satisfies readonly (readonly [string, RegExp])[];
const OBJECT_ID_FIELDS = [
  "customer",
  "subscription",
  "invoice",
  "payment_intent",
  "charge",
  "latest_charge",
] as const;
const OBJECT_TOKEN_FIELDS = [
  "object",
  "status",
  "payment_status",
  "mode",
  "billing_reason",
] as const;
const OBJECT_BOOLEAN_FIELDS = ["livemode", "paid", "refunded"] as const;
const OBJECT_INTEGER_FIELDS = [
  "created",
  "amount",
  "amount_due",
  "amount_paid",
  "amount_received",
  "amount_refunded",
] as const;

function isSupportedRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      return false;
    }
    return Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key === "string" &&
        descriptor !== undefined &&
        descriptor.enumerable &&
        "value" in descriptor
      );
    });
  } catch {
    return false;
  }
}

function auditToken(value: unknown): string | undefined {
  return typeof value === "string" &&
    AUDIT_TOKEN.test(value) &&
    !SECRET_VALUE.test(value)
    ? value
    : undefined;
}

function objectId(value: unknown): string | undefined {
  const candidate = isSupportedRecord(value) ? value["id"] : value;
  return auditToken(candidate);
}

function safeMetadata(value: unknown): Record<string, JsonValue> {
  const safe: Record<string, JsonValue> = {};
  if (!isSupportedRecord(value)) {
    return safe;
  }
  for (const [key, pattern] of METADATA_PATTERNS) {
    const candidate = value[key];
    if (
      typeof candidate === "string" &&
      pattern.test(candidate) &&
      !SECRET_VALUE.test(candidate)
    ) {
      safe[key] = candidate;
    }
  }
  return safe;
}

function auditObject(value: unknown): Record<string, JsonValue> {
  const audit: Record<string, JsonValue> = {};
  if (!isSupportedRecord(value)) {
    return audit;
  }
  const id = objectId(value["id"]);
  if (id !== undefined) {
    audit["id"] = id;
  }
  for (const field of OBJECT_ID_FIELDS) {
    const identifier = objectId(value[field]);
    if (identifier !== undefined) {
      audit[field] = identifier;
    }
  }
  for (const field of OBJECT_TOKEN_FIELDS) {
    const token = auditToken(value[field]);
    if (token !== undefined) {
      audit[field] = token;
    }
  }
  const clientReferenceId = value["client_reference_id"];
  if (typeof clientReferenceId === "string" && UUID.test(clientReferenceId)) {
    audit["client_reference_id"] = clientReferenceId;
  }
  const currency = value["currency"];
  if (typeof currency === "string" && /^[a-z]{3}$/u.test(currency)) {
    audit["currency"] = currency;
  }
  for (const field of OBJECT_BOOLEAN_FIELDS) {
    const candidate = value[field];
    if (typeof candidate === "boolean") {
      audit[field] = candidate;
    }
  }
  for (const field of OBJECT_INTEGER_FIELDS) {
    const candidate = value[field];
    if (typeof candidate === "number" && Number.isSafeInteger(candidate)) {
      audit[field] = candidate;
    }
  }
  const metadata = safeMetadata(value["metadata"]);
  if (Object.keys(metadata).length > 0) {
    audit["metadata"] = metadata;
  }
  return audit;
}

/** Return a minimal operational allowlist, never a recursively copied Event. */
export function redactedEventSnapshot(event: unknown): JsonObject {
  const snapshot: Record<string, JsonValue> = {};
  if (!isSupportedRecord(event)) {
    return snapshot;
  }
  for (const field of ["id", "object", "type", "api_version"] as const) {
    const token = auditToken(event[field]);
    if (token !== undefined) {
      snapshot[field] = token;
    }
  }
  const livemode = event["livemode"];
  if (typeof livemode === "boolean") {
    snapshot["livemode"] = livemode;
  }
  const created = event["created"];
  if (typeof created === "number" && Number.isSafeInteger(created)) {
    snapshot["created"] = created;
  }
  const data = event["data"];
  if (isSupportedRecord(data)) {
    const object = auditObject(data["object"]);
    if (Object.keys(object).length > 0) {
      snapshot["data"] = { object };
    }
  }
  return snapshot;
}
