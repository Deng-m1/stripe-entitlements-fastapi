import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { CryptoKey, JWK, JWSAlgorithm, JWTPayload } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { AuthenticationError } from "../../src/auth.js";
import {
  JwksSigningKeyProvider,
  JwksUnavailableError,
  JwtVerificationConfig,
  JwtVerifier,
  PersonalJwtAuthAdapter,
  SigningKeyNotFoundError,
  TeamAuthorizationError,
  TeamBillingAuthorizationPolicy,
  TeamBillingRole,
  TeamJwtAuthAdapter,
} from "../../src/auth-starters.js";
import type {
  JwtSigningKey,
  SigningKeyProvider,
  TeamMembership,
  TeamMembershipRepository,
} from "../../src/auth-starters.js";

const ISSUER = "https://identity.example.test/";
const AUDIENCE = "billing-api";
const USER_ID = "bcd14e19-2c8f-42aa-aeb5-e419d3477cc9";
const ADMIN_USER_ID = "96da8316-d8dd-4d29-b51c-d04123845503";
const TENANT_A = "88a213a7-3424-4260-b964-fd082d776b10";
const TENANT_B = "dd5163d1-c81c-48e7-8668-f62629c2bc21";

interface TestKeyPair {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}

let primaryKeys: TestKeyPair;
let rotatedKeys: TestKeyPair;
let attackerKeys: TestKeyPair;
let es256Keys: TestKeyPair;
let es384Keys: TestKeyPair;
let es512Keys: TestKeyPair;
let eddsaKeys: TestKeyPair;

beforeAll(async () => {
  primaryKeys = await generateKeyPair("RS256", { extractable: true });
  rotatedKeys = await generateKeyPair("RS256", { extractable: true });
  attackerKeys = await generateKeyPair("RS256", { extractable: true });
  es256Keys = await generateKeyPair("ES256", { extractable: true });
  es384Keys = await generateKeyPair("ES384", { extractable: true });
  es512Keys = await generateKeyPair("ES512", { extractable: true });
  eddsaKeys = await generateKeyPair("EdDSA", { extractable: true });
});

function verificationConfig(
  overrides: Partial<
    ConstructorParameters<typeof JwtVerificationConfig>[0]
  > = {},
): JwtVerificationConfig {
  return new JwtVerificationConfig({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUrl: "https://identity.example.test/.well-known/jwks.json",
    algorithms: ["RS256"],
    ...overrides,
  });
}

interface TokenOptions {
  readonly key?: CryptoKey | Uint8Array;
  readonly algorithm?: JWSAlgorithm;
  readonly kid?: string | null;
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly remove?: ReadonlySet<string>;
}

async function tokenFor(options: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: USER_ID,
    iat: now,
    nbf: now - 1,
    exp: now + 300,
    ...options.claims,
  };
  for (const claim of options.remove ?? []) {
    Reflect.deleteProperty(payload, claim);
  }
  const algorithm = options.algorithm ?? "RS256";
  const kid = options.kid === undefined ? "test-key-1" : options.kid;
  const protectedHeader =
    kid === null ? { alg: algorithm } : { alg: algorithm, kid };
  return new SignJWT(payload as JWTPayload)
    .setProtectedHeader(protectedHeader)
    .sign(options.key ?? primaryKeys.privateKey);
}

function requestFor(
  tokenOrAuthorization: string,
  options: { readonly method?: string; readonly path?: string } = {},
): Request {
  const authorization = tokenOrAuthorization.startsWith("Bearer ")
    ? tokenOrAuthorization
    : `Bearer ${tokenOrAuthorization}`;
  return new Request(
    `https://billing.example.test${options.path ?? "/api/catalog"}`,
    {
      method: options.method ?? "GET",
      headers: { authorization },
    },
  );
}

class StaticSigningKeys implements SigningKeyProvider {
  public calls = 0;

  public constructor(
    private readonly value: JwtSigningKey,
    private readonly failure?: Error,
  ) {}

  public signingKey(_token: string): Promise<JwtSigningKey> {
    void _token;
    this.calls += 1;
    return this.failure === undefined
      ? Promise.resolve(this.value)
      : Promise.reject(this.failure);
  }
}

function staticKey(
  key: CryptoKey = primaryKeys.publicKey,
  keyId = "test-key-1",
): JwtSigningKey {
  return { key, keyId, algorithm: "RS256" };
}

function verifierFor(key: CryptoKey = primaryKeys.publicKey): {
  readonly verifier: JwtVerifier;
  readonly provider: StaticSigningKeys;
} {
  const provider = new StaticSigningKeys(staticKey(key));
  return {
    verifier: new JwtVerifier(verificationConfig(), { signingKeys: provider }),
    provider,
  };
}

async function publicJwk(keys: TestKeyPair, kid: string): Promise<JWK> {
  return {
    ...(await exportJWK(keys.publicKey)),
    kid,
    alg: "RS256",
    use: "sig",
  };
}

function jwksResponse(...keys: JWK[]): Response {
  return Response.json({ keys });
}

