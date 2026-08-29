import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import type { CryptoKey, JWK, JWSAlgorithm, JWTPayload } from "jose";

import { AuthenticationError } from "./auth.js";
import type { AuthAccountAdapter, AuthenticatedIdentity } from "./auth.js";
import {
  BodyReadError,
  BodyTooLargeError,
  readBoundedResponseBody,
} from "./bounded-body.js";
import {
  isPlainRecord,
  isPrintable,
  requiredVisibleString,
} from "./validation.js";

const ASYMMETRIC_JWT_ALGORITHMS = new Set<string>([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
]);
const MAX_BEARER_BYTES = 16_384;
const MAX_CLAIM_BYTES = 512;
const MAX_JWKS_BYTES = 1_048_576;
const MAX_JWKS_KEYS = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(
      `${field} must be an integer from ${String(minimum)} to ${String(maximum)}`,
    );
  }
  return value;
}

function httpsUrl(value: unknown, field: string, maximum: number): string {
  const normalized = requiredVisibleString(value, field, maximum);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch (error) {
    throw new TypeError(
      `${field} must be an HTTPS URL without credentials or fragment`,
      { cause: error },
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.host.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new TypeError(
      `${field} must be an HTTPS URL without credentials or fragment`,
    );
  }
  return normalized;
}

function canonicalUuid(value: unknown, field: string): string {
  let normalized: string;
  try {
    normalized = requiredVisibleString(value, field, MAX_CLAIM_BYTES);
  } catch (error) {
    throw new AuthenticationError("invalid bearer token", { cause: error });
  }
  if (!UUID.test(normalized) || normalized === NIL_UUID) {
    throw new AuthenticationError("invalid bearer token");
  }
  return normalized;
}

function verifiedEmail(
  claims: Readonly<Record<string, unknown>>,
): string | undefined {
  if (claims["email_verified"] !== true) {
    return undefined;
  }
  let email: string;
  try {
    email = requiredVisibleString(claims["email"], "email", 320);
  } catch (error) {
    throw new AuthenticationError("invalid bearer token", { cause: error });
  }
  if (email.split("@").length !== 2 || /\s/u.test(email)) {
    throw new AuthenticationError("invalid bearer token");
  }
  return email;
}

export interface JwtVerificationConfigOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly algorithms?: readonly string[];
  readonly leewaySeconds?: number;
  readonly jwksCacheSeconds?: number;
  readonly jwksTimeoutSeconds?: number;
  readonly jwksRefreshCooldownSeconds?: number;
  readonly jwksMaxConcurrentLookups?: number;
  readonly jwksUnknownKidCacheSize?: number;
  readonly jwksUnknownKidTtlSeconds?: number;
}

/** Strict verification contract for exactly one production issuer and audience. */
export class JwtVerificationConfig {
  public readonly issuer: string;
  public readonly audience: string;
  public readonly jwksUrl: string;
  public readonly algorithms: readonly JWSAlgorithm[];
  public readonly leewaySeconds: number;
  public readonly jwksCacheSeconds: number;
  public readonly jwksTimeoutSeconds: number;
  public readonly jwksRefreshCooldownSeconds: number;
  public readonly jwksMaxConcurrentLookups: number;
  public readonly jwksUnknownKidCacheSize: number;
  public readonly jwksUnknownKidTtlSeconds: number;

