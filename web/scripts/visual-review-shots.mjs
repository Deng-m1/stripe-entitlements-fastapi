// Screenshot rig for the iterative landing visual review.
// Usage: node scripts/visual-review-shots.mjs <outDir> [baseUrl]
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const outDir = process.argv[2] ?? "/tmp/landing-iterative-review/round1";
const baseUrl = process.argv[3] ?? "http://127.0.0.1:4321";
await mkdir(outDir, { recursive: true });

const sections = [
  ["hero", ".paper-hero"],
  ["ledger", "section[aria-labelledby='ledger-heading']"],
  ["nodegraph", "section[aria-labelledby='invariants-heading']"],
  ["matrix", "section[aria-labelledby='matrix-heading']"],
  ["proofband", "section[aria-labelledby='gates-heading']"],
  ["catalog", "section[aria-labelledby='catalog-heading']"],
  ["faq-footer", "section[aria-labelledby='faq-heading']"],
];

const browser = await chromium.launch();

async function settle(page) {
  await page.goto(baseUrl + "/", { waitUntil: "networkidle" });
  // Headless Chromium may defer CSS animation compositor frames until the first
  // paint-producing operation. Warm one pixel before the timed reveal so the
  // first full-page review shot records the settled terminal, not its initial
  // transparent frame.
  await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
  // Step-scroll through the page so every IntersectionObserver reveal fires
  // (an instant jump skips intermediate sections), then return to top.
  await page.evaluate(async () => {
    await document.fonts.ready;
    const step = window.innerHeight * 0.7;
    for (let y = 0; y <= document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(4600);
}

// Desktop 1440
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await settle(page);
  await page.screenshot({ path: `${outDir}/desktop-full.png`, fullPage: true });
  for (const [name, selector] of sections) {
    const el = page.locator(selector).first();
    if ((await el.count()) === 0) {
      console.log(`MISSING selector for ${name}: ${selector}`);
      continue;
    }
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(900);
    await el.screenshot({ path: `${outDir}/desktop-${name}.png` });
  }
  // Footer + stack strip: capture the last viewport.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${outDir}/desktop-footer-viewport.png` });
  // First viewport exactly as a visitor lands.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${outDir}/desktop-first-viewport.png` });
  await page.close();
}

// Mobile 390
{
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await settle(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(`mobile horizontal overflow px: ${overflow}`);
  await page.screenshot({ path: `${outDir}/mobile-full.png`, fullPage: true });
  for (const [name, selector] of [
    ["hero", ".paper-hero"],
    ["ledger", "section[aria-labelledby='ledger-heading']"],
    ["matrix", "section[aria-labelledby='matrix-heading']"],
    ["proofband", "section[aria-labelledby='gates-heading']"],
  ]) {
    const el = page.locator(selector).first();
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(900);
    await el.screenshot({ path: `${outDir}/mobile-${name}.png` });
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${outDir}/mobile-first-viewport.png` });
  await page.close();
}

// Reduced motion, desktop first viewport + ledger
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(baseUrl + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${outDir}/reduced-motion-hero.png` });
  const ledger = page.locator("section[aria-labelledby='ledger-heading']").first();
  await ledger.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await ledger.screenshot({ path: `${outDir}/reduced-motion-ledger.png` });
  await page.close();
}

await browser.close();
console.log(`done -> ${outDir}`);
