// Screenshot rig for the site-chrome round: the header's transparent-over-
// hero and scrolled white-blur states, plus the compact demo-notice pill.
// The header pair runs against a production build (the hero renderer and
// poster handover behave differently under the dev overlay); the demo-notice
// pair needs a mock-mode dev server, since production builds refuse mock and
// therefore never render the banner.
// Usage: node scripts/chrome-v2-shots.mjs <outDir> <baseUrl> <prefix>
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const outDir = process.argv[2] ?? "/tmp/chrome-v2";
const baseUrl = process.argv[3] ?? "http://127.0.0.1:4732";
const prefix = process.argv[4] ?? "prod";
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();

async function open(page) {
  await page.goto(baseUrl + "/", { waitUntil: "networkidle" });
  // Warm one pixel so headless Chromium starts compositing, then wait for
  // the hero's first real frame when the WebGL path is present, plus the
  // 900ms poster fade so the capture shows the live render, not the fade.
  await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const wave = page.locator(".hero-wave");
  if ((await wave.count()) > 0) {
    await wave
      .first()
      .evaluate(
        (el) =>
          new Promise((resolve) => {
            const done = () => el.dataset.drawn === "true" && resolve();
            done();
            new MutationObserver(done).observe(el, { attributes: true });
            setTimeout(resolve, 8000);
          }),
      );
  }
  await page.waitForTimeout(1400);
}

async function captureHeaderStates(width, height, label) {
  const page = await browser.newPage({ viewport: { width, height } });
  await open(page);

  const headerBox = { x: 0, y: 0, width, height: 150 };
  await page.screenshot({ path: `${outDir}/${prefix}-${label}-top.png` });
  await page.screenshot({
    clip: headerBox,
    path: `${outDir}/${prefix}-${label}-top-header.png`,
  });

  // A real wheel gesture: programmatic scrollTo does not dispatch scroll
  // events in this headless engine, while user input always does.
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(600);
  const scrolled = await page.evaluate(() => {
    const header = document.querySelector(".site-header");
    return {
      flagged: header?.hasAttribute("data-scrolled") ?? false,
      background: header ? getComputedStyle(header).backgroundColor : "",
      blur: header ? getComputedStyle(header).backdropFilter : "",
    };
  });
  console.log(`${prefix}-${label} scrolled state:`, JSON.stringify(scrolled));
  await page.screenshot({ path: `${outDir}/${prefix}-${label}-scrolled.png` });
  await page.screenshot({
    clip: headerBox,
    path: `${outDir}/${prefix}-${label}-scrolled-header.png`,
  });
  await page.close();
}

async function captureDemoNotice(width, height, label) {
  const page = await browser.newPage({ viewport: { width, height } });
  await open(page);
  const notice = page.locator(".demo-notice");
  if ((await notice.count()) === 0) {
    console.log(`${prefix}-${label}: no demo notice rendered (http mode)`);
    await page.close();
    return;
  }
  const metrics = await notice.first().evaluate((el) => {
    const body = el.querySelector(".demo-notice-body");
    return {
      noticeHeight: el.getBoundingClientRect().height,
      bodyHeight: body?.getBoundingClientRect().height ?? 0,
      overflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    };
  });
  console.log(`${prefix}-${label} demo notice:`, JSON.stringify(metrics));
  await page.screenshot({
    clip: { x: 0, y: 0, width, height: 170 },
    path: `${outDir}/${prefix}-${label}-demo-notice.png`,
  });
  await page.close();
}

await captureHeaderStates(1440, 900, "desktop-1440");
await captureHeaderStates(390, 844, "mobile-390");
await captureDemoNotice(1440, 900, "desktop-1440");
await captureDemoNotice(390, 844, "mobile-390");

await browser.close();
