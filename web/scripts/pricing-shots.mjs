// Screenshot rig for the /pricing product-page rounds: desktop and mobile
// captures of both billing intervals, the featured plan, the grouped
// comparison table with its pinned row-header column, the closing CTA
// band, plus the landing viewport and catalog tiles for the shared
// display-token and price-lockup comparisons.
// Usage: node scripts/pricing-shots.mjs <outDir> [baseUrl]
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const outDir = process.argv[2] ?? "/tmp/pricing-v3";
const baseUrl = process.argv[3] ?? "http://127.0.0.1:4321";
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();

async function settle(page, path) {
  await page.goto(baseUrl + path, { waitUntil: "networkidle" });
  await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(900);
}

// Desktop: monthly, yearly, and the comparison card.
const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await settle(desktop, "/pricing");
await desktop.screenshot({ path: `${outDir}/pricing-desktop-monthly-full.png`, fullPage: true });
await desktop.screenshot({ path: `${outDir}/pricing-desktop-viewport.png` });
await desktop.getByRole("button", { name: "Yearly" }).click();
await desktop.waitForTimeout(500);
await desktop.screenshot({ path: `${outDir}/pricing-desktop-yearly-full.png`, fullPage: true });
await desktop
  .locator(".pricing-compare")
  .screenshot({ path: `${outDir}/pricing-desktop-compare.png` });
await desktop
  .locator(".pricing-cta")
  .screenshot({ path: `${outDir}/pricing-desktop-cta.png` });
await desktop.close();

// Landing viewport: the H1 must visibly share the /pricing display tokens,
// and the catalog tiles must carry the same price lockup as the plan cards.
const landing = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await settle(landing, "/");
await landing.waitForTimeout(3200);
await landing.screenshot({ path: `${outDir}/landing-desktop-viewport.png` });
await landing.locator(".catalog-tiles").scrollIntoViewIfNeeded();
await landing.waitForTimeout(900);
await landing
  .locator(".catalog-tiles")
  .screenshot({ path: `${outDir}/landing-catalog-tiles.png` });
await landing.close();

// Mobile: full page plus the panned comparison table with its pinned
// row-header column, and the document-level overflow probe.
const mobile = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
await settle(mobile, "/pricing");
const overflow = await mobile.evaluate(
  () => document.body.scrollWidth - document.documentElement.clientWidth,
);
console.log(`pricing mobile horizontal overflow px: ${overflow}`);
await mobile.screenshot({ path: `${outDir}/pricing-mobile-full.png`, fullPage: true });
await mobile.locator(".pricing-compare").scrollIntoViewIfNeeded();
await mobile.evaluate(() => {
  const wrap = document.querySelector(".comparison-table-wrap");
  if (wrap) wrap.scrollLeft = 170;
});
await mobile.waitForTimeout(400);
await mobile
  .locator(".comparison-table-wrap")
  .screenshot({ path: `${outDir}/pricing-mobile-compare-panned.png` });
await mobile.close();

await browser.close();
console.log(`done -> ${outDir}`);