function compactToken(algorithm: string | undefined, kid: string): string {
  const protectedHeader = Buffer.from(
    JSON.stringify(algorithm === undefined ? { kid } : { alg: algorithm, kid }),
  ).toString("base64url");
  return `${protectedHeader}.e30.c2lnYXR1cmU`;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) {
        throw new Error("deferred promise was not initialized");
      }
      resolvePromise(value);
    },
    reject(error) {
      if (rejectPromise === undefined) {
        throw new Error("deferred promise was not initialized");
      }
      rejectPromise(error);
    },
  };
}

describe("JWT verification configuration", () => {
  it.each([
    { jwksUrl: "http://identity.example.test/jwks.json" },
    { jwksUrl: "https://user:pass@identity.example.test/jwks.json" },
    { jwksUrl: "https://identity.example.test/jwks.json#fragment" },
    { algorithms: ["HS256"] },
    { algorithms: ["RS256", "RS256"] },
    { algorithms: [] },
    { leewaySeconds: 301 },
    { jwksCacheSeconds: 86_401 },
    { jwksTimeoutSeconds: 0 },
    { jwksRefreshCooldownSeconds: 0 },
    { jwksRefreshCooldownSeconds: 61 },
    { jwksMaxConcurrentLookups: 0 },
    { jwksMaxConcurrentLookups: 65 },
    { jwksUnknownKidCacheSize: 0 },
    { jwksUnknownKidCacheSize: 4097 },
    { jwksUnknownKidTtlSeconds: 0 },
    { jwksUnknownKidTtlSeconds: 301 },
    { jwksCacheSeconds: 4, jwksRefreshCooldownSeconds: 5 },
  ])("rejects unsafe or unbounded option %#", (override) => {
    expect(() => verificationConfig(override)).toThrow();
  });

  it("rejects an unparseable issuer and non-array runtime allowlist", () => {
    expect(() => verificationConfig({ issuer: "not a URL" })).toThrow(
      "HTTPS URL",
    );
    expect(() =>
      verificationConfig({ algorithms: "RS256" as unknown as string[] }),
    ).toThrow("asymmetric JWT allowlist");
  });

  it("applies the explicit RS256 default", () => {
    const config = new JwtVerificationConfig({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: "https://identity.example.test/.well-known/jwks.json",
    });
    expect(config.algorithms).toEqual(["RS256"]);
    expect(Object.isFrozen(config)).toBe(true);
  });
});

