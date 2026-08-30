const TEST_SECRET = /^sk_test_[A-Za-z0-9]{16,}$/u;

/**
 * Fail closed before constructing a Stripe client. The error deliberately does
 * not interpolate the supplied credential.
 */
export function requireStripeTestSecret(value: unknown): string {
  if (typeof value !== "string" || !TEST_SECRET.test(value)) {
    throw new Error(
      "real Stripe tests require a well-formed sk_test_ secret and refuse live or malformed keys",
    );
  }
  return value;
}

export function optionalStripeTestSecret(value: unknown): string | undefined {
  return value === undefined || value === ""
    ? undefined
    : requireStripeTestSecret(value);
}
