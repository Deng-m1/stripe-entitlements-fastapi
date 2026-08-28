// Bakes the hero wave's static poster set from the live WebGL render.
//
// Usage (with `next start` already serving the production build):
//   node scripts/build-hero-wave-poster.mjs [baseUrl] [outDir]
//
// The poster is the renderer's own output rather than a hand-drawn
// approximation, so the SSR / reduced-motion / no-WebGL frame and the animated
// wave cannot drift apart. The layer's CSS mask is disabled for the capture
// because the runtime `<picture>` sits inside `.hero-wave` and inherits that
// same mask; baking it in would apply it twice.
import { mkdir, stat } from "node:fs/promises";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4321";
const outDir = process.argv[3] ?? new URL("../public/", import.meta.url).pathname;
await mkdir(outDir, { recursive: true });

const CAPTURE_CSS = `
  html, body { background: none !important; }
  .site-header, .demo-notice, .paper-hero > .shell { visibility: hidden !important; }
  .hero-wave-fallback { display: none !important; }
  .paper-hero { overflow: visible !important; }
  .hero-wave { mask-image: none !important; }
`;

const targets = [
  { name: "hero-wave-desktop", viewport: { width: 1440, height: 900 }, widths: [1280, 1920] },
  { name: "hero-wave-mobile", viewport: { width: 430, height: 932 }, widths: [820] },
];

const browser = await chromium.launch();

async function grab({ viewport }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".hero-wave[data-drawn='true']", { timeout: 20_000 });
  // Same settle the review rig uses, so the poster matches a representative
  // frame of the animation rather than its opening pose.
  await page.waitForTimeout(2_600);
  await page.addStyleTag({ content: CAPTURE_CSS });
  await page.waitForTimeout(400);
  const raw = await page
    .locator(".hero-wave")
    .screenshot({ omitBackground: true });
  await page.close();
  return raw;
}

async function report(file) {
  const { size } = await stat(file);
  console.log(`  ${file.split("/").pop()} — ${(size / 1024).toFixed(1)} KiB`);
}

for (const target of targets) {
  const raw = await grab(target);
  const source = sharp(raw);
  const { width, height } = await source.metadata();
  console.log(`${target.name}: captured ${width}×${height}`);

  for (const [index, outputWidth] of target.widths.entries()) {
    const suffix = index === 0 ? "" : `-${index + 1}x`;
    const file = `${outDir}/${target.name}${suffix}.webp`;
    await sharp(raw)
      .resize({ width: outputWidth })
      // A smooth gradient hides compression artefacts well, and the poster is
      // above the fold, so the byte count matters more than the last few dB.
      .webp({ alphaQuality: 78, effort: 6, quality: 70, smartSubsample: true })
      .toFile(file);
    await report(file);
  }

  if (target.name === "hero-wave-desktop") {
    // Ultimate fallback for engines without WebP. Held at a modest width: it
    // is a decorative layer that CSS scales to cover, and a smooth alpha ramp
    // is the worst case for PNG's filters.
    const file = `${outDir}/${target.name}.png`;
    await sharp(raw)
      .resize({ width: 820 })
      .png({ compressionLevel: 9, palette: true, quality: 82, dither: 1 })
      .toFile(file);
    await report(file);
  }
}

await browser.close();
