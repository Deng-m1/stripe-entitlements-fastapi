import { defineConfig } from "@playwright/test";

function requiredEnvironment(name: string, expected?: string): string {
  const value = process.env[name]?.trim();
  if (!value || (expected !== undefined && value !== expected)) {
    const suffix = expected === undefined ? "" : `=${expected}`;
    throw new Error(
      `Real Stripe browser E2E is opt-in. Set ${name}${suffix} exactly as documented.`,
    );
  }
  return value;
}

function positiveDuration(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 10_000 || value > 600_000) {
    throw new Error(`${name} must be an integer between 10000 and 600000 ms.`);
  }
  return value;
}

function integerInRange(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

requiredEnvironment("E2E_RUN_REAL_STRIPE", "1");
requiredEnvironment("E2E_STRIPE_MODE", "test");
if (!requiredEnvironment("STRIPE_SECRET_KEY").startsWith("sk_test_")) {
  throw new Error("Real Stripe browser E2E refuses a key that is not sk_test_.");
}
requiredEnvironment("E2E_DATABASE_URL");
requiredEnvironment("E2E_EXTERNAL_REF");

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function validatedOrigin(name: string): { url: URL; loopback: boolean } {
  let url: URL;
  try {
    url = new URL(requiredEnvironment(name));
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  const loopback = loopbackHosts.has(url.hostname);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${name} must not contain credentials, a query string, or a fragment.`,
    );
  }
  if (url.pathname !== "/") {
    throw new Error(`${name} must be an origin without an application path.`);
  }
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error(`${name} must use HTTPS; loopback HTTP is the only exception.`);
  }
  return { url, loopback };
}

const frontend = validatedOrigin("E2E_BASE_URL");
const backend = validatedOrigin("E2E_BACKEND_URL");
if (!frontend.loopback || !backend.loopback) {
  requiredEnvironment("E2E_ALLOW_REMOTE_BASE_URL", "1");
}

const lifecycleTimeout = positiveDuration("E2E_WEBHOOK_TIMEOUT_MS", 180_000);
integerInRange("E2E_DECLINE_STABILITY_SECONDS", 10, 10, 60);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "stripe-checkout.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: lifecycleTimeout + 120_000,
  expect: { timeout: 20_000 },
  outputDir: "test-results/playwright-stripe",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/stripe", open: "never" }],
  ],
  use: {
    baseURL: frontend.url.origin,
    browserName: "chromium",
    headless: process.env.E2E_HEADLESS !== "0",
    locale: "en-US",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
});
