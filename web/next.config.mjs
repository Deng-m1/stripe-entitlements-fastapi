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

validatePublicBillingBuildEnvironment(
  process.env.NODE_ENV,
  process.env.NEXT_PUBLIC_BILLING_API_MODE,
  process.env.NEXT_PUBLIC_DEMO_BEARER_TOKEN,
);

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
        ],
      },
    ];
  },
};

export default nextConfig;
