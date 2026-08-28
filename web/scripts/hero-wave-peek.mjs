// One-viewport isolated capture of the hero wave layer, for tuning rounds.
//
// Usage: node scripts/hero-wave-peek.mjs <out.jpg> [width] [height] [baseUrl]
//
// `hero-wave-shots.mjs` walks five viewports and takes about a minute, which
// is too slow a loop for adjusting a layout constant. This does one viewport,
// hides the page so only the wave paints, and writes a thumbnail small enough
// to read back directly.
import { chromium } from "@playwright/test";
import sharp from "sharp";

const out = process.argv[2] ?? ".review/peek.jpg";
const width = Number(process.argv[3] ?? 1440);
const height = Number(process.argv[4] ?? 900);
const baseUrl = process.argv[5] ?? "http://127.0.0.1:4321";
const isolate = process.env.HERO_PEEK_ISOLATE !== "0";

const ISOLATE_CSS = `
  html, body { background: none !important; }
  body * { visibility: hidden !important; }
  .hero-wave, .hero-wave * { visibility: visible !important; }
  .hero-wave-fallback { display: none !important; }
`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height } });
await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
await page.waitForSelector(".hero-wave[data-drawn='true']", { timeout: 25_000 });
await page.waitForTimeout(2_600);

const box = await page.locator(".paper-hero").boundingBox();
if (isolate) {
  await page.addStyleTag({ content: ISOLATE_CSS });
  await page.waitForTimeout(300);
}
const shot = await page.screenshot({ clip: box, omitBackground: isolate });
await sharp(shot)
  .flatten({ background: "#ffffff" })
  .resize({ width: Math.min(760, Math.round(box.width)) })
  .jpeg({ quality: 84 })
  .toFile(out);

console.log(`${out} <- ${Math.round(box.width)}x${Math.round(box.height)}`);
await browser.close();