  public constructor(options: JwtVerificationConfigOptions) {
    this.issuer = httpsUrl(options.issuer, "issuer", 2048);
    this.audience = requiredVisibleString(options.audience, "audience", 512);
    this.jwksUrl = httpsUrl(options.jwksUrl, "JWKS URL", 2048);
    const algorithms: unknown = options.algorithms ?? ["RS256"];
    if (
      !Array.isArray(algorithms) ||
      algorithms.length === 0 ||
      new Set(algorithms as unknown[]).size !== algorithms.length ||
      (algorithms as unknown[]).some(
        (algorithm) =>
          typeof algorithm !== "string" ||
          !ASYMMETRIC_JWT_ALGORITHMS.has(algorithm),
      )
    ) {
      throw new TypeError(
        "algorithms must be a non-empty unique asymmetric JWT allowlist",
      );
    }
    this.algorithms = Object.freeze(
      (algorithms as unknown[]).map((algorithm) => algorithm as JWSAlgorithm),
    );
    this.leewaySeconds = boundedInteger(
      options.leewaySeconds ?? 0,
      "leewaySeconds",
      0,
      300,
    );
    this.jwksCacheSeconds = boundedInteger(
      options.jwksCacheSeconds ?? 300,
      "jwksCacheSeconds",
      1,
      86_400,
    );
    this.jwksTimeoutSeconds = boundedInteger(
      options.jwksTimeoutSeconds ?? 5,
      "jwksTimeoutSeconds",
      1,
      30,
    );
    this.jwksRefreshCooldownSeconds = boundedInteger(
      options.jwksRefreshCooldownSeconds ?? 5,
      "jwksRefreshCooldownSeconds",
      1,
      60,
    );
    this.jwksMaxConcurrentLookups = boundedInteger(
      options.jwksMaxConcurrentLookups ?? 8,
      "jwksMaxConcurrentLookups",
      1,
      64,
    );
    this.jwksUnknownKidCacheSize = boundedInteger(
      options.jwksUnknownKidCacheSize ?? 1024,
      "jwksUnknownKidCacheSize",
      1,
      4096,
    );
    this.jwksUnknownKidTtlSeconds = boundedInteger(
      options.jwksUnknownKidTtlSeconds ?? 5,
      "jwksUnknownKidTtlSeconds",
      1,
      300,
    );
    if (this.jwksCacheSeconds < this.jwksRefreshCooldownSeconds) {
      throw new RangeError(
        "jwksCacheSeconds must be greater than or equal to jwksRefreshCooldownSeconds",
      );
    }
    Object.freeze(this);
  }
}

export interface VerifiedJwt {
  readonly userId: string;
  readonly email?: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

export interface JwtSigningKey {
  readonly key: CryptoKey;
  readonly keyId: string;
  readonly algorithm: JWSAlgorithm;
}

export interface SigningKeyProvider {
  signingKey(token: string): Promise<JwtSigningKey>;
}

/** A valid JWKS document was fetched but did not contain the selected signing key. */
export class SigningKeyNotFoundError extends Error {}

/** The configured JWKS transport or document is temporarily unusable. */
export class JwksUnavailableError extends Error {}

/** Sanitized, retryable identity-provider failure for HTTP adapters. */
export class IdentityProviderUnavailable extends Error {
  public readonly statusCode = 503;
  public readonly retryAfterSeconds = 5;

