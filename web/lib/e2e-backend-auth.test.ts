import { describe, expect, it } from "vitest";
import {
  isExactBackendApiRequest,
  optionalE2EBearerToken,
  withE2EBackendAuthorization,
} from "@/lib/e2e-backend-auth";
import { E2E_ROUTE_AUTH_SENTINEL } from "@/lib/auth";

describe("production browser E2E backend authentication", () => {
  it("targets only the attested backend origin and API path", () => {
    const backend = "https://127.0.0.1:8443";
    expect(isExactBackendApiRequest(`${backend}/api/account`, backend)).toBe(true);
    expect(isExactBackendApiRequest(`${backend}/api/checkout`, backend)).toBe(true);
    expect(isExactBackendApiRequest(`${backend}/health`, backend)).toBe(false);
    expect(
      isExactBackendApiRequest("https://checkout.stripe.com/api/account", backend),
    ).toBe(false);
    expect(
      isExactBackendApiRequest("https://127.0.0.1.attacker.test/api/account", backend),
    ).toBe(false);
    expect(
      isExactBackendApiRequest("https://127.0.0.1:9443/api/account", backend),
    ).toBe(false);
  });

  it("rejects malformed tokens and adds an isolated header copy", () => {
    expect(optionalE2EBearerToken(undefined)).toBeUndefined();
    expect(optionalE2EBearerToken("")).toBeUndefined();
    expect(() => optionalE2EBearerToken(" padded ")).toThrow(/visible ASCII/);
    expect(() => optionalE2EBearerToken("line\nbreak")).toThrow(/visible ASCII/);
    expect(() => optionalE2EBearerToken("x".repeat(8_193))).toThrow(/8192/);

    const original = {
      accept: "application/json",
      Authorization: `Bearer ${E2E_ROUTE_AUTH_SENTINEL}`,
    };
    expect(withE2EBackendAuthorization(original, "test-token")).toEqual({
      accept: "application/json",
      authorization: "Bearer test-token",
    });
    expect(original).toEqual({
      accept: "application/json",
      Authorization: `Bearer ${E2E_ROUTE_AUTH_SENTINEL}`,
    });
  });

  it("replaces only the fixed public sentinel", () => {
    expect(() =>
      withE2EBackendAuthorization({ accept: "application/json" }, "secret"),
    ).toThrow(/exact route-auth sentinel/);
    expect(() =>
      withE2EBackendAuthorization(
        { authorization: "Bearer custom-sentinel" },
        "secret",
      ),
    ).toThrow(/exact route-auth sentinel/);
    expect(() =>
      withE2EBackendAuthorization(
        {
          authorization: `Bearer ${E2E_ROUTE_AUTH_SENTINEL}`,
          Authorization: `Bearer ${E2E_ROUTE_AUTH_SENTINEL}`,
        },
        "secret",
      ),
    ).toThrow(/exact route-auth sentinel/);
  });
});
