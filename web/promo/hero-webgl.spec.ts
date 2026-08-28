import { expect, test, type Page } from "@playwright/test";

/**
 * DESIGN_BRIEF.md v3 §7.1 — proof that the hero renders through WebGL on the
 * default browser profile, and that it degrades to the static poster (with no
 * canvas at all) under reduced motion and without JavaScript.
 *
 * Runs under playwright.hero.config.ts rather than the promo capture rig,
 * because the capture rig fixes motion settings for reproducible video and
 * this file's first assertion needs a profile that actually animates.
 */

async function openLanding(page: Page, baseURL: string | undefined) {
  if (!baseURL) throw new Error("HERO_BASE_URL is missing.");
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", {
      name: "Billing events are chaos. Your entitlements aren’t.",
    }),
  ).toBeVisible();
}

test("the default profile renders the hero through a WebGL context", async ({
  page,
  baseURL,
}) => {
  await openLanding(page, baseURL);

  const layer = page.locator(".hero-wave");
  await expect(layer).toHaveAttribute("data-drawn", "true", {
    timeout: 30_000,
  });

  const canvas = layer.locator("canvas");
  await expect(canvas).toHaveCount(1);

  const context = await canvas.evaluate((element) => {
    const target = element as HTMLCanvasElement;
    // Re-requesting the type the renderer already holds returns that same
    // context, so a truthy result proves the drawing buffer is WebGL.
    const gl = target.getContext("webgl2") ?? target.getContext("webgl");
    return {
      isWebgl: Boolean(gl),
      isWebgl2: Boolean(target.getContext("webgl2")),
      width: target.width,
      height: target.height,
    };
  });

  expect(context.isWebgl).toBe(true);
  expect(context.isWebgl2).toBe(true);
  expect(context.width).toBeGreaterThan(0);
  expect(context.height).toBeGreaterThan(0);

  // The poster must hand over rather than stay stacked on top of the canvas.
  const posterOpacity = await layer
    .locator(".hero-wave-fallback")
    .evaluate((element) => getComputedStyle(element).opacity);
  expect(Number(posterOpacity)).toBeLessThan(0.05);
});

test("the wave keeps moving between frames", async ({ page, baseURL }) => {
  await openLanding(page, baseURL);
  const layer = page.locator(".hero-wave");
  await expect(layer).toHaveAttribute("data-drawn", "true", {
    timeout: 30_000,
  });

  const first = await layer.screenshot();
  await page.waitForTimeout(1_200);
  const second = await layer.screenshot();

  // A stalled rAF loop, a frozen uniform, or a fallback masquerading as the
  // canvas would all produce byte-identical frames here.
  expect(Buffer.compare(first, second)).not.toBe(0);
});

test("reduced motion keeps the static poster and mounts no canvas", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await openLanding(page, baseURL);
  await page.waitForTimeout(2_000);

  await expect(page.locator(".hero-wave canvas")).toHaveCount(0);
  await expect(page.locator(".hero-wave picture img")).toBeVisible();
  await expect(page.locator(".hero-wave")).not.toHaveAttribute(
    "data-drawn",
    "true",
  );
  await context.close();
});

test("the server HTML carries the poster and no canvas", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  if (!baseURL) throw new Error("HERO_BASE_URL is missing.");
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });

  await expect(page.locator(".hero-wave canvas")).toHaveCount(0);
  await expect(page.locator(".hero-wave picture source")).toHaveCount(2);
  await expect(page.locator(".hero-wave picture img")).toBeVisible();
  await context.close();
});
