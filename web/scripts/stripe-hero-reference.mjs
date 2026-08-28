// Captures the Stripe zh-us hero and reduces it to a comparable colour ramp.
//
// Usage: node scripts/stripe-hero-reference.mjs [outDir] [url]
//
// STRIPE_MESH_GRADIENT_REVERSE_ENGINEERING.md §6 points at screenshots under
// /tmp, which do not survive a reboot; a palette round that trusts a stale
// file is comparing against nothing. So each round re-captures the reference
// and reduces it to numbers. Two gradients viewed side by side cannot tell a
// 15-degree hue error from a lighting difference, and hue placement is the
// part this hero keeps getting wrong.
//
// Output: PNGs plus reference.json, whose stops are sampled along the hero's
// horizontal axis and reported as sRGB hex and HSL, directly comparable with
// the stops in lib/hero-wave-palette.ts.
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const outDir = process.argv[2] ?? "/tmp/stripe-hero-ref";
const target = process.argv[3] ?? "https://stripe.com/zh-us";
await mkdir(outDir, { recursive: true });

export function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  const chroma = max - min;
  if (chroma === 0) return { h: 0, s: 0, l: lightness };
  const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
  let hue;
  if (max === rn) hue = ((gn - bn) / chroma + 6) % 6;
  else if (max === gn) hue = (bn - rn) / chroma + 2;
  else hue = (rn - gn) / chroma + 4;
  hue *= 60;
  return { h: hue, s: saturation, l: lightness };
}

/**
 * Mean colour of a narrow column band, ignoring near-white pixels: the page
 * behind the gradient is paper, and including it drags every stop toward
 * white in proportion to how much of the column the wave happens to miss.
 */
function columnMean(pixels, width, height, xFraction, yFrom, yTo) {
  const x0 = Math.max(0, Math.round((xFraction - 0.012) * width));
  const x1 = Math.min(width - 1, Math.round((xFraction + 0.012) * width));
  const y0 = Math.round(yFrom * height);
  const y1 = Math.round(yTo * height);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const i = (width * y + x) * 3;
      if (pixels[i] > 244 && pixels[i + 1] > 244 && pixels[i + 2] > 244) continue;
      r += pixels[i];
      g += pixels[i + 1];
      b += pixels[i + 2];
      n += 1;
    }
  }
  if (n === 0) return null;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

export async function rampFromPng(buffer, { xFrom, xTo, yFrom, yTo, steps }) {
  const { data, info } = await sharp(buffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const stops = [];
  for (let i = 0; i <= steps; i += 1) {
    const xFraction = xFrom + ((xTo - xFrom) * i) / steps;
    const color = columnMean(data, info.width, info.height, xFraction, yFrom, yTo);
    if (!color) continue;
    const [r, g, b] = color;
    const { h, s, l } = rgbToHsl(r, g, b);
    stops.push({
      x: Number(xFraction.toFixed(3)),
      hex: `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`,
      rgb: [r, g, b],
      hsl: [Math.round(h), Number(s.toFixed(3)), Number(l.toFixed(3))],
    });
  }
  return stops;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await chromium.launch();
  const report = [];

  for (const [name, width, height, window] of [
    ["stripe-desktop-1440", 1440, 900, { xFrom: 0.5, xTo: 0.98, yFrom: 0.06, yTo: 0.5 }],
    ["stripe-mobile-390", 390, 844, { xFrom: 0.04, xTo: 0.96, yFrom: 0.04, yTo: 0.3 }],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(target, { waitUntil: "networkidle", timeout: 90_000 });
    await page.evaluate(() => document.fonts.ready);
    // The canvas is injected after hydration and after a WebGL probe, and the
    // wave needs a few seconds to travel away from its opening frame.
    await page.waitForTimeout(6_000);

    const shot = await page.screenshot();
    await writeFile(`${outDir}/${name}.png`, shot);
    const stops = await rampFromPng(shot, { ...window, steps: 12 });

    report.push({ name, width, height, window, stops });
    console.log(`${name}: ${stops.map((stop) => stop.hex).join(" ")}`);
    console.log(`${name} hue: ${stops.map((stop) => stop.hsl[0]).join(" ")}`);
    await page.close();
  }

  await writeFile(`${outDir}/reference.json`, `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
