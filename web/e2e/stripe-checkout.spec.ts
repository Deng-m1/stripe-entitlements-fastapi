import {
  expect,
  test,
  type APIRequestContext,
  type Frame,
  type Locator,
  type Page,
} from "@playwright/test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const DECLINED_TEST_CARD = "4000000000000002";
const SCA_TEST_CARD = "4000002500003155";
const TEST_EXPIRY = "1234";
const TEST_CVC = "123";
const DEFAULT_TEST_EMAIL = "browser-checkout@example.test";
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface AccountProjection {
  account_id: string;
  transition_policy: "full_period_reset" | "prorated_delta";
  plan_key: string;
  plan_interval: string | null;
  subscription_status: string;
  credits: {
    balance: number;
    grant_amount: number;
  };
  entitlements_enforceable: boolean;
}

async function expectedAccountId(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "uv",
      ["run", "python", "scripts/e2e_stripe.py", "resolve-account"],
      {
        cwd: REPOSITORY_ROOT,
        env: process.env,
        timeout: 30_000,
        maxBuffer: 16 * 1024,
      },
      (error, stdout) => {
        const match = stdout.match(
          /account-id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
        );
        if (error || !match) {
          reject(new Error("Authenticated E2E subject could not be bound to PostgreSQL."));
          return;
        }
        resolve(match[1]);
      },
    );
  });
}

interface CheckoutRedirect {
  url: string;
}

interface BackendHealth {
  ok: boolean;
  database: boolean;
  stripe_mode: "test" | "live";
  transition_policy: "full_period_reset" | "prorated_delta";
}

function timeoutFromEnvironment(): number {
  return Number(process.env.E2E_WEBHOOK_TIMEOUT_MS ?? "180000");
}

function frontendUrl(baseURL: string, path: string): string {
  return new URL(path, baseURL).toString();
}

async function clickAfterUserScroll(
  locator: Locator,
  options: { noWaitAfter?: boolean } = {},
): Promise<void> {
  await expect(locator).toBeVisible();
  await expect(locator).toBeEnabled();
  await locator.evaluate((element) => {
    element.scrollIntoView({ block: "center", inline: "center" });
  });
  await locator.click(options);
}

async function verifyTestBackend(
  request: APIRequestContext,
  backendURL: string,
): Promise<void> {
  const response = await request.get(new URL("/health", backendURL).toString());
  if (!response.ok()) {
    throw new Error(`Backend /health returned HTTP ${response.status()}.`);
  }
  const health = (await response.json()) as BackendHealth;
  expect(health.ok).toBe(true);
  expect(health.database).toBe(true);
  if (health.stripe_mode !== "test") {
    throw new Error(
      "Refusing all stateful browser requests: backend did not attest Stripe test mode.",
    );
  }
  const expectedPolicy = process.env.E2E_TRANSITION_POLICY;
  if (health.transition_policy !== expectedPolicy) {
    throw new Error("Backend transition policy differs from E2E_TRANSITION_POLICY.");
  }
}

async function prepareUpgradePaymentMethod(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "uv",
      [
        "run",
        "python",
        "scripts/e2e_stripe.py",
        "prepare-upgrade-payment-method",
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: process.env,
        timeout: 90_000,
        maxBuffer: 64 * 1024,
      },
      (error, stdout) => {
        if (error || !stdout.includes("prepared run-owned upgrade PaymentMethod")) {
          reject(new Error("Run-owned upgrade PaymentMethod preparation failed."));
          return;
        }
        resolve();
      },
    );
  });
}

async function verifyDeclineStability(): Promise<void> {
  const databaseURL = process.env.E2E_DATABASE_URL?.trim();
  const externalRef = process.env.E2E_EXTERNAL_REF?.trim();
  const stabilitySeconds = process.env.E2E_DECLINE_STABILITY_SECONDS?.trim() ?? "10";
  if (!databaseURL || !externalRef) {
    throw new Error("Decline barrier environment is missing.");
  }
  await new Promise<void>((resolve, reject) => {
    execFile(
      "uv",
      [
        "run",
        "python",
        "scripts/e2e_stripe.py",
        "verify-decline",
        "--stability-seconds",
        stabilitySeconds,
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: process.env,
        timeout: 90_000,
        maxBuffer: 64 * 1024,
      },
      (error, stdout) => {
        if (error || !stdout.includes("verified decline stability")) {
          reject(
            new Error(
              "Server-side decline barrier failed; inspect private runner logs.",
            ),
          );
          return;
        }
        resolve();
      },
    );
  });
}