  public constructor(options?: ErrorOptions) {
    super("identity provider temporarily unavailable", options);
  }
}

interface ParsedJwtHeader {
  readonly algorithm: JWSAlgorithm;
  readonly keyId: string;
}

function parsedJwtHeader(token: string): ParsedJwtHeader {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch (error) {
    throw new AuthenticationError("invalid bearer token", { cause: error });
  }
  const algorithm = header.alg;
  const keyId = header.kid;
  if (typeof algorithm !== "string") {
    throw new AuthenticationError("invalid bearer token");
  }
  let normalizedKeyId: string;
  try {
    normalizedKeyId = requiredVisibleString(keyId, "JWT kid", MAX_CLAIM_BYTES);
  } catch (error) {
    throw new AuthenticationError("invalid bearer token", { cause: error });
  }
  return { algorithm: algorithm as JWSAlgorithm, keyId: normalizedKeyId };
}

type KeyAlgorithms = ReadonlyMap<JWSAlgorithm, CryptoKey>;

interface SigningKeySnapshot {
  readonly signingKeys: ReadonlyMap<string, KeyAlgorithms>;
  readonly expiresAt: number;
}

interface RefreshInFlight {
  readonly keyId: string;
  readonly promise: Promise<SigningKeySnapshot>;
}

export interface JwksSigningKeyProviderOptions {
  readonly fetcher?: (input: string, init: RequestInit) => Promise<Response>;
  /** Monotonic time in seconds. Intended for deterministic tests. */
  readonly monotonicSeconds?: () => number;
}

function algorithmsForJwk(
  jwk: JWK,
  configured: ReadonlySet<string>,
): readonly JWSAlgorithm[] {
  if (typeof jwk.alg === "string") {
    return configured.has(jwk.alg) ? [jwk.alg as JWSAlgorithm] : [];
  }
  let candidates: readonly string[];
  switch (jwk.kty) {
    case "RSA":
      candidates = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512"];
      break;
    case "EC":
      switch (jwk.crv) {
        case "P-256":
          candidates = ["ES256"];
          break;
        case "P-384":
          candidates = ["ES384"];
          break;
        case "P-521":
          candidates = ["ES512"];
          break;
        default:
          candidates = [];
      }
      break;
    case "OKP":
      candidates =
        jwk.crv === "Ed25519" || jwk.crv === "Ed448" ? ["EdDSA"] : [];
      break;
    default:
      candidates = [];
  }
  return candidates.filter((algorithm) =>
    configured.has(algorithm),
  ) as JWSAlgorithm[];
}

function usableForSignature(jwk: JWK): boolean {
  if (jwk.use !== undefined && jwk.use !== "sig") {
    return false;
  }
  if (jwk.key_ops !== undefined) {
    return (
      Array.isArray(jwk.key_ops) &&
      jwk.key_ops.every((operation) => typeof operation === "string") &&
      jwk.key_ops.includes("verify")
    );
  }
  return true;
}

async function importedSigningKeys(
  document: unknown,
  configuredAlgorithms: readonly JWSAlgorithm[],
): Promise<ReadonlyMap<string, KeyAlgorithms>> {
  if (!isPlainRecord(document) || !Array.isArray(document["keys"])) {
    throw new JwksUnavailableError(
      "JWKS endpoint returned an invalid document",
    );
  }
  const rawKeys = document["keys"];
  if (rawKeys.length === 0 || rawKeys.length > MAX_JWKS_KEYS) {
    throw new JwksUnavailableError(
      "JWKS endpoint returned an invalid key count",
    );
  }
  const configured = new Set<string>(configuredAlgorithms);
  const result = new Map<string, KeyAlgorithms>();
  for (const rawKey of rawKeys) {
    if (!isPlainRecord(rawKey)) {
      throw new JwksUnavailableError("JWKS endpoint returned a malformed key");
    }
    const jwk = { ...rawKey } as JWK;
    if (!usableForSignature(jwk)) {
      continue;
    }
    if (typeof jwk.kty !== "string" || jwk.kty === "oct" || "d" in jwk) {
      throw new JwksUnavailableError(
        "JWKS endpoint returned a non-public signing key",
      );
    }
    let keyId: string;
    try {
      keyId = requiredVisibleString(jwk.kid, "JWKS kid", MAX_CLAIM_BYTES);
    } catch (error) {
      throw new JwksUnavailableError(
        "JWKS endpoint returned a signing key without kid",
        {
          cause: error,
        },
      );
    }
    if (result.has(keyId)) {
      throw new JwksUnavailableError(
        "JWKS endpoint returned duplicate signing key ids",
      );
    }
    const algorithms = algorithmsForJwk(jwk, configured);
    if (algorithms.length === 0) {
      continue;
    }
    const keys = new Map<JWSAlgorithm, CryptoKey>();
    for (const algorithm of algorithms) {
      try {
        const imported = (await importJWK(jwk, algorithm)) as CryptoKey;
        keys.set(algorithm, imported);
      } catch (error) {
        throw new JwksUnavailableError(
          "JWKS endpoint returned an unusable signing key",
          {
            cause: error,
          },
        );
      }
    }
    result.set(keyId, keys);
  }
  if (result.size === 0) {
    throw new JwksUnavailableError(
      "JWKS endpoint returned no usable signing keys",
    );
  }
  return result;
}

/**
 * Bounded remote JWKS resolver with one global cross-kid refresh budget.
 *
 * Same-kid cold requests share one refresh. Distinct misses fail fast while that
 * refresh is running, and random kids cannot each force an identity-provider call.
 */
export class JwksSigningKeyProvider implements SigningKeyProvider {
  readonly #config: JwtVerificationConfig;
  readonly #fetcher: (input: string, init: RequestInit) => Promise<Response>;
  readonly #monotonicSeconds: () => number;
  readonly #unknownKids = new Map<string, number>();
  #snapshot: SigningKeySnapshot | undefined;
  #nextRefreshAt = 0;
  #refreshInFlight: RefreshInFlight | undefined;
  #lastRefreshFailed = false;

