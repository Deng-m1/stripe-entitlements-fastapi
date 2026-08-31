const STRIPE_ACCOUNT_SELECTOR = /^(?:acct|cus|sub)_[A-Za-z0-9_]+$/u;
const UUID_HEX = /^[0-9a-f]{32}$/iu;

function isUuidSelector(value: string): boolean {
  let candidate = value;
  if (candidate.toLowerCase().startsWith("urn:uuid:")) {
    candidate = candidate.slice("urn:uuid:".length);
  }
  if (candidate.startsWith("{") && candidate.endsWith("}")) {
    candidate = candidate.slice(1, -1);
  }
  return UUID_HEX.test(candidate.replaceAll("-", ""));
}

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
  if (isUuidSelector(value)) {
    throw new InvalidOwnerReferenceError(
      "owner_external_ref cannot be an internal account ID",
    );
  }
  return value;
}