function isAccountResponse(url: string, method: string): boolean {
  try {
    return method === "GET" && new URL(url).pathname.endsWith("/api/account");
  } catch {
    return false;
  }
}

function isCatalogResponse(url: string, method: string): boolean {
  try {
    return method === "GET" && new URL(url).pathname.endsWith("/api/catalog");
  } catch {
    return false;
  }
}

async function openPricingThroughExpectedBackend(
  page: Page,
  baseURL: string,
  backendURL: string,
): Promise<void> {
  const responsePromise = page.waitForResponse(
    (response) => isCatalogResponse(response.url(), response.request().method()),
    { timeout: 20_000 },
  );
  await page.goto(frontendUrl(baseURL, "/pricing"), {
    waitUntil: "domcontentloaded",
  });
  const response = await responsePromise;
  if (!response.ok()) {
    throw new Error(`GET /api/catalog returned HTTP ${response.status()}.`);
  }
  if (new URL(response.url()).origin !== new URL(backendURL).origin) {
    throw new Error(
      "Refusing stateful E2E: frontend catalog traffic does not use E2E_BACKEND_URL.",
    );
  }
}

async function openHostedCheckout(page: Page, checkoutUrl: string): Promise<void> {
  const expectedSession = checkoutSessionId(checkoutUrl);
  if (!expectedSession) {
    throw new Error("The captured Checkout redirect has no test Session identity.");
  }
  let lastError: unknown;
  try {
    await page.waitForURL(
      (url) => checkoutSessionId(url.toString()) === expectedSession,
      { timeout: 30_000, waitUntil: "commit" },
    );
    return;
  } catch (error) {
    lastError = error;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(checkoutUrl, { timeout: 30_000, waitUntil: "commit" });
      if (checkoutSessionId(page.url()) === expectedSession) return;
    } catch (error) {
      lastError = error;
      if (checkoutSessionId(page.url()) === expectedSession) return;
      if (!/ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED/.test(String(error))) {
        if (attempt === 3) throw error;
      }
      await page.waitForTimeout(attempt * 500);
    }
  }
  throw lastError;
}

async function prepareCheckoutCapture(page: Page, backendURL: string): Promise<{
  wait: () => Promise<CheckoutRedirect>;
  release: () => Promise<void>;
}> {
  let redirect: CheckoutRedirect | undefined;
  let captureError: unknown;
  const routePattern = /\/api\/checkout(?:\?.*)?$/;

  await page.route(routePattern, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    try {
      if (new URL(route.request().url()).origin !== new URL(backendURL).origin) {
        throw new Error(
          "Refusing Checkout POST: frontend write target does not match E2E_BACKEND_URL.",
        );
      }
      const response = await route.fetch({
        headers: {
          ...route.request().headers(),
          "x-stripe-mode-requirement": "test",
        },
      });
      const body = await response.text();
      let capturedRedirect: CheckoutRedirect | undefined;
      if (!response.ok()) {
        captureError = new Error(
          `POST /api/checkout returned HTTP ${response.status()}.`,
        );
      } else {
        capturedRedirect = JSON.parse(body) as CheckoutRedirect;
      }
      // Capture the body before the application calls location.assign(). Chromium
      // may otherwise release Network.getResponseBody during an external navigation.
      await route.fulfill({ response, body });
      redirect = capturedRedirect;
    } catch (error) {
      captureError = error;
      await route.abort("failed").catch(() => undefined);
    }
  });

  return {
    wait: async () => {
      await expect
        .poll(
          () => {
            if (captureError) throw captureError;
            return redirect;
          },
          {
            timeout: 60_000,
            message: "waiting for the Checkout redirect response",
          },
        )
        .toBeTruthy();
      if (!redirect) {
        throw new Error("The Checkout response did not contain a redirect.");
      }
      return redirect;
    },
    release: () => page.unroute(routePattern),
  };
}

