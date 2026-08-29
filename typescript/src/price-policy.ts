import type { BillingInterval } from "./types.js";

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

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

function ownValueOrDefault(
  value: Readonly<Record<string, unknown>>,
  field: string,
  fallback: unknown,
): unknown {
  return Object.hasOwn(value, field) ? value[field] : fallback;
}

function currencyOptionsMatch(
  value: unknown,
  expectedCurrency: string,
  expectedUnitAmount: number,
): boolean {
  if (isAbsent(value)) {
    return true;
  }
  if (!isSupportedRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return true;
  }
  if (keys.length !== 1 || keys[0] !== expectedCurrency) {
    return false;
  }
  const option = value[expectedCurrency];
  return (
    isSupportedRecord(option) &&
    typeof option["unit_amount"] === "number" &&
    Number.isSafeInteger(option["unit_amount"]) &&
    option["unit_amount"] === expectedUnitAmount &&
    isAbsent(option["custom_unit_amount"]) &&
    (isAbsent(option["tax_behavior"]) ||
      option["tax_behavior"] === "unspecified")
  );
}

function catalogIdentityMatches(
  price: Readonly<Record<string, unknown>>,
  product: Readonly<Record<string, unknown>>,
  expectedProductLine: string,
  expectedPlanKey: string,
): boolean {
  for (const metadata of [price["metadata"], product["metadata"]]) {
    if (isAbsent(metadata)) {
      continue;
    }
    if (!isSupportedRecord(metadata)) {
      return false;
    }
    const productLine = metadata["product_line"];
    const plan = metadata["plan"];
    if (!isAbsent(productLine) && productLine !== expectedProductLine) {
      return false;
    }
    if (!isAbsent(plan) && plan !== expectedPlanKey) {
      return false;
    }
  }
  return true;
}

export interface CatalogPriceExpectation {
  readonly expectedCurrency: string;
  readonly expectedUnitAmount: number;
  readonly expectedInterval: BillingInterval;
  readonly expectedProductLine: string;
  readonly expectedPlanKey: string;
  readonly expectedLookupKey?: string | null;
  readonly expectedPriceId?: string | null;
  readonly requireActive?: boolean;
}

/** Validate an expanded recurring Stripe Price against the immutable catalog. */
export function catalogPriceMatches(
  price: unknown,
  expected: CatalogPriceExpectation,
): boolean {
  if (
    !isSupportedRecord(price) ||
    !Number.isSafeInteger(expected.expectedUnitAmount)
  ) {
    return false;
  }
  const recurring = price["recurring"];
  const product = price["product"];
  if (!isSupportedRecord(recurring) || !isSupportedRecord(product)) {
    return false;
  }

  const requireActive = expected.requireActive ?? true;
  if (typeof requireActive !== "boolean") {
    return false;
  }
  const priceActive = ownValueOrDefault(price, "active", true);
  const productActive = ownValueOrDefault(product, "active", true);
  if (requireActive && (priceActive !== true || productActive !== true)) {
    return false;
  }

  const currency = price["currency"];
  const unitAmount = price["unit_amount"];
  const intervalCount = ownValueOrDefault(recurring, "interval_count", 1);
  return (
    catalogIdentityMatches(
      price,
      product,
      expected.expectedProductLine,
      expected.expectedPlanKey,
    ) &&
    (isAbsent(expected.expectedLookupKey) ||
      price["lookup_key"] === expected.expectedLookupKey) &&
    (isAbsent(expected.expectedPriceId) ||
      price["id"] === expected.expectedPriceId) &&
    typeof currency === "string" &&
    currency === currency.toLowerCase() &&
    currency === expected.expectedCurrency &&
    typeof unitAmount === "number" &&
    Number.isSafeInteger(unitAmount) &&
    unitAmount === expected.expectedUnitAmount &&
    recurring["interval"] === expected.expectedInterval &&
    typeof intervalCount === "number" &&
    Number.isSafeInteger(intervalCount) &&
    intervalCount === 1 &&
    ownValueOrDefault(recurring, "usage_type", "licensed") === "licensed" &&
    ownValueOrDefault(price, "type", "recurring") === "recurring" &&
    ownValueOrDefault(price, "billing_scheme", "per_unit") === "per_unit" &&
    isAbsent(price["tiers_mode"]) &&
    isAbsent(price["transform_quantity"]) &&
    isAbsent(price["custom_unit_amount"]) &&
    currencyOptionsMatch(
      price["currency_options"],
      expected.expectedCurrency,
      expected.expectedUnitAmount,
    ) &&
    (isAbsent(price["tax_behavior"]) || price["tax_behavior"] === "unspecified")
  );
}

export interface CatalogOneTimePriceExpectation {
  readonly expectedCurrency: string;
  readonly expectedUnitAmount: number;
  readonly expectedProductLine: string;
  readonly expectedPackKey: string;
  readonly expectedLookupKey: string;
  readonly requireActive?: boolean;
}

/** Validate the deliberately narrow one-time credit-pack Stripe Price shape. */
export function catalogOneTimePriceMatches(
  price: unknown,
  expected: CatalogOneTimePriceExpectation,
): boolean {
  if (
    !isSupportedRecord(price) ||
    !Number.isSafeInteger(expected.expectedUnitAmount)
  ) {
    return false;
  }
  const product = price["product"];
  if (!isSupportedRecord(product)) {
    return false;
  }
  for (const metadata of [price["metadata"], product["metadata"]]) {
    if (isAbsent(metadata)) {
      continue;
    }
    if (
      !isSupportedRecord(metadata) ||
      (!isAbsent(metadata["product_line"]) &&
        metadata["product_line"] !== expected.expectedProductLine) ||
      (!isAbsent(metadata["credit_pack"]) &&
        metadata["credit_pack"] !== expected.expectedPackKey) ||
      !isAbsent(metadata["plan"])
    ) {
      return false;
    }
  }

  const requireActive = expected.requireActive ?? true;
  if (typeof requireActive !== "boolean") {
    return false;
  }
  const currency = price["currency"];
  const unitAmount = price["unit_amount"];
  return (
    (!requireActive ||
      (price["active"] === true && product["active"] === true)) &&
    price["lookup_key"] === expected.expectedLookupKey &&
    ownValueOrDefault(price, "type", "one_time") === "one_time" &&
    isAbsent(price["recurring"]) &&
    typeof currency === "string" &&
    currency === currency.toLowerCase() &&
    currency === expected.expectedCurrency &&
    typeof unitAmount === "number" &&
    Number.isSafeInteger(unitAmount) &&
    unitAmount === expected.expectedUnitAmount &&
    ownValueOrDefault(price, "billing_scheme", "per_unit") === "per_unit" &&
    isAbsent(price["tiers_mode"]) &&
    isAbsent(price["transform_quantity"]) &&
    isAbsent(price["custom_unit_amount"]) &&
    (isAbsent(price["tax_behavior"]) ||
      price["tax_behavior"] === "unspecified") &&
    currencyOptionsMatch(
      price["currency_options"],
      expected.expectedCurrency,
      expected.expectedUnitAmount,
    )
  );
}