  public constructor(
    config: JwtVerificationConfig,
    options: JwksSigningKeyProviderOptions = {},
  ) {
    this.#config = config;
    this.#fetcher =
      options.fetcher ??
      ((input, init): Promise<Response> => globalThis.fetch(input, init));
    this.#monotonicSeconds =
      options.monotonicSeconds ?? (() => performance.now() / 1000);
  }

  #match(
    snapshot: SigningKeySnapshot | undefined,
    header: ParsedJwtHeader,
  ): JwtSigningKey | undefined {
    const key = snapshot?.signingKeys.get(header.keyId)?.get(header.algorithm);
    return key === undefined
      ? undefined
      : { key, keyId: header.keyId, algorithm: header.algorithm };
  }

  #unknownIsCached(keyId: string, now: number): boolean {
    const expiresAt = this.#unknownKids.get(keyId);
    if (expiresAt === undefined) {
      return false;
    }
    if (now >= expiresAt) {
      this.#unknownKids.delete(keyId);
      return false;
    }
    this.#unknownKids.delete(keyId);
    this.#unknownKids.set(keyId, expiresAt);
    return true;
  }

  #rememberUnknown(keyId: string, now: number): void {
    this.#unknownKids.delete(keyId);
    this.#unknownKids.set(
      keyId,
      Math.min(
        now + this.#config.jwksUnknownKidTtlSeconds,
        this.#nextRefreshAt,
      ),
    );
    while (this.#unknownKids.size > this.#config.jwksUnknownKidCacheSize) {
      for (const oldest of this.#unknownKids.keys()) {
        this.#unknownKids.delete(oldest);
        break;
      }
    }
  }

  async #fetchSnapshot(): Promise<SigningKeySnapshot> {
    const abort = new AbortController();
    let rejectTimeout: ((reason: JwksUnavailableError) => void) | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      abort.abort();
      rejectTimeout?.(
        new JwksUnavailableError("JWKS endpoint request timed out"),
      );
    }, this.#config.jwksTimeoutSeconds * 1000);
    timeout.unref();
    let response: Response;
    try {
      response = await Promise.race([
        this.#fetcher(this.#config.jwksUrl, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "error",
          signal: abort.signal,
        }),
        timedOut,
      ]);
    } catch (error) {
      clearTimeout(timeout);
      throw new JwksUnavailableError("JWKS endpoint request failed", {
        cause: error,
      });
    }
    try {
      if (!response.ok) {
        throw new JwksUnavailableError(
          "JWKS endpoint returned an unsuccessful response",
        );
      }
      const advertisedLength = response.headers.get("content-length");
      let declaredLength: number | undefined;
      if (advertisedLength !== null) {
        if (!/^\d+$/u.test(advertisedLength)) {
          throw new JwksUnavailableError(
            "JWKS endpoint returned an invalid content length",
          );
        }
        const length = Number(advertisedLength);
        if (!Number.isSafeInteger(length) || length > MAX_JWKS_BYTES) {
          throw new JwksUnavailableError(
            "JWKS endpoint returned an invalid content length",
          );
        }
        declaredLength = length;
      }
      let payload: Uint8Array;
      try {
        payload = await readBoundedResponseBody(response, MAX_JWKS_BYTES, {
          signal: abort.signal,
        });
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          throw new JwksUnavailableError(
            "JWKS endpoint returned an invalid response size",
          );
        }
        if (!(error instanceof BodyReadError)) {
          throw error;
        }
        throw new JwksUnavailableError(
          "JWKS endpoint response could not be read",
          {
            cause: error,
          },
        );
      }
      clearTimeout(timeout);
      if (payload.byteLength === 0 || payload.byteLength > MAX_JWKS_BYTES) {
        throw new JwksUnavailableError(
          "JWKS endpoint returned an invalid response size",
        );
      }
      if (
        declaredLength !== undefined &&
        declaredLength !== payload.byteLength
      ) {
        throw new JwksUnavailableError(
          "JWKS endpoint returned an invalid content length",
        );
      }
      let document: unknown;
      try {
        document = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(payload),
        ) as unknown;
      } catch (error) {
        throw new JwksUnavailableError("JWKS endpoint returned invalid JSON", {
          cause: error,
        });
      }
      const signingKeys = await importedSigningKeys(
        document,
        this.#config.algorithms,
      );
      return {
        signingKeys,
        expiresAt: this.#monotonicSeconds() + this.#config.jwksCacheSeconds,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  #startRefresh(
    keyId: string,
    reservedUntil: number,
  ): Promise<SigningKeySnapshot> {
    const promise = this.#fetchSnapshot();
    this.#refreshInFlight = { keyId, promise };
    void promise.then(
      (snapshot) => {
        const completedAt = this.#monotonicSeconds();
        this.#snapshot = snapshot;
        this.#nextRefreshAt = Math.max(
          reservedUntil,
          completedAt + this.#config.jwksRefreshCooldownSeconds,
        );
        this.#lastRefreshFailed = false;
        this.#unknownKids.clear();
        if (this.#refreshInFlight?.promise === promise) {
          this.#refreshInFlight = undefined;
        }
      },
      () => {
        const completedAt = this.#monotonicSeconds();
        this.#nextRefreshAt = Math.max(
          reservedUntil,
          completedAt + this.#config.jwksRefreshCooldownSeconds,
        );
        this.#lastRefreshFailed = true;
        if (this.#refreshInFlight?.promise === promise) {
          this.#refreshInFlight = undefined;
        }
      },
    );
    return promise;
  }

  public async signingKey(token: string): Promise<JwtSigningKey> {
    const header = parsedJwtHeader(token);
    for (;;) {
      const now = this.#monotonicSeconds();
      const snapshot = this.#snapshot;
      if (snapshot !== undefined && now < snapshot.expiresAt) {
        const known = this.#match(snapshot, header);
        if (known !== undefined) {
          return known;
        }
      }

      if (this.#unknownIsCached(header.keyId, now)) {
        throw new SigningKeyNotFoundError(
          "JWKS does not contain the selected signing key",
        );
      }
      const inFlight = this.#refreshInFlight;
      if (inFlight !== undefined) {
        if (inFlight.keyId !== header.keyId) {
          throw new JwksUnavailableError("JWKS refresh is in progress");
        }
        await inFlight.promise;
        continue;
      }
      if (now < this.#nextRefreshAt) {
        const stale = this.#match(snapshot, header);
        if (this.#lastRefreshFailed || stale !== undefined) {
          throw new JwksUnavailableError("JWKS refresh is cooling down");
        }
        this.#rememberUnknown(header.keyId, now);
        throw new SigningKeyNotFoundError(
          "JWKS does not contain the selected signing key",
        );
      }

      const reservedUntil = now + this.#config.jwksRefreshCooldownSeconds;
      this.#nextRefreshAt = reservedUntil;
      this.#lastRefreshFailed = false;
      const refreshed = await this.#startRefresh(header.keyId, reservedUntil);
      const known = this.#match(refreshed, header);
      if (known !== undefined) {
        return known;
      }
      this.#rememberUnknown(header.keyId, this.#monotonicSeconds());
      throw new SigningKeyNotFoundError(
        "JWKS does not contain the selected signing key",
      );
    }
  }
}

