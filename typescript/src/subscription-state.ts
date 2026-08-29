import { POSTGRES_BIGINT_MAX } from "./bounds.js";
import type { PgTimestamp } from "./types.js";

const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/u;
const MICROS_PER_SECOND = 1_000_000n;
const SECONDS_PER_DAY = 86_400n;

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

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  const lengths = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return lengths[month - 1] ?? 0;
}

// Howard Hinnant's proleptic-Gregorian civil-date conversion.
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

function timestampMicros(value: unknown): bigint | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = TIMESTAMP.exec(value);
  if (match === null) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const timezone = match[8];
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    timezone === undefined
  ) {
    return undefined;
  }

  let offsetSeconds = 0;
  if (timezone !== "Z") {
    const sign = timezone.startsWith("+") ? 1 : -1;
    const compact = timezone.slice(1).replace(":", "");
    const offsetHours = Number(compact.slice(0, 2));
    const offsetMinutes = compact.length === 4 ? Number(compact.slice(2)) : 0;
    if (offsetHours > 23 || offsetMinutes > 59) {
      return undefined;
    }
    offsetSeconds = sign * (offsetHours * 3600 + offsetMinutes * 60);
  }

  const localSeconds =
    daysFromCivil(year, month, day) * SECONDS_PER_DAY +
    BigInt(hour * 3600 + minute * 60 + second);
  const fractionalMicros = BigInt(fraction.padEnd(6, "0") || "0");
  return (
    (localSeconds - BigInt(offsetSeconds)) * MICROS_PER_SECOND +
    fractionalMicros
  );
}

export interface SubscriptionSpendabilityInput {
  readonly asOf: PgTimestamp | null | undefined;
}

/** Whether stored subscription funding remains spendable at the supplied DB time. */
export function subscriptionCreditsAreSpendable(
  account: unknown,
  input: SubscriptionSpendabilityInput,
): boolean {
  if (
    !isSupportedRecord(account) ||
    !isSupportedRecord(input) ||
    account["subscription_status"] !== "active"
  ) {
    return false;
  }
  const revoked = account["entitlement_revoked"];
  if (revoked !== undefined && revoked !== null && revoked !== false) {
    return false;
  }
  const asOf = timestampMicros(input.asOf);
  const expiresAt = timestampMicros(account["credit_expires_at"]);
  return asOf !== undefined && expiresAt !== undefined && expiresAt > asOf;
}

/** Return exact PostgreSQL bigint atoms, or zero when funding is not enforceable. */
export function spendableSubscriptionAtoms(
  account: unknown,
  input: SubscriptionSpendabilityInput,
): bigint {
  if (
    !subscriptionCreditsAreSpendable(account, input) ||
    !isSupportedRecord(account)
  ) {
    return 0n;
  }
  const balance = account["credits_balance"];
  return typeof balance === "bigint" &&
    balance >= 0n &&
    balance <= POSTGRES_BIGINT_MAX
    ? balance
    : 0n;
}