async function loadAccountProjection(
  page: Page,
  baseURL: string,
): Promise<AccountProjection> {
  const responsePromise = page.waitForResponse(
    (response) => isAccountResponse(response.url(), response.request().method()),
    { timeout: 20_000 },
  );
  await page.goto(frontendUrl(baseURL, "/account"), {
    waitUntil: "domcontentloaded",
  });
  const response = await responsePromise;
  if (!response.ok()) {
    throw new Error(`GET /api/account returned HTTP ${response.status()}.`);
  }
  return (await response.json()) as AccountProjection;
}

async function waitForPaidProjection(
  page: Page,
  baseURL: string,
  expectedPlan = "starter",
  expectedBalance = 300,
  expectedGrant = 300,
): Promise<AccountProjection> {
  let latest: AccountProjection | undefined;
  await expect
    .poll(
      async () => {
        try {
          latest = await loadAccountProjection(page, baseURL);
          return {
            plan_key: latest.plan_key,
            plan_interval: latest.plan_interval,
            subscription_status: latest.subscription_status,
            balance: latest.credits.balance,
            grant_amount: latest.credits.grant_amount,
            entitlements_enforceable: latest.entitlements_enforceable,
          };
        } catch {
          return null;
        }
      },
      {
        timeout: timeoutFromEnvironment(),
        intervals: [500, 1_000, 2_000, 3_000],
        message: "waiting for the signed invoice.paid webhook account projection",
      },
    )
    .toEqual({
      plan_key: expectedPlan,
      plan_interval: "month",
      subscription_status: "active",
      balance: expectedBalance,
      grant_amount: expectedGrant,
      entitlements_enforceable: true,
    });
  if (!latest) throw new Error("The paid account projection was not captured.");
  return latest;
}

async function visibleLocatorAcrossFrames(
  page: Page,
  selectors: readonly string[],
  description: string,
  timeout = 30_000,
): Promise<Locator> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      for (const selector of selectors) {
        const locator = frame.locator(selector).first();
        if (await locator.isVisible().catch(() => false)) return locator;
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function optionalVisibleLocatorAcrossFrames(
  page: Page,
  selectors: readonly string[],
  timeout = 2_000,
): Promise<Locator | null> {
  try {
    return await visibleLocatorAcrossFrames(page, selectors, "optional Checkout field", timeout);
  } catch {
    return null;
  }
}

async function fillIfEditable(locator: Locator | null, value: string): Promise<void> {
  if (locator && (await locator.isEditable().catch(() => false))) {
    await locator.fill(value);
  }
}

async function fillCheckoutIdentity(page: Page): Promise<void> {
  const email = await optionalVisibleLocatorAcrossFrames(page, [
    'input[type="email"]',
    'input[name="email"]',
    'input[autocomplete="email"]',
  ]);
  await fillIfEditable(
    email,
    process.env.E2E_CUSTOMER_EMAIL?.trim() || DEFAULT_TEST_EMAIL,
  );
}

async function fillCheckoutCard(page: Page, number: string): Promise<void> {
  const cardNumber = await visibleLocatorAcrossFrames(
    page,
    [
      'input[name="cardNumber"]',
      'input[data-elements-stable-field-name="cardNumber"]',
      'input[autocomplete="cc-number"]',
      'input[aria-label*="Card number" i]',
    ],
    "Stripe card-number field",
  );
  await cardNumber.fill(number);

  const expiry = await visibleLocatorAcrossFrames(
    page,
    [
      'input[name="cardExpiry"]',
      'input[data-elements-stable-field-name="cardExpiry"]',
      'input[autocomplete="cc-exp"]',
      'input[aria-label*="expiration" i]',
      'input[aria-label*="expiry" i]',
    ],
    "Stripe expiration field",
  );
  await expiry.fill(TEST_EXPIRY);

  const cvc = await visibleLocatorAcrossFrames(
    page,
    [
      'input[name="cardCvc"]',
      'input[data-elements-stable-field-name="cardCvc"]',
      'input[autocomplete="cc-csc"]',
      'input[aria-label*="security code" i]',
      'input[aria-label*="CVC" i]',
    ],
    "Stripe card security-code field",
  );
  await cvc.fill(TEST_CVC);

  await fillIfEditable(
    await optionalVisibleLocatorAcrossFrames(page, [
      'input[name="billingName"]',
      'input[autocomplete="cc-name"]',
      'input[aria-label*="name on card" i]',
    ]),
    "Stripe Browser Test",
  );
  await fillIfEditable(
    await optionalVisibleLocatorAcrossFrames(page, [
      'input[name="billingPostalCode"]',
      'input[name="postalCode"]',
      'input[autocomplete="postal-code"]',
    ]),
    "10001",
  );
}

async function disableLinkSave(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    const checkbox = frame
      .getByRole("checkbox", { name: /save my information for faster checkout/i })
      .first();
    if (
      (await checkbox.isVisible().catch(() => false)) &&
      (await checkbox.isChecked().catch(() => false))
    ) {
      await checkbox.uncheck();
    }
  }
}

