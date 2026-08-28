// One-shot structural assertions for the visual polish pass. Prints PASS or
// FAIL lines; exits nonzero when any check fails.
// Usage: node scripts/pages-polish-assert.mjs [baseUrl]
import { chromium } from "@playwright/test";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4321";
let failures = 0;

function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

for (const [name, path, h1] of [
  ["landing", "/", "Billing events are chaos."],
  ["pricing", "/pricing", "Choose a plan"],
  ["account", "/account", "Your billing account"],
]) {
  await page.goto(baseUrl + path, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const facts = await page.evaluate(() => {
    const h1El = document.querySelector("h1");
    const eyebrow = document.querySelector(".eyebrow");
    const header = document.querySelector(".site-header");
    const body = getComputedStyle(document.body);
    return {
      h1Text: h1El?.textContent ?? "",
      h1Family: h1El ? getComputedStyle(h1El).fontFamily : "",
      eyebrowFamily: eyebrow ? getComputedStyle(eyebrow).fontFamily : "",
      display: document.fonts.check('16px "Instrument Sans"'),
      bodyFont: document.fonts.check('16px "Instrument Sans"'),
      mono: document.fonts.check('16px "IBM Plex Mono"'),
      canvas: body.backgroundColor,
      grid: body.backgroundImage.includes("radial-gradient"),
      headerScrolledAtTop: header?.hasAttribute("data-scrolled") ?? true,
      overflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    };
  });

  report(`${name}: h1 present`, facts.h1Text.includes(h1), facts.h1Text.slice(0, 60));
  report(`${name}: h1 display font`, facts.h1Family.includes("Instrument"), facts.h1Family);
  report(`${name}: eyebrow mono font`, facts.eyebrowFamily.includes("IBM Plex Mono"), facts.eyebrowFamily);
  report(
    `${name}: fonts loaded`,
    facts.display && facts.bodyFont && facts.mono,
    `display=${facts.display} body=${facts.bodyFont} mono=${facts.mono}`,
  );
  report(`${name}: white canvas`, facts.canvas === "rgb(255, 255, 255)", facts.canvas);
  report(`${name}: dotted grid retired`, !facts.grid);
  report(`${name}: header transparent at top`, !facts.headerScrolledAtTop);
  report(`${name}: no horizontal overflow`, facts.overflow === 0, `${facts.overflow}px`);

  // A real wheel gesture: programmatic scrollTo does not dispatch scroll
  // events in this headless engine, while user input always does.
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(400);
  const scrolled = await page.evaluate(() => {
    const header = document.querySelector(".site-header");
    return {
      flagged: header?.hasAttribute("data-scrolled") ?? false,
      background: header ? getComputedStyle(header).backgroundColor : "",
    };
  });
  report(
    `${name}: header gains white blur bar on scroll`,
    scrolled.flagged && scrolled.background.includes("255, 255, 255"),
    scrolled.background,
  );
}

// Landing-specific: gradient hero accent + terminal untouched.
await page.goto(baseUrl + "/", { waitUntil: "networkidle" });
const landing = await page.evaluate(() => {
  const accent = document.querySelector(".hero-accent");
  const terminalLines = document.querySelectorAll(".terminal-line").length;
  const style = accent ? getComputedStyle(accent) : null;
  return {
    gradient: style?.backgroundImage.includes("linear-gradient") ?? false,
    clipped: style ? style.webkitBackgroundClip || style.backgroundClip : "",
    terminalLines,
  };
});
report("landing: hero accent gradient text", landing.gradient && landing.clipped === "text", landing.clipped);
report("landing: 8 terminal lines intact", landing.terminalLines === 8, String(landing.terminalLines));

await browser.close();
process.exit(failures === 0 ? 0 : 1);
