import { describe, expect, it, vi } from "vitest";

import type { AuthAccountAdapter } from "../../src/auth.js";
import {
  IdentityProviderUnavailable,
  TeamAuthorizationError,
} from "../../src/auth-starters.js";
import {
  createBillingFetchHandler,
  MAX_STRIPE_WEBHOOK_BYTES,
  normalizeAllowedOrigins,
  validateCronSecret,
} from "../../src/http/index.js";
import type {
  BillingCronJob,
  BillingHttpResult,
  BillingHttpServices,
  BillingRequestContext,
  StripeWebhookContext,
} from "../../src/http/index.js";

const OK: BillingHttpResult = { status: 200, body: { ok: true } };

function services(
  overrides: Partial<BillingHttpServices> = {},
): BillingHttpServices {
  const result = async (): Promise<BillingHttpResult> => OK;
  return {
    health: result,
    catalog: result,
    account: result,
    checkout: result,
    creditPackCheckout: result,
    portal: result,
    previewPlanChange: result,
    confirmPlanChange: result,
    stripeWebhook: result,
    runCron: result,
    ...overrides,
  };
}

function authenticated(): AuthAccountAdapter {
  return {
    authenticate: vi.fn(async () => ({
      externalRef: "v1:user:test-owner",
      email: "a@example.test",
    })),
  };
}

