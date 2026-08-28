// Motion v3 evidence rig (scorecard §9 follow-up to scroll-motion-shots.mjs).
//
// Captures, against a running production build:
//   1. a screen recording of the landing scroll-through followed by a hover
//      tour (cards, buttons, chips) and the /pricing featured-card lift;
//   2. entrance-stagger frames: the hero pill cascade mid-flight and the
//      upgrade-matrix group reveal mid-rise;
//   3. rest/hover screenshot pairs plus a computed-style probe
//      (hover-probe.json) for every hover target — a transform delta between
//      rest and hover is the machine-readable proof of each micro-interaction;
//   4. the same probe under prefers-reduced-motion: reduce, where hovering
//      must produce zero movement: every target's rest and hover computed
//      transform/translate must be identical (reduced-probe.json).
//
// Usage: node scripts/motion-v3-shots.mjs [outDir] [baseUrl]
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const outDir = process.argv[2] ?? "/tmp/motion-v3";
const baseUrl = process.argv[3] ?? "http://127.0.0.1:4321";
await mkdir(outDir, { recursive: true });

// [name, path, selector] for every hover micro-interaction under proof.
const hoverTargets = [
  ["event-pill", "/", ".hero-pills li:nth-child(1)"],
  ["capability-card", "/", ".pipeline-band .capability-grid li:nth-child(1)"],
  ["gate-item", "/", ".gate-list li:nth-child(1)"],
  ["catalog-tile", "/", ".catalog-tile:nth-child(1)"],
  ["button-primary", "/", ".hero-actions .button.primary"],
  ["button-secondary", "/", ".hero-actions .button.secondary"],
  ["button-outline-invert", "/", ".pipeline-band .button.outline-invert"],
  ["plan-card-side", "/pricing", ".plan-grid .plan-card:nth-child(1)"],
  ["pricing-featured", "/pricing", ".plan-grid .pricing-featured"],
];

async function open(page, path) {
  await page.goto(baseUrl + path, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

async function styleOf(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      transform: style.transform,
      translate: style.translate,
      boxShadow: style.boxShadow,
      backgroundColor: style.backgroundColor,
    };
  }, selector);
}

async function shotAround(page, selector, path) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) return;
  const pad = 48;
  await page.screenshot({
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.width + pad * 2,
      height: box.height + pad * 2,
    },
    path,
  });
}

const browser = await chromium.launch();

// 1. Screen recording: scroll-through + hover tour + featured lift.
{
  const context = await browser.newContext({
    recordVideo: { dir: outDir, size: { width: 1440, height: 810 } },
    viewport: { width: 1440, height: 810 },
  });
  const page = await context.newPage();
  await open(page, "/");
  await page.waitForTimeout(2200);
  await page.evaluate(async () => {
    const total = document.body.scrollHeight - window.innerHeight;
    const steps = 80;
    for (let i = 0; i <= steps; i += 1) {
      window.scrollTo(0, (total * i) / steps);
      await new Promise((r) => setTimeout(r, 55));
    }
  });
  // Hover tour on the way back up.
  for (const [, path, selector] of hoverTargets) {
    if (path !== "/") continue;
    const target = page.locator(selector).first();
    await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await target.hover();
    await page.waitForTimeout(650);
    await page.mouse.move(4, 4);
    await page.waitForTimeout(300);
  }
  await open(page, "/pricing");
  await page.waitForTimeout(1400);
  for (const selector of [
    ".plan-grid .plan-card:nth-child(1)",
    ".plan-grid .pricing-featured",
    ".interval-toggle button:nth-child(2)",
  ]) {
    await page.locator(selector).first().hover();
    await page.waitForTimeout(750);
  }
  await page.mouse.move(4, 4);
  await page.waitForTimeout(400);
  await page.close();
  await context.close();
  console.log(`recording saved under ${outDir}`);
}

