import {
  expect,
  test,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
  type Response,
} from "@playwright/test";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isExactBackendApiRequest,
  optionalE2EBearerToken,
  withE2EBackendAuthorization,
} from "../lib/e2e-backend-auth";
import { E2E_ROUTE_AUTH_SENTINEL } from "../lib/auth";
import { parseExactCreditAmount } from "../lib/credit-amount";

const DECLINED_TEST_CARD = "4000000000000002";
const SCA_TEST_CARD = "4000002500003155";
const SUCCESS_TEST_CARD = "4242424242424242";
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
    balance: string;
    balance_atoms: string;
    subscription_balance: string;
    subscription_balance_atoms: string;
    purchased_balance: string;
    purchased_balance_atoms: string;
    grant_amount: string;
    grant_amount_atoms: string;
    scale: 1_000_000;
    credit_packs: Array<{
      lot_id: string;
      pack_key: string;
      checkout_session_id: string;
      remaining: string;
      remaining_atoms: string;
      expires_at: string;
    }>;
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
  session_id?: string;
}

interface PortalRedirect {
  url: string;
  session_id: string;
}

interface CreditOperationEvidence {
  outcome: "charged" | "refunded" | "replayed" | "epoch_expired";
  balance: string;
  balance_atoms: string;
  requested: string;
  requested_atoms: string;
  restored: string;
  restored_atoms: string;
  scale: 1_000_000;
}

interface ProductJobEvidence {
  job_status: "succeeded" | "failed_refunded";
  entitlement: {
    allowed: boolean;
    plan_key: string;
    credits: { balance: string; balance_atoms: string; scale: 1_000_000 };
  };
  charge: CreditOperationEvidence;
  refund: CreditOperationEvidence | null;
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

function recordingEnabled(): boolean {
  return process.env.E2E_RECORD_VIDEO === "1";
}

async function demoPause(page: Page, multiplier = 1): Promise<void> {
  const milliseconds = Number(process.env.E2E_DEMO_PAUSE_MS ?? "0");
  if (milliseconds > 0) {
    await page.waitForTimeout(milliseconds * multiplier);
  }
}

function safeTimelineUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.hostname === "stripe.com" || url.hostname.endsWith(".stripe.com")) {
      return `${url.origin}/[stripe-hosted-page]`;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return "about:blank";
  }
}

async function installRecordingCaptureStyles(page: Page): Promise<void> {
  if (!recordingEnabled()) return;
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.dataset.promoCapture = "true";
      style.textContent = `
        .demo-notice { display: none !important; }
        html { scroll-behavior: smooth !important; }
        * { caret-color: transparent !important; }
      `;
      document.head.append(style);
    });
  });
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
  page: Page,
  backendURL: string,
): Promise<void> {
  const response = await page.goto(new URL("/health", backendURL).toString(), {
    waitUntil: "domcontentloaded",
  });
  if (!response || !response.ok()) {
    throw new Error(
      `Backend /health returned HTTP ${response?.status() ?? "no response"}.`,
    );
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

async function installBackendAuthentication(
  context: BrowserContext,
  backendURL: string,
  token: string | undefined,
): Promise<void> {
  if (!token) return;
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (
      request.method() === "OPTIONS" ||
      !isExactBackendApiRequest(request.url(), backendURL)
    ) {
      await route.continue();
      return;
    }
    const response = await route.fetch({
      headers: withE2EBackendAuthorization(request.headers(), token),
      maxRedirects: 0,
    });
    await route.fulfill({ response });
  });
}