function postRequest(
  path: string,
  options: {
    readonly body?: Uint8Array;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Request {
  const body = Uint8Array.from(
    options.body ?? new TextEncoder().encode("{}"),
  ).buffer;
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    duplex: "half",
    body,
  };
  if (options.headers !== undefined) {
    init.headers = options.headers;
  }
  return new Request(`https://billing.example${path}`, init);
}

describe("framework-neutral billing HTTP handler", () => {
  it("routes authenticated requests and passes only the verified identity", async () => {
    const account = vi.fn(
      async (context: BillingRequestContext): Promise<BillingHttpResult> => ({
        status: 200,
        body: { account: context.identity.externalRef },
      }),
    );
    const auth = authenticated();
    const handler = createBillingFetchHandler({
      services: services({ account }),
      auth,
      allowedOrigins: ["https://app.example"],
    });

    const response = await handler(
      new Request("https://billing.example/api/account", {
        headers: { Authorization: "Bearer verified" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account: "v1:user:test-owner" });
    expect(account).toHaveBeenCalledOnce();
    expect(account.mock.calls[0]?.[0].identity).toEqual({
      externalRef: "v1:user:test-owner",
      email: "a@example.test",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("fails closed when auth throws or returns an infrastructure identifier", async () => {
    const account = vi.fn(async (): Promise<BillingHttpResult> => OK);
    const throwing: AuthAccountAdapter = {
      authenticate: vi.fn(async () => {
        throw new Error("provider secret detail");
      }),
    };
    const invalid: AuthAccountAdapter = {
      authenticate: vi.fn(async () => ({ externalRef: "cus_untrusted" })),
    };

    for (const auth of [throwing, invalid]) {
      const handler = createBillingFetchHandler({
        services: services({ account }),
        auth,
        allowedOrigins: [],
      });
      const response = await handler(
        new Request("https://billing.example/api/account"),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        detail: "authentication failed",
      });
    }
    expect(account).not.toHaveBeenCalled();
  });

  it("distinguishes authorization denial and retryable identity-provider outage", async () => {
    const denied: AuthAccountAdapter = {
      authenticate: vi.fn(async () => {
        throw new TeamAuthorizationError("private membership detail");
      }),
    };
    const unavailable: AuthAccountAdapter = {
      authenticate: vi.fn(async () => {
        throw new IdentityProviderUnavailable();
      }),
    };
    const deniedHandler = createBillingFetchHandler({
      services: services(),
      auth: denied,
      allowedOrigins: ["https://app.example"],
    });
    const unavailableHandler = createBillingFetchHandler({
      services: services(),
      auth: unavailable,
      allowedOrigins: ["https://app.example"],
    });
    const request = (): Request =>
      new Request("https://billing.example/api/account", {
        headers: { Origin: "https://app.example" },
      });

    const forbidden = await deniedHandler(request());
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      detail: "billing operation is not permitted",
    });
    expect(forbidden.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );

    const retryable = await unavailableHandler(request());
    expect(retryable.status).toBe(503);
    expect(retryable.headers.get("retry-after")).toBe("5");
    expect(await retryable.text()).not.toContain("JWKS");
  });

  it("rejects hostile mutation origins before authentication", async () => {
    const auth = authenticated();
    const checkout = vi.fn(async (): Promise<BillingHttpResult> => OK);
    const handler = createBillingFetchHandler({
      services: services({ checkout }),
      auth,
      allowedOrigins: ["https://app.example"],
    });

    const response = await handler(
      postRequest("/api/checkout", {
        headers: { Origin: "https://attacker.example" },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "request origin is not allowed",
    });
    expect(auth.authenticate).not.toHaveBeenCalled();
    expect(checkout).not.toHaveBeenCalled();
  });

  it("requires Origin for cookie-backed same-origin sessions", async () => {
    const checkout = vi.fn(async (): Promise<BillingHttpResult> => OK);
    const handler = createBillingFetchHandler({
      services: services({ checkout }),
      auth: authenticated(),
      allowedOrigins: ["https://app.example"],
      csrfMode: "same-origin-session",
    });

    const missing = await handler(postRequest("/api/checkout"));
    const crossSite = await handler(
      postRequest("/api/checkout", {
        headers: {
          Origin: "https://app.example",
          "Sec-Fetch-Site": "cross-site",
        },
      }),
    );
    const allowed = await handler(
      postRequest("/api/checkout", {
        headers: {
          Origin: "https://app.example",
          "Sec-Fetch-Site": "same-origin",
        },
      }),
    );

    expect(missing.status).toBe(403);
    expect(crossSite.status).toBe(403);
    expect(allowed.status).toBe(200);
    expect(checkout).toHaveBeenCalledOnce();
  });

  it("answers a bounded credentialed CORS preflight without authenticating", async () => {
    const auth = authenticated();
    const handler = createBillingFetchHandler({
      services: services(),
      auth,
      allowedOrigins: ["https://app.example"],
    });
    const response = await handler(
      new Request("https://billing.example/api/checkout", {
        method: "OPTIONS",
        headers: {
          Origin: "https://app.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers":
            "authorization, idempotency-key, content-type",
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it("preserves exact webhook bytes and never parses them in the adapter", async () => {
    const payload = new TextEncoder().encode(
      '{\n  "message": "海", "spacing": true\n}\n',
    );
    let observed: StripeWebhookContext | undefined;
    const stripeWebhook = vi.fn(
      async (context: StripeWebhookContext): Promise<BillingHttpResult> => {
        observed = context;
        return { status: 200, body: { received: true } };
      },
    );
    const handler = createBillingFetchHandler({
      services: services({ stripeWebhook }),
      auth: authenticated(),
      allowedOrigins: [],
    });

    const response = await handler(
      postRequest("/webhooks/stripe", {
        body: payload,
        headers: {
          "Content-Length": String(payload.byteLength),
          "Stripe-Signature": "t=123,v1=signature",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(observed?.stripeSignature).toBe("t=123,v1=signature");
    expect(observed?.rawBody).toEqual(payload);
  });

  it("rejects a missing signature and declared oversize before core dispatch", async () => {
    const stripeWebhook = vi.fn(async (): Promise<BillingHttpResult> => OK);
    const handler = createBillingFetchHandler({
      services: services({ stripeWebhook }),
      auth: authenticated(),
      allowedOrigins: [],
    });

    const missing = await handler(postRequest("/webhooks/stripe"));
    const oversized = await handler(
      postRequest("/webhooks/stripe", {
        headers: {
          "Content-Length": String(MAX_STRIPE_WEBHOOK_BYTES + 1),
          "Stripe-Signature": "t=123,v1=signature",
        },
      }),
    );

    expect(missing.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(stripeWebhook).not.toHaveBeenCalled();
  });

  it("enforces the actual streamed webhook limit when Content-Length is absent", async () => {
    const stripeWebhook = vi.fn(async (): Promise<BillingHttpResult> => OK);
    const handler = createBillingFetchHandler({
      services: services({ stripeWebhook }),
      auth: authenticated(),
      allowedOrigins: [],
    });
    const oversized = new Uint8Array(MAX_STRIPE_WEBHOOK_BYTES + 1);

    const response = await handler(
      postRequest("/webhooks/stripe", {
        body: oversized,
        headers: { "Stripe-Signature": "t=123,v1=signature" },
      }),
    );

    expect(response.status).toBe(413);
    expect(stripeWebhook).not.toHaveBeenCalled();
  });

  it("accepts exactly the one-MiB webhook boundary", async () => {
    let observedLength = -1;
    const stripeWebhook = vi.fn(
      async (context: StripeWebhookContext): Promise<BillingHttpResult> => {
        observedLength = context.rawBody.byteLength;
        return OK;
      },
    );
    const handler = createBillingFetchHandler({
      services: services({ stripeWebhook }),
      auth: authenticated(),
      allowedOrigins: [],
    });
    const payload = new Uint8Array(MAX_STRIPE_WEBHOOK_BYTES);

    const response = await handler(
      postRequest("/webhooks/stripe", {
        body: payload,
        headers: {
          "Content-Length": String(payload.byteLength),
          "Stripe-Signature": "t=123,v1=signature",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(observedLength).toBe(MAX_STRIPE_WEBHOOK_BYTES);
    expect(stripeWebhook).toHaveBeenCalledOnce();
  });

  it("rejects a mismatched or malformed Content-Length", async () => {
    const stripeWebhook = vi.fn(async (): Promise<BillingHttpResult> => OK);
    const handler = createBillingFetchHandler({
      services: services({ stripeWebhook }),
      auth: authenticated(),
      allowedOrigins: [],
    });
    const mismatch = await handler(
      postRequest("/webhooks/stripe", {
        body: new Uint8Array([1, 2]),
        headers: { "Content-Length": "1", "Stripe-Signature": "t=1,v1=x" },
      }),
    );
    const malformed = await handler(
      postRequest("/webhooks/stripe", {
        headers: { "Content-Length": "-1", "Stripe-Signature": "t=1,v1=x" },
      }),
    );

    expect(mismatch.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(stripeWebhook).not.toHaveBeenCalled();
  });

  it("returns retryable webhook and Cron errors without reflecting exceptions", async () => {
    const handler = createBillingFetchHandler({
      services: services({
        stripeWebhook: vi.fn(async () => {
          throw new Error("sk_test_secret_detail");
        }),
        runCron: vi.fn(async () => {
          throw new Error("database identifier detail");
        }),
      }),
      auth: authenticated(),
      allowedOrigins: [],
      cronSecret: "cron-secret-at-least-sixteen",
    });
    const webhook = await handler(
      postRequest("/webhooks/stripe", {
        headers: { "Stripe-Signature": "t=1,v1=x" },
      }),
    );
    const cron = await handler(
      new Request("https://billing.example/api/cron/reconcile", {
        headers: { Authorization: "Bearer cron-secret-at-least-sixteen" },
      }),
    );

    expect(webhook.status).toBe(500);
    expect(await webhook.text()).not.toContain("sk_test");
    expect(cron.status).toBe(503);
    expect(await cron.text()).not.toContain("database identifier");
  });

  it("authorizes Cron with an exact bearer value and fails closed when unconfigured", async () => {
    const observedJobs: BillingCronJob[] = [];
    const runCron = vi.fn(
      async (job: BillingCronJob): Promise<BillingHttpResult> => {
        observedJobs.push(job);
        return {
          status: 200,
          body: { attempted: 0 },
        };
      },
    );
    const withoutSecret = createBillingFetchHandler({
      services: services({ runCron }),
      auth: authenticated(),
      allowedOrigins: [],
    });
    const withSecret = createBillingFetchHandler({
      services: services({ runCron }),
      auth: authenticated(),
      allowedOrigins: [],
      cronSecret: "cron-secret-at-least-sixteen",
    });

    const unavailable = await withoutSecret(
      new Request("https://billing.example/api/cron/reconcile"),
    );
    const wrong = await withSecret(
      new Request("https://billing.example/api/cron/reconcile", {
        headers: { Authorization: "Bearer wrong" },
      }),
    );
    const allowed = await withSecret(
      new Request("https://billing.example/api/cron/annual-grants", {
        headers: { Authorization: "Bearer cron-secret-at-least-sixteen" },
      }),
    );

    expect(unavailable.status).toBe(503);
    expect(wrong.status).toBe(401);
    expect(allowed.status).toBe(200);
    expect(runCron).toHaveBeenCalledOnce();
    expect(observedJobs).toEqual(["annual-grants"]);
  });

  it("validates deployment security configuration eagerly", () => {
    expect(() => normalizeAllowedOrigins(["*", "https://app.example"])).toThrow(
      "bare HTTP(S) origins",
    );
    expect(() => normalizeAllowedOrigins(["https://app.example/path"])).toThrow(
      "bare HTTP(S) origins",
    );
    expect(() => validateCronSecret("short")).toThrow("16 to 512");
    expect(validateCronSecret(undefined)).toBeUndefined();
  });

  it("returns 405 for a known path and never invokes the service", async () => {
    const health = vi.fn(async (): Promise<BillingHttpResult> => OK);
    const handler = createBillingFetchHandler({
      services: services({ health }),
      auth: authenticated(),
      allowedOrigins: [],
    });
    const response = await handler(
      new Request("https://billing.example/health", { method: "POST" }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(health).not.toHaveBeenCalled();
  });
});