// 2. Entrance-stagger frames.
{
  const page = await browser.newPage({
    viewport: { width: 1440, height: 810 },
  });
  // Hero pill cascade: land and grab an early + settled frame.
  await page.goto(baseUrl + "/", { waitUntil: "commit" });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${outDir}/entrance-hero-early.png` });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${outDir}/entrance-hero-settled.png` });

  // Matrix group reveal: park just above, scroll it in, catch mid-rise.
  await open(page, "/");
  await page.evaluate(() => {
    const el = document.querySelector(
      "section[aria-labelledby='matrix-heading']",
    );
    window.scrollTo(0, el.offsetTop - window.innerHeight);
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const el = document.querySelector(
      "section[aria-labelledby='matrix-heading']",
    );
    window.scrollTo(0, el.offsetTop - window.innerHeight * 0.55);
  });
  await page.waitForTimeout(180);
  await page.screenshot({ path: `${outDir}/entrance-matrix-mid.png` });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${outDir}/entrance-matrix-settled.png` });

  // Pricing plan-card cascade on load.
  await page.goto(baseUrl + "/pricing", { waitUntil: "commit" });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/entrance-pricing-early.png` });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/entrance-pricing-settled.png` });
  await page.close();
}

// 3. Hover rest/active pairs + computed-style probe.
{
  const page = await browser.newPage({
    viewport: { width: 1440, height: 810 },
  });
  const probe = {};
  let currentPath = null;
  for (const [name, path, selector] of hoverTargets) {
    if (path !== currentPath) {
      await open(page, path);
      await page.waitForTimeout(1600);
      currentPath = path;
    }
    const target = page.locator(selector).first();
    await target.scrollIntoViewIfNeeded();
    await page.mouse.move(4, 4);
    await page.waitForTimeout(600);
    const rest = await styleOf(page, selector);
    await shotAround(page, selector, `${outDir}/hover-${name}-rest.png`);
    await target.hover();
    await page.waitForTimeout(450);
    const hover = await styleOf(page, selector);
    await shotAround(page, selector, `${outDir}/hover-${name}-active.png`);
    probe[name] = {
      rest,
      hover,
      moved:
        rest?.transform !== hover?.transform ||
        rest?.translate !== hover?.translate,
    };
  }
  await page.close();
  await writeFile(`${outDir}/hover-probe.json`, JSON.stringify(probe, null, 2));
  const moved = Object.entries(probe)
    .map(([name, entry]) => `${name}=${entry.moved}`)
    .join(" ");
  console.log("hover transform deltas:", moved);
}

// 4. Reduced motion: hovering must move nothing — rest and hover computed
//    transform/translate must match on every target. (Static poses such as
//    the hero pills' scatter offsets legitimately keep a non-none
//    transform; the invariant is zero delta, not `none`.)
{
  const page = await browser.newPage({
    viewport: { width: 1440, height: 810 },
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const probe = {};
  let currentPath = null;
  for (const [name, path, selector] of hoverTargets) {
    if (path !== currentPath) {
      await open(page, path);
      await page.waitForTimeout(700);
      currentPath = path;
    }
    const target = page.locator(selector).first();
    await target.scrollIntoViewIfNeeded();
    await page.mouse.move(4, 4);
    await page.waitForTimeout(150);
    const rest = await styleOf(page, selector);
    await target.hover();
    await page.waitForTimeout(250);
    const hover = await styleOf(page, selector);
    probe[name] = {
      rest,
      hover,
      moved:
        rest?.transform !== hover?.transform ||
        rest?.translate !== hover?.translate,
    };
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/reduced-landing.png` });
  await open(page, "/pricing");
  await page.locator(".plan-grid .pricing-featured").hover();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/reduced-pricing-hover.png` });
  await page.close();
  await writeFile(
    `${outDir}/reduced-probe.json`,
    JSON.stringify(probe, null, 2),
  );
  const stuck = Object.entries(probe)
    .filter(([, entry]) => entry.moved)
    .map(
      ([name, entry]) =>
        `${name}: ${entry.rest?.transform}/${entry.rest?.translate} -> ${entry.hover?.transform}/${entry.hover?.translate}`,
    );
  console.log(
    stuck.length === 0
      ? "reduced-motion: all hover targets parked (zero hover delta)"
      : `reduced-motion VIOLATIONS: ${stuck.join(" ")}`,
  );
}

await browser.close();
console.log(`done -> ${outDir}`);
