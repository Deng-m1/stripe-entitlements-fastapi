// Capture rig for the WebGL hero wave.
//
// Usage: node scripts/hero-wave-shots.mjs <outDir> [baseUrl]
//
// Renders the production hero at three viewports, waits for the renderer to
// report its first drawn frame (`[data-drawn]`), and records the browser
// console so a silently-failing shader cannot pass as a good screenshot.
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const outDir = process.argv[2] ?? "/tmp/hero-webgl-v1";
const baseUrl = process.argv[3] ?? "http://127.0.0.1:4321";
await mkdir(outDir, { recursive: true });

const viewports = [
  ["desktop-1440", 1440, 900],
  ["laptop-1024", 1024, 768],
  ["mobile-390", 390, 844],
];

const browser = await chromium.launch();
const report = [];

async function capture(name, width, height, options = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  const messages = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      messages.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
  if (options.reducedMotion) {
    await page.emulateMedia({ reducedMotion: "reduce" });
  }

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);

  let drawn = false;
  if (!options.reducedMotion) {
    drawn = await page
      .waitForSelector(".hero-wave[data-drawn='true']", { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    // Let the wave travel past its opening frame before the shutter.
    await page.waitForTimeout(options.settleMs ?? 2_600);
    // Park the pointer inside the wave so the swell is visible in the capture.
    await page.mouse.move(width * 0.72, height * 0.42);
    await page.waitForTimeout(1_200);
  } else {
    await page.waitForTimeout(1_500);
  }

  const renderer = await page.evaluate(() => {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2");
    if (!gl) return null;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  const canvasCount = await page.locator(".hero-wave canvas").count();

  await page.screenshot({ path: `${outDir}/${name}.png` });
  const hero = page.locator(".paper-hero");
  await hero.screenshot({ path: `${outDir}/${name}-hero.png` });

  report.push({ name, width, height, drawn, canvasCount, renderer, messages });
  console.log(
    `${name}: drawn=${drawn} canvases=${canvasCount} issues=${messages.length}`,
  );
  for (const message of messages) console.log(`  ${message}`);
  await page.close();
}

for (const [name, width, height] of viewports) {
  await capture(name, width, height);
}
// A second desktop frame taken several seconds later: the wave must keep one
// colour identity as it travels rather than cycling through the palette.
await capture("desktop-1440-late", 1440, 900, { settleMs: 9_000 });
await capture("desktop-1440-reduced-motion", 1440, 900, { reducedMotion: true });

await writeFile(`${outDir}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
await browser.close();