class AsyncSemaphore {
  #available: number;
  readonly #waiters: ((release: () => void) => void)[] = [];

  public constructor(capacity: number) {
    this.#available = capacity;
  }

  public acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve(this.#releaseFunction());
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #releaseFunction(): () => void {
    return () => {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        this.#available += 1;
      } else {
        waiter(this.#releaseFunction());
      }
    };
  }
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const separator = authorization.indexOf(" ");
  const scheme =
    separator < 0 ? authorization : authorization.slice(0, separator);
  const token = separator < 0 ? "" : authorization.slice(separator + 1);
  if (
    scheme.toLowerCase() !== "bearer" ||
    token.length === 0 ||
    token !== token.trim() ||
    /\s/u.test(token) ||
    !/^[A-Za-z0-9._-]+$/u.test(token) ||
    Buffer.byteLength(token, "ascii") > MAX_BEARER_BYTES
  ) {
    throw new AuthenticationError("invalid bearer token");
  }
  return token;
}

/** Verify an asymmetric Bearer JWT, including strict claims and bounded JWKS lookup. */
export class JwtVerifier {
  readonly #config: JwtVerificationConfig;
  readonly #signingKeys: SigningKeyProvider;
  readonly #lookupSlots: AsyncSemaphore;

  public constructor(
    config: JwtVerificationConfig,
    options: { readonly signingKeys?: SigningKeyProvider } = {},
  ) {
    this.#config = config;
    this.#signingKeys =
      options.signingKeys ?? new JwksSigningKeyProvider(config);
    this.#lookupSlots = new AsyncSemaphore(config.jwksMaxConcurrentLookups);
  }