async function acknowledgeAgentAutomation(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    const checkbox = frame
      .getByRole("checkbox", {
        name: /I am an AI agent acting on behalf of someone else/i,
      })
      .first();
    if (
      (await checkbox.isVisible().catch(() => false)) &&
      !(await checkbox.isChecked().catch(() => false))
    ) {
      // Stripe positions the precisely named native input outside the viewport and
      // renders a custom control. Native click() applies the checkbox's real default
      // action inside its own frame without relying on impossible screen coordinates.
      await checkbox.evaluate((element: HTMLInputElement) => element.click());
      await expect(checkbox).toBeChecked();
    }
  }
}

async function submitCheckout(page: Page): Promise<void> {
  // Some Checkout configurations opt into Link by default after email/card input.
  // Leaving it checked introduces an unrelated phone/OTP flow and prevents the card
  // decline or 3DS PaymentIntent from being submitted.
  await disableLinkSave(page);
  // Stripe Sandbox currently asks automated agents to disclose themselves. This
  // suite is an agent-driven browser, so leaving the box unchecked would be both
  // inaccurate and a potential blocker for challenge completion.
  await acknowledgeAgentAutomation(page);
  const submit = await visibleLocatorAcrossFrames(
    page,
    [
      'button[type="submit"]:has-text("Subscribe")',
      'button[type="submit"]:has-text("Pay")',
      'button[type="submit"]:has-text("Complete")',
      'button[type="submit"]',
    ],
    "Stripe Checkout submit button",
  );
  await submit.click();
}

async function hasVisibleTextAcrossFrames(page: Page, pattern: RegExp): Promise<boolean> {
  for (const frame of page.frames()) {
    const match = frame.getByText(pattern).first();
    if (await match.isVisible().catch(() => false)) return true;
  }
  return false;
}

async function completeScaChallenge(page: Page): Promise<void> {
  const deadline = Date.now() + 60_000;
  let button: Locator | null = null;
  let challengeFrame: Frame | null = null;
  while (!button && Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!isStripeChallengeFrame(frame, page)) continue;
      const challengeHeading = frame
        .getByRole("heading", { name: /3D Secure 2 Test Page/i })
        .first();
      const candidate = frame
        .getByRole("button", { name: "Complete", exact: true })
        .first();
      if (
        (await challengeHeading.isVisible().catch(() => false)) &&
        (await candidate.isVisible().catch(() => false))
      ) {
        challengeFrame = frame;
        button = candidate;
      }
      if (button) break;
    }
    if (!button) await page.waitForTimeout(200);
  }
  if (!button) {
    throw new Error("Timed out waiting for Stripe's test 3DS authentication challenge.");
  }
  if (!challengeFrame) throw new Error("Stripe's 3DS challenge frame is missing.");
  await challengeFrame.waitForLoadState("load");
  await expect(button).toBeEnabled();
  // The sandbox button can render just before challenge.js attaches its listener.
  await page.waitForTimeout(500);
  const acsResponsePromise = page.waitForResponse(
    (response) => {
      try {
        const url = new URL(response.url());
        return (
          response.request().method() === "POST" &&
          url.hostname === "testmode-acs.stripe.com"
        );
      } catch {
        return false;
      }
    },
    { timeout: 30_000 },
  );
  await button.click();
  const acsResponse = await acsResponsePromise;
  if (!acsResponse.ok()) {
    throw new Error(`Stripe test ACS completion returned HTTP ${acsResponse.status()}.`);
  }
  await expect
    .poll(() => page.frames().includes(challengeFrame), {
      timeout: 30_000,
      message: "waiting for the completed Stripe 3DS frame to detach",
    })
    .toBe(false);
}

