// One-shot structural assertions for the /pricing product-page rounds
// (round one: hero/featured/table; round two: bento card depth, the dark
// CTA band, comparison groups, and the unified sitewide price lockup).
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
  const priceFigure = document.querySelector(".pricing-page .price-row strong");
  const priceStyle = priceFigure ? getComputedStyle(priceFigure) : null;
  const cta = document.querySelector(".pricing-cta");
  const ctaStyle = cta ? getComputedStyle(cta) : null;
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
    plainBorderColor: plain ? getComputedStyle(plain).borderTopColor : "",
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
    priceFont: priceStyle ? priceStyle.fontFamily : "",
    priceFigures: priceStyle ? priceStyle.fontVariantNumeric : "",
    groupRows: document.querySelectorAll(
      ".comparison-table tbody tr.compare-group",
    ).length,
    ctaBandGradient: ctaStyle
      ? ctaStyle.backgroundImage.includes("radial-gradient")
      : false,
    ctaBandBase: ctaStyle ? ctaStyle.backgroundColor : "",
    ctaFullBleed: cta
      ? Math.round(cta.getBoundingClientRect().width) >= window.innerWidth
      : false,
  };
});
await page.goto(baseUrl + "/", { waitUntil: "networkidle" });
const landing = await page.evaluate(() => {
  const h1 = document.querySelector("h1");
  const catalogPrice = document.querySelector(".catalog-price");
  const catalogStyle = catalogPrice ? getComputedStyle(catalogPrice) : null;
  return {
    h1Size: h1 ? getComputedStyle(h1).fontSize : "",
    catalogFont: catalogStyle ? catalogStyle.fontFamily : "",
    catalogFigures: catalogStyle ? catalogStyle.fontVariantNumeric : "",
  };
});
const landingH1 = landing.h1Size;

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
report(
  "plan cards are depth-framed, not outlined",
  pricing.plainBorderColor === "rgba(0, 0, 0, 0)",
  pricing.plainBorderColor,
);
report(
  "catalog tiles share the pricing price lockup",
  landing.catalogFont === pricing.priceFont &&
    landing.catalogFigures === "normal" &&
    pricing.priceFigures === "normal",
  `${landing.catalogFigures}/${pricing.priceFigures}`,
);
report(
  "comparison table opens price and entitlement groups",
  pricing.groupRows === 2,
  `${pricing.groupRows} group rows`,
);
report(
  "closing CTA rides the full-bleed dark band grammar",
  pricing.ctaBandGradient &&
    pricing.ctaFullBleed &&
    pricing.ctaBandBase !== "rgba(0, 0, 0, 0)",
  `gradient=${pricing.ctaBandGradient}, fullBleed=${pricing.ctaFullBleed}, base=${pricing.ctaBandBase}`,
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
  // Stripes count data rows only; group label rows sit outside the cadence.
  const dataRows = document.querySelectorAll(
    ".comparison-table tbody tr:not(.compare-group)",
  );
  const oddRow = dataRows[0] ?? null;
  const evenRow = dataRows[1] ?? null;
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