async function browserBackendPost<T>(
  page: Page,
  backendURL: string,
  path: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const target = new URL(path, backendURL);
  if (target.origin !== new URL(backendURL).origin || !target.pathname.startsWith("/api/")) {
    throw new Error("Refusing browser E2E POST outside the attested backend API.");
  }
  const result = await page.evaluate(
    async ({ url, body, sentinel }) => {
      const response = await fetch(url, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        headers: {
          authorization: `Bearer ${sentinel}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      return { status: response.status, ok: response.ok, parsed };
    },
    {
      url: target.toString(),
      body: payload,
      sentinel: E2E_ROUTE_AUTH_SENTINEL,
    },
  );
  if (!result.ok) {
    throw new Error(`Browser POST ${target.pathname} returned HTTP ${result.status}.`);
  }
  if (!result.parsed || typeof result.parsed !== "object") {
    throw new Error(`Browser POST ${target.pathname} returned an invalid JSON contract.`);
  }
  return result.parsed as T;
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


async function creditPackGate(
  command: "wait-captured" | "release" | "wait-forwarded",
): Promise<void> {
  const stateDir = process.env.E2E_WEBHOOK_GATE_STATE_DIR?.trim();
  if (!stateDir) {
    throw new Error("E2E_WEBHOOK_GATE_STATE_DIR is missing.");
  }
  const args = ["run", "python", "scripts/e2e_stripe.py"];
  let expectedOutput: string;
  if (command === "release") {
    args.push("release-credit-pack-gate", "--state-dir", stateDir);
    expectedOutput = "released the run-owned credit-pack webhook barrier";
  } else {
    const phase = command === "wait-captured" ? "captured" : "forwarded";
    args.push(
      "wait-credit-pack-gate",
      "--state-dir",
      stateDir,
      "--phase",
      phase,
      "--timeout-seconds",
      "60",
    );
    expectedOutput = `verified run-owned credit-pack webhook gate phase: ${phase}`;
  }
  await new Promise<void>((resolve, reject) => {
    execFile(
      "uv",
      args,
      {
        cwd: REPOSITORY_ROOT,
        env: process.env,
        timeout: 90_000,
        maxBuffer: 16 * 1024,
      },
      (error, stdout) => {
        if (error || !stdout.includes(expectedOutput)) {
          reject(new Error(`Credit-pack webhook gate command failed: ${command}.`));
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
  const navigation = await page.goto(frontendUrl(baseURL, "/pricing"), {
    waitUntil: "domcontentloaded",
  });
  if (navigation?.headers()["x-frontend-build-mode"] !== "production") {
    throw new Error(
      "Real browser E2E requires a production Next.js build served by next start.",
    );
  }
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

  // Checkout capture deliberately aborts the application's automatic navigation.
  // Chromium still updates page.url() before showing an empty aborted document, so
  // URL matching is not proof that hosted Checkout loaded. Always issue a fresh
  // navigation after the temporary route is removed.
  let lastError: unknown = new Error("Stripe Checkout navigation did not start.");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(checkoutUrl, { timeout: 45_000, waitUntil: "commit" });
      if (checkoutSessionId(page.url()) !== expectedSession) {
        throw new Error("Hosted Checkout opened a different Session identity.");
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await page.waitForTimeout(attempt * 500);
      }
    }
  }
  throw lastError;
}

async function prepareCheckoutCapture(
  page: Page,
  backendURL: string,
  token: string | undefined,
  endpointPath = "/api/checkout",
): Promise<{
  wait: () => Promise<CheckoutRedirect>;
  release: () => Promise<void>;
}> {
  let redirect: CheckoutRedirect | undefined;
  let captureError: unknown;
  const escapedPath = endpointPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const routePattern = new RegExp(`${escapedPath}(?:\\?.*)?$`, "u");
  const automaticCheckoutNavigation = /^https:\/\/checkout\.stripe\.com\//;

  // The application redirects immediately after receiving the Session URL. During
  // capture, abort only that automatic top-level navigation so Locator.click() does
  // not wait for a slow external page load. The trusted URL is opened explicitly
  // after both routes are removed.
  await page.route(automaticCheckoutNavigation, async (route) => {
    if (
      route.request().isNavigationRequest() &&
      route.request().frame() === page.mainFrame()
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

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
      const requestHeaders = token
        ? withE2EBackendAuthorization(route.request().headers(), token)
        : route.request().headers();
      const response = await route.fetch({
        headers: {
          ...requestHeaders,
          "x-stripe-mode-requirement": "test",
        },
        maxRedirects: 0,
      });
      const body = await response.text();
      let capturedRedirect: CheckoutRedirect | undefined;
      if (!response.ok()) {
        captureError = new Error(
          `POST ${endpointPath} returned HTTP ${response.status()}.`,
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
    release: async () => {
      await page.unroute(routePattern);
      await page.unroute(automaticCheckoutNavigation);
    },
  };
}

async function preparePortalCapture(
  page: Page,
  backendURL: string,
  token: string | undefined,
): Promise<{
  wait: () => Promise<PortalRedirect>;
  release: () => Promise<void>;
}> {
  let redirect: PortalRedirect | undefined;
  let captureError: unknown;
  const routePattern = /\/api\/billing\/portal(?:\?.*)?$/u;
  const automaticPortalNavigation = /^https:\/\/billing\.stripe\.com\//u;

  await page.route(automaticPortalNavigation, async (route) => {
    if (
      route.request().isNavigationRequest() &&
      route.request().frame() === page.mainFrame()
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await page.route(routePattern, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    try {
      if (new URL(route.request().url()).origin !== new URL(backendURL).origin) {
        throw new Error(
          "Refusing Portal POST: frontend write target does not match E2E_BACKEND_URL.",
        );
      }
      const response = await route.fetch({
        headers: token
          ? withE2EBackendAuthorization(route.request().headers(), token)
          : route.request().headers(),
        maxRedirects: 0,
      });
      const responseBody = await response.text();
      if (!response.ok()) {
        captureError = new Error(
          `POST /api/billing/portal returned HTTP ${response.status()}.`,
        );
      } else {
        redirect = JSON.parse(responseBody) as PortalRedirect;
      }
      await route.fulfill({ response, body: responseBody });
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
          { timeout: 60_000, message: "waiting for the Portal redirect response" },
        )
        .toBeTruthy();
      if (!redirect) throw new Error("The Portal response did not contain a redirect.");
      return redirect;
    },
    release: async () => {
      await page.unroute(routePattern);
      await page.unroute(automaticPortalNavigation);
    },
  };
}

function assertTestModePortal(redirect: PortalRedirect): void {
  if (!/^bps_[A-Za-z0-9_]+$/u.test(redirect.session_id)) {
    throw new Error("Stripe did not return a stable test Portal Session identity.");
  }
  const hosted = new URL(redirect.url);
  if (hosted.protocol !== "https:" || hosted.hostname !== "billing.stripe.com") {
    throw new Error("Portal redirect is not the real Stripe-hosted billing origin.");
  }
}

async function openHostedPortal(page: Page, redirect: PortalRedirect): Promise<void> {
  assertTestModePortal(redirect);
  let lastError: unknown = new Error("Stripe Portal navigation did not start.");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(redirect.url, { timeout: 45_000, waitUntil: "domcontentloaded" });
      const opened = new URL(page.url());
      if (opened.protocol !== "https:" || opened.hostname !== "billing.stripe.com") {
        throw new Error("Hosted Portal navigated outside billing.stripe.com.");
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await page.waitForTimeout(attempt * 500);
    }
  }
  throw lastError;
}

async function portalReturnLink(page: Page, expectedReturnURL: string): Promise<Locator> {
  const expected = new URL(expectedReturnURL).toString();
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const links = frame.locator("a[href]");
      const count = await links.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const link = links.nth(index);
        const href = await link.getAttribute("href").catch(() => null);
        if (!href || !(await link.isVisible().catch(() => false))) continue;
        try {
          if (new URL(href, frame.url()).toString() === expected) return link;
        } catch {
          // Ignore malformed unrelated links on the hosted page.
        }
      }
      for (const role of ["link", "button"] as const) {
        const returnControl = frame
          .getByRole(role, { name: /(?:return|back) to .+/i })
          .first();
        if (await returnControl.isVisible().catch(() => false)) return returnControl;
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error("Stripe Portal did not expose the configured return-to-account link.");
}

async function loadAccountProjection(
  page: Page,
  baseURL: string,
  backendURL: string,
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
  if (new URL(response.url()).origin !== new URL(backendURL).origin) {
    throw new Error(
      "Account projection response does not use the attested E2E backend origin.",
    );
  }
  const projection = (await response.json()) as AccountProjection;
  parseExactCreditAmount(
    projection.credits.balance,
    projection.credits.balance_atoms,
    projection.credits.scale,
  );
  const subscription = parseExactCreditAmount(
    projection.credits.subscription_balance,
    projection.credits.subscription_balance_atoms,
    projection.credits.scale,
  );
  const purchased = parseExactCreditAmount(
    projection.credits.purchased_balance,
    projection.credits.purchased_balance_atoms,
    projection.credits.scale,
  );
  const total = parseExactCreditAmount(
    projection.credits.balance,
    projection.credits.balance_atoms,
    projection.credits.scale,
  );
  let lotAtoms = 0n;
  for (const lot of projection.credits.credit_packs) {
    const remaining = parseExactCreditAmount(
      lot.remaining,
      lot.remaining_atoms,
      projection.credits.scale,
    );
    lotAtoms += BigInt(remaining.atoms);
  }
  if (
    BigInt(subscription.atoms) + BigInt(purchased.atoms) !== BigInt(total.atoms) ||
    lotAtoms !== BigInt(purchased.atoms)
  ) {
    throw new Error("Account projection returned inconsistent credit funding totals.");
  }
  parseExactCreditAmount(
    projection.credits.grant_amount,
    projection.credits.grant_amount_atoms,
    projection.credits.scale,
  );
  return projection;
}

async function waitForPaidProjection(
  page: Page,
  baseURL: string,
  backendURL: string,
  expectedPlan = "starter",
  expectedBalance = "300",
  expectedGrant = "300",
): Promise<AccountProjection> {
  let latest: AccountProjection | undefined;
  await expect
    .poll(
      async () => {
        try {
          latest = await loadAccountProjection(page, baseURL, backendURL);
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

async function waitForCreditPackProjection(
  page: Page,
  baseURL: string,
  backendURL: string,
  expectedSessionId: string,
): Promise<AccountProjection> {
  let latest: AccountProjection | undefined;
  await expect
    .poll(
      async () => {
        try {
          latest = await loadAccountProjection(page, baseURL, backendURL);
          const lot = latest.credits.credit_packs.find(
            (candidate) =>
              candidate.pack_key === "boost-100" &&
              candidate.checkout_session_id === expectedSessionId,
          );
          return {
            plan_key: latest.plan_key,
            subscription_balance: latest.credits.subscription_balance,
            purchased_balance: latest.credits.purchased_balance,
            total_balance: latest.credits.balance,
            pack_count: latest.credits.credit_packs.length,
            pack_remaining: lot?.remaining ?? null,
            exact_session: lot?.checkout_session_id ?? null,
          };
        } catch {
          return null;
        }
      },
      {
        timeout: timeoutFromEnvironment(),
        intervals: [250, 500, 1_000, 2_000],
        message:
          "waiting for the signed payment_intent.succeeded credit-pack projection",
      },
    )
    .toEqual({
      plan_key: "pro",
      subscription_balance: "1000",
      purchased_balance: "100",
      total_balance: "1100",
      pack_count: 1,
      pack_remaining: "100",
      exact_session: expectedSessionId,
    });
  if (!latest) throw new Error("The credit-pack account projection was not captured.");
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
  const visibleCheckbox = async (name: RegExp, timeout: number) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        const checkbox = frame.getByRole("checkbox", { name }).first();
        if (await checkbox.isVisible().catch(() => false)) return checkbox;
      }
      await page.waitForTimeout(100);
    }
    return null;
  };

  for (const [name, timeout] of [
    /I am an AI agent acting on behalf of someone else/i,
    /I am an AI agent and have followed the instructions above/i,
  ].map((name, index) => [name, index === 0 ? 3_000 : 2_000] as const)) {
    const checkbox = await visibleCheckbox(name, timeout);
    if (checkbox && !(await checkbox.isChecked().catch(() => false))) {
      // Stripe positions the precisely named native input outside the viewport and
      // renders a custom control. Native click() applies the checkbox's real default
      // action inside its own frame without relying on impossible screen coordinates.
      await checkbox.evaluate((element: HTMLInputElement) => element.click());
      await expect(checkbox).toBeChecked();
    }
  }
}

async function selectCardPaymentMethodIfPresented(page: Page): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // Search every frame for the method selector before accepting any card-like
    // input. Express Checkout/Wallet iframes can expose their own visible fields
    // while the main payment-method radio is still waiting for user selection.
    for (const frame of page.frames()) {
      const card = frame.getByRole("radio", { name: /^Card$/i }).first();
      if (!(await card.isVisible().catch(() => false))) continue;
      if (!(await card.isChecked().catch(() => false))) {
        // Stripe deliberately overlays the native radio with its accordion action.
        // Use that public accessible control instead of forcing a click through it.
        const cardAction = frame
          .getByRole("button", { name: /^Pay with card$/i })
          .first();
        if (await cardAction.isVisible().catch(() => false)) {
          await cardAction.click();
          await page.waitForTimeout(250);
        }
        if (!(await card.isChecked().catch(() => false))) {
          await card.focus();
          await card.press("Space");
          await page.waitForTimeout(250);
        }
        if (!(await card.isChecked().catch(() => false))) {
          // The accordion cover can consume the action without changing the
          // underlying native radio in some Sandbox layouts. Native click() runs
          // the real input default action and its framework change listeners.
          await card.evaluate((element: HTMLInputElement) => element.click());
        }
        // Stripe's controlled accordion does not consistently expose the native
        // radio's checked property. The required, fillable card form below is the
        // observable success condition; an internal implementation flag is not.
      }
      return;
    }
    for (const frame of page.frames()) {
      const directCardField = frame
        .locator(
          'input[name="cardNumber"], input[data-elements-stable-field-name="cardNumber"], input[autocomplete="cc-number"]',
        )
        .first();
      if (await directCardField.isVisible().catch(() => false)) return;
    }
    await page.waitForTimeout(100);
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

async function submitCreditPackCheckout(
  page: Page,
  frontendOrigin: string,
): Promise<void> {
  await fillCheckoutIdentity(page);
  // Stripe Sandbox can gate payment-method accordion state behind its agent
  // disclosure. Acknowledge that state before selecting Card; submitCheckout
  // repeats the check immediately before payment as an idempotent safety net.
  await acknowledgeAgentAutomation(page);
  // Payment-mode Checkout can expose multiple methods even when subscription
  // Checkout previously showed card fields directly. Select the explicit Card
  // branch before looking for its lazily rendered fields.
  await selectCardPaymentMethodIfPresented(page);
  let cardNumber = await optionalVisibleLocatorAcrossFrames(
    page,
    [
      'input[name="cardNumber"]',
      'input[data-elements-stable-field-name="cardNumber"]',
      'input[autocomplete="cc-number"]',
      'input[aria-label*="Card number" i]',
    ],
    10_000,
  );
  if (!cardNumber) {
    for (const frame of page.frames()) {
      const addCard = frame
        .getByRole("button", {
          name: /add (?:a )?(?:new )?payment method|use (?:a )?different card|new card/i,
        })
        .first();
      if (await addCard.isVisible().catch(() => false)) {
        await addCard.click();
        cardNumber = await optionalVisibleLocatorAcrossFrames(
          page,
          [
            'input[name="cardNumber"]',
            'input[data-elements-stable-field-name="cardNumber"]',
            'input[autocomplete="cc-number"]',
            'input[aria-label*="Card number" i]',
          ],
          10_000,
        );
        break;
      }
    }
  }
  if (cardNumber) {
    await fillCheckoutCard(page, SUCCESS_TEST_CARD);
  } else {
    throw new Error(
      "Credit-pack Checkout did not expose the selected Card payment form.",
    );
  }
  await submitCheckout(page);

  const outcomeDeadline = Date.now() + 60_000;
  let challengeVisible = false;
  while (Date.now() < outcomeDeadline) {
    const current = new URL(page.url());
    if (current.origin === frontendOrigin && current.pathname === "/billing/success") {
      return;
    }
    challengeVisible = page
      .frames()
      .some((frame) => isStripeChallengeFrame(frame, page));
    if (challengeVisible) break;
    await page.waitForTimeout(200);
  }
  if (!challengeVisible) {
    throw new Error("Credit-pack Checkout neither returned nor opened a 3DS challenge.");
  }
  await completeScaChallenge(page);
  await page.waitForURL(
    (url) => url.origin === frontendOrigin && url.pathname === "/billing/success",
    { timeout: 90_000 },
  );
}

async function hasVisibleTextAcrossFrames(page: Page, pattern: RegExp): Promise<boolean> {
  for (const frame of page.frames()) {
    const matches = frame.getByText(pattern);
    const count = await matches.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (await matches.nth(index).isVisible().catch(() => false)) return true;
    }
  }
  return false;
}

async function completeScaChallenge(
  page: Page,
  onChallengeReady?: () => Promise<void>,
): Promise<void> {
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
  if (onChallengeReady) {
    await onChallengeReady();
  } else {
    await demoPause(page);
  }
  // The sandbox button can render before challenge.js attaches its listener. Observe
  // the ACS response when Chromium exposes it, but use challenge-frame detachment as
  // the cross-version completion invariant and retry the enabled test button narrowly.
  let acsResponseStatus: number | null = null;
  const observeAcsResponse = (response: Response) => {
    try {
      const url = new URL(response.url());
      const stripeAcsHost =
        url.hostname === "testmode-acs.stripe.com" ||
        (url.hostname.endsWith(".stripe.com") &&
          /3d[_-]?secure|3ds|authenticate|challenge|acs/i.test(
            `${url.pathname}${url.search}`,
          ));
      if (response.request().method() === "POST" && stripeAcsHost) {
        acsResponseStatus = response.status();
      }
    } catch {
      // Ignore unrelated malformed URLs; the frame-detachment invariant remains.
    }
  };
  page.on("response", observeAcsResponse);
  try {
    const completionDeadline = Date.now() + 30_000;
    let clickAttempts = 0;
    while (page.frames().includes(challengeFrame) && Date.now() < completionDeadline) {
      const enabled = await button.isEnabled().catch(() => false);
      const visible = await button.isVisible().catch(() => false);
      if (enabled && visible && clickAttempts < 3) {
        await button.click();
        clickAttempts += 1;
      }
      if (page.frames().includes(challengeFrame)) {
        await page.waitForTimeout(750);
      }
    }
    await expect
      .poll(() => page.frames().includes(challengeFrame), {
        timeout: 1_000,
        message: "waiting for the completed Stripe 3DS frame to detach",
      })
      .toBe(false);
  } finally {
    page.off("response", observeAcsResponse);
  }
  if (acsResponseStatus !== null && acsResponseStatus >= 400) {
    throw new Error(`Stripe test ACS completion returned HTTP ${acsResponseStatus}.`);
  }
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
    baseURL,
  }, testInfo) => {
    if (!baseURL) throw new Error("Playwright baseURL is missing.");
    const backendURL = process.env.E2E_BACKEND_URL?.trim();
    if (!backendURL) throw new Error("E2E_BACKEND_URL is missing.");
    const personalBearerToken = optionalE2EBearerToken(
      process.env.E2E_PERSONAL_BEARER_TOKEN,
    );
    const fullStackEvidence = process.env.E2E_FULL_STACK_EVIDENCE === "1";
    if (fullStackEvidence && !personalBearerToken) {
      throw new Error("E2E_PERSONAL_BEARER_TOKEN is required for the Personal Auth gate.");
    }
    const successJobKey = process.env.E2E_JOB_SUCCESS_KEY?.trim() ?? "";
    const failureJobKey = process.env.E2E_JOB_FAILURE_KEY?.trim() ?? "";
    if (
      fullStackEvidence &&
      (!successJobKey || !failureJobKey || successJobKey === failureJobKey)
    ) {
      throw new Error("Distinct browser E2E product Job operation keys are required.");
    }
    const webhookGateEnabled = Boolean(
      process.env.E2E_WEBHOOK_GATE_STATE_DIR?.trim(),
    );
    await installBackendAuthentication(context, backendURL, personalBearerToken);

    const recordingStartedAt = Date.now();
    const timeline: Array<{ label: string; milliseconds: number; url: string }> = [];
    let screenshotSequence = 0;
    const mark = async (
      targetPage: Page,
      label: string,
      multiplier = 1,
      screenshotName?: string,
    ) => {
      timeline.push({
        label,
        milliseconds: Date.now() - recordingStartedAt,
        url: safeTimelineUrl(targetPage.url()),
      });
      if (recordingEnabled() && screenshotName) {
        screenshotSequence += 1;
        const screenshotPath = testInfo.outputPath(
          `${String(screenshotSequence).padStart(2, "0")}-${screenshotName}.png`,
        );
        let captured = false;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await targetPage.screenshot({
              animations: "disabled",
              path: screenshotPath,
            });
            captured = true;
            break;
          } catch (error) {
            if (targetPage.isClosed()) throw error;
            await targetPage.waitForTimeout(250 * attempt);
          }
        }
        if (!captured) {
          console.warn(`promo milestone screenshot was not captured: ${screenshotName}`);
        }
      }
      await demoPause(targetPage, multiplier);
    };
    await installRecordingCaptureStyles(page);

    await test.step("backend attests Stripe test mode before any state write", async () => {
      await verifyTestBackend(page, backendURL);
    });

    await test.step("frontend read traffic is bound to the attested backend", async () => {
      await openPricingThroughExpectedBackend(page, baseURL, backendURL);
    });
    await mark(page, "Pricing page · Free account", 0.75, "pricing-free");

    const accountPage = await context.newPage();
    await installRecordingCaptureStyles(accountPage);
    const initial = await loadAccountProjection(accountPage, baseURL, backendURL);
    expect(initial.account_id).toBe(await expectedAccountId());
    expect(initial.plan_key).toBe("free");
    expect(initial.credits.balance).toBe("0");
    expect(initial.entitlements_enforceable).toBe(false);
    await mark(accountPage, "Free account · zero credits", 1.25, "free-account");

    let initialCheckoutSessionId = "";

    await test.step("open a verifiably test-mode hosted Checkout", async () => {
      await expect(page.getByRole("heading", { name: "Starter" })).toBeVisible();
      const capture = await prepareCheckoutCapture(
        page,
        backendURL,
        personalBearerToken,
      );
      await clickAfterUserScroll(
        page.getByRole("button", { name: "Choose Starter month" }),
        { noWaitAfter: true },
      );
      const redirect = await capture.wait();
      await capture.release();
      assertTestModeCheckout(redirect.url);
      const redirectSessionId = checkoutSessionId(redirect.url);
      if (!redirectSessionId) {
        throw new Error("The captured test Checkout URL has no Session identity.");
      }

      // The application already calls location.assign(). Navigating explicitly to the
      // same server-authoritative URL makes a one-off Chromium ERR_NETWORK_CHANGED
      // recoverable without creating a second Checkout claim or user intent.
      await openHostedCheckout(page, redirect.url);
      assertTestModeCheckout(page.url());
      expect(checkoutSessionId(page.url())).toBe(redirectSessionId);
      initialCheckoutSessionId = redirectSessionId;
      await fillCheckoutIdentity(page);
      await mark(page, "Real Stripe test Checkout", 1.5);
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
      expect(checkoutSessionId(page.url())).toBe(initialCheckoutSessionId);

      const afterDecline = await loadAccountProjection(
        accountPage,
        baseURL,
        backendURL,
      );
      expect(afterDecline.plan_key).toBe("free");
      expect(afterDecline.credits.balance).toBe("0");
      expect(afterDecline.entitlements_enforceable).toBe(false);
      await mark(page, "Declined payment · access unchanged", 1.5);
    });

    await test.step("decline remains effect-free across the DB stability barrier", async () => {
      await verifyDeclineStability();
    });

    await test.step("the same Checkout completes a real test 3DS challenge", async () => {
      expect(initialCheckoutSessionId).toMatch(/^cs_test_/);
      expect(checkoutSessionId(page.url())).toBe(initialCheckoutSessionId);
      await fillCheckoutCard(page, SCA_TEST_CARD);
      await submitCheckout(page);
      await completeScaChallenge(page, () =>
        mark(page, "Checkout 3DS challenge", 1.25),
      );
      const frontendOrigin = new URL(baseURL).origin;
      await page.waitForURL(
        (url) =>
          url.origin === frontendOrigin && url.pathname === "/billing/success",
        { timeout: 90_000 },
      );
    });

    await test.step("signed webhooks become the only success authority", async () => {
      await waitForPaidProjection(accountPage, baseURL, backendURL);
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
      await mark(
        page,
        "Webhook-backed Checkout success",
        1.25,
        "checkout-success",
      );
      await mark(
        accountPage,
        "Starter Monthly · 300 credits",
        1.5,
        "starter-300-credits",
      );
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
      await mark(
        accountPage,
        policy === "prorated_delta"
          ? "Prorated delta · +700 entitlement credits"
          : "Full-period reset · new funded period",
        1.75,
        policy === "prorated_delta"
          ? "prorated-delta-preview"
          : "full-period-preview",
      );
      await accountPage.getByRole("checkbox").check();
      await accountPage
        .getByRole("button", { name: "Confirm billing change" })
        .click();
      if (
        (process.env.E2E_UPGRADE_PAYMENT_METHOD ??
          "pm_card_authenticationRequired") === "pm_card_authenticationRequired"
      ) {
        await completeScaChallenge(accountPage, () =>
          mark(accountPage, "Upgrade 3DS challenge", 1.25),
        );
      }
      await accountPage.waitForURL(
        (url) => url.pathname === "/billing/success",
        { timeout: 90_000 },
      );
    });

    await test.step("upgrade access still waits for its paid webhook projection", async () => {
      await waitForPaidProjection(
        page,
        baseURL,
        backendURL,
        "pro",
        "1000",
        "1000",
      );
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
      await mark(
        accountPage,
        "Webhook-backed upgrade success",
        1.25,
        "upgrade-success",
      );
      await mark(
        page,
        "Pro Monthly · 1,000 credits",
        1.75,
        "pro-1000-credits",
      );
    });

    let packSessionId = "";
    await test.step("buy Boost 100 through a real payment-mode Checkout", async () => {
      await openPricingThroughExpectedBackend(page, baseURL, backendURL);
      const capture = await prepareCheckoutCapture(
        page,
        backendURL,
        personalBearerToken,
        "/api/credit-packs/checkout",
      );
      await clickAfterUserScroll(
        page.getByRole("button", { name: "Buy Boost 100" }),
        { noWaitAfter: true },
      );
      const redirect = await capture.wait();
      await capture.release();
      assertTestModeCheckout(redirect.url);
      const redirectSessionId = checkoutSessionId(redirect.url);
      if (
        !redirectSessionId ||
        !redirect.session_id ||
        redirect.session_id !== redirectSessionId
      ) {
        throw new Error(
          "Credit-pack API response and hosted URL do not bind the same test Session.",
        );
      }
      packSessionId = redirectSessionId;
      await openHostedCheckout(page, redirect.url);
      expect(checkoutSessionId(page.url())).toBe(packSessionId);
      await mark(page, "Real Stripe · Boost 100 one-time Checkout", 1.25);
      await submitCreditPackCheckout(page, new URL(baseURL).origin);

      const returnUrl = new URL(page.url());
      expect(returnUrl.searchParams.get("expected_credit_pack")).toBe("boost-100");
      expect(returnUrl.searchParams.get("checkout_session_id")).toBe(packSessionId);
    });

    await test.step("the return page cannot grant before the signed pack webhook", async () => {
      if (!webhookGateEnabled) return;
      await creditPackGate("wait-captured");
      await expect(
        page.getByRole("heading", { name: "Waiting for webhook confirmation" }),
      ).toBeVisible();
      const beforeSignedProjection = await loadAccountProjection(
        accountPage,
        baseURL,
        backendURL,
      );
      expect(beforeSignedProjection.plan_key).toBe("pro");
      expect(beforeSignedProjection.credits.subscription_balance).toBe("1000");
      expect(beforeSignedProjection.credits.purchased_balance).toBe("0");
      expect(beforeSignedProjection.credits.balance).toBe("1000");
      expect(
        beforeSignedProjection.credits.credit_packs.some(
          (lot) => lot.checkout_session_id === packSessionId,
        ),
      ).toBe(false);
      await creditPackGate("release");
      await creditPackGate("wait-forwarded");
    });

    await test.step("only the exact Session's PaymentIntent projection adds 100", async () => {
      await waitForCreditPackProjection(
        accountPage,
        baseURL,
        backendURL,
        packSessionId,
      );
      const retryProjection = page.getByRole("button", {
        name: "Check account state again",
      });
      if (await retryProjection.isVisible().catch(() => false)) {
        await retryProjection.click();
      }
      await expect(
        page.getByRole("heading", { name: "Webhook-backed account state is ready" }),
      ).toBeVisible();
      await accountPage.goto(frontendUrl(baseURL, "/account"));
      const credits = accountPage.locator(".account-card").filter({
        has: accountPage.getByText("Credits", { exact: true }),
      });
      await expect(credits.getByText("1,100", { exact: true })).toBeVisible();
      await expect(credits.getByText("boost-100", { exact: true })).toBeVisible();
      await expect(credits.getByText("100 credits", { exact: true })).toBeVisible();
      await mark(
        page,
        "Signed PaymentIntent · exact Session confirmed",
        1.25,
        "pack-success",
      );
      await mark(
        accountPage,
        "Pro 1,000 + Boost 100 · 1,100 total",
        1.5,
        "pro-plus-boost-100",
      );
    });

    await test.step("open the owner-bound real Stripe Portal and return to account", async () => {
      await accountPage.goto(frontendUrl(baseURL, "/account"));
      const capture = await preparePortalCapture(
        accountPage,
        backendURL,
        personalBearerToken,
      );
      await clickAfterUserScroll(
        accountPage.getByRole("button", { name: "Open Stripe Billing Portal" }),
        { noWaitAfter: true },
      );
      const redirect = await capture.wait();
      await capture.release();
      assertTestModePortal(redirect);
      if (fullStackEvidence) {
        const evidence = await browserBackendPost<{
          verified: boolean;
          session_id: string;
          personal_jwks_verified: boolean;
        }>(accountPage, backendURL, "/api/e2e/portal-evidence", {
          session_id: redirect.session_id,
        });
        expect(evidence).toEqual({
          verified: true,
          session_id: redirect.session_id,
          personal_jwks_verified: true,
        });
      }

      await openHostedPortal(accountPage, redirect);
      await mark(accountPage, "Real Stripe Billing Portal · owner-bound Session", 1.25);
      const expectedReturnURL = frontendUrl(baseURL, "/account");
      const returnLink = await portalReturnLink(accountPage, expectedReturnURL);
      await returnLink.click();
      await accountPage.waitForURL(
        (url) => url.toString() === new URL(expectedReturnURL).toString(),
        { timeout: 60_000 },
      );
      const returned = await loadAccountProjection(accountPage, baseURL, backendURL);
      expect(returned.plan_key).toBe("pro");
      expect(returned.credits.balance).toBe("1100");
      await mark(
        accountPage,
        "Portal return · webhook-backed account unchanged",
        1.25,
        "portal-return",
      );
    });

    await test.step("a user-triggered product Job charges through signed workload auth", async () => {
      if (!fullStackEvidence) return;
      const result = await browserBackendPost<ProductJobEvidence>(
        page,
        backendURL,
        "/api/e2e/jobs",
        {
          operation_key: successJobKey,
          amount: "80",
          scenario: "success",
        },
      );
      expect(result.job_status).toBe("succeeded");
      expect(result.entitlement.allowed).toBe(true);
      expect(result.entitlement.plan_key).toBe("pro");
      expect(result.entitlement.credits.balance).toBe("1100");
      expect(result.charge).toMatchObject({
        outcome: "charged",
        balance: "1020",
        requested: "80",
        restored: "0",
        scale: 1_000_000,
      });
      expect(result.refund).toBeNull();

      const projection = await loadAccountProjection(
        accountPage,
        baseURL,
        backendURL,
      );
      expect(projection.credits.subscription_balance).toBe("920");
      expect(projection.credits.purchased_balance).toBe("100");
      expect(projection.credits.balance).toBe("1020");

      const replay = await browserBackendPost<ProductJobEvidence>(
        page,
        backendURL,
        "/api/e2e/jobs",
        {
          operation_key: successJobKey,
          amount: "80",
          scenario: "success",
        },
      );
      expect(replay.charge).toMatchObject({
        outcome: "replayed",
        balance: "1020",
        requested: "80",
      });
      await mark(accountPage, "Product Job · 80-credit owner-bound charge", 1.25);
    });

    await test.step("a terminal product failure refunds the exact original debit", async () => {
      if (!fullStackEvidence) return;
      const result = await browserBackendPost<ProductJobEvidence>(
        page,
        backendURL,
        "/api/e2e/jobs",
        {
          operation_key: failureJobKey,
          amount: "20",
          scenario: "terminal_failure",
        },
      );
      expect(result.job_status).toBe("failed_refunded");
      expect(result.charge).toMatchObject({
        outcome: "charged",
        balance: "1000",
        requested: "20",
      });
      expect(result.refund).toMatchObject({
        outcome: "refunded",
        balance: "1020",
        requested: "20",
        restored: "20",
      });

      const finalProjection = await loadAccountProjection(
        accountPage,
        baseURL,
        backendURL,
      );
      expect(finalProjection.plan_key).toBe("pro");
      expect(finalProjection.entitlements_enforceable).toBe(true);
      expect(finalProjection.credits.subscription_balance).toBe("920");
      expect(finalProjection.credits.purchased_balance).toBe("100");
      expect(finalProjection.credits.balance).toBe("1020");
      await accountPage.goto(frontendUrl(baseURL, "/account"));
      const credits = accountPage.locator(".account-card").filter({
        has: accountPage.getByText("Credits", { exact: true }),
      });
      await expect(credits.getByText("1,020", { exact: true })).toBeVisible();
      await expect(credits.getByText("100 credits", { exact: true })).toBeVisible();
      await mark(
        accountPage,
        "Failed Job refunded · 1,020 credits remain",
        1.5,
        "job-charge-refund",
      );
    });

    writeFileSync(
      testInfo.outputPath("timeline.json"),
      `${JSON.stringify(
        {
          duration_ms: Date.now() - recordingStartedAt,
          transition_policy: process.env.E2E_TRANSITION_POLICY,
          timeline,
        },
        null,
        2,
      )}\n`,
    );
  });
});
