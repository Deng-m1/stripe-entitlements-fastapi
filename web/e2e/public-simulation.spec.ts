import { expect, test } from "@playwright/test";

test("public simulation completes browser-local billing flows without a backend", async ({
  browser,
  page,
  request,
}) => {
  const attestation = await request.get("/");
  expect(attestation.ok()).toBe(true);
  expect(attestation.headers()["x-frontend-build-mode"]).toBe("production");
  expect(attestation.headers()["x-billing-api-mode"]).toBe("simulation");

  const robots = await request.get("/robots.txt");
  expect(robots.ok()).toBe(true);
  expect(await robots.text()).toContain("Disallow: /");
  for (const path of ["/api/account", "/health"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
    expect(response.headers()["cache-control"], path).toContain("no-store");
    expect(response.headers()["x-billing-api-mode"], path).toBe("simulation");
  }
  const webhook = await request.post("/webhooks/stripe", { data: "{}" });
  expect(webhook.status()).toBe(404);
  expect(webhook.headers()["cache-control"]).toContain("no-store");
  expect(webhook.headers()["x-billing-api-mode"]).toBe("simulation");

  const forbiddenRequests: string[] = [];
  const forbidden = (rawUrl: string) => {
    const url = new URL(rawUrl);
    const stripeNetwork = ["stripe.com", "stripe.network", "stripecdn.com"].some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    );
    return (
      stripeNetwork ||
      url.pathname === "/api" ||
      url.pathname.startsWith("/api/") ||
      url.pathname === "/webhooks/stripe"
    );
  };
  const protect = async (candidate: typeof page) => {
    candidate.on("request", (outbound) => {
      if (forbidden(outbound.url())) forbiddenRequests.push(outbound.url());
    });
    await candidate.route("**/*", async (route) => {
      if (forbidden(route.request().url())) {
        await route.abort("blockedbyclient");
      } else {
        await route.continue();
      }
    });
  };
  await protect(page);

  await page.goto("/pricing", { waitUntil: "networkidle" });
  await expect(page.getByLabel("Demo environment notice")).toContainText(
    "PUBLIC SIMULATION",
  );
  await expect(page.getByLabel("Demo environment notice")).toContainText(
    "No Stripe request, payment, webhook, database, or account is used.",
  );
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    /noindex/u,
  );
  await expect(
    page.getByRole("button", { name: "Choose Starter month" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Choose Starter month" }).click();
  await expect(
    page.getByRole("heading", { name: "Simulated account state is ready" }),
  ).toBeVisible();
  await expect(page.getByText("Checkout returned", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Webhook-backed account state is ready", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("starter · month", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Back to pricing" }).click();
  await expect(page.getByRole("button", { name: "Choose Pro month" })).toBeEnabled();
  await page.getByRole("button", { name: "Choose Pro month" }).click();
  await expect(
    page.getByRole("heading", {
      name: "This simulated change applies immediately",
    }),
  ).toBeVisible();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Confirm simulated change" }).click();
  await expect(
    page.getByRole("heading", { name: "Simulated account state is ready" }),
  ).toBeVisible();
  await expect(page.getByText("pro · month", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Back to pricing" }).click();
  await page.getByRole("button", { name: "Buy Boost 100" }).click();
  await expect(
    page.getByRole("heading", { name: "Simulated account state is ready" }),
  ).toBeVisible();
  await expect(page.getByText("100 credits", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "View account" }).click();
  await expect(page.getByRole("heading", { name: "Your billing account" })).toBeVisible();
  await expect(page.getByText("1,100", { exact: true }).first()).toBeVisible();
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByText("1,100", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open Stripe Billing Portal" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Open simulated Portal" }).click();
  await expect(page).toHaveURL(/\/account\?portal=demo$/u);
  await expect(page.getByText("1,100", { exact: true }).first()).toBeVisible();

  const isolatedContext = await browser.newContext();
  const isolatedPage = await isolatedContext.newPage();
  await protect(isolatedPage);
  await isolatedPage.goto(new URL("/account", page.url()).toString(), {
    waitUntil: "networkidle",
  });
  await expect(isolatedPage.getByText("Free", { exact: true }).first()).toBeVisible();
  await expect(isolatedPage.getByText("0", { exact: true }).first()).toBeVisible();
  await isolatedContext.close();

  await Promise.all([
    page.waitForURL(/\/pricing$/u),
    page.getByRole("button", { name: "Reset simulation" }).click(),
  ]);
  await expect(
    page.getByRole("button", { name: "Choose Starter month" }),
  ).toBeEnabled();
  await page.getByRole("link", { name: "Account", exact: true }).click();
  await expect(page.getByText("Free", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("0", { exact: true }).first()).toBeVisible();

  expect(forbiddenRequests).toEqual([]);
});

test("public simulation fails closed when browser session storage is denied", async ({
  page,
  request,
}) => {
  const attestation = await request.get("/");
  expect(attestation.headers()["x-frontend-build-mode"]).toBe("production");
  expect(attestation.headers()["x-billing-api-mode"]).toBe("simulation");

  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("storage denied", "SecurityError");
    };
  });
  await page.goto("/pricing", { waitUntil: "networkidle" });

  await expect(
    page.getByRole("alert").filter({
      hasText: "Public simulation requires available browser sessionStorage",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose Starter month" }),
  ).toBeDisabled();
});
