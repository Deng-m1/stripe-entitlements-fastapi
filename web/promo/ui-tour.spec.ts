import { expect, test, type Locator, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";

function stepPauseMs(): number {
  const value = Number(process.env.PROMO_STEP_PAUSE_MS ?? "1600");
  return Number.isFinite(value) ? value : 1600;
}

async function cleanCapture(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      .demo-notice { display: none !important; }
      html { scroll-behavior: smooth !important; }
      * { caret-color: transparent !important; }
    `,
  });
}

async function smoothFocus(page: Page, locator: Locator): Promise<void> {
  await locator.evaluate((element: Element) => {
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  await page.waitForTimeout(700);
}

test("open-source billing reference UI tour", async ({ page, baseURL }, testInfo) => {
  if (!baseURL) throw new Error("PROMO_BASE_URL is missing.");

  const startedAt = Date.now();
  const timeline: Array<{ label: string; milliseconds: number }> = [];
  const pause = async (label: string, screenshotName: string, multiplier = 1) => {
    timeline.push({ label, milliseconds: Date.now() - startedAt });
    await page.screenshot({
      path: testInfo.outputPath(`${screenshotName}.png`),
      animations: "disabled",
    });
    await page.waitForTimeout(stepPauseMs() * multiplier);
  };

  await page.goto(baseURL, { waitUntil: "networkidle" });
  await cleanCapture(page);
  await expect(
    page.getByRole("heading", {
      name: "Race-safe Stripe billing for FastAPI, PostgreSQL, and Next.js.",
    }),
  ).toBeVisible();
  await pause("Landing hero", "01-landing-hero", 1.5);

  const capabilities = page.getByRole("heading", {
    name: "A Stripe billing template built around invariants.",
  });
  await smoothFocus(page, capabilities);
  await expect(capabilities).toBeVisible();
  await pause("Correctness capabilities", "02-correctness-capabilities");

  const catalogHeading = page.getByRole("heading", {
    name: "Three tiers, monthly and annual billing.",
  });
  await smoothFocus(page, catalogHeading);
  await expect(catalogHeading).toBeVisible();
  await pause("Reference catalog", "03-reference-catalog");

  const faqHeading = page.getByRole("heading", {
    name: "Stripe billing template FAQ",
  });
  await smoothFocus(page, faqHeading);
  await page
    .getByText("Does it support Stripe prorated subscription upgrades?", {
      exact: true,
    })
    .click();
  await pause("Prorated upgrade scope", "04-prorated-upgrade-scope");

  await page.getByRole("link", { name: "Pricing", exact: true }).click();
  await page.waitForLoadState("networkidle");
  await cleanCapture(page);
  await expect(
    page.getByRole("heading", {
      name: "Choose a plan without hiding the billing consequences.",
    }),
  ).toBeVisible();
  await pause("Monthly pricing", "05-monthly-pricing");

  await page.getByRole("button", { name: "Yearly" }).click();
  await expect(page.getByText("Save $235.00/year", { exact: true })).toBeVisible();
  await pause("Annual savings", "06-annual-savings", 1.25);

  await page.getByRole("button", { name: "Monthly" }).click();
  const proButton = page.getByRole("button", { name: "Choose Pro month" });
  await smoothFocus(page, proButton);
  await expect(proButton).toBeEnabled();
  await proButton.click();
  await expect(
    page.getByRole("heading", {
      name: "This change requires immediate settlement",
    }),
  ).toBeVisible();
  await pause(
    "Server-calculated plan-change preview",
    "07-plan-change-preview",
    1.5,
  );

  await page.getByRole("checkbox").check();
  await pause("Explicit billing acknowledgement", "08-billing-acknowledgement");
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("link", { name: "Account" }).click();
  await page.waitForLoadState("networkidle");
  await cleanCapture(page);
  await expect(page.getByRole("heading", { name: "Your billing account" })).toBeVisible();
  await pause("Webhook-authoritative account", "09-account-projection", 1.25);

  const entitlementHeading = page.getByRole("heading", {
    name: "What the product may enforce",
  });
  await smoothFocus(page, entitlementHeading);
  await expect(page.getByText("214", { exact: true }).first()).toBeVisible();
  await pause(
    "Credits and structured entitlements",
    "10-structured-entitlements",
    1.5,
  );

  writeFileSync(
    testInfo.outputPath("timeline.json"),
    `${JSON.stringify({ duration_ms: Date.now() - startedAt, timeline }, null, 2)}\n`,
  );
});
