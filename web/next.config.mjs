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
  allowIndexing,
  simulationAcknowledgement,
  stripePublishableKey,
  serverCredentials = {},
) {
  if (mode && mode !== "http" && mode !== "mock" && mode !== "simulation") {
    throw new Error(
      "NEXT_PUBLIC_BILLING_API_MODE must be 'http', 'mock', or 'simulation'.",
    );
  }
  if (simulationAcknowledgement !== undefined && simulationAcknowledgement !== "1") {
    throw new Error(
      "NEXT_PUBLIC_SIMULATION_ACKNOWLEDGEMENT must be exactly '1' when set.",
    );
  }
  if (simulationAcknowledgement !== undefined && mode !== "simulation") {
    throw new Error(
      "NEXT_PUBLIC_SIMULATION_ACKNOWLEDGEMENT is valid only in simulation mode.",
    );
  }
  if (
    mode === "simulation" &&
    (Boolean(demoToken) || Boolean(stripePublishableKey))
  ) {
    throw new Error(
      "Public simulation cannot include browser demo authentication or a Stripe publishable key.",
    );
  }
  if (mode === "simulation" && allowIndexing !== "false") {
    throw new Error(
      "Public simulation requires NEXT_PUBLIC_ALLOW_INDEXING=false.",
    );
  }
  if (mode === "simulation") {
    const configuredServerCredentials = Object.entries(serverCredentials)
      .filter(([, value]) => typeof value === "string" && value.length > 0)
      .map(([name]) => name)
      .sort();
    if (configuredServerCredentials.length > 0) {
      throw new Error(
        `Public simulation cannot include server credentials: ${configuredServerCredentials.join(
          ", ",
        )}.`,
      );
    }
  }
  if (
    environment === "production" &&
    (mode === "mock" || Boolean(demoToken))
  ) {
    throw new Error(
      "Production builds cannot include mock billing mode or NEXT_PUBLIC_DEMO_BEARER_TOKEN.",
    );
  }
  if (
    environment === "production" &&
    mode === "simulation" &&
    simulationAcknowledgement !== "1"
  ) {
    throw new Error(
      "Production simulation requires NEXT_PUBLIC_SIMULATION_ACKNOWLEDGEMENT=1.",
    );
  }
}

export function frontendBuildMode(environment) {
  return environment === "production" ? "production" : "development";
}

export function frontendBillingApiMode(environment, mode) {
  if (mode === "http" || mode === "mock" || mode === "simulation") {
    return mode;
  }
  return environment === "production" ? "http" : "mock";
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
  process.env.NEXT_PUBLIC_ALLOW_INDEXING,
  process.env.NEXT_PUBLIC_SIMULATION_ACKNOWLEDGEMENT,
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
  {
    CRON_SECRET: process.env.CRON_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    DEMO_BEARER_TOKEN: process.env.DEMO_BEARER_TOKEN,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  },
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
          {
            key: "X-Billing-Api-Mode",
            value: frontendBillingApiMode(
              process.env.NODE_ENV,
              process.env.NEXT_PUBLIC_BILLING_API_MODE,
            ),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
