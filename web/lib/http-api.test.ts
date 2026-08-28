import { describe, expect, it, vi } from "vitest";
import {
  createHttpBillingApi,
  normalizeBillingApiBaseUrl,
} from "@/lib/http-api";
import { CREDIT_SCALE, creditAmountFromAtoms } from "@/lib/credit-amount";
import { demoAccount, demoCatalog } from "@/lib/mock-api";
import type { AuthAdapter } from "@/lib/auth";

const auth: AuthAdapter = {
  kind: "production",
  async getAccessToken() {
    return "verified-session-token";
  },
};

const validPreview = {
  preview_id: "preview-1",
  current_plan_key: "starter",
  current_interval: "month",
  target_plan_key: "pro",
  target_interval: "year",
  timing: "immediate",
  transition_policy: "full_period_reset",
  settlement_mode: "new_period_full_price",
  effective_at: "2026-07-31T00:00:00Z",
  currency: "USD",
  amount_due_now: 100,
  credit_applied: 0,
  entitlement_credit_delta: null,
  entitlement_credit_delta_atoms: null,
  credit_scale: CREDIT_SCALE,
  next_invoice_amount: 35300,
};

describe("HTTP billing API", () => {
  it.each([
    ["checkout", "/api/checkout"],
    ["preview", "/api/billing/change/preview"],
  ] as const)("sends a caller-provided idempotency key for %s", async (kind, path) => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify(
          kind === "checkout"
            ? { url: "https://checkout.stripe.test/session" }
            : validPreview,
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const api = createHttpBillingApi({
      baseUrl: "https://billing-api.example",
      auth,
      fetchImpl,
    });

    if (kind === "checkout") {
      await api.createCheckout(
        {
          plan_key: "starter",
          interval: "month",
          success_url: "https://app.example/billing/success",
          cancel_url: "https://app.example/pricing",
        },
        { idempotencyKey: "same-user-intent" },
      );
    } else {
      await api.previewPlanChange(
        { plan_key: "pro", interval: "year" },
        { idempotencyKey: "same-user-intent" },
      );
    }

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://billing-api.example${path}`,
      expect.objectContaining({
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          Authorization: "Bearer verified-session-token",
          "Idempotency-Key": "same-user-intent",
        }),
      }),
    );
  });

  it("sends a caller-provided idempotency key for Portal", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ url: "https://billing.stripe.com/p/session/test" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const api = createHttpBillingApi({
      baseUrl: "https://billing-api.example",
      auth,
      fetchImpl,
    });

    await api.createPortal("https://app.example/account", {
      idempotencyKey: "same-portal-intent",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://billing-api.example/api/billing/portal",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ return_url: "https://app.example/account" }),
        headers: expect.objectContaining({
          Authorization: "Bearer verified-session-token",
          "Idempotency-Key": "same-portal-intent",
        }),
      }),
    );
  });

  it("uses the backend's six canonical API paths", async () => {
    const fetchImpl = vi.fn(async (request: RequestInfo | URL) => {
      const path = new URL(request.toString()).pathname;
      const body = path.endsWith("/api/catalog")
        ? demoCatalog()
        : path.endsWith("/api/account")
          ? demoAccount()
          : path.endsWith("/api/billing/change/preview")
            ? validPreview
            : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const api = createHttpBillingApi({
      baseUrl: "https://billing-api.example/root/",
      auth,
      fetchImpl,
    });

    await api.getCatalog();
    await api.getAccount();
    await api.createCheckout({
      plan_key: "starter",
      interval: "month",
      success_url: "https://app.example/billing/success",
      cancel_url: "https://app.example/pricing",
    });
    await api.createPortal("https://app.example/account");
    await api.previewPlanChange({ plan_key: "pro", interval: "year" });
    await api.confirmPlanChange({ preview_id: "preview-1" });

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => url)).toEqual([
      "https://billing-api.example/root/api/catalog",
      "https://billing-api.example/root/api/account",
      "https://billing-api.example/root/api/checkout",
      "https://billing-api.example/root/api/billing/portal",
      "https://billing-api.example/root/api/billing/change/preview",
      "https://billing-api.example/root/api/billing/change/confirm",
    ]);
  });

  it.each([
    ["https://user:password@billing.example", "credentials"],
    ["https://billing.example?token=value", "query"],
    ["javascript:alert(1)", "HTTPS"],
    ["http://billing.example", "HTTPS"],
  ])("rejects an unsafe API base URL: %s", (url, message) => {
    expect(() => normalizeBillingApiBaseUrl(url, "production")).toThrow(message);
  });

  it("allows loopback HTTP only outside production", () => {
    expect(normalizeBillingApiBaseUrl("http://127.0.0.1:8000/", "test")).toBe(
      "http://127.0.0.1:8000",
    );
    expect(() =>
      normalizeBillingApiBaseUrl("http://127.0.0.1:8000", "production"),
    ).toThrow("HTTPS");
  });

  it.each([0, -1, 1.5, 120_001])(
    "rejects an invalid HTTP timeout: %s",
    (timeoutMs) => {
      expect(() =>
        createHttpBillingApi({
          baseUrl: "https://billing-api.example",
          auth,
          timeoutMs,
        }),
      ).toThrow(/timeout must be an integer between/);
    },
  );

  it.each(["line\nbreak", " nontrimmed", "é", "x".repeat(8_193)])(
    "rejects an unsafe access token before constructing a request: %s",
    async (token) => {
      const fetchImpl = vi.fn();
      const api = createHttpBillingApi({
        baseUrl: "https://billing-api.example",
        auth: {
          kind: "production",
          async getAccessToken() {
            return token;
          },
        },
        fetchImpl,
      });
      await expect(api.getAccount()).rejects.toMatchObject({
        message: "The authentication adapter returned an invalid access token.",
        status: 401,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(["", " padded ", "line\nbreak", "x".repeat(201), "💳"])(
    "rejects an unsafe idempotency header before fetch: %s",
    (idempotencyKey) => {
      const fetchImpl = vi.fn();
      const api = createHttpBillingApi({
        baseUrl: "https://billing-api.example",
        auth,
        fetchImpl,
      });
      expect(() =>
        api.createPortal("https://app.example/account", { idempotencyKey }),
      ).toThrow(/visible ASCII/);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("aborts a stalled request and returns a sanitized timeout", async () => {
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("secret provider detail", "AbortError")),
            { once: true },
          );
        }),
    );
    const api = createHttpBillingApi({
      baseUrl: "https://billing-api.example",
      auth,
      fetchImpl,
      timeoutMs: 1,
    });
    await expect(api.getAccount()).rejects.toMatchObject({
      message: "Billing API request timed out.",
      status: 504,
    });
  });

  it("preserves an exact fractional entitlement delta in plan previews", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ...validPreview,
          entitlement_credit_delta: "0.000001",
          entitlement_credit_delta_atoms: "1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const api = createHttpBillingApi({
      baseUrl: "https://billing-api.example",
      auth,
      fetchImpl,
    });

    const result = await api.previewPlanChange({
      plan_key: "pro",
      interval: "month",
    });
    expect(result.entitlement_credit_delta).toBe("0.000001");
    expect(result.entitlement_credit_delta_atoms).toBe("1");
  });

  it("rejects a numeric entitlement delta from the production API", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ...validPreview,
          entitlement_credit_delta: 0.000001,
          entitlement_credit_delta_atoms: "1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const api = createHttpBillingApi({
      baseUrl: "https://billing-api.example",
      auth,
      fetchImpl,
    });

    await expect(
      api.previewPlanChange({ plan_key: "pro", interval: "month" }),
    ).rejects.toMatchObject({
      message: "Billing API returned an invalid exact-credit contract.",
      status: 502,
    });
  });

  it("does not reflect network exception details", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("sk_test_should_never_be_rendered");
    });
    const api = createHttpBillingApi({
      baseUrl: "https://billing-api.example",
      auth,
      fetchImpl,
    });
    await expect(api.getAccount()).rejects.toMatchObject({
      message: "Billing API is temporarily unavailable.",
      status: 503,
    });
  });

  it("preserves exact account atoms beyond Number.MAX_SAFE_INTEGER", async () => {
    const exact = creditAmountFromAtoms("9007199254740993");
    const account = demoAccount();
    account.credits = {
      ...account.credits,
      balance: exact.decimal,
      balance_atoms: exact.atoms,
      subscription_balance: exact.decimal,
      subscription_balance_atoms: exact.atoms,
      scale: exact.scale,
    };
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(account), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const api = createHttpBillingApi({
      baseUrl: "https://billing-api.example",
      auth,
      fetchImpl,
    });

    const result = await api.getAccount();
    expect(result.credits.balance).toBe("9007199254.740993");
    expect(result.credits.balance_atoms).toBe("9007199254740993");
  });

  it.each([
    ["legacy numeric balance", { balance: 300 }],
    ["mismatched atoms", { balance: "300.5", balance_atoms: "300500001" }],
    ["wrong scale", { scale: 1000 }],
  ])("rejects an invalid production credit response: %s", async (_label, override) => {
    const account = demoAccount();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ...account,
          credits: { ...account.credits, ...override },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const api = createHttpBillingApi({
      baseUrl: "https://billing-api.example",
      auth,
      fetchImpl,
    });

    await expect(api.getAccount()).rejects.toMatchObject({
      message: "Billing API returned an invalid exact-credit contract.",
      status: 502,
    });
  });

  it.each([
    [{ detail: "safe validation message" }, "safe validation message"],
    [{ detail: "line\nbreak" }, "Request failed (400)"],
    [{ detail: "x".repeat(501) }, "Request failed (400)"],
    [{ detail: { nested: "not a string" } }, "Request failed (400)"],
  ])("bounds API error text before showing it", async (body, message) => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const api = createHttpBillingApi({
      baseUrl: "https://billing-api.example",
      auth,
      fetchImpl,
    });
    await expect(api.getAccount()).rejects.toMatchObject({ message, status: 400 });
  });
});
