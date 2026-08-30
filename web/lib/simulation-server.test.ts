import { describe, expect, it, vi } from "vitest";
import { createSimulationSafeBillingRouteHandler } from "@/lib/simulation-server";

describe("public simulation server boundary", () => {
  it("returns a no-store 404 without importing the billing backend", async () => {
    const loader = vi.fn(async () => async () => new Response("unsafe"));
    const handler = createSimulationSafeBillingRouteHandler(
      "simulation",
      loader,
    );
    const response = await handler(new Request("https://demo.example/api/account"));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({ detail: "not found" });
    expect(loader).not.toHaveBeenCalled();
  });

  it("delegates non-simulation traffic to the packaged backend", async () => {
    const packaged = vi.fn(async () => new Response("ready", { status: 200 }));
    const loader = vi.fn(async () => packaged);
    const handler = createSimulationSafeBillingRouteHandler("http", loader);
    const request = new Request("https://billing.example/health");
    const response = await handler(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ready");
    expect(loader).toHaveBeenCalledOnce();
    expect(packaged).toHaveBeenCalledWith(request);
  });
});