  public async verifyRequest(request: Request): Promise<VerifiedJwt> {
    const token = bearerToken(request);
    const header = parsedJwtHeader(token);
    if (!this.#config.algorithms.includes(header.algorithm)) {
      throw new AuthenticationError("invalid bearer token");
    }

    const release = await this.#lookupSlots.acquire();
    let signingKey: JwtSigningKey;
    try {
      signingKey = await this.#signingKeys.signingKey(token);
    } catch (error) {
      if (error instanceof JwksUnavailableError) {
        throw new IdentityProviderUnavailable({ cause: error });
      }
      throw new AuthenticationError("invalid bearer token", { cause: error });
    } finally {
      release();
    }
    if (
      signingKey.keyId !== header.keyId ||
      signingKey.algorithm !== header.algorithm
    ) {
      throw new AuthenticationError("invalid bearer token");
    }

    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, signingKey.key, {
        algorithms: [header.algorithm],
        issuer: this.#config.issuer,
        audience: this.#config.audience,
        clockTolerance: this.#config.leewaySeconds,
        requiredClaims: ["exp", "nbf", "sub"],
      });
      payload = verified.payload;
    } catch (error) {
      throw new AuthenticationError("invalid bearer token", { cause: error });
    }
    if (
      payload.aud !== this.#config.audience ||
      !Number.isSafeInteger(payload.exp) ||
      !Number.isSafeInteger(payload.nbf)
    ) {
      throw new AuthenticationError("invalid bearer token");
    }
    const userId = canonicalUuid(payload.sub, "sub");
    const claims = Object.freeze({ ...payload }) as Readonly<
      Record<string, unknown>
    >;
    const email = verifiedEmail(claims);
    return email === undefined ? { userId, claims } : { userId, email, claims };
  }
}

/** Map one verified host user UUID to one personal billing owner. */
export class PersonalJwtAuthAdapter implements AuthAccountAdapter {
  readonly #verifier: JwtVerifier;

  public constructor(verifier: JwtVerifier) {
    this.#verifier = verifier;
  }

  public async authenticate(request: Request): Promise<AuthenticatedIdentity> {
    const principal = await this.#verifier.verifyRequest(request);
    return principal.email === undefined
      ? { externalRef: `v1:user:${principal.userId}` }
      : {
          externalRef: `v1:user:${principal.userId}`,
          email: principal.email,
        };
  }
}

export enum TeamBillingRole {
  Viewer = "viewer",
  BillingAdmin = "billing_admin",
}

export enum TeamBillingCapability {
  CatalogRead = "catalog:read",
  AccountRead = "account:read",
  CheckoutCreate = "checkout:create",
  CreditPackCheckoutCreate = "credit_pack_checkout:create",
  PortalOpen = "portal:open",
  PlanChange = "plan:change",
  UnknownBillingOperation = "billing:unknown",
}

export interface TeamMembership {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: TeamBillingRole;
}

export interface TeamMembershipRepository {
  membershipFor(
    userId: string,
    tenantId: string,
  ): Promise<TeamMembership | null>;
}

export class TeamAuthorizationError extends Error {
  public readonly statusCode = 403;
}

function validatedTeamBillingRole(value: unknown): TeamBillingRole {
  if (
    value === TeamBillingRole.Viewer ||
    value === TeamBillingRole.BillingAdmin
  ) {
    return value;
  }
  throw new Error("membership repository returned an invalid billing role");
}

const RELATIVE_TEAM_ROUTES: ReadonlyMap<string, TeamBillingCapability> =
  new Map([
    ["GET /api/catalog", TeamBillingCapability.CatalogRead],
    ["GET /billing/catalog", TeamBillingCapability.CatalogRead],
    ["GET /api/account", TeamBillingCapability.AccountRead],
    ["GET /billing/account", TeamBillingCapability.AccountRead],
    ["POST /api/checkout", TeamBillingCapability.CheckoutCreate],
    ["POST /billing/checkout", TeamBillingCapability.CheckoutCreate],
    [
      "POST /api/credit-packs/checkout",
      TeamBillingCapability.CreditPackCheckoutCreate,
    ],
    ["POST /api/billing/portal", TeamBillingCapability.PortalOpen],
    ["POST /billing/portal", TeamBillingCapability.PortalOpen],
    ["POST /api/billing/change/preview", TeamBillingCapability.PlanChange],
    ["POST /billing/plan-change/preview", TeamBillingCapability.PlanChange],
    ["POST /api/billing/change/confirm", TeamBillingCapability.PlanChange],
    ["POST /billing/plan-change/confirm", TeamBillingCapability.PlanChange],
  ]);

