import { describe, expect, it, vi } from "vitest";
import {
  createHttpBillingApi,
  normalizeBillingApiBaseUrl,
} from "@/lib/http-api";
import type { AuthAdapter } from "@/lib/auth";

const auth: AuthAdapter = {
  kind: "production",
  async getAccessToken() {
    return "verified-session-token";
  },
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
            : {
                preview_id: "preview-1",
                current_plan_key: "starter",
                current_interval: "month",
                target_plan_key: "pro",
                target_interval: "year",
                timing: "immediate",
                effective_at: "2026-07-31T00:00:00Z",
                currency: "USD",
                amount_due_now: 100,
                credit_applied: 0,
                next_invoice_amount: 35300,
              },
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
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
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
});
