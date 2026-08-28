// Scroll-motion evidence rig (DESIGN_BRIEF.md v3 §3.2 / §7.1.4).
//
// Captures, against a running production build:
//   1. a screen recording of a full scroll-through on the default motion
//      profile (reveals + parallax + hero drift in motion);
//   2. frame screenshots of the hero at increasing scroll offsets (drift);
//   3. a computed-transform probe of every parallax layer at two scroll
//      positions, written to parallax-probe.json — distinct translate values
//      per layer are the machine-readable proof of distinct parallax rates;
//   4. the same probe under prefers-reduced-motion: reduce, where every
//      layer must report `none`.
//
// Usage: node scripts/scroll-motion-shots.mjs <outDir> [baseUrl]
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const outDir = process.argv[2] ?? "/tmp/scroll-motion-v2/run";
const baseUrl = process.argv[3] ?? "http://127.0.0.1:4321";
await mkdir(outDir, { recursive: true });

const probedLayers = [
  // ScrollMotion contracts (--scroll-exit / --scroll-progress).
  ["hero-wave", ".hero-wave"],
  ["hero-artifact", ".hero-artifact"],
  // ScrollReveal [data-depth] layers (--parallax-shift).
  ["ledger-glow", ".ledger-stage-glow"],
  ["ledger-stack", ".ledger-stack"],
  ["band-stage", ".band-stage"],
  ["matrix-glow", ".matrix-stage-glow"],
  ["matrix-stack", ".matrix-stack"],
  ["proof-popover", ".proof-popover"],
  // Static depth poses that must NOT respond to scroll.
  ["ledger-card", ".ledger-card"],
  ["matrix-card", ".matrix-card"],
  ["proof-table", ".proof-table"],
  ["settlement-chart", ".settlement-chart"],
];

async function probe(page) {
  return page.evaluate((layers) => {
    const out = {};
    for (const [name, selector] of layers) {
      const el = document.querySelector(selector);
      out[name] = el
        ? {
            transform: getComputedStyle(el).transform,
            opacity: getComputedStyle(el).opacity,
            scrollProgress:
              getComputedStyle(el).getPropertyValue("--scroll-progress") || null,
            scrollExit:
              getComputedStyle(el).getPropertyValue("--scroll-exit") || null,
            parallaxShift:
              getComputedStyle(el).getPropertyValue("--parallax-shift") || null,
          }
        : null;
    }
    out.scrollY = window.scrollY;
    return out;
  }, layers);
}
const layers = probedLayers;

async function open(page) {
  await page.goto(baseUrl + "/", { waitUntil: "networkidle" });
  await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

const browser = await chromium.launch();

// 1. Screen recording: scroll through the whole page and back.
{
  const context = await browser.newContext({
    recordVideo: { dir: outDir, size: { width: 1440, height: 810 } },
    viewport: { width: 1440, height: 810 },
  });
  const page = await context.newPage();
  await open(page);
  // Give the WebGL hero a moment to hand over from the poster.
  await page.waitForTimeout(2500);
  await page.evaluate(async () => {
    const total = document.body.scrollHeight - window.innerHeight;
    const steps = 90;
    for (let i = 0; i <= steps; i += 1) {
      window.scrollTo(0, (total * i) / steps);
      await new Promise((r) => setTimeout(r, 66));
    }
    await new Promise((r) => setTimeout(r, 600));
    for (let i = steps; i >= 0; i -= 1) {
      window.scrollTo(0, (total * i) / steps);
      await new Promise((r) => setTimeout(r, 33));
    }
  });
  await page.waitForTimeout(500);
  await page.close();
  await context.close();
  console.log(`recording saved under ${outDir}`);
}

// 2 + 3. Hero drift frames and the parallax probe on the default profile.
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  await open(page);
  await page.waitForTimeout(2500);

  const probes = { motion: [] };
  for (const offset of [0, 260, 520, 780]) {
    await page.evaluate((y) => window.scrollTo(0, y), offset);
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${outDir}/hero-scroll-${offset}.png` });
    probes.motion.push(await probe(page));
  }

  // Park each artifact section at two viewport positions: low (just entered)
  // and high (about to leave). Distinct parallax rates show up as different
  // translate deltas between the two probes.
  for (const [name, selector] of [
    ["ledger", "section[aria-labelledby='ledger-heading']"],
    ["matrix", "section[aria-labelledby='matrix-heading']"],
    ["proofband", "section[aria-labelledby='gates-heading']"],
  ]) {
    for (const [pose, ratio] of [
      ["low", 0.75],
      ["high", 0.15],
    ]) {
      await page.evaluate(
        ({ sel, r }) => {
          const el = document.querySelector(sel);
          const rect = el.getBoundingClientRect();
          window.scrollTo(0, window.scrollY + rect.top - window.innerHeight * r);
        },
        { sel: selector, r: ratio },
      );
      await page.waitForTimeout(450);
      await page.screenshot({ path: `${outDir}/${name}-${pose}.png` });
      probes[`${name}-${pose}`] = await probe(page);
    }
  }
  await page.close();
  await writeFile(
    `${outDir}/parallax-probe.json`,
    JSON.stringify(probes, null, 2),
  );
  console.log(`motion probes -> ${outDir}/parallax-probe.json`);
}

// 4. Reduced motion: every layer must be static (`transform: none`).
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  await page.waitForTimeout(800);
  const probes = [];
  for (const offset of [0, 520]) {
    await page.evaluate((y) => window.scrollTo(0, y), offset);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${outDir}/reduced-scroll-${offset}.png` });
    probes.push(await probe(page));
  }
  const transforms = probes.flatMap((entry) =>
    Object.entries(entry)
      .filter(([, value]) => value && typeof value === "object")
      .map(([name, value]) => `${name}=${value.transform}`),
  );
  console.log("reduced-motion transforms:", transforms.join(" "));
  await writeFile(
    `${outDir}/reduced-motion-probe.json`,
    JSON.stringify(probes, null, 2),
  );
}

await browser.close();
console.log(`done -> ${outDir}`);
