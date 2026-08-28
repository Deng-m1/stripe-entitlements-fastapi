// Scroll-motion evidence rig for the below-hero landing sections (brief §3.2/§3.3):
// per-section frame sequences while scrolling, plus the measured
// --parallax-shift of each [data-depth] layer at every stop, proving the
// stacked layers move at distinct rates.
// Usage: node scripts/landing-sections-shots.mjs <outDir> [baseUrl]
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const outDir = process.argv[2] ?? "/tmp/landing-sections-v2/motion";
const baseUrl = process.argv[3] ?? "http://127.0.0.1:4321";
await mkdir(outDir, { recursive: true });

const sections = [
  ["ledger", "section[aria-labelledby='ledger-heading']"],
  ["band", "section[aria-labelledby='invariants-heading']"],
  ["matrix", "section[aria-labelledby='matrix-heading']"],
  ["proof", "section[aria-labelledby='gates-heading']"],
];
// Fractions of the section's travel through the viewport per frame.
const STOPS = [0.15, 0.5, 0.85];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
await page.evaluate(async () => {
  await document.fonts.ready;
});

const report = [];
for (const [name, selector] of sections) {
  const el = page.locator(selector).first();
  if ((await el.count()) === 0) {
    console.log(`MISSING selector for ${name}: ${selector}`);
    continue;
  }
  for (const [index, stop] of STOPS.entries()) {
    const shifts = await el.evaluate(async (section, fraction) => {
      const viewport = window.innerHeight;
      const rect = section.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      // progress = (viewport - sectionTop) / (viewport + height)
      const target =
        top - viewport + fraction * (viewport + rect.height);
      window.scrollTo(0, Math.max(0, target));
      await new Promise((resolve) => setTimeout(resolve, 450));
      return Array.from(
        section.querySelectorAll("[data-depth]"),
        (layer) => ({
          depth: layer.getAttribute("data-depth"),
          className: layer.className,
          shift: layer.style.getPropertyValue("--parallax-shift") || "(unset)",
        }),
      );
    }, stop);
    await page.screenshot({
      path: `${outDir}/${name}-frame${index + 1}.png`,
    });
    report.push({ section: name, stop, shifts });
  }
}

await writeFile(
  `${outDir}/parallax-shifts.json`,
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
await browser.close();
console.log(`done -> ${outDir}`);
