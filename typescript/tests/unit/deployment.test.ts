import { describe, expect, it } from "vitest";

import { PersonalJwtAuthAdapter } from "../../src/auth-starters.js";
import { authAdapterFromEnvironment } from "../../src/deployment.js";

describe("deployment authentication wiring", () => {
  it("keeps the kernel default when no deployment auth mode is configured", () => {
    expect(authAdapterFromEnvironment({})).toBeUndefined();
  });

  it("constructs the strict personal JWT starter from explicit environment", () => {
    const adapter = authAdapterFromEnvironment({
      BILLING_AUTH_MODE: "personal_jwt",
      BILLING_JWT_ISSUER: "https://issuer.example/",
      BILLING_JWT_AUDIENCE: "billing-api",
      BILLING_JWKS_URL: "https://issuer.example/.well-known/jwks.json",
      BILLING_JWT_ALGORITHMS: "RS256, ES256",
    });
    expect(adapter).toBeInstanceOf(PersonalJwtAuthAdapter);
  });

  it("fails closed on partial or ambiguous JWT configuration", () => {
    expect(() =>
      authAdapterFromEnvironment({
        BILLING_JWT_ISSUER: "https://issuer.example/",
      }),
    ).toThrow("BILLING_AUTH_MODE");
    expect(() =>
      authAdapterFromEnvironment({
        BILLING_AUTH_MODE: "personal_jwt",
        BILLING_JWT_ISSUER: "https://issuer.example/",
      }),
    ).toThrow("BILLING_JWT_AUDIENCE");
    expect(() =>
      authAdapterFromEnvironment({ BILLING_AUTH_MODE: "cookie_magic" }),
    ).toThrow("reject_all or personal_jwt");
  });
});