function isStripeChallengeFrame(frame: Frame, page: Page): boolean {
  if (frame === page.mainFrame()) return false;
  try {
    const url = new URL(frame.url());
    const stripeOwned =
      url.hostname === "stripe.com" || url.hostname.endsWith(".stripe.com");
    return (
      stripeOwned &&
      /3d[_-]?secure|3ds|authenticate|challenge|acs/i.test(
        `${url.pathname}${url.search}`,
      )
    );
  } catch {
    return false;
  }
}

function assertTestModeCheckout(urlValue: string): void {
  const checkout = new URL(urlValue);
  const stripeHost =
    checkout.hostname === "stripe.com" || checkout.hostname.endsWith(".stripe.com");
  expect(checkout.protocol).toBe("https:");
  expect(stripeHost).toBe(true);
  const sessionPathSegment = checkoutSessionId(urlValue);
  if (!sessionPathSegment?.startsWith("cs_test_")) {
    throw new Error(
      "Refusing to enter card data: the hosted Checkout URL is not a cs_test_ Session.",
    );
  }
}

function checkoutSessionId(urlValue: string): string | undefined {
  try {
    return new URL(urlValue).pathname
      .split("/")
      .find((segment) => segment.startsWith("cs_"));
  } catch {
    return undefined;
  }
}

