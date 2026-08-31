import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import nextConfig, {
  frontendBillingApiMode,
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

  it("traces the billing catalog and migrations into server bundles", () => {
    expect(nextConfig.outputFileTracingIncludes).toEqual({
      "/*": [
        "./node_modules/@tosea/stripe-entitlements/dist/plans.toml",
        "./node_modules/@tosea/stripe-entitlements/dist/migrations/**/*.sql",
        "../typescript/dist/plans.toml",
        "../typescript/dist/migrations/**/*.sql",
      ],
    });
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
      ).toThrow(/must be 'http', 'mock', or 'simulation'/);
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

  it("allows only an acknowledged, noindex, credential-free production simulation", () => {
    expect(() =>
      validatePublicBillingBuildEnvironment(
        "production",
        "simulation",
        undefined,
        "false",
        "1",
      ),
    ).not.toThrow();
  });

  it.each([
    ["missing acknowledgement", undefined, "false", undefined],
    ["invalid acknowledgement", undefined, "false", "yes"],
    ["indexable", undefined, "true", "1"],
    ["missing explicit noindex", undefined, undefined, "1"],
    ["browser demo token", "public-token", "false", "1"],
  ])(
    "rejects a production simulation that is %s",
    (_label, token, indexing, acknowledgement) => {
      expect(() =>
        validatePublicBillingBuildEnvironment(
          "production",
          "simulation",
          token,
          indexing,
          acknowledgement,
        ),
      ).toThrow();
    },
  );

  it("rejects a stale simulation acknowledgement in HTTP mode", () => {
    expect(() =>
      validatePublicBillingBuildEnvironment(
        "production",
        "http",
        undefined,
        "false",
        "1",
      ),
    ).toThrow(/valid only in simulation mode/);
  });

  it("rejects a Stripe publishable key in public simulation", () => {
    expect(() =>
      validatePublicBillingBuildEnvironment(
        "production",
        "simulation",
        undefined,
        "false",
        "1",
        "pk_test_public",
      ),
    ).toThrow(/Stripe publishable key/);
  });

  it("rejects inherited database, Stripe, demo, or scheduler credentials", () => {
    expect(() =>
      validatePublicBillingBuildEnvironment(
        "production",
        "simulation",
        undefined,
        "false",
        "1",
        undefined,
        {
          STRIPE_SECRET_KEY: "configured",
          DATABASE_URL: "configured",
          STRIPE_WEBHOOK_SECRET: "configured",
          DEMO_BEARER_TOKEN: "configured",
          CRON_SECRET: "configured",
        },
      ),
    ).toThrow(
      /CRON_SECRET, DATABASE_URL, DEMO_BEARER_TOKEN, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET/,
    );
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
    expect(headers.get("x-billing-api-mode")).toBe(
      frontendBillingApiMode(
        process.env.NODE_ENV,
        process.env.NEXT_PUBLIC_BILLING_API_MODE,
      ),
    );
  });

  it("attests production builds independently of browser-supplied state", () => {
    expect(frontendBuildMode("production")).toBe("production");
    expect(frontendBuildMode("development")).toBe("development");
    expect(frontendBuildMode("test")).toBe("development");
    expect(frontendBillingApiMode("production", undefined)).toBe("http");
    expect(frontendBillingApiMode("development", undefined)).toBe("mock");
    expect(frontendBillingApiMode("production", "simulation")).toBe(
      "simulation",
    );
  });
});

describe("frontend-only Vercel simulation topology", () => {
  it("deploys only web and contains no backend rewrite or scheduler", async () => {
    const config = JSON.parse(
      await readFile(
        resolve(process.cwd(), "../vercel.simulation.json"),
        "utf8",
      ),
    );

    expect(config.services).toEqual({
      application: {
        root: "web/",
        framework: "nextjs",
        installCommand: "npm ci",
      },
    });
    expect(config.rewrites).toEqual([
      { source: "/(.*)", destination: { service: "application" } },
    ]);
    expect(config).not.toHaveProperty("crons");
    expect(JSON.stringify(config)).not.toContain("fastapi");
    expect(JSON.stringify(config)).not.toContain('"billing"');
  });
});
