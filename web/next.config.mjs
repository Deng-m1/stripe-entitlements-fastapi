import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function validatePublicBillingBuildEnvironment(
  environment,
  mode,
  demoToken,
) {
  if (mode && mode !== "http" && mode !== "mock") {
    throw new Error(
      "NEXT_PUBLIC_BILLING_API_MODE must be either 'http' or 'mock'.",
    );
  }
  if (environment === "production" && (mode === "mock" || Boolean(demoToken))) {
    throw new Error(
      "Production builds cannot include mock billing mode or NEXT_PUBLIC_DEMO_BEARER_TOKEN.",
    );
  }
}

export function frontendBuildMode(environment) {
  return environment === "production" ? "production" : "development";
}

export const PRODUCTION_E2E_ROUTE_AUTH_SENTINEL =
  "stripe-entitlements-e2e-route-auth-v1.invalid";

function isHttpsLoopbackOrigin(raw) {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
}

export function productionE2ERouteAuthSentinel({
  environment,
  mode,
  backendUrl,
  allowIndexing,
  demoToken,
  acknowledgement,
  publicSentinel,
}) {
  if (publicSentinel !== undefined) {
    throw new Error(
      "NEXT_PUBLIC_E2E_ROUTE_AUTH_SENTINEL is reserved and cannot be configured.",
    );
  }
  if (acknowledgement === undefined || acknowledgement === "") return undefined;
  if (acknowledgement !== "1") {
    throw new Error("E2E_ALLOW_PRODUCTION_ROUTE_AUTH must be exactly '1'.");
  }
  if (
    environment !== "production" ||
    mode !== "http" ||
    !isHttpsLoopbackOrigin(backendUrl) ||
    allowIndexing !== "false" ||
    Boolean(demoToken)
  ) {
    throw new Error(
      "Production E2E route auth requires production HTTP mode, an HTTPS loopback backend origin, explicit indexing=false, and no demo token.",
    );
  }
  return PRODUCTION_E2E_ROUTE_AUTH_SENTINEL;
}

validatePublicBillingBuildEnvironment(
  process.env.NODE_ENV,
  process.env.NEXT_PUBLIC_BILLING_API_MODE,
  process.env.NEXT_PUBLIC_DEMO_BEARER_TOKEN,
);

const productionRouteAuthSentinel = productionE2ERouteAuthSentinel({
  environment: process.env.NODE_ENV,
  mode: process.env.NEXT_PUBLIC_BILLING_API_MODE,
  backendUrl: process.env.NEXT_PUBLIC_BILLING_API_BASE_URL,
  allowIndexing: process.env.NEXT_PUBLIC_ALLOW_INDEXING,
  demoToken: process.env.NEXT_PUBLIC_DEMO_BEARER_TOKEN,
  acknowledgement: process.env.E2E_ALLOW_PRODUCTION_ROUTE_AUTH,
  publicSentinel: process.env.NEXT_PUBLIC_E2E_ROUTE_AUTH_SENTINEL,
});

/** @type {import("next").NextConfig} */
const nextConfig = {
  // Next 16.3 otherwise writes nested AGENTS.md/CLAUDE.md files on `next dev`,
  // duplicating and potentially shadowing this repository's reviewed root guide.
  agentRules: false,
  reactStrictMode: true,
  outputFileTracingRoot: repositoryRoot,
  transpilePackages: ["@tosea/stripe-entitlements"],
  turbopack: { root: repositoryRoot },
  env: productionRouteAuthSentinel
    ? { NEXT_PUBLIC_E2E_ROUTE_AUTH_SENTINEL: productionRouteAuthSentinel }
    : {},
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
          },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Origin-Agent-Cluster", value: "?1" },
          {
            key: "Permissions-Policy",
            value: "camera=(), geolocation=(), microphone=()",
          },
          {
            key: "X-Frontend-Build-Mode",
            value: frontendBuildMode(process.env.NODE_ENV),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
