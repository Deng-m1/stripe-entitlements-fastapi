import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: projectRoot,
  turbopack: {
    root: projectRoot,
  },
  // The package resolves its immutable catalog and SQL bundle at runtime. Keep
  // those non-JavaScript resources in serverless output-file traces.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/@tosea/stripe-entitlements/dist/plans.toml",
      "./node_modules/@tosea/stripe-entitlements/dist/migrations/**/*.sql",
    ],
  },
};

export default nextConfig;
