// Product-bento evidence rig (scorecard §3, brief §3.3): deterministic 1440
// and 390 stills of the bento section — reduced motion pins the reveals so
// captures are stable while the static tilt/depth composition stays intact.
// Usage: node scripts/bento-shots.mjs <outDir> [baseUrl]
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const outDir = process.argv[2] ?? "/tmp/bento-v1";
const baseUrl = process.argv[3] ?? "http://127.0.0.1:4321";
await mkdir(outDir, { recursive: true });

const SECTION = "section[aria-labelledby='bento-heading']";
const VIEWPORTS = [
  ["1440", { width: 1440, height: 900 }],
  ["390", { width: 390, height: 844 }],
];

const browser = await chromium.launch();
for (const [name, viewport] of VIEWPORTS) {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    viewport,
  });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  // The sticky header would float over the section-only crop; the viewport
  // and full-page shots below keep it.
  await page.addStyleTag({ content: ".site-header { visibility: hidden; }" });
  const section = page.locator(SECTION);
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(450);
  await section.screenshot({ path: `${outDir}/bento-section-${name}.png` });
  await page.evaluate(() => {
    const styles = document.querySelectorAll("style");
    styles[styles.length - 1]?.remove();
  });

  await page.evaluate((selector) => {
    document.querySelector(selector)?.scrollIntoView({ block: "start" });
  }, SECTION);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/bento-viewport-${name}.png` });

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({
    fullPage: true,
    path: `${outDir}/landing-full-${name}.png`,
  });

  await context.close();
}
await browser.close();
console.log(`bento evidence written to ${outDir}`);