describe("personal JWT starter", () => {
  it("uses only the verified UUID subject and verified email", async () => {
    const { verifier } = verifierFor();
    const adapter = new PersonalJwtAuthAdapter(verifier);
    const token = await tokenFor({
      claims: { email: "person@example.test", email_verified: true },
    });
    const request = requestFor(token);
    request.headers.set("x-user-id", "76a06bbc-1440-4053-b7b9-d713954b5a4a");

    await expect(adapter.authenticate(request)).resolves.toEqual({
      externalRef: `v1:user:${USER_ID}`,
      email: "person@example.test",
    });
  });

  it.each([false, "true", 1, null])(
    "never forwards an email with unverified marker %#",
    async (emailVerified) => {
      const { verifier } = verifierFor();
      const principal = await verifier.verifyRequest(
        requestFor(
          await tokenFor({
            claims: {
              email: "untrusted@example.test",
              email_verified: emailVerified,
            },
          }),
        ),
      );
      expect(principal.email).toBeUndefined();
    },
  );

  it.each(["not-an-email", "two@@example.test", "space @example.test", ""])(
    "fails closed for malformed verified email %#",
    async (email) => {
      const { verifier } = verifierFor();
      await expect(
        verifier.verifyRequest(
          requestFor(
            await tokenFor({ claims: { email, email_verified: true } }),
          ),
        ),
      ).rejects.toThrow(AuthenticationError);
    },
  );

  it.each([
    { claims: { iss: "https://attacker.example.test/" } },
    { claims: { aud: "another-api" } },
    { claims: { aud: [AUDIENCE, "another-api"] } },
    { claims: { exp: 1 } },
    { claims: { exp: Math.floor(Date.now() / 1000) + 300.5 } },
    { claims: { nbf: Math.floor(Date.now() / 1000) + 600 } },
    { claims: { nbf: false } },
    { claims: { sub: "not-a-uuid" } },
    { claims: { sub: USER_ID.toUpperCase() } },
    { claims: { sub: "00000000-0000-0000-0000-000000000000" } },
    { remove: new Set(["exp"]) },
    { remove: new Set(["nbf"]) },
    { remove: new Set(["sub"]) },
  ])("rejects wrong issuer/audience/time/subject case %#", async (options) => {
    const { verifier } = verifierFor();
    await expect(
      verifier.verifyRequest(requestFor(await tokenFor(options))),
    ).rejects.toThrow(AuthenticationError);
  });

  it("rejects a disallowed algorithm before key lookup", async () => {
    const provider = new StaticSigningKeys(staticKey());
    const verifier = new JwtVerifier(verificationConfig(), {
      signingKeys: provider,
    });
    const token = await tokenFor({
      algorithm: "HS256",
      key: new TextEncoder().encode("a-test-secret-with-enough-entropy"),
    });

    await expect(verifier.verifyRequest(requestFor(token))).rejects.toThrow(
      AuthenticationError,
    );
    expect(provider.calls).toBe(0);
  });

  it("rejects a missing kid before key lookup", async () => {
    const { verifier, provider } = verifierFor();
    await expect(
      verifier.verifyRequest(requestFor(await tokenFor({ kid: null }))),
    ).rejects.toThrow(AuthenticationError);
    expect(provider.calls).toBe(0);
  });

  it("rejects a protected header without an algorithm before lookup", async () => {
    const { verifier, provider } = verifierFor();
    await expect(
      verifier.verifyRequest(requestFor(compactToken(undefined, "test-key-1"))),
    ).rejects.toThrow(AuthenticationError);
    expect(provider.calls).toBe(0);
  });

  it("rejects an invalid signature", async () => {
    const { verifier } = verifierFor();
    await expect(
      verifier.verifyRequest(
        requestFor(await tokenFor({ key: attackerKeys.privateKey })),
      ),
    ).rejects.toThrow(AuthenticationError);
  });

  it.each([
    "",
    "Basic abc.def.ghi",
    "Bearer",
    "Bearer  abc.def.ghi",
    "Bearer abc.def.ghi extra",
    "Bearer é",
    "Bearer not-a-jwt",
  ])("rejects malformed authorization %#", async (authorization) => {
    const { verifier } = verifierFor();
    await expect(
      verifier.verifyRequest(
        new Request("https://billing.example.test/api/catalog", {
          headers: { authorization },
        }),
      ),
    ).rejects.toThrow(AuthenticationError);
  });

  it("enforces the 16 KiB Bearer-token boundary before lookup", async () => {
    const { verifier, provider } = verifierFor();
    await expect(
      verifier.verifyRequest(requestFor(`Bearer ${"a".repeat(16_385)}`)),
    ).rejects.toThrow(AuthenticationError);
    expect(provider.calls).toBe(0);
  });

  it("returns immutable verified claims", async () => {
    const { verifier } = verifierFor();
    const principal = await verifier.verifyRequest(
      requestFor(await tokenFor({ claims: { tenant_id: TENANT_A } })),
    );
    expect(Object.isFrozen(principal.claims)).toBe(true);
    expect(principal.claims["tenant_id"]).toBe(TENANT_A);
  });

  it("omits email from a personal owner when it was not verified", async () => {
    const { verifier } = verifierFor();
    await expect(
      new PersonalJwtAuthAdapter(verifier).authenticate(
        requestFor(await tokenFor()),
      ),
    ).resolves.toEqual({ externalRef: `v1:user:${USER_ID}` });
  });

  it("maps JWKS transport failures to one sanitized retryable error", async () => {
    const provider = new StaticSigningKeys(
      staticKey(),
      new JwksUnavailableError("private upstream detail"),
    );
    const verifier = new JwtVerifier(verificationConfig(), {
      signingKeys: provider,
    });

    const result = verifier.verifyRequest(requestFor(await tokenFor()));
    await expect(result).rejects.toMatchObject({
      message: "identity provider temporarily unavailable",
      statusCode: 503,
      retryAfterSeconds: 5,
    });
    await expect(result).rejects.not.toHaveProperty(
      "message",
      expect.stringContaining("private"),
    );
  });

  it("maps an unknown kid to authentication failure without reflecting it", async () => {
    const secretKid = "private-tenant-key-id";
    const provider = new StaticSigningKeys(
      staticKey(),
      new SigningKeyNotFoundError(secretKid),
    );
    const verifier = new JwtVerifier(verificationConfig(), {
      signingKeys: provider,
    });
    const promise = verifier.verifyRequest(
      requestFor(await tokenFor({ kid: secretKid })),
    );

    await expect(promise).rejects.toThrow("invalid bearer token");
    await promise.catch((error: unknown) => {
      expect(String(error)).not.toContain(secretKid);
    });
  });

  it("rejects a provider result whose kid or algorithm does not match", async () => {
    const wrongKid = new JwtVerifier(verificationConfig(), {
      signingKeys: new StaticSigningKeys(
        staticKey(primaryKeys.publicKey, "other-key"),
      ),
    });
    await expect(
      wrongKid.verifyRequest(requestFor(await tokenFor())),
    ).rejects.toThrow(AuthenticationError);

    const wrongAlgorithm = new JwtVerifier(verificationConfig(), {
      signingKeys: new StaticSigningKeys({
        key: primaryKeys.publicKey,
        keyId: "test-key-1",
        algorithm: "RS384",
      }),
    });
    await expect(
      wrongAlgorithm.verifyRequest(requestFor(await tokenFor())),
    ).rejects.toThrow(AuthenticationError);
  });

  it("uses the production remote provider by default", async () => {
    const jwk = await publicJwk(primaryKeys, "test-key-1");
    const fetcher = vi.fn(() => Promise.resolve(jwksResponse(jwk)));
    vi.stubGlobal("fetch", fetcher);
    try {
      const verifier = new JwtVerifier(verificationConfig());
      await expect(
        verifier.verifyRequest(requestFor(await tokenFor())),
      ).resolves.toMatchObject({ userId: USER_ID });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("bounds concurrent signing-key lookups", async () => {
    const gate = deferred<undefined>();
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    const provider: SigningKeyProvider = {
      async signingKey() {
        started += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await gate.promise;
          return staticKey();
        } finally {
          active -= 1;
        }
      },
    };
    const verifier = new JwtVerifier(
      verificationConfig({ jwksMaxConcurrentLookups: 3 }),
      { signingKeys: provider },
    );
    const token = await tokenFor();
    const requests = Array.from({ length: 18 }, () =>
      verifier.verifyRequest(requestFor(token)),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(3);
    expect(active).toBe(3);
    expect(maximumActive).toBe(3);
    gate.resolve(undefined);
    await expect(Promise.all(requests)).resolves.toHaveLength(18);
    expect(maximumActive).toBe(3);
  });
});

describe("bounded remote JWKS provider", () => {
  it("coalesces same-kid cold starts into one fetch", async () => {
    const gate = deferred<Response>();
    let fetches = 0;
    const provider = new JwksSigningKeyProvider(verificationConfig(), {
      fetcher() {
        fetches += 1;
        return gate.promise;
      },
    });
    const token = await tokenFor({ kid: "cold-key" });
    const lookups = Array.from({ length: 8 }, () => provider.signingKey(token));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetches).toBe(1);
    gate.resolve(jwksResponse(await publicJwk(primaryKeys, "cold-key")));
    const keys = await Promise.all(lookups);
    expect(keys.every((key) => key.keyId === "cold-key")).toBe(true);
    expect(fetches).toBe(1);
  });

  it("coalesces one same-kid refresh after the snapshot TTL", async () => {
    let now = 0;
    let fetches = 0;
    const refresh = deferred<Response>();
    const knownJwk = await publicJwk(primaryKeys, "known-key");
    const provider = new JwksSigningKeyProvider(
      verificationConfig({
        jwksCacheSeconds: 5,
        jwksRefreshCooldownSeconds: 5,
      }),
      {
        monotonicSeconds: () => now,
        fetcher() {
          fetches += 1;
          return fetches === 1
            ? Promise.resolve(jwksResponse(knownJwk))
            : refresh.promise;
        },
      },
    );
    const token = await tokenFor({ kid: "known-key" });
    await provider.signingKey(token);
    now = 5.001;
    const lookups = Array.from({ length: 8 }, () => provider.signingKey(token));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetches).toBe(2);
    refresh.resolve(jwksResponse(knownJwk));
    await expect(Promise.all(lookups)).resolves.toHaveLength(8);
    expect(fetches).toBe(2);
  });

  it("imports allowed RSA, EC, and OKP keys even when JWK alg is omitted", async () => {
    const variants: readonly (readonly [JWSAlgorithm, string, TestKeyPair])[] =
      [
        ["RS256", "rsa-key", primaryKeys],
        ["ES256", "p256-key", es256Keys],
        ["ES384", "p384-key", es384Keys],
        ["ES512", "p521-key", es512Keys],
        ["EdDSA", "ed25519-key", eddsaKeys],
      ];
    for (const [algorithm, kid, keys] of variants) {
      const jwk = await exportJWK(keys.publicKey);
      const provider = new JwksSigningKeyProvider(
        verificationConfig({ algorithms: [algorithm] }),
        {
          fetcher: () => Promise.resolve(jwksResponse({ ...jwk, kid })),
        },
      );
      await expect(
        provider.signingKey(compactToken(algorithm, kid)),
      ).resolves.toMatchObject({ keyId: kid, algorithm });
    }
  });

  it("ignores non-signing keys and accepts an explicit verify key_ops", async () => {
    const ignored = {
      ...(await publicJwk(attackerKeys, "encryption-key")),
      use: "enc",
    };
    const accepted = {
      ...(await publicJwk(primaryKeys, "verify-key")),
      key_ops: ["verify"],
    };
    const provider = new JwksSigningKeyProvider(verificationConfig(), {
      fetcher: () => Promise.resolve(jwksResponse(ignored, accepted)),
    });
    await expect(
      provider.signingKey(await tokenFor({ kid: "verify-key" })),
    ).resolves.toMatchObject({ keyId: "verify-key" });
  });

  it("recovers a real key rotation only after the global cooldown", async () => {
    let now = 0;
    let fetches = 0;
    const staleJwk = await publicJwk(primaryKeys, "stale-key");
    const rotatedJwk = await publicJwk(rotatedKeys, "rotated-key");
    const provider = new JwksSigningKeyProvider(verificationConfig(), {
      monotonicSeconds: () => now,
      fetcher() {
        fetches += 1;
        return Promise.resolve(
          fetches === 1 ? jwksResponse(staleJwk) : jwksResponse(rotatedJwk),
        );
      },
    });
    const staleToken = await tokenFor({ kid: "stale-key" });
    const rotatedToken = await tokenFor({
      kid: "rotated-key",
      key: rotatedKeys.privateKey,
    });

    await expect(provider.signingKey(staleToken)).resolves.toMatchObject({
      keyId: "stale-key",
    });
    now = 4.999;
    await expect(provider.signingKey(rotatedToken)).rejects.toBeInstanceOf(
      SigningKeyNotFoundError,
    );
    expect(fetches).toBe(1);
    now = 5.001;
    await expect(provider.signingKey(rotatedToken)).resolves.toMatchObject({
      keyId: "rotated-key",
    });
    expect(fetches).toBe(2);
  });

  it("gives distinct attacker kids only one refresh budget", async () => {
    let now = 0;
    let fetches = 0;
    const refresh = deferred<Response>();
    const knownJwk = await publicJwk(primaryKeys, "known-key");
    const provider = new JwksSigningKeyProvider(verificationConfig(), {
      monotonicSeconds: () => now,
      fetcher() {
        fetches += 1;
        return fetches === 1
          ? Promise.resolve(jwksResponse(knownJwk))
          : refresh.promise;
      },
    });
    const knownToken = await tokenFor({ kid: "known-key" });
    await provider.signingKey(knownToken);
    now = 5.001;
    const first = provider.signingKey(
      await tokenFor({ kid: "random-attacker-kid-0" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const restTokens = await Promise.all(
      Array.from({ length: 31 }, (_, index) =>
        tokenFor({ kid: `random-attacker-kid-${String(index + 1)}` }),
      ),
    );
    const rest = await Promise.allSettled(
      restTokens.map((token) => provider.signingKey(token)),
    );
    expect(fetches).toBe(2);
    expect(
      rest.every(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof JwksUnavailableError,
      ),
    ).toBe(true);
    refresh.resolve(jwksResponse(knownJwk));
    await expect(first).rejects.toBeInstanceOf(SigningKeyNotFoundError);
    expect(fetches).toBe(2);
  });

  it("fails different unknown kids fast while preserving a fresh known key", async () => {
    let now = 0;
    let fetches = 0;
    const refresh = deferred<Response>();
    const knownJwk = await publicJwk(primaryKeys, "known-key");
    const provider = new JwksSigningKeyProvider(verificationConfig(), {
      monotonicSeconds: () => now,
      fetcher() {
        fetches += 1;
        return fetches === 1
          ? Promise.resolve(jwksResponse(knownJwk))
          : refresh.promise;
      },
    });
    const knownToken = await tokenFor({ kid: "known-key" });
    await provider.signingKey(knownToken);
    now = 5.001;
    const blocking = provider.signingKey(
      await tokenFor({ kid: "unknown-blocking" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    const attackerTokens = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        tokenFor({ kid: `unknown-fast-${String(index)}` }),
      ),
    );
    const attackerResults = await Promise.allSettled(
      attackerTokens.map((token) => provider.signingKey(token)),
    );
    expect(
      attackerResults.every(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof JwksUnavailableError,
      ),
    ).toBe(true);
    await expect(provider.signingKey(knownToken)).resolves.toMatchObject({
      keyId: "known-key",
    });
    expect(fetches).toBe(2);
    refresh.resolve(jwksResponse(knownJwk));
    await expect(blocking).rejects.toBeInstanceOf(SigningKeyNotFoundError);
  });

  it("keeps an expired known key retryable after refresh failure", async () => {
    let now = 0;
    let fetches = 0;
    const knownJwk = await publicJwk(primaryKeys, "known-key");
    const provider = new JwksSigningKeyProvider(
      verificationConfig({
        jwksCacheSeconds: 5,
        jwksRefreshCooldownSeconds: 5,
      }),
      {
        monotonicSeconds: () => now,
        fetcher() {
          fetches += 1;
          return fetches === 1
            ? Promise.resolve(jwksResponse(knownJwk))
            : Promise.reject(new Error("private provider outage"));
        },
      },
    );
    const knownToken = await tokenFor({ kid: "known-key" });
    await provider.signingKey(knownToken);
    now = 5.001;
    await expect(provider.signingKey(knownToken)).rejects.toBeInstanceOf(
      JwksUnavailableError,
    );
    now = 6;
    await expect(provider.signingKey(knownToken)).rejects.toBeInstanceOf(
      JwksUnavailableError,
    );
    expect(fetches).toBe(2);
  });

  it("does not turn a transport failure into a negative kid observation", async () => {
    let now = 0;
    let fetches = 0;
    const jwk = await publicJwk(primaryKeys, "recovered-key");
    const provider = new JwksSigningKeyProvider(verificationConfig(), {
      monotonicSeconds: () => now,
      fetcher() {
        fetches += 1;
        return fetches === 1
          ? Promise.reject(new Error("private transport failure"))
          : Promise.resolve(jwksResponse(jwk));
      },
    });
    const token = await tokenFor({ kid: "recovered-key" });
    await expect(provider.signingKey(token)).rejects.toBeInstanceOf(
      JwksUnavailableError,
    );
    now = 5.001;
    await expect(provider.signingKey(token)).resolves.toMatchObject({
      keyId: "recovered-key",
    });
    expect(fetches).toBe(2);
  });

  it("serves a repeated unknown kid from the bounded negative cache", async () => {
    let now = 0;
    let fetches = 0;
    const knownJwk = await publicJwk(primaryKeys, "known-key");
    const provider = new JwksSigningKeyProvider(verificationConfig(), {
      monotonicSeconds: () => now,
      fetcher() {
        fetches += 1;
        return Promise.resolve(jwksResponse(knownJwk));
      },
    });
    await provider.signingKey(await tokenFor({ kid: "known-key" }));
    now = 1;
    const unknown = await tokenFor({ kid: "same-unknown" });
    await expect(provider.signingKey(unknown)).rejects.toBeInstanceOf(
      SigningKeyNotFoundError,
    );
    now = 1.5;
    await expect(provider.signingKey(unknown)).rejects.toBeInstanceOf(
      SigningKeyNotFoundError,
    );
    expect(fetches).toBe(1);
  });

  it.each([
    { keys: [] },
    [],
    { keys: "not-an-array" },
    { keys: [null] },
    { keys: [{ kty: "oct", kid: "symmetric", k: "AA", alg: "HS256" }] },
    { keys: [{ kty: "RSA", alg: "RS256", n: "AA", e: "AQAB" }] },
    {
      keys: [
        {
          kty: "RSA",
          kid: "private-key",
          alg: "RS256",
          n: "AA",
          e: "AQAB",
          d: "private",
        },
      ],
    },
    {
      keys: [{ kty: "unsupported", kid: "unsupported-key", alg: "RS256" }],
    },
    {
      keys: [
        {
          kty: "EC",
          crv: "unknown-curve",
          kid: "unknown-curve",
        },
      ],
    },
    {
      keys: [
        {
          kty: "RSA",
          kid: "no-verify",
          alg: "RS256",
          key_ops: ["sign"],
        },
      ],
    },
    {
      keys: [
        {
          kty: "RSA",
          kid: "broken-rsa",
          alg: "RS256",
          e: "AQAB",
        },
      ],
    },
  ])("classifies malformed JWKS %# as unavailable", async (document) => {
    const provider = new JwksSigningKeyProvider(verificationConfig(), {
      fetcher: () => Promise.resolve(Response.json(document)),
    });
    await expect(provider.signingKey(await tokenFor())).rejects.toBeInstanceOf(
      JwksUnavailableError,
    );
  });

  it("rejects duplicate signing kids", async () => {
    const jwk = await publicJwk(primaryKeys, "duplicate-key");
    const provider = new JwksSigningKeyProvider(verificationConfig(), {
      fetcher: () => Promise.resolve(jwksResponse(jwk, { ...jwk })),
    });
    await expect(
      provider.signingKey(await tokenFor({ kid: "duplicate-key" })),
    ).rejects.toBeInstanceOf(JwksUnavailableError);
  });

  it.each([
    new Response(null, { status: 503 }),
    new Response("{}", { headers: { "content-length": "not-a-number" } }),
    new Response("{}", {
      headers: { "content-length": "1048577" },
    }),
    new Response("{}", { headers: { "content-length": "1" } }),
    new Response(null),
    new Response("a".repeat(1_048_577)),
    new Response("{"),
    new Response(new Uint8Array([255])),
  ])("rejects an unusable JWKS HTTP response %#", async (response) => {
    const provider = new JwksSigningKeyProvider(verificationConfig(), {
      fetcher: () => Promise.resolve(response.clone()),
    });
    await expect(provider.signingKey(await tokenFor())).rejects.toBeInstanceOf(
      JwksUnavailableError,
    );
  });

  it("rejects a response body read failure", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("private stream failure"));
        },
      }),
    );
    const provider = new JwksSigningKeyProvider(verificationConfig(), {
      fetcher: () => Promise.resolve(response),
    });
    await expect(provider.signingKey(await tokenFor())).rejects.toBeInstanceOf(
      JwksUnavailableError,
    );
  });

  it("cancels an undeclared oversized JWKS stream at the byte bound", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(512 * 1024));
          controller.enqueue(new Uint8Array(512 * 1024));
          controller.enqueue(new Uint8Array(1));
        },
        cancel() {
          canceled = true;
        },
      }),
    );
    const provider = new JwksSigningKeyProvider(verificationConfig(), {
      fetcher: () => Promise.resolve(response),
    });

    await expect(provider.signingKey(await tokenFor())).rejects.toBeInstanceOf(
      JwksUnavailableError,
    );
    expect(canceled).toBe(true);
  });

  it("enforces its timeout when a fetch implementation ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const provider = new JwksSigningKeyProvider(
        verificationConfig({ jwksTimeoutSeconds: 1 }),
        {
          monotonicSeconds: () => 0,
          fetcher: () => new Promise<Response>(() => undefined),
        },
      );
      const lookup = provider.signingKey(await tokenFor());
      const rejection =
        expect(lookup).rejects.toBeInstanceOf(JwksUnavailableError);
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the timeout active while an HTTP response body stalls", async () => {
    vi.useFakeTimers();
    try {
      let canceled = false;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"keys":['));
          },
          cancel() {
            canceled = true;
          },
        }),
      );
      const provider = new JwksSigningKeyProvider(
        verificationConfig({ jwksTimeoutSeconds: 1 }),
        {
          monotonicSeconds: () => 0,
          fetcher: () => Promise.resolve(response),
        },
      );
      const lookup = provider.signingKey(await tokenFor());
      const rejection =
        expect(lookup).rejects.toBeInstanceOf(JwksUnavailableError);

      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
      expect(canceled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds unknown-kid observations while the cooldown prevents refetch", async () => {
    let fetches = 0;
    const knownJwk = await publicJwk(primaryKeys, "known-key");
    const provider = new JwksSigningKeyProvider(
      verificationConfig({ jwksUnknownKidCacheSize: 2 }),
      {
        fetcher() {
          fetches += 1;
          return Promise.resolve(jwksResponse(knownJwk));
        },
      },
    );
    await provider.signingKey(await tokenFor({ kid: "known-key" }));
    const unknownTokens = await Promise.all(
      Array.from({ length: 2_000 }, (_, index) =>
        tokenFor({ kid: `bounded-random-${String(index)}` }),
      ),
    );
    const results = await Promise.allSettled(
      unknownTokens.map((token) => provider.signingKey(token)),
    );
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(fetches).toBe(1);
  });
});

