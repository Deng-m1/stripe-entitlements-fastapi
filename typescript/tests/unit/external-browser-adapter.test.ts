import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

const examplePath = fileURLToPath(
  new URL(
    "../../../examples/browser_adapters/vite-billing-client.ts",
    import.meta.url,
  ),
);

interface ExampleModule {
  createBillingFetch(options: {
    readonly baseUrl: string;
    readonly getAccessToken: () => Promise<string | null>;
  }): <T>(
    path: string,
    request?: {
      readonly method?: "GET" | "POST";
      readonly body?: unknown;
      readonly idempotencyKey?: string;
    },
  ) => Promise<T>;
}

function exampleSource(): string {
  // The path is a fixed repository fixture derived from this module URL.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(examplePath, "utf8");
}

async function loadExample(): Promise<ExampleModule> {
  const javascript = ts.transpileModule(exampleSource(), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;
  return (await import(/* @vite-ignore */ moduleUrl)) as ExampleModule;
}

describe("external browser adapter example", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strict-typechecks as a dependency-free DOM consumer", () => {
    const source = exampleSource();
    expect(source).not.toContain("@/");
    expect(source).not.toContain("@tosea/stripe-entitlements");
    expect(source).not.toContain("process.env");

    const program = ts.createProgram([examplePath], {
      exactOptionalPropertyTypes: true,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      types: [],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(
      diagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      ),
    ).toEqual([]);
  });

  it.each([
    "http://billing.example",
    "https://user:password@billing.example",
    "https://billing.example?tenant=one",
    "https://billing.example#fragment",
  ])("rejects an unsafe API base: %s", async (baseUrl) => {
    const { createBillingFetch } = await loadExample();

    expect(() =>
      createBillingFetch({
        baseUrl,
        getAccessToken: async () => "valid-token",
      }),
    ).toThrow();
  });

  it.each([null, "", " token", "token ", "tok en", "\ttoken"])(
    "rejects an invalid browser access token",
    async (token) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { createBillingFetch } = await loadExample();
      const billingFetch = createBillingFetch({
        baseUrl: "https://billing.example",
        getAccessToken: async () => token,
      });

      await expect(billingFetch("/api/account")).rejects.toThrow(
        "Sign in before opening billing.",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("does not impose an 8 KiB client limit below the server contract", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _request?: RequestInit) =>
        Response.json({ plan_key: "starter" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { createBillingFetch } = await loadExample();
    const longOpaqueToken = "x".repeat(9_000);
    const billingFetch = createBillingFetch({
      baseUrl: "https://billing.example",
      getAccessToken: async () => longOpaqueToken,
    });

    await expect(billingFetch("/api/account")).resolves.toEqual({
      plan_key: "starter",
    });
    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(request?.headers).get("Authorization")).toBe(
      `Bearer ${longOpaqueToken}`,
    );
  });

  it.each([
    [
      "https://billing.example/prefix",
      "https://billing.example/prefix/api/account",
    ],
    [
      "https://billing.example/prefix/",
      "https://billing.example/prefix/api/account",
    ],
    [
      "http://localhost:8000/billing",
      "http://localhost:8000/billing/api/account",
    ],
  ])(
    "preserves a configured API path prefix: %s",
    async (baseUrl, expectedUrl) => {
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _request?: RequestInit) =>
          Response.json({ plan_key: "starter" }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { createBillingFetch } = await loadExample();
      const billingFetch = createBillingFetch({
        baseUrl,
        getAccessToken: async () => "valid-token",
      });

      await billingFetch("/api/account");

      const [input] = fetchMock.mock.calls[0] ?? [];
      expect(input).toEqual(new URL(expectedUrl));
    },
  );

  it("forwards one valid user token and idempotency key to the exact billing path", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _request?: RequestInit) =>
        Response.json({ url: "https://checkout.example" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { createBillingFetch } = await loadExample();
    const billingFetch = createBillingFetch({
      baseUrl: "https://billing.example",
      getAccessToken: async () => "compact-user-token",
    });

    await expect(
      billingFetch<{ url: string }>("/api/checkout", {
        method: "POST",
        idempotencyKey: "checkout-intent-1",
        body: { plan_key: "starter", interval: "month" },
      }),
    ).resolves.toEqual({ url: "https://checkout.example" });

    const [input, request] = fetchMock.mock.calls[0] ?? [];
    expect(input).toEqual(new URL("https://billing.example/api/checkout"));
    const headers = new Headers(request?.headers);
    expect(headers.get("Authorization")).toBe("Bearer compact-user-token");
    expect(headers.get("Idempotency-Key")).toBe("checkout-intent-1");
    expect(request?.credentials).toBe("omit");
    expect(request?.body).toBe(
      JSON.stringify({ plan_key: "starter", interval: "month" }),
    );
  });
});
