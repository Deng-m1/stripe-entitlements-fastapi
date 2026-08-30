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

function isExplicitZero(value: unknown): boolean {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value === 0
  );
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * Return whether an Invoice participates in an adjustment mechanism that this
 * reference implementation deliberately does not fulfill.
 *
 * Presence matters even when Stripe computed a zero amount: a zero-valued tax
 * or discount object is still an unsupported Invoice shape.
 */
export function hasUnsupportedInvoiceAdjustments(
  invoice: unknown,
  lines: unknown,
): boolean {
  if (!isSupportedRecord(invoice) || !Array.isArray(lines)) {
    return true;
  }

  for (const field of [
    "starting_balance",
    "ending_balance",
    "pre_payment_credit_notes_amount",
    "post_payment_credit_notes_amount",
    "amount_overpaid",
  ] as const) {
    const value = invoice[field];
    if (!isAbsent(value) && !isExplicitZero(value)) {
      return true;
    }
  }

  const automaticTax = invoice["automatic_tax"];
  if (!isAbsent(automaticTax)) {
    if (!isSupportedRecord(automaticTax) || automaticTax["enabled"] !== false) {
      return true;
    }
  }

  if (!isAbsent(invoice["discount"])) {
    return true;
  }

  for (const field of [
    "discounts",
    "default_tax_rates",
    "total_tax_amounts",
    "total_taxes",
    "total_discount_amounts",
  ] as const) {
    const value = invoice[field];
    if (!isAbsent(value) && (!Array.isArray(value) || value.length !== 0)) {
      return true;
    }
  }

  for (const rawLine of lines) {
    if (!isSupportedRecord(rawLine)) {
      return true;
    }
    for (const field of [
      "discounts",
      "tax_amounts",
      "taxes",
      "discount_amounts",
      "pretax_credit_amounts",
      "tax_rates",
    ] as const) {
      const value = rawLine[field];
      if (!isAbsent(value) && (!Array.isArray(value) || value.length !== 0)) {
        return true;
      }
    }
  }
  return false;
}

/** Keep fulfillment on the single Stripe-collected payment model. */
export function hasUnsupportedInvoicePaymentShape(invoice: unknown): boolean {
  if (!isSupportedRecord(invoice)) {
    return true;
  }

  const paidOutOfBand = invoice["paid_out_of_band"];
  if (!isAbsent(paidOutOfBand) && paidOutOfBand !== false) {
    return true;
  }

  const amountOverpaid = invoice["amount_overpaid"];
  if (!isAbsent(amountOverpaid) && !isExplicitZero(amountOverpaid)) {
    return true;
  }

  const payments = invoice["payments"];
  if (isAbsent(payments)) {
    return false;
  }
  if (!isSupportedRecord(payments)) {
    return true;
  }

  const hasMore = payments["has_more"];
  if (!isAbsent(hasMore) && hasMore !== false) {
    return true;
  }

  const rawData = payments["data"];
  if (isAbsent(rawData)) {
    return false;
  }
  if (!Array.isArray(rawData) || rawData.length > 1) {
    return true;
  }
  const payment: unknown = rawData[0];
  if (payment === undefined) {
    return false;
  }
  if (!isSupportedRecord(payment)) {
    return true;
  }

  const status = payment["status"];
  if (!isAbsent(status) && status !== "paid") {
    return true;
  }

  const paymentDetails = payment["payment"];
  if (isAbsent(paymentDetails)) {
    return false;
  }
  if (!isSupportedRecord(paymentDetails)) {
    return true;
  }
  const type = paymentDetails["type"];
  return !isAbsent(type) && type !== "charge" && type !== "payment_intent";
}