class MemoryMemberships implements TeamMembershipRepository {
  public readonly queries: (readonly [string, string])[] = [];
  readonly #memberships = new Map<string, TeamMembership>();

  public constructor(...memberships: TeamMembership[]) {
    for (const membership of memberships) {
      this.#memberships.set(
        `${membership.userId}:${membership.tenantId}`,
        membership,
      );
    }
  }

  public membershipFor(
    userId: string,
    tenantId: string,
  ): Promise<TeamMembership | null> {
    this.queries.push([userId, tenantId]);
    return Promise.resolve(
      this.#memberships.get(`${userId}:${tenantId}`) ?? null,
    );
  }
}

function teamAdapter(
  role: TeamBillingRole,
  options: { readonly authorization?: TeamBillingAuthorizationPolicy } = {},
): Promise<{
  readonly adapter: TeamJwtAuthAdapter;
  readonly memberships: MemoryMemberships;
}> {
  const { verifier } = verifierFor();
  const memberships = new MemoryMemberships({
    userId: USER_ID,
    tenantId: TENANT_A,
    role,
  });
  return Promise.resolve({
    adapter: new TeamJwtAuthAdapter(verifier, memberships, options),
    memberships,
  });
}

describe("team JWT starter", () => {
  it("uses the signed tenant selector and a live membership lookup", async () => {
    const { adapter, memberships } = await teamAdapter(TeamBillingRole.Viewer);
    const request = requestFor(
      await tokenFor({ claims: { tenant_id: TENANT_A } }),
    );
    request.headers.set("x-tenant-id", TENANT_B);

    await expect(adapter.authenticate(request)).resolves.toEqual({
      externalRef: `v1:tenant:${TENANT_A}`,
    });
    await adapter.authenticate(request);
    expect(memberships.queries).toEqual([
      [USER_ID, TENANT_A],
      [USER_ID, TENANT_A],
    ]);
  });

  it("forwards an email only after JWT verification", async () => {
    const { adapter } = await teamAdapter(TeamBillingRole.Viewer);
    await expect(
      adapter.authenticate(
        requestFor(
          await tokenFor({
            claims: {
              tenant_id: TENANT_A,
              email: "member@example.test",
              email_verified: true,
            },
          }),
        ),
      ),
    ).resolves.toEqual({
      externalRef: `v1:tenant:${TENANT_A}`,
      email: "member@example.test",
    });
  });

  it.each([
    "stripe",
    "/stripe/",
    "/stripe//billing",
    "/stripe?x=1",
    "/stripe#x",
    "/{tenant}",
  ])("rejects ambiguous billing prefix %#", (billingPrefix) => {
    expect(() => new TeamBillingAuthorizationPolicy({ billingPrefix })).toThrow(
      "billing prefix",
    );
  });

  it("requires the explicit configured prefix without path guessing", async () => {
    const authorization = new TeamBillingAuthorizationPolicy({
      billingPrefix: "/stripe",
    });
    const { adapter } = await teamAdapter(TeamBillingRole.Viewer, {
      authorization,
    });
    const token = await tokenFor({ claims: { tenant_id: TENANT_A } });

    await expect(
      adapter.authenticate(requestFor(token, { path: "/stripe/api/catalog" })),
    ).resolves.toMatchObject({ externalRef: `v1:tenant:${TENANT_A}` });
    await expect(
      adapter.authenticate(requestFor(token, { path: "/api/catalog" })),
    ).rejects.toBeInstanceOf(TeamAuthorizationError);
  });

  it("forbids a signed tenant selector without current membership", async () => {
    const { adapter, memberships } = await teamAdapter(TeamBillingRole.Viewer);
    await expect(
      adapter.authenticate(
        requestFor(await tokenFor({ claims: { tenant_id: TENANT_B } })),
      ),
    ).rejects.toBeInstanceOf(TeamAuthorizationError);
    expect(memberships.queries).toEqual([[USER_ID, TENANT_B]]);
  });

  it.each([
    ["GET", "/api/catalog", true],
    ["GET", "/billing/catalog", true],
    ["GET", "/api/account", false],
    ["POST", "/api/checkout", false],
    ["POST", "/api/credit-packs/checkout", false],
    ["POST", "/api/billing/portal", false],
    ["POST", "/api/billing/change/preview", false],
    ["POST", "/api/billing/change/confirm", false],
    ["GET", "/host/new-billing-route", false],
  ] as const)(
    "enforces viewer route matrix %s %s",
    async (method, path, allowed) => {
      const { adapter } = await teamAdapter(TeamBillingRole.Viewer);
      const request = requestFor(
        await tokenFor({ claims: { tenant_id: TENANT_A } }),
        { method, path },
      );
      if (allowed) {
        await expect(adapter.authenticate(request)).resolves.toMatchObject({
          externalRef: `v1:tenant:${TENANT_A}`,
        });
      } else {
        await expect(adapter.authenticate(request)).rejects.toBeInstanceOf(
          TeamAuthorizationError,
        );
      }
    },
  );

  it.each([
    ["GET", "/api/catalog"],
    ["GET", "/api/account"],
    ["POST", "/api/checkout"],
    ["POST", "/api/credit-packs/checkout"],
    ["POST", "/api/billing/portal"],
    ["POST", "/api/billing/change/preview"],
    ["POST", "/api/billing/change/confirm"],
  ] as const)("allows billing admin capability %s %s", async (method, path) => {
    const { adapter } = await teamAdapter(TeamBillingRole.BillingAdmin);
    await expect(
      adapter.authenticate(
        requestFor(await tokenFor({ claims: { tenant_id: TENANT_A } }), {
          method,
          path,
        }),
      ),
    ).resolves.toMatchObject({ externalRef: `v1:tenant:${TENANT_A}` });
  });

  it.each([
    undefined,
    "not-a-uuid",
    TENANT_A.toUpperCase(),
    "00000000-0000-0000-0000-000000000000",
  ])("requires a canonical nonzero tenant UUID %#", async (tenantId) => {
    const { adapter, memberships } = await teamAdapter(TeamBillingRole.Viewer);
    const claims = tenantId === undefined ? {} : { tenant_id: tenantId };
    await expect(
      adapter.authenticate(requestFor(await tokenFor({ claims }))),
    ).rejects.toThrow(AuthenticationError);
    expect(memberships.queries).toEqual([]);
  });

  it("rejects a repository result for another tenant or user", async () => {
    const { verifier } = verifierFor();
    const mismatched: TeamMembershipRepository = {
      membershipFor(userId) {
        return Promise.resolve({
          userId,
          tenantId: TENANT_B,
          role: TeamBillingRole.BillingAdmin,
        });
      },
    };
    const adapter = new TeamJwtAuthAdapter(verifier, mismatched);
    await expect(
      adapter.authenticate(
        requestFor(await tokenFor({ claims: { tenant_id: TENANT_A } })),
      ),
    ).rejects.toThrow("mismatched identity");
  });

  it("rejects an invalid repository role instead of escalating it", async () => {
    const { verifier } = verifierFor();
    const invalid: TeamMembershipRepository = {
      membershipFor() {
        return Promise.resolve({
          userId: USER_ID,
          tenantId: TENANT_A,
          role: "owner" as TeamBillingRole,
        });
      },
    };
    const adapter = new TeamJwtAuthAdapter(verifier, invalid);
    await expect(
      adapter.authenticate(
        requestFor(await tokenFor({ claims: { tenant_id: TENANT_A } })),
      ),
    ).rejects.toThrow("invalid billing role");
  });

  it("does not confuse two users in the same tenant", async () => {
    const provider = new StaticSigningKeys(staticKey());
    const verifier = new JwtVerifier(verificationConfig(), {
      signingKeys: provider,
    });
    const memberships = new MemoryMemberships({
      userId: ADMIN_USER_ID,
      tenantId: TENANT_A,
      role: TeamBillingRole.BillingAdmin,
    });
    const adapter = new TeamJwtAuthAdapter(verifier, memberships);
    await expect(
      adapter.authenticate(
        requestFor(await tokenFor({ claims: { tenant_id: TENANT_A } })),
      ),
    ).rejects.toBeInstanceOf(TeamAuthorizationError);
  });
});
