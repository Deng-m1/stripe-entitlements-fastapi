import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AuthAccountAdapter } from "../../src/auth.js";
import type {
  BillingHttpResult,
  BillingHttpServices,
} from "../../src/http/index.js";
import {
  asNextRouteHandler,
  createNextBillingRouteHandler,
  dynamic,
  environmentNextBillingRouteHandler,
  maxDuration,
  runtime,
} from "../../src/next/index.js";

const response: BillingHttpResult = { status: 200, body: { ok: true } };

function serviceFacade(): BillingHttpServices {
  const result = async (): Promise<BillingHttpResult> => response;
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
  };
}

describe("Next.js adapter", () => {
  it("exports the required Node, dynamic, and duration route literals", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
    expect(maxDuration).toBe(60);
  });

  it("adapts an existing Fetch handler without changing its Request", async () => {
    const request = new Request("https://app.example/health");
    const fetchHandler = vi.fn(
      async () => new Response("healthy", { status: 202 }),
    );
    const handler = asNextRouteHandler(fetchHandler);

    const result = await handler(request);

    expect(fetchHandler).toHaveBeenCalledWith(request);
    expect(result.status).toBe(202);
    expect(await result.text()).toBe("healthy");
  });

  it("constructs the framework-neutral handler from explicit injected services", async () => {
    const auth: AuthAccountAdapter = {
      authenticate: vi.fn(async () => ({ externalRef: "v1:user:next-owner" })),
    };
    const handler = createNextBillingRouteHandler({
      services: serviceFacade(),
      auth,
      allowedOrigins: ["https://app.example"],
    });

    const result = await handler(
      new Request("https://app.example/api/account"),
    );

    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true });
    expect(auth.authenticate).toHaveBeenCalledOnce();
  });

  it("sanitizes a failed lazy environment initialization and permits retry", async () => {
    const previous = process.env["DATABASE_URL"];
    delete process.env["DATABASE_URL"];
    try {
      const first = await environmentNextBillingRouteHandler(
        new Request("https://app.example/health"),
      );
      const second = await environmentNextBillingRouteHandler(
        new Request("https://app.example/health"),
      );
      expect(first.status).toBe(503);
      expect(second.status).toBe(503);
      expect(first.headers.get("retry-after")).toBe("5");
      expect(await first.text()).not.toContain("DATABASE_URL");
    } finally {
      if (previous === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = previous;
    }
  });

  it("keeps the TypeScript Vercel topology on one Next service with bounded Cron routes", async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const configPath = resolve(root, "vercel.typescript.json");
    // The path is anchored to this checked-in test, not derived from user input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;

    expect(config["services"]).toEqual({
      application: {
        root: "web/",
        framework: "nextjs",
        installCommand: "npm ci",
      },
    });
    expect(config["rewrites"]).toEqual([
      { source: "/(.*)", destination: { service: "application" } },
    ]);
    expect(config["crons"]).toEqual([
      { path: "/api/cron/annual-grants", schedule: "7 * * * *" },
      { path: "/api/cron/reconcile", schedule: "*/5 * * * *" },
    ]);
    expect(JSON.stringify(config).toLowerCase()).not.toContain("fastapi");
    expect(JSON.stringify(config).toLowerCase()).not.toContain("python");

    const routeFiles = [
      "web/app/api/[...billing]/route.ts",
      "web/app/webhooks/stripe/route.ts",
      "web/app/health/route.ts",
    ];
    for (const relative of routeFiles) {
      // Every candidate is a checked-in literal rooted at this test file.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const source = await readFile(resolve(root, relative), "utf8");
      expect(source).toContain("simulationSafeBillingRouteHandler");
      expect(source).toContain('runtime = "nodejs"');
      expect(source).toContain('dynamic = "force-dynamic"');
      expect(source).toContain("maxDuration = 60");
    }
    const webPackage = JSON.parse(
      // The path is a checked-in literal rooted at this test file.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await readFile(resolve(root, "web/package.json"), "utf8"),
    ) as { readonly dependencies?: Readonly<Record<string, string>> };
    expect(webPackage.dependencies?.["@tosea/stripe-entitlements"]).toBe(
      "file:../typescript",
    );
  });
});
