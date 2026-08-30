import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeBillingServer } from "../../src/node/index.js";
import type { BillingFetchHandler } from "../../src/http/index.js";

describe("standalone Node adapter", () => {
  const servers: ReturnType<typeof createNodeBillingServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error === undefined) resolve();
              else reject(error);
            });
          }),
      ),
    );
  });

  async function start(handler: BillingFetchHandler): Promise<string> {
    const server = createNodeBillingServer(handler, {
      origin: "http://127.0.0.1",
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${String(address.port)}`;
  }

  it("adapts an incoming Node request to Fetch without trusting Host for the URL", async () => {
    let observed: Request | undefined;
    const origin = await start(async (request) => {
      observed = request;
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "X-Adapter": "node" },
      });
    });

    const response = await fetch(`${origin}/api/account?view=current`, {
      headers: { Host: "attacker.example", Authorization: "Bearer value" },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("x-adapter")).toBe("node");
    expect(observed?.url).toBe("http://127.0.0.1/api/account?view=current");
    expect(observed?.headers.get("authorization")).toBe("Bearer value");
  });

  it("preserves POST request bytes for the Fetch handler", async () => {
    const expected = new TextEncoder().encode("raw\u0000stripe\nbytes");
    let actual: Uint8Array | undefined;
    const origin = await start(async (request) => {
      actual = new Uint8Array(await request.arrayBuffer());
      return new Response("{}", { status: 200 });
    });

    const response = await fetch(`${origin}/webhooks/stripe`, {
      method: "POST",
      body: expected,
      headers: { "Content-Type": "application/octet-stream" },
    });

    expect(response.status).toBe(200);
    expect(actual).toEqual(expected);
  });

  it("sanitizes an unhandled Fetch handler exception", async () => {
    const origin = await start(async () => {
      throw new Error("whsec_provider_detail");
    });
    const response = await fetch(`${origin}/health`);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("whsec_");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects an unsafe configured server origin", () => {
    expect(() =>
      createNodeBillingServer(async () => new Response("{}"), {
        origin: "https://user:password@example.test/path",
      }),
    ).toThrow("bare HTTP(S) origin");
  });
});
