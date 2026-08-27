import { defineConfig } from "@playwright/test";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { browserProcessEnvironment } from "./lib/browser-process-environment";
import { optionalLoopbackCertificateSpki } from "./lib/e2e-tls";

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
requiredEnvironment("E2E_FRONTEND_BUILD_MODE", "production");
const transitionPolicy = requiredEnvironment("E2E_TRANSITION_POLICY");
if (!["full_period_reset", "prorated_delta"].includes(transitionPolicy)) {
  throw new Error(
    "E2E_TRANSITION_POLICY must be full_period_reset or prorated_delta.",
  );
}
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

function validatedStorageState(): string | undefined {
  const configured = process.env.E2E_STORAGE_STATE?.trim();
  if (!configured) {
    if (!frontend.loopback || !backend.loopback) {
      throw new Error(
        "Remote browser E2E requires E2E_STORAGE_STATE for an isolated authenticated subject.",
      );
    }
    return undefined;
  }
  const path = resolve(configured);
  const state = statSync(path);
  if (!state.isFile()) throw new Error("E2E_STORAGE_STATE must identify a file.");
  if ((state.mode & 0o077) !== 0) {
    throw new Error("E2E_STORAGE_STATE must not be readable by group or other users.");
  }
  return path;
}

const lifecycleTimeout = positiveDuration("E2E_WEBHOOK_TIMEOUT_MS", 180_000);
integerInRange("E2E_DECLINE_STABILITY_SECONDS", 10, 10, 60);
const demoPauseMs = integerInRange("E2E_DEMO_PAUSE_MS", 0, 0, 5_000);
const storageState = validatedStorageState();
const recordVideo = process.env.E2E_RECORD_VIDEO === "1";
const loopbackCertificateSpki = optionalLoopbackCertificateSpki(
  process.env.E2E_LOOPBACK_TLS_SPKI,
);
const outputDir = resolve(
  process.env.E2E_OUTPUT_DIR?.trim() ||
    `test-results/playwright-stripe-${transitionPolicy}`,
);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "stripe-checkout.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  preserveOutput: "always",
  timeout: 2 * lifecycleTimeout + 180_000,
  expect: { timeout: 20_000 },
  outputDir,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/stripe", open: "never" }],
  ],
  use: {
    baseURL: frontend.url.origin,
    storageState,
    browserName: "chromium",
    headless: process.env.E2E_HEADLESS !== "0",
    locale: "en-US",
    viewport: recordVideo
      ? { width: 1440, height: 810 }
      : { width: 1280, height: 720 },
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: recordVideo
      ? { mode: "on", size: { width: 1440, height: 810 } }
      : "off",
    launchOptions: {
      env: browserProcessEnvironment(process.env),
      args: loopbackCertificateSpki
        ? [`--ignore-certificate-errors-spki-list=${loopbackCertificateSpki}`]
        : [],
    },
  },
  metadata: { demoPauseMs, recordVideo },
});
