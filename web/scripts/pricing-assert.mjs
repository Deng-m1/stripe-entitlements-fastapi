// One-shot structural assertions for the /pricing product-page round.
// Checks bind to token relationships (shared scales, layered shadows,
// stripe contrast) rather than literal palette values so they survive
// theme-token flips like the paper -> white-canvas move.
// Prints PASS or FAIL lines; exits nonzero when any check fails.
// Usage: node scripts/pricing-assert.mjs [baseUrl]
import { chromium } from "@playwright/test";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4321";
const browser = await chromium.launch();
let failures = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(baseUrl + "/pricing", { waitUntil: "networkidle" });
const pricing = await page.evaluate(() => {
  const h1 = document.querySelector("h1");
  const ribbon = document.querySelector(".pricing-ribbon");
  const featured = document.querySelector(".pricing-featured");
  const plain = document.querySelector(".plan-card:not(.pricing-featured)");
  const accent = document.querySelector(".pricing-accent");
  const accentStyle = accent ? getComputedStyle(accent) : null;
  const flag = document.querySelector(".pricing-flag");
  const featuredShadow = featured ? getComputedStyle(featured).boxShadow : "";
  return {
    h1Size: h1 ? getComputedStyle(h1).fontSize : "",
    ribbonPresent: Boolean(ribbon),
    ribbonBand: ribbon
      ? getComputedStyle(ribbon, "::after").backgroundImage.includes(
          "linear-gradient",
        )
      : false,
    featuredShadow,
    featuredShadowLayers: featuredShadow.match(/rgba?\(/g)?.length ?? 0,
    plainShadow: plain ? getComputedStyle(plain).boxShadow : "",
    featuredHalo: featured
      ? getComputedStyle(featured, "::before").filter
      : "",
    accentGradient: accentStyle
      ? accentStyle.backgroundImage.includes("linear-gradient")
      : false,
    accentClip: accentStyle
      ? accentStyle.webkitBackgroundClip || accentStyle.backgroundClip
      : "",
    flagText: flag ? flag.textContent : "",
    flagCard: flag
      ? flag.closest("article")?.querySelector("h2")?.textContent
      : "",
  };
});
await page.goto(baseUrl + "/", { waitUntil: "networkidle" });
const landingH1 = await page.evaluate(() => {
  const h1 = document.querySelector("h1");
  return h1 ? getComputedStyle(h1).fontSize : "";
});

report(
  "pricing h1 shares the landing display token",
  pricing.h1Size === landingH1,
  `${pricing.h1Size} vs ${landingH1}`,
);
report(
  "gradient ribbon present with mesh band",
  pricing.ribbonPresent && pricing.ribbonBand,
);
report(
  "featured card floats above the plain cards",
  pricing.featuredShadow !== pricing.plainShadow &&
    pricing.featuredShadowLayers >= 2,
  `${pricing.featuredShadowLayers} layers`,
);
report(
  "featured card has a blurred gradient base",
  pricing.featuredHalo.includes("blur"),
  pricing.featuredHalo,
);
report(
  "pricing accent phrase clips a gradient",
  pricing.accentGradient && pricing.accentClip === "text",
  pricing.accentClip,
);
report(
  "recommended flag sits on the Pro card",
  pricing.flagText === "Recommended" && pricing.flagCard === "Pro",
  `${pricing.flagText} on ${pricing.flagCard}`,
);
await page.close();

const mobile = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
await mobile.goto(baseUrl + "/pricing", { waitUntil: "networkidle" });
const table = await mobile.evaluate(() => {
  const rowHeader = document.querySelector(
    ".comparison-table tbody th[scope='row']",
  );
  const oddRow = document.querySelector(
    ".comparison-table tbody tr:nth-child(1)",
  );
  const evenRow = document.querySelector(
    ".comparison-table tbody tr:nth-child(2)",
  );
  const wrap = document.querySelector(".comparison-table-wrap");
  return {
    sticky: rowHeader ? getComputedStyle(rowHeader).position : "",
    rowHeaderBg: rowHeader
      ? getComputedStyle(rowHeader).backgroundColor
      : "",
    oddStripe: oddRow ? getComputedStyle(oddRow).backgroundColor : "",
    evenStripe: evenRow ? getComputedStyle(evenRow).backgroundColor : "",
    scrollable: wrap ? wrap.scrollWidth > wrap.clientWidth : false,
    overflow:
      document.body.scrollWidth - document.documentElement.clientWidth,
  };
});
report(
  "mobile row headers pin while the table pans",
  table.sticky === "sticky" && table.scrollable,
  `${table.sticky}, scrollable=${table.scrollable}`,
);
report(
  "row headers paint opaque over panned cells",
  table.rowHeaderBg !== "rgba(0, 0, 0, 0)",
  table.rowHeaderBg,
);
report(
  "even rows carry the sunken stripe",
  table.evenStripe !== "rgba(0, 0, 0, 0)" &&
    table.evenStripe !== table.oddStripe,
  `${table.evenStripe} vs ${table.oddStripe}`,
);
report("no mobile horizontal overflow", table.overflow === 0, `${table.overflow}px`);
await mobile.close();

await browser.close();
process.exit(failures === 0 ? 0 : 1);
