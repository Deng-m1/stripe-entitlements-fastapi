import { expect, test, type Page } from "@playwright/test";

async function openLanding(page: Page, baseURL: string | undefined): Promise<void> {
  if (!baseURL) throw new Error("PROMO_BASE_URL is missing.");
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", {
      name: "Billing events are chaos. Your entitlements aren’t.",
    }),
  ).toBeVisible();
}

async function terminalOpacities(page: Page): Promise<string[]> {
  return page.locator(".terminal-line").evaluateAll((lines) =>
    lines.map((line) => getComputedStyle(line).opacity),
  );
}

test("normal motion settles every terminal line on desktop", async ({
  page,
  baseURL,
}) => {
  await openLanding(page, baseURL);
  const terminal = page.locator(".hero-terminal");
  await expect(terminal.locator(".terminal-line")).toHaveCount(8);

  // A capture forces an initial compositor frame in headless Chromium. The
  // following assertion then exercises the same normal-motion reveal a visitor sees.
  // Capture the page rather than the animated element. Locator screenshots wait
  // for element stability and can time out while the terminal reveal is moving.
  await page.screenshot({ animations: "allow" });
  await expect
    .poll(() => terminalOpacities(page), { timeout: 7_000 })
    .toEqual(Array(8).fill("1"));
  await expect(terminal.locator(".terminal-title-path")).toBeVisible();
});

test("390px layout contains the ledger and exposes the matrix overflow", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLanding(page, baseURL);

  const terminal = page.locator(".hero-terminal");
  await terminal.scrollIntoViewIfNeeded();
  await page.screenshot({ animations: "allow" });
  await expect
    .poll(() => terminalOpacities(page), { timeout: 7_000 })
    .toEqual(Array(8).fill("1"));
  await expect(terminal.locator(".terminal-title-path")).toBeHidden();

  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBe(0);

  const ledger = page.locator(".ledger-card");
  await ledger.scrollIntoViewIfNeeded();
  const ledgerColumnsContained = await ledger.evaluate((card) => {
    const boundary = card.getBoundingClientRect();
    const cells = [
      ...card.querySelectorAll<HTMLElement>(".ledger-seq, .ledger-chip"),
    ];
    return cells.every((cell) => {
      const rect = cell.getBoundingClientRect();
      return rect.left >= boundary.left - 1 && rect.right <= boundary.right + 1;
    });
  });
  expect(ledgerColumnsContained).toBe(true);
  await expect(ledger.getByText("001", { exact: true }).first()).toBeVisible();
  await expect(ledger.getByText("absorbed", { exact: true })).toBeVisible();

  const hint = page.getByText(
    "Scroll sideways for the yearly target columns.",
    { exact: true },
  );
  await expect(hint).toBeVisible();
  const matrix = page.getByRole("region", {
    name: "Scrollable plan transition matrix",
  });
  await matrix.scrollIntoViewIfNeeded();
  expect(
    await matrix.evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  await matrix.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const finalColumnIsVisible = await matrix.evaluate((element) => {
    const boundary = element.getBoundingClientRect();
    const finalHeader = element.querySelector("thead th:last-child");
    if (!finalHeader) return false;
    const rect = finalHeader.getBoundingClientRect();
    return rect.left >= boundary.left - 1 && rect.right <= boundary.right + 1;
  });
  expect(finalColumnIsVisible).toBe(true);
});

test("390px pricing hydrates and contains its comparison table", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("PROMO_BASE_URL is missing.");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(new URL("/pricing", baseURL).toString(), {
    waitUntil: "networkidle",
  });

  await expect(
    page.getByRole("heading", {
      name: "Choose a plan without hiding the billing consequences.",
    }),
  ).toBeVisible();
  await expect(page.locator(".account-loading")).toBeHidden();
  await expect(page.getByRole("button", { name: "Choose Pro month" })).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBe(0);

  await page.getByRole("button", { name: "Yearly" }).click();
  await expect(page.getByText("$353.00 billed yearly", { exact: true })).toBeVisible();
  await expect(page.getByText("Save $235.00/year", { exact: true })).toBeVisible();

  const comparison = page.locator(".comparison-table-wrap");
  await comparison.scrollIntoViewIfNeeded();
  expect(
    await comparison.evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  await comparison.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const finalColumnIsVisible = await comparison.evaluate((element) => {
    const boundary = element.getBoundingClientRect();
    const finalHeader = element.querySelector("thead th:last-child");
    if (!finalHeader) return false;
    const rect = finalHeader.getBoundingClientRect();
    return rect.left >= boundary.left - 1 && rect.right <= boundary.right + 1;
  });
  expect(finalColumnIsVisible).toBe(true);
});

test("reduced motion renders the settled terminal and ledger state", async ({
  page,
  baseURL,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await openLanding(page, baseURL);

  const terminal = page.locator(".hero-terminal");
  await terminal.scrollIntoViewIfNeeded();
  await page.screenshot({ animations: "allow" });
  await expect
    .poll(() => terminalOpacities(page), { timeout: 2_000 })
    .toEqual(Array(8).fill("1"));

  const ledger = page.locator(".ledger-card");
  await ledger.scrollIntoViewIfNeeded();
  await expect(ledger.getByText("charge.refunded", { exact: true }).last()).toBeVisible();
  await expect(ledger.getByText("absorbed", { exact: true })).toBeVisible();
});
