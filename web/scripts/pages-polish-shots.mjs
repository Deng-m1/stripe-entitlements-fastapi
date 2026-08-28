// Screenshot rig for the site-wide visual polish review: landing, pricing,
// and account captured desktop + mobile from one running dev server.
// Usage: node scripts/pages-polish-shots.mjs <outDir> [baseUrl]
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const outDir = process.argv[2] ?? "/tmp/pages-polish-v1";
const baseUrl = process.argv[3] ?? "http://127.0.0.1:4321";
await mkdir(outDir, { recursive: true });

const pages = [
  ["landing", "/"],
  ["pricing", "/pricing"],
  ["account", "/account"],
  // The billing returns only render their settled state with the expectation
  // the redirect carried, so the rig has to arrive the way Checkout does.
  ["billing-success", "/billing/success?expected_plan=pro&expected_interval=month"],
  ["billing-error", "/billing/error?code=payment_failed"],
];

const browser = await chromium.launch();

async function settle(page, path) {
  await page.goto(baseUrl + path, { waitUntil: "networkidle" });
  // Warm one pixel so headless Chromium starts compositing CSS animations,
  // then step-scroll so every IntersectionObserver reveal fires.
  await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
  await page.evaluate(async () => {
    await document.fonts.ready;
    const step = window.innerHeight * 0.7;
    for (let y = 0; y <= document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(4600);
}

for (const [name, path] of pages) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await settle(page, path);
  await page.screenshot({ path: `${outDir}/${name}-desktop-full.png`, fullPage: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${outDir}/${name}-desktop-viewport.png` });
  // The sticky header swaps from transparent to blurred paper on scroll.
  // Real wheel input: programmatic scrollTo does not dispatch scroll events
  // in this headless engine.
  await page.mouse.wheel(0, 520);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${outDir}/${name}-desktop-scrolled-header.png` });
  await page.close();

  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await settle(mobile, path);
  // body.scrollWidth excludes the Next.js dev-tools iframe that the dev
  // server appends under <body>; that overlay never ships to production.
  const overflow = await mobile.evaluate(
    () => document.body.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(`${name} mobile horizontal overflow px: ${overflow}`);
  await mobile.screenshot({ path: `${outDir}/${name}-mobile-full.png`, fullPage: true });
  await mobile.close();
}

await browser.close();
console.log(`done -> ${outDir}`);
