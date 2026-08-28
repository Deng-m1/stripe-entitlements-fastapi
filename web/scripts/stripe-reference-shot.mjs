// Captures the live Stripe zh-us hero as the Round 2 visual-review reference.
// Usage: node scripts/stripe-reference-shot.mjs <outDir>
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const outDir = process.argv[2] ?? "/tmp/visual-review/round3/reference";
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();

for (const [name, width, height] of [
  ["stripe-zh-us-1440", 1440, 900],
  ["stripe-zh-us-390", 390, 844],
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  try {
    await page.goto("https://stripe.com/zh-us", {
      waitUntil: "networkidle",
      timeout: 45_000,
    });
  } catch {
    // networkidle can starve on ad/analytics beacons; capture anyway.
  }
  await page.waitForTimeout(6_000);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  await page.close();
}

await browser.close();
console.log(`done -> ${outDir}`);
