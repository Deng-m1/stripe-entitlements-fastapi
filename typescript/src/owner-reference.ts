const STRIPE_ACCOUNT_SELECTOR = /^(?:acct|cus|sub)_[A-Za-z0-9_]+$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class InvalidOwnerReferenceError extends Error {}

export function validateOwnerExternalRef(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > 512 ||
    [...value].some((character) => /\p{C}/u.test(character))
  ) {
    throw new InvalidOwnerReferenceError("owner_external_ref is invalid");
  }
  if (STRIPE_ACCOUNT_SELECTOR.test(value)) {
    throw new InvalidOwnerReferenceError(
      "owner_external_ref cannot be a Stripe identifier",
    );
  }
  if (UUID.test(value)) {
    throw new InvalidOwnerReferenceError(
      "owner_external_ref cannot be an internal account ID",
    );
  }
  return value;
}
