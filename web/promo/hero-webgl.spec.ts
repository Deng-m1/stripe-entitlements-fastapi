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
  // The handover is a 900ms opacity transition that starts when `data-drawn`
  // flips, so this has to be a retrying assertion: a one-shot read races the
  // fade and fails on any machine fast enough to reach it mid-transition.
  await expect(layer.locator(".hero-wave-fallback")).toHaveCSS("opacity", "0", {
    timeout: 5_000,
  });
});

test("the renderer hands back to the poster when reduced motion arrives mid-session", async ({
  page,
  baseURL,
}) => {
  await openLanding(page, baseURL);
  const layer = page.locator(".hero-wave");
  await expect(layer).toHaveAttribute("data-drawn", "true", {
    timeout: 30_000,
  });

  // Flipping the OS motion preference while the canvas is live must not
  // leave the hero blank: the canvas unmounts, `data-drawn` releases, and
  // the poster returns at full opacity in the same frame.
  await page.emulateMedia({ reducedMotion: "reduce" });

  await expect(layer.locator("canvas")).toHaveCount(0);
  await expect(layer).not.toHaveAttribute("data-drawn", "true");
  await expect(layer.locator(".hero-wave-fallback")).toHaveCSS("opacity", "1");

  // And the handover must recover when the preference is withdrawn.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(layer).toHaveAttribute("data-drawn", "true", {
    timeout: 30_000,
  });
  await expect(layer.locator("canvas")).toHaveCount(1);
});

test("the headline lockup strands no orphan word at 1440px", async ({
  page,
  baseURL,
}) => {
  // Review P1-5: at this width "Billing events are" and the headline column
  // are within a few pixels of each other, so greedy wrapping used to flip
  // between "…events / are chaos." and "…events are / chaos." on font-metric
  // noise, stranding "chaos." alone on its own line.
  await openLanding(page, baseURL);

  const lockup = await page.evaluate(() => {
    const hold = document.querySelector(".h1-hold");
    const heading = document.getElementById("hero-heading");
    if (!hold || !heading) return null;
    const lineCount = (element: Element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const tops = new Set<number>();
      for (const rect of range.getClientRects()) {
        if (rect.width === 0) continue;
        // Quantise: fragments of one line share a top within subpixel noise.
        tops.add(Math.round(rect.top));
      }
      return tops.size;
    };
    return {
      holdLines: lineCount(hold),
      headingLines: lineCount(heading),
    };
  });

  expect(lockup).not.toBeNull();
  // "are chaos." renders as one unbroken fragment, so "chaos." cannot orphan.
  expect(lockup?.holdLines).toBe(1);
  // The whole lockup holds the intended four lines — a fifth line means a
  // shattered rag (the laptop-width failure class).
  expect(lockup?.headingLines).toBeLessThanOrEqual(4);
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
