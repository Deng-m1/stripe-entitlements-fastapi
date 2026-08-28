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
  [
    "billing-success",
    "/billing/success?expected_plan=pro&expected_interval=month",
    "webhook confirmation",
  ],
  ["billing-error", "/billing/error?code=payment_failed", "payment did not complete"],
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
      display: document.fonts.check('16px "Bricolage Grotesque"'),
      bodyFont: document.fonts.check('16px "Instrument Sans"'),
      mono: document.fonts.check('16px "Spline Sans Mono"'),
      canvas: body.backgroundColor,
      texture: body.backgroundImage,
      headerScrolledAtTop: header?.hasAttribute("data-scrolled") ?? true,
      overflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    };
  });

  report(`${name}: h1 present`, facts.h1Text.includes(h1), facts.h1Text.slice(0, 60));
  report(`${name}: h1 display font`, facts.h1Family.includes("Bricolage"), facts.h1Family);
  report(`${name}: eyebrow mono font`, facts.eyebrowFamily.includes("Spline"), facts.eyebrowFamily);
  report(
    `${name}: fonts loaded`,
    facts.display && facts.bodyFont && facts.mono,
    `display=${facts.display} body=${facts.bodyFont} mono=${facts.mono}`,
  );
  // DESIGN_SYSTEM.md §3.1: a pristine white content plane. The v2 warm paper
  // tint and its dotted-grid texture are retired, so both are asserted gone.
  report(`${name}: white canvas`, facts.canvas === "rgb(255, 255, 255)", facts.canvas);
  report(`${name}: no page texture`, facts.texture === "none", facts.texture);
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
    `${name}: header gains translucent white bar on scroll`,
    scrolled.flagged && scrolled.background.startsWith("rgba(255, 255, 255"),
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

// Brief §3.2/§3.3: every landing section is eyebrowed, enters on scroll, and
// the artifact stacks travel at rates of their own. Structural proof only —
// the motion itself is gated by promo/landing-responsive.spec.ts.
const sections = await page.evaluate(() =>
  [...document.querySelectorAll(".paper-band, .gradient-band, .proof-band")].map(
    (section) => ({
      id: section.getAttribute("aria-labelledby") ?? section.className,
      eyebrow: Boolean(section.querySelector(".eyebrow .eyebrow-label")),
      // The ledger band carries data-reveal on the section itself so its
      // connectors and rows can key off one staged state; the rest put it on
      // the shell inside.
      reveal:
        section.hasAttribute("data-reveal") ||
        section.querySelector("[data-reveal]") !== null,
    }),
  ),
);
report(
  "landing: every band carries a structured eyebrow",
  sections.length >= 6 && sections.every((section) => section.eyebrow),
  sections.filter((section) => !section.eyebrow).map((s) => s.id).join(", ") ||
    `${sections.length} bands`,
);
report(
  "landing: every band reveals on scroll",
  sections.every((section) => section.reveal),
  sections.filter((section) => !section.reveal).map((s) => s.id).join(", "),
);

// Sampled with the ledger stage on screen. At the foot of the page every
// layer is clamped to the same maximum travel, which would hide a bug where
// the two stacked layers share one rate.
await page.evaluate(() => {
  const stage = document.querySelector(".artifact-stage");
  stage?.scrollIntoView({ block: "center" });
});
await page.mouse.wheel(0, 120);
await page.waitForTimeout(600);
const layered = await page.evaluate(() => {
  const read = (selector) =>
    document.querySelector(selector)?.style.getPropertyValue(
      "--parallax-shift",
    ) ?? "";
  return { ghost: read(".artifact-ghost"), front: read(".artifact-front") };
});
report(
  "landing: stacked artifact layers travel at different rates",
  layered.ghost !== "" &&
    layered.front !== "" &&
    Number.parseFloat(layered.ghost) !== Number.parseFloat(layered.front),
  `ghost=${layered.ghost} front=${layered.front}`,
);

await page.evaluate(async () => {
  const step = window.innerHeight * 0.7;
  for (let y = 0; y <= document.body.scrollHeight; y += step) {
    window.scrollTo(0, y);
    await new Promise((resolve) => setTimeout(resolve, 90));
  }
});
await page.waitForTimeout(600);
const motion = await page.evaluate(() => ({
  layers: document.querySelectorAll("[data-parallax]").length,
  unshifted: [...document.querySelectorAll("[data-parallax]")].filter(
    (layer) => layer.style.getPropertyValue("--parallax-shift") === "",
  ).length,
  unrevealed: document.querySelectorAll("[data-reveal]:not(.is-revealed)")
    .length,
  heroDrift: document
    .querySelector(".paper-hero")
    ?.style.getPropertyValue("--hero-drift"),
}));
report(
  "landing: every parallax layer is driven",
  motion.layers >= 4 && motion.unshifted === 0,
  `${motion.layers} layers, ${motion.unshifted} idle`,
);
report("landing: hero gradient drifts with scroll", Boolean(motion.heroDrift), motion.heroDrift);
report("landing: all reveals fired", motion.unrevealed === 0, `${motion.unrevealed} left`);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
