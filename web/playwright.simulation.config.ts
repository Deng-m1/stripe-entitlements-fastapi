import { defineConfig } from "@playwright/test";

const externalBaseUrl = process.env.SIMULATION_BASE_URL?.trim();
const baseURL = externalBaseUrl || "http://127.0.0.1:3099";
const remoteAcknowledgement = process.env.SIMULATION_ALLOW_REMOTE;

if (externalBaseUrl) {
  if (remoteAcknowledgement !== "1") {
    throw new Error(
      "Remote simulation E2E requires SIMULATION_ALLOW_REMOTE=1.",
    );
  }
  const parsed = new URL(externalBaseUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    parsed.hostname,
  );
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error(
      "SIMULATION_BASE_URL must be an HTTPS origin (or loopback HTTP) without credentials, path, query, or fragment.",
    );
  }
} else if (remoteAcknowledgement !== undefined) {
  throw new Error(
    "SIMULATION_ALLOW_REMOTE is valid only with SIMULATION_BASE_URL.",
  );
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "public-simulation.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  ...(externalBaseUrl
    ? {}
    : {
        webServer: {
          command: "npm run build && npm start -- -H 127.0.0.1 -p 3099",
          env: {
            NEXT_PUBLIC_BILLING_API_MODE: "simulation",
            NEXT_PUBLIC_SIMULATION_ACKNOWLEDGEMENT: "1",
            NEXT_PUBLIC_ALLOW_INDEXING: "false",
          },
          url: baseURL,
          reuseExistingServer: false,
          timeout: 180_000,
        },
      }),
});
