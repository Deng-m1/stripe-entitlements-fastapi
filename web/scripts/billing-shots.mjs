// Settlement-moment screenshot rig for /billing/success and /billing/error.
// Captures every reachable screen state at desktop 1440 and mobile 390 and
// prints the 390px horizontal-overflow measurement for each shot.
//
// Two backends produce the full state matrix:
//   prodBase — a production `next start` in http mode with no API configured:
//     the honest failure path (validation error banner + timed-out state) and
//     the static /billing/error screens.
//   mockBase — a `next dev` in mock mode: the hydrated polling, timed-out,
//     and webhook-confirmed states (mock account settles starter/month and
//     never settles pro/year).
//
// Usage: node scripts/billing-shots.mjs <outDir> <prodBase> [mockBase]
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const outDir = process.argv[2] ?? "/tmp/billing-v2";
const prodBase = process.argv[3] ?? "http://127.0.0.1:3021";
const mockBase = process.argv[4];
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();

const sizes = {
  desktop: { viewport: { width: 1440, height: 900 } },
  mobile: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
};

async function shoot(base, route, slug, labels, options = {}) {
  const { waitForHeading, settleMs = 1500 } = options;
  for (const label of labels) {
    const page = await browser.newPage(sizes[label]);
    await page.goto(base + route, { waitUntil: "networkidle" });
    // Warm one pixel so headless Chromium starts compositing.
    await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
    if (waitForHeading) {
      await page
        .getByRole("heading", { name: waitForHeading })
        .waitFor({ timeout: 45_000 });
    }
    await page.waitForTimeout(settleMs);
    await page.screenshot({ path: `${outDir}/${slug}-${label}.png`, fullPage: true });
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    console.log(`${slug} ${label} overflow px: ${overflow}`);
    await page.close();
  }
}

const both = ["desktop", "mobile"];
const desktopOnly = ["desktop"];

// Static danger states — identical in any backend mode.
await shoot(prodBase, "/billing/error?code=payment_failed", "error-payment-failed", both);
await shoot(prodBase, "/billing/error?code=payment_canceled", "error-payment-canceled", desktopOnly);
await shoot(prodBase, "/billing/error?code=authentication_failed", "error-authentication-failed", desktopOnly);
await shoot(prodBase, "/billing/error", "error-fallback", desktopOnly);

// Unverifiable return: no expected plan/interval in the query.
await shoot(prodBase, "/billing/success", "success-invalid", both);

// Honest failure path: the unconfigured production API rejects the catalog
// fetch, so the screen lands in timed-out with the inline error banner — the
// exact state whose unbreakable token overflowed 390px in review round 2.
await shoot(
  prodBase,
  "/billing/success?expected_plan=starter&expected_interval=month",
  "success-timedout-banner",
  both,
  { waitForHeading: "Payment may still be processing" },
);

if (mockBase) {
  // Mock account never settles pro/year: a stable polling window (~18s),
  // then the clean timed-out state.
  await shoot(
    mockBase,
    "/billing/success?expected_plan=pro&expected_interval=year",
    "success-polling",
    both,
    { waitForHeading: "Waiting for webhook confirmation", settleMs: 800 },
  );
  await shoot(
    mockBase,
    "/billing/success?expected_plan=pro&expected_interval=year",
    "success-timedout",
    desktopOnly,
    { waitForHeading: "Payment may still be processing" },
  );
  // The webhook-confirmed settlement moment (medallion + facts).
  await shoot(
    mockBase,
    "/billing/success?expected_plan=starter&expected_interval=month",
    "success-confirmed",
    both,
    { waitForHeading: "Webhook-backed account state is ready" },
  );
}

await browser.close();
console.log(`done -> ${outDir}`);
