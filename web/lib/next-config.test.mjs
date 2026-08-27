import nextConfig, {
  frontendBuildMode,
  productionE2ERouteAuthSentinel,
  PRODUCTION_E2E_ROUTE_AUTH_SENTINEL,
  validatePublicBillingBuildEnvironment,
} from "../next.config.mjs";
import { E2E_ROUTE_AUTH_SENTINEL } from "./auth.ts";


describe("Next.js public billing build boundary", () => {
  it("does not generate nested agent instructions during development", () => {
    expect(nextConfig.agentRules).toBe(false);
  });

  it.each([
    ["production", "mock", undefined],
    ["production", "http", "browser-visible-token"],
    ["production", undefined, "browser-visible-token"],
  ])("rejects production demo configuration", (environment, mode, token) => {
    expect(() =>
      validatePublicBillingBuildEnvironment(environment, mode, token),
    ).toThrow(/Production builds cannot include/);
  });

  it.each(["MOCK", "production", "htp"])(
    "rejects an unknown public billing mode: %s",
    (mode) => {
      expect(() =>
        validatePublicBillingBuildEnvironment("development", mode, undefined),
      ).toThrow(/must be either 'http' or 'mock'/);
    },
  );

  it("allows explicit HTTP production and local mock development", () => {
    expect(() =>
      validatePublicBillingBuildEnvironment("production", "http", undefined),
    ).not.toThrow();
    expect(() =>
      validatePublicBillingBuildEnvironment("development", "mock", "local-token"),
    ).not.toThrow();
  });

  const safeRouteAuthBuild = {
    environment: "production",
    mode: "http",
    backendUrl: "https://127.0.0.1:8443",
    allowIndexing: "false",
    demoToken: undefined,
    acknowledgement: "1",
    publicSentinel: undefined,
  };

  it("injects one fixed sentinel only for an explicitly non-indexable loopback build", () => {
    expect(productionE2ERouteAuthSentinel(safeRouteAuthBuild)).toBe(
      PRODUCTION_E2E_ROUTE_AUTH_SENTINEL,
    );
    expect(PRODUCTION_E2E_ROUTE_AUTH_SENTINEL).toBe(E2E_ROUTE_AUTH_SENTINEL);
  });

  it.each([
    ["development environment", { environment: "development" }],
    ["mock mode", { mode: "mock" }],
    ["implicit mode", { mode: undefined }],
    ["remote backend", { backendUrl: "https://api.example.test" }],
    ["HTTP backend", { backendUrl: "http://127.0.0.1:8443" }],
    ["backend path", { backendUrl: "https://127.0.0.1:8443/api" }],
    ["indexable build", { allowIndexing: "true" }],
    ["implicit indexing", { allowIndexing: undefined }],
    ["demo token", { demoToken: "browser-token" }],
    ["invalid acknowledgement", { acknowledgement: "yes" }],
    ["custom sentinel", { publicSentinel: "custom" }],
  ])("rejects route auth with %s", (_label, override) => {
    expect(() =>
      productionE2ERouteAuthSentinel({
        ...safeRouteAuthBuild,
        ...override,
      }),
    ).toThrow();
  });

  it("keeps ordinary production builds fail-closed without acknowledgement", () => {
    expect(
      productionE2ERouteAuthSentinel({
        ...safeRouteAuthBuild,
        acknowledgement: undefined,
      }),
    ).toBeUndefined();
    expect(nextConfig.env).toEqual({});
  });
});


describe("Next.js security headers", () => {
  it("applies the clickjacking, MIME, referrer, and permission boundaries globally", async () => {
    const rules = await nextConfig.headers();
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe("/:path*");
    const headers = new Map(
      rules[0].headers.map(({ key, value }) => [key.toLowerCase(), value]),
    );

    expect(headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers.get("content-security-policy")).toContain("base-uri 'self'");
    expect(headers.get("content-security-policy")).toContain("object-src 'none'");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(headers.get("permissions-policy")).toContain("camera=()");
    expect(headers.get("permissions-policy")).toContain("microphone=()");
    expect(headers.get("permissions-policy")).toContain("geolocation=()");
    expect(headers.get("x-frontend-build-mode")).toBe(
      frontendBuildMode(process.env.NODE_ENV),
    );
  });

  it("attests production builds independently of browser-supplied state", () => {
    expect(frontendBuildMode("production")).toBe("production");
    expect(frontendBuildMode("development")).toBe("development");
    expect(frontendBuildMode("test")).toBe("development");
  });
});
