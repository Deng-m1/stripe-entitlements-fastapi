// Reports which hues a hero screenshot actually puts on screen, and how much
// of the frame each one covers.
//
// Usage: node scripts/hero-hue-histogram.mjs <image.png> [minChroma]
//
// A hero can miss its brief in two different ways that look identical in a
// thumbnail: the ramp can be present but desaturated into pastel, or whole
// arcs of it can be missing. Coverage-per-hue separates them.
//
// The floor is **chroma** (max channel minus min channel), not HSL saturation.
// HSL saturation is chroma divided by how far the colour is from black or
// white, so it reports near-white as highly saturated: this site's paper is
// #faf5ed, which scores 0.57 HSL saturation and would be counted as 60% of the
// frame in warm hues. Its chroma is 0.05, which correctly reads as "no colour
// here". Buckets are 15 degrees wide.
import { readFile } from "node:fs/promises";
import sharp from "sharp";

export function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const chroma = max - min;
  if (chroma === 0) return { h: 0, s: 0, l };
  const s = chroma / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === rn) h = ((gn - bn) / chroma + 6) % 6;
  else if (max === gn) h = (bn - rn) / chroma + 2;
  else h = (rn - gn) / chroma + 4;
  return { h: h * 60, s, l };
}

export async function hueHistogram(source, minChroma = 0.16) {
  const { data, info } = await sharp(source)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const buckets = new Array(24).fill(null).map(() => ({
    count: 0,
    r: 0,
    g: 0,
    b: 0,
    peakChroma: 0,
    peak: [0, 0, 0],
  }));
  let counted = 0;

  for (let i = 0; i < data.length; i += 3) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    // Dark type antialiases into colourful pixels; the hero never does.
    if (chroma < minChroma || Math.max(r, g, b) < 70) continue;
    const { h } = rgbToHsl(r, g, b);
    const bucket = buckets[Math.min(23, Math.floor(h / 15))];
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    if (chroma > bucket.peakChroma) {
      bucket.peakChroma = chroma;
      bucket.peak = [r, g, b];
    }
    counted += 1;
  }

  const total = info.width * info.height;
  return buckets
    .map((bucket, index) => ({
      hue: index * 15,
      share: bucket.count / Math.max(1, counted),
      coverage: bucket.count / total,
      mean:
        bucket.count === 0
          ? null
          : `#${[bucket.r, bucket.g, bucket.b]
              .map((c) => Math.round(c / bucket.count).toString(16).padStart(2, "0"))
              .join("")}`,
      peak:
        bucket.count === 0
          ? null
          : `#${bucket.peak.map((c) => c.toString(16).padStart(2, "0")).join("")}`,
      peakChroma: Number(bucket.peakChroma.toFixed(3)),
      meanChroma:
        bucket.count === 0
          ? 0
          : Number(
              (
                (Math.max(bucket.r, bucket.g, bucket.b) -
                  Math.min(bucket.r, bucket.g, bucket.b)) /
                bucket.count /
                255
              ).toFixed(3),
            ),
    }))
    .filter((bucket) => bucket.count !== 0 || bucket.share > 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  const floor = Number(process.argv[3] ?? 0.25);
  const buckets = await hueHistogram(await readFile(file), floor);
  const coloured = buckets.filter((bucket) => bucket.mean !== null);
  console.log(`${file} (chroma >= ${floor})`);
  for (const bucket of coloured) {
    if (bucket.share < 0.004) continue;
    console.log(
      `  hue ${String(bucket.hue).padStart(3)}-${String(bucket.hue + 15).padStart(3)}` +
        `  share ${(bucket.share * 100).toFixed(1).padStart(5)}%` +
        `  frame ${(bucket.coverage * 100).toFixed(1).padStart(5)}%` +
        `  mean ${bucket.mean}  chroma ${bucket.meanChroma.toFixed(2)}`,
    );
  }
  const coverage = coloured.reduce((sum, bucket) => sum + bucket.coverage, 0);
  const cool = coloured
    .filter((bucket) => bucket.hue >= 195 && bucket.hue < 285)
    .reduce((sum, bucket) => sum + bucket.coverage, 0);
  const warm = coloured
    .filter((bucket) => bucket.hue < 60)
    .reduce((sum, bucket) => sum + bucket.coverage, 0);
  const magenta = coloured
    .filter((bucket) => bucket.hue >= 285 && bucket.hue < 345)
    .reduce((sum, bucket) => sum + bucket.coverage, 0);
  console.log(
    `  frame coverage: total ${(coverage * 100).toFixed(1)}%` +
      `  cool ${(cool * 100).toFixed(1)}%` +
      `  magenta ${(magenta * 100).toFixed(1)}%` +
      `  warm ${(warm * 100).toFixed(1)}%`,
  );
}
