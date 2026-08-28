// Multi-page screenshot rig for the iterative visual review rounds.
// Covers /, /pricing, /account at desktop 1440 and mobile 390.
// Usage: node scripts/visual-review-pages.mjs <outDir> [baseUrl]
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const outDir = process.argv[2] ?? "/tmp/visual-review/round1";
const baseUrl = process.argv[3] ?? "http://127.0.0.1:3001";
await mkdir(outDir, { recursive: true });

const pages = [
  { route: "/", slug: "landing" },
  { route: "/pricing", slug: "pricing" },
  { route: "/account", slug: "account" },
  // The settlement moment: SuccessScreen polls the account API until the
  // projection matches the expected plan, so mock mode settles immediately.
  {
    route: "/billing/success?expected_plan=starter&expected_interval=month",
    slug: "success",
  },
];

const browser = await chromium.launch();

async function settle(page, route) {
  await page.goto(baseUrl + route, { waitUntil: "networkidle" });
  // Headless Chromium may defer CSS animation compositor frames until the
  // first paint-producing operation; warm one pixel first.
  await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
  // Step-scroll so IntersectionObserver reveals fire, then return to top.
  await page.evaluate(async () => {
    await document.fonts.ready;
    const step = window.innerHeight * 0.7;
    for (let y = 0; y <= document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(3200);
}

for (const { route, slug } of pages) {
  // Desktop 1440
  {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await settle(page, route);
    await page.screenshot({
      path: `${outDir}/${slug}-desktop-first-viewport.png`,
    });
    await page.screenshot({
      path: `${outDir}/${slug}-desktop-full.png`,
      fullPage: true,
    });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${outDir}/${slug}-desktop-bottom.png` });
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
    await settle(page, route);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    console.log(`${slug} mobile horizontal overflow px: ${overflow}`);
    await page.screenshot({
      path: `${outDir}/${slug}-mobile-first-viewport.png`,
    });
    await page.screenshot({
      path: `${outDir}/${slug}-mobile-full.png`,
      fullPage: true,
    });
    await page.close();
  }
}

await browser.close();
console.log(`done -> ${outDir}`);