function normalizedBillingPrefix(prefix: string): string {
  if (prefix === "") {
    return prefix;
  }
  if (
    !prefix.startsWith("/") ||
    prefix.endsWith("/") ||
    prefix.includes("//") ||
    /[{}?#]/u.test(prefix) ||
    !isPrintable(prefix)
  ) {
    throw new TypeError(
      "billing prefix must be empty or a slash-prefixed path without a trailing slash",
    );
  }
  return prefix;
}

/** Explicit route-to-capability policy; viewers fail closed on unknown routes. */
export class TeamBillingAuthorizationPolicy {
  public readonly billingPrefix: string;
  readonly #routes: ReadonlyMap<string, TeamBillingCapability>;

  public constructor(options: { readonly billingPrefix?: string } = {}) {
    this.billingPrefix = normalizedBillingPrefix(options.billingPrefix ?? "");
    this.#routes = new Map(
      [...RELATIVE_TEAM_ROUTES].map(([route, capability]) => {
        const separator = route.indexOf(" ");
        const method = route.slice(0, separator);
        const path = route.slice(separator + 1);
        return [`${method} ${this.billingPrefix}${path}`, capability];
      }),
    );
  }

  public capabilityFor(request: Request): TeamBillingCapability {
    const pathname = new URL(request.url).pathname;
    return (
      this.#routes.get(`${request.method.toUpperCase()} ${pathname}`) ??
      TeamBillingCapability.UnknownBillingOperation
    );
  }

  public require(
    membership: TeamMembership,
    capability: TeamBillingCapability,
  ): void {
    const role = validatedTeamBillingRole(
      (membership as { readonly role: unknown }).role,
    );
    if (role === TeamBillingRole.BillingAdmin) {
      return;
    }
    if (capability === TeamBillingCapability.CatalogRead) {
      return;
    }
    throw new TeamAuthorizationError(
      "billing administrator permission required",
    );
  }
}

/** Resolve a signed tenant selector, then prove current host membership server-side. */
export class TeamJwtAuthAdapter implements AuthAccountAdapter {
  readonly #verifier: JwtVerifier;
  readonly #memberships: TeamMembershipRepository;
  readonly #tenantClaim: string;
  readonly #authorization: TeamBillingAuthorizationPolicy;

  public constructor(
    verifier: JwtVerifier,
    memberships: TeamMembershipRepository,
    options: {
      readonly tenantClaim?: string;
      readonly authorization?: TeamBillingAuthorizationPolicy;
    } = {},
  ) {
    this.#verifier = verifier;
    this.#memberships = memberships;
    this.#tenantClaim = requiredVisibleString(
      options.tenantClaim ?? "tenant_id",
      "tenant claim name",
      128,
    );
    this.#authorization =
      options.authorization ?? new TeamBillingAuthorizationPolicy();
  }

  public async authenticate(request: Request): Promise<AuthenticatedIdentity> {
    const principal = await this.#verifier.verifyRequest(request);
    const tenantId = canonicalUuid(
      principal.claims[this.#tenantClaim],
      this.#tenantClaim,
    );
    const membership = await this.#memberships.membershipFor(
      principal.userId,
      tenantId,
    );
    if (membership === null) {
      throw new TeamAuthorizationError("tenant membership required");
    }
    if (
      membership.userId !== principal.userId ||
      membership.tenantId !== tenantId
    ) {
      throw new Error("membership repository returned a mismatched identity");
    }
    validatedTeamBillingRole((membership as { readonly role: unknown }).role);
    this.#authorization.require(
      membership,
      this.#authorization.capabilityFor(request),
    );
    return principal.email === undefined
      ? { externalRef: `v1:tenant:${tenantId}` }
      : { externalRef: `v1:tenant:${tenantId}`, email: principal.email };
  }
}
