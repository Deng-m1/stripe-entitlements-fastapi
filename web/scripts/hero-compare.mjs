// Stacks the reference hero above ours and measures both the same way.
//
// Usage: node scripts/hero-compare.mjs <tag> [baseUrl]
//
// Writes .review/<tag>.jpg (reference on top, ours below, same width and crop)
// and prints the hue coverage of each. Judging a gradient by eye alone drifts
// — every round looks like an improvement on the last one — so the sheet and
// the numbers are produced together and read together.
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { hueHistogram } from "./hero-hue-histogram.mjs";

const tag = process.argv[2] ?? "compare";
const baseUrl = process.argv[3] ?? "http://127.0.0.1:4321";
const reference = "/tmp/stripe-hero-ref/stripe-desktop-1440.png";
const CROP = { left: 0, top: 0, width: 1440, height: 560 };
const SHEET_WIDTH = 640;

function summarise(buckets) {
  const coloured = buckets.filter((bucket) => bucket.mean !== null);
  const band = (from, to) =>
    coloured
      .filter((bucket) => bucket.hue >= from && bucket.hue < to)
      .reduce((sum, bucket) => sum + bucket.coverage, 0) * 100;
  const total = coloured.reduce((sum, bucket) => sum + bucket.coverage, 0) * 100;
  const chroma =
    coloured.reduce((sum, bucket) => sum + bucket.meanChroma * bucket.share, 0);
  return {
    total,
    cool: band(195, 285),
    magenta: band(285, 345),
    warm: band(345, 360) + band(0, 60),
    chroma,
  };
}

const row = (name, m) =>
  `${name.padEnd(11)} total ${m.total.toFixed(1).padStart(5)}%` +
  `  cool ${m.cool.toFixed(1).padStart(5)}%` +
  `  magenta ${m.magenta.toFixed(1).padStart(5)}%` +
  `  warm ${m.warm.toFixed(1).padStart(5)}%` +
  `  chroma ${m.chroma.toFixed(2)}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
await page.waitForSelector(".hero-wave[data-drawn='true']", { timeout: 25_000 });
await page.waitForTimeout(2_600);
const ours = await page.screenshot();
await browser.close();

const top = await sharp(reference).extract(CROP).resize(SHEET_WIDTH).toBuffer();
const bottom = await sharp(ours).extract(CROP).resize(SHEET_WIDTH).toBuffer();
const { height } = await sharp(top).metadata();
await sharp({
  create: {
    width: SHEET_WIDTH,
    height: height * 2 + 6,
    channels: 3,
    background: "#1b1b1b",
  },
})
  .composite([
    { input: top, top: 0, left: 0 },
    { input: bottom, top: height + 6, left: 0 },
  ])
  .jpeg({ quality: 86 })
  .toFile(`.review/${tag}.jpg`);

console.log(row("reference", summarise(await hueHistogram(reference))));
console.log(row("ours", summarise(await hueHistogram(ours))));
console.log(`.review/${tag}.jpg`);
