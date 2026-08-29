import { createHash, timingSafeEqual } from "node:crypto";

import type { BillingCsrfMode } from "./contracts.js";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const CRON_SECRET_MIN_BYTES = 16;
const CRON_SECRET_MAX_BYTES = 512;
const MAX_AUTHORIZATION_BYTES = 2_048;

function isBareHttpOrigin(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.origin === value.replace(/\/$/u, "")
  );
}

export function normalizeAllowedOrigins(
  values: readonly string[],
): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const raw of values) {
    if (raw === "*" || raw !== raw.trim() || !isBareHttpOrigin(raw)) {
      throw new TypeError(
        "allowed origins must be unique bare HTTP(S) origins",
      );
    }
    const normalized = raw.replace(/\/$/u, "");
    if (origins.has(normalized)) {
      throw new TypeError(
        "allowed origins must be unique bare HTTP(S) origins",
      );
    }
    origins.add(normalized);
  }
  return origins;
}

export interface MutationOriginDecision {
  readonly allowed: boolean;
  readonly reason?: "missing" | "cross-site" | "untrusted";
}

export function mutationOriginDecision(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
  mode: BillingCsrfMode,
): MutationOriginDecision {
  if (!MUTATION_METHODS.has(request.method.toUpperCase())) {
    return { allowed: true };
  }
  const origin = request.headers.get("origin");
  if (origin === null) {
    return mode === "same-origin-session"
      ? { allowed: false, reason: "missing" }
      : { allowed: true };
  }
  if (
    mode === "same-origin-session" &&
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    return { allowed: false, reason: "cross-site" };
  }
  if (!allowedOrigins.has(origin)) {
    return { allowed: false, reason: "untrusted" };
  }
  return { allowed: true };
}

export function validateCronSecret(
  secret: string | undefined,
): string | undefined {
  // This is a configuration-presence branch, not a comparison with secret data.
  // eslint-disable-next-line security/detect-possible-timing-attacks
  if (secret === undefined) {
    return undefined;
  }
  const length = Buffer.byteLength(secret, "utf8");
  if (
    secret !== secret.trim() ||
    length < CRON_SECRET_MIN_BYTES ||
    length > CRON_SECRET_MAX_BYTES ||
    !/^[\x20-\x7e]+$/u.test(secret)
  ) {
    throw new TypeError(
      "cron secret must be 16 to 512 visible ASCII characters",
    );
  }
  return secret;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function cronAuthorizationMatches(
  authorization: string | null,
  secret: string,
): boolean {
  const supplied = authorization ?? "";
  // Hash first so timingSafeEqual always compares fixed-length buffers. The header
  // limit also prevents an attacker from using this check as an unbounded hash sink.
  if (Buffer.byteLength(supplied, "utf8") > MAX_AUTHORIZATION_BYTES) {
    return false;
  }
  return timingSafeEqual(digest(supplied), digest(`Bearer ${secret}`));
}
