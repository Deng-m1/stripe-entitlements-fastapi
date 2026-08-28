// Finds the elements that stick out past the 390px viewport on one route.
// Usage: node scripts/overflow-culprit.mjs <route> [baseUrl]
import { chromium } from "@playwright/test";

const route = process.argv[2] ?? "/";
const baseUrl = process.argv[3] ?? "http://127.0.0.1:3002";

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
await page.goto(baseUrl + route, { waitUntil: "networkidle" });
await page.waitForTimeout(2_500);
const culprits = await page.evaluate(() => {
  const width = document.documentElement.clientWidth;
  const found = [];
  for (const el of document.querySelectorAll("body *")) {
    const rect = el.getBoundingClientRect();
    if (rect.right > width + 0.5 || rect.left < -0.5) {
      found.push(
        `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} left=${rect.left.toFixed(1)} right=${rect.right.toFixed(1)}`,
      );
    }
  }
  return found.slice(0, 12);
});
console.log(culprits.join("\n") || "none");
await browser.close();
