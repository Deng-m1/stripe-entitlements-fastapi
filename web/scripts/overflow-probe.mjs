// Quick 390px horizontal-overflow probe for the review routes.
// Usage: node scripts/overflow-probe.mjs [baseUrl]
import { chromium } from "@playwright/test";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:3002";
const routes = [
  "/",
  "/pricing",
  "/account",
  "/billing/success?expected_plan=starter&expected_interval=month",
  "/billing/error?code=payment_failed",
  "/billing/error",
];

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

for (const route of routes) {
  await page.goto(baseUrl + route, { waitUntil: "networkidle" });
  await page.waitForTimeout(2_500);
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  console.log(`${route} overflow px: ${overflow}`);
}

await browser.close();
