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

const allowedDevOrigins = ["127.0.0.1"];
const previewDevOrigin = process.env.NEXT_ALLOWED_DEV_ORIGIN?.trim();
if (previewDevOrigin) allowedDevOrigins.push(previewDevOrigin);

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Next 16 blocks dev-resource requests from origins other than localhost.
  // Without this, a dev preview opened via 127.0.0.1 serves HTML but never
  // hydrates (no errors; effects and clicks are silently dead), which breaks
  // every mock-mode review of /pricing and /account. Dev-only setting.
  allowedDevOrigins,
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
