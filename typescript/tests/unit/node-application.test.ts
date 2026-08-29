import { describe, expect, it, vi } from "vitest";

import type { BillingRuntime } from "../../src/deployment.js";
import { TYPESCRIPT_PACKAGE_VERSION } from "../../src/doctor.js";
import {
  parseNodeBillingCommand,
  runNodeBillingCommand,
  startNodeBillingApplication,
} from "../../src/node/index.js";

describe("standalone Node application", () => {
  it("parses only the bounded operational command surface", () => {
    expect(parseNodeBillingCommand([])).toEqual({ name: "serve" });
    expect(parseNodeBillingCommand(["--version"])).toEqual({
      name: "version",
    });
    expect(parseNodeBillingCommand(["version"])).toEqual({ name: "version" });
    expect(parseNodeBillingCommand(["migrate"])).toEqual({ name: "migrate" });
    expect(
      parseNodeBillingCommand([
        "bootstrap",
        "--verify-only",
        "--catalog",
        "/tmp/plans.toml",
        "--lookup-prefix",
        "demo",
        "--product-line",
        "demo-saas",
      ]),
    ).toEqual({
      name: "bootstrap",
      verifyOnly: true,
      allowLive: false,
      confirmedLiveProductLine: null,
      catalogPath: "/tmp/plans.toml",
      lookupPrefix: "demo",
      productLine: "demo-saas",
    });
    expect(
      parseNodeBillingCommand([
        "bootstrap",
        "--allow-live",
        "--confirm-live-product-line",
        "live-saas",
      ]),
    ).toMatchObject({
      name: "bootstrap",
      allowLive: true,
      confirmedLiveProductLine: "live-saas",
    });
    expect(parseNodeBillingCommand(["doctor"])).toEqual({
      name: "doctor",
      json: false,
      stripeNetwork: false,
    });
    expect(
      parseNodeBillingCommand(["doctor", "--stripe-network", "--json"]),
    ).toEqual({ name: "doctor", json: true, stripeNetwork: true });
    expect(parseNodeBillingCommand(["cron", "reconcile"])).toEqual({
      name: "cron",
      job: "reconcile",
    });
    expect(() => parseNodeBillingCommand(["cron", "erase"])).toThrow("usage");
    expect(() => parseNodeBillingCommand(["doctor", "extra"])).toThrow("usage");
    expect(() =>
      parseNodeBillingCommand(["doctor", "--json", "--json"]),
    ).toThrow("usage");
    expect(() => parseNodeBillingCommand(["bootstrap", "--catalog"])).toThrow(
      "usage",
    );
    expect(() =>
      parseNodeBillingCommand(["bootstrap", "--verify-only", "--verify-only"]),
    ).toThrow("usage");
    expect(() => parseNodeBillingCommand(["bootstrap", "--unknown"])).toThrow(
      "usage",
    );
  });

  it("reports the package version without loading configuration or services", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await runNodeBillingCommand(
      parseNodeBillingCommand(["--version"]),
      {},
      {
        out: (value) => output.push(value),
        error: (value) => errors.push(value),
      },
    );
    expect(exitCode).toBe(0);
    expect(output).toEqual([
      `stripe-entitlements ${TYPESCRIPT_PACKAGE_VERSION}`,
    ]);
    expect(errors).toEqual([]);
  });

  it("owns the HTTP listener and closes its runtime exactly once", async () => {
    const close = vi.fn(async () => undefined);
    const runtime = {
      handler: async (request: Request): Promise<Response> =>
        new Response(JSON.stringify({ path: new URL(request.url).pathname }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      close,
    } as unknown as BillingRuntime;
    const application = await startNodeBillingApplication({
      runtime,
      host: "127.0.0.1",
      port: 0,
      origin: "http://127.0.0.1",
    });

    const response = await fetch(
      `http://127.0.0.1:${String(application.port)}/health`,
    );
    expect(await response.json()).toEqual({ path: "/health" });
    await application.close();
    await application.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects an invalid listening port before opening a socket", async () => {
    const runtime = {
      handler: async (): Promise<Response> => new Response("{}"),
      close: vi.fn(async () => undefined),
    } as unknown as BillingRuntime;
    await expect(
      startNodeBillingApplication({ runtime, port: 65_536 }),
    ).rejects.toThrow("port");
    expect(runtime.close).not.toHaveBeenCalled();
  });
});
