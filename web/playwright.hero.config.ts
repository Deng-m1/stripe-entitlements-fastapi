import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Proof gate for the WebGL hero (DESIGN_BRIEF.md §7.1).
 *
 * Deliberately separate from `playwright.promo.config.ts`: that suite is a
 * video capture rig that pins deterministic motion settings, and the first
 * assertion here needs the opposite — a default profile that actually animates.
 * Each test in this file also drives its own browser context, so the shared
 * `use` block stays minimal.
 */

const baseURL = process.env.HERO_BASE_URL?.trim();
if (!baseURL) {
  throw new Error("HERO_BASE_URL is required. Use scripts/run_hero_webgl.sh.");
}

export default defineConfig({
  testDir: "./promo",
  testMatch: ["hero-webgl.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: resolve(
    process.env.HERO_OUTPUT_DIR?.trim() || "test-results/hero-webgl",
  ),
  reporter: [["list"]],
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    locale: "en-US",
    viewport: { width: 1440, height: 810 },
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    screenshot: "off",
    trace: "off",
    video: "off",
  },
});
