import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

function positiveInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

const baseURL = process.env.PROMO_BASE_URL?.trim();
if (!baseURL) {
  throw new Error("PROMO_BASE_URL is required. Use scripts/run_promo_ui.sh.");
}

const outputDir = resolve(
  process.env.PROMO_OUTPUT_DIR?.trim() || "test-results/promo-ui",
);
const stepPause = positiveInteger("PROMO_STEP_PAUSE_MS", 1600, 300, 5000);

export default defineConfig({
  testDir: "./promo",
  testMatch: ["ui-tour.spec.ts", "landing-responsive.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir,
  reporter: [["list"]],
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    locale: "en-US",
    viewport: { width: 1440, height: 810 },
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    video: {
      mode: "on",
      size: { width: 1440, height: 810 },
    },
    screenshot: "off",
    trace: "off",
  },
  metadata: { stepPause },
});