test.describe("real Stripe hosted Checkout", () => {
  test.describe.configure({ mode: "serial" });

  test("decline remains free, then 3DS succeeds only after webhook projection", async ({
    context,
    page,
    request,
    baseURL,
  }) => {
    if (!baseURL) throw new Error("Playwright baseURL is missing.");
    const backendURL = process.env.E2E_BACKEND_URL?.trim();
    if (!backendURL) throw new Error("E2E_BACKEND_URL is missing.");

    await test.step("backend attests Stripe test mode before any state write", async () => {
      await verifyTestBackend(request, backendURL);
    });

    await test.step("frontend read traffic is bound to the attested backend", async () => {
      await openPricingThroughExpectedBackend(page, baseURL, backendURL);
    });

    const accountPage = await context.newPage();
    const initial = await loadAccountProjection(accountPage, baseURL);
    expect(initial.account_id).toBe(await expectedAccountId());
    expect(initial.plan_key).toBe("free");
    expect(initial.credits.balance).toBe(0);
    expect(initial.entitlements_enforceable).toBe(false);

    await test.step("open a verifiably test-mode hosted Checkout", async () => {
      await expect(page.getByRole("heading", { name: "Starter" })).toBeVisible();
      const capture = await prepareCheckoutCapture(page, backendURL);
      await clickAfterUserScroll(
        page.getByRole("button", { name: "Choose Starter month" }),
        { noWaitAfter: true },
      );
      const redirect = await capture.wait();
      await capture.release();
      assertTestModeCheckout(redirect.url);

      // The application already calls location.assign(). Navigating explicitly to the
      // same server-authoritative URL makes a one-off Chromium ERR_NETWORK_CHANGED
      // recoverable without creating a second Checkout claim or user intent.
      await openHostedCheckout(page, redirect.url);
      assertTestModeCheckout(page.url());
      await fillCheckoutIdentity(page);
    });

    await test.step("a real declined payment never grants entitlement", async () => {
      await fillCheckoutCard(page, DECLINED_TEST_CARD);
      await submitCheckout(page);
      await expect
        .poll(() => hasVisibleTextAcrossFrames(page, /card (?:was|has been) declined|declined/i), {
          timeout: 45_000,
          intervals: [250, 500, 1_000],
          message: "waiting for Stripe Checkout to show the test decline",
        })
        .toBe(true);
      assertTestModeCheckout(page.url());

      const afterDecline = await loadAccountProjection(accountPage, baseURL);
      expect(afterDecline.plan_key).toBe("free");
      expect(afterDecline.credits.balance).toBe(0);
      expect(afterDecline.entitlements_enforceable).toBe(false);
    });

    await test.step("decline remains effect-free across the DB stability barrier", async () => {
      await verifyDeclineStability();
    });

    await test.step("the same Checkout completes a real test 3DS challenge", async () => {
      await fillCheckoutCard(page, SCA_TEST_CARD);
      await submitCheckout(page);
      await completeScaChallenge(page);
      const frontendOrigin = new URL(baseURL).origin;
      await page.waitForURL(
        (url) =>
          url.origin === frontendOrigin && url.pathname === "/billing/success",
        { timeout: 90_000 },
      );
    });

    await test.step("signed webhooks become the only success authority", async () => {
      await waitForPaidProjection(accountPage, baseURL);
      await page.goto(page.url());
      await expect(
        page.getByRole("heading", { name: "Webhook-backed account state is ready" }),
      ).toBeVisible();

      await accountPage.goto(frontendUrl(baseURL, "/account"));
      const subscription = accountPage.locator(".account-card").filter({
        has: accountPage.getByText("Subscription", { exact: true }),
      });
      await expect(subscription.getByRole("heading", { name: "Starter" })).toBeVisible();
      await expect(subscription.getByText("active", { exact: true })).toBeVisible();
      const credits = accountPage.locator(".account-card").filter({
        has: accountPage.getByText("Credits", { exact: true }),
      });
      await expect(credits.getByText("300", { exact: true }).first()).toBeVisible();
    });

    await test.step("browser previews and confirms the configured real upgrade template", async () => {
      await prepareUpgradePaymentMethod();
      await openPricingThroughExpectedBackend(accountPage, baseURL, backendURL);
      await clickAfterUserScroll(
        accountPage.getByRole("button", { name: "Choose Pro month" }),
      );
      const policy = process.env.E2E_TRANSITION_POLICY;
      if (policy === "prorated_delta") {
        await expect(
          accountPage.getByRole("heading", {
            name: "Pay the prorated difference for this period",
          }),
        ).toBeVisible();
        await expect(
          accountPage.locator(".timing-panel").filter({ hasText: "700 credits" }),
        ).toBeVisible();
      } else {
        await expect(
          accountPage.getByRole("heading", {
            name: "This change requires immediate settlement",
          }),
        ).toBeVisible();
      }
      await accountPage.getByRole("checkbox").check();
      await accountPage
        .getByRole("button", { name: "Confirm billing change" })
        .click();
      if (
        (process.env.E2E_UPGRADE_PAYMENT_METHOD ??
          "pm_card_authenticationRequired") === "pm_card_authenticationRequired"
      ) {
        await completeScaChallenge(accountPage);
      }
      await accountPage.waitForURL(
        (url) => url.pathname === "/billing/success",
        { timeout: 90_000 },
      );
    });

    await test.step("upgrade access still waits for its paid webhook projection", async () => {
      await waitForPaidProjection(page, baseURL, "pro", 1000, 1000);
      await accountPage.goto(accountPage.url());
      await expect(
        accountPage.getByRole("heading", { name: "Webhook-backed account state is ready" }),
      ).toBeVisible();
      await page.goto(frontendUrl(baseURL, "/account"));
      const subscription = page.locator(".account-card").filter({
        has: page.getByText("Subscription", { exact: true }),
      });
      await expect(subscription.getByRole("heading", { name: "Pro" })).toBeVisible();
      const credits = page.locator(".account-card").filter({
        has: page.getByText("Credits", { exact: true }),
      });
      await expect(credits.getByText("1,000", { exact: true }).first()).toBeVisible();
    });
  });
});
