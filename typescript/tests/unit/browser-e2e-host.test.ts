import { describe, expect, test, vi } from "vitest";

import {
  browserE2eHostConfiguration,
  createBrowserE2eApiHandler,
} from "../e2e/browser-host.js";

const PERSONAL_SUBJECT = "7e4a3d62-e503-4f07-8f23-980056172964";
const WORKLOAD_SUBJECT = "bcd6b1ab-0185-4b2f-8a58-85b28c12bbb3";
const FRONTEND_ORIGIN = "https://127.0.0.1:3002";
const BACKEND_ORIGIN = "https://127.0.0.1:8443";

function environment(): Record<string, string> {
  return {
    STRIPE_SECRET_KEY: "sk_test_browser_host_fixture",
    E2E_BACKEND_HOST: "127.0.0.1",
    E2E_BACKEND_PORT: "8443",
    E2E_TLS_KEY_FILE: "/tmp/browser-host.key",
    E2E_TLS_CERT_FILE: "/tmp/browser-host.crt",
    E2E_PERSONAL_JWKS_FILE: "/tmp/browser-host-jwks.json",
    E2E_JWT_ISSUER: "https://127.0.0.1:8443/e2e/issuer",
    E2E_PERSONAL_JWT_AUDIENCE: "browser-audience",
    E2E_WORKLOAD_JWT_AUDIENCE: "workload-audience",
    E2E_WORKLOAD_SUBJECT: WORKLOAD_SUBJECT,
    E2E_WORKLOAD_JWT: "eyJ.fixture.signature",
    E2E_EXPECTED_OWNER_EXTERNAL_REF: `v1:user:${PERSONAL_SUBJECT}`,
    E2E_JOB_SUCCESS_KEY: "browser-e2e:test:success",
    E2E_JOB_FAILURE_KEY: "browser-e2e:test:failure",
  };
}

describe("TypeScript browser E2E host startup contract", () => {
  test("accepts one isolated loopback test-mode identity", () => {
    expect(browserE2eHostConfiguration(environment())).toMatchObject({
      host: "127.0.0.1",
      port: 8443,
      origin: "https://127.0.0.1:8443",
      issuer: "https://127.0.0.1:8443/e2e/issuer",
      workloadSubject: WORKLOAD_SUBJECT,
      expectedOwner: `v1:user:${PERSONAL_SUBJECT}`,
    });
  });

  test("rejects a missing or live Stripe key before startup", () => {
    expect(() => browserE2eHostConfiguration({})).toThrow(
      "STRIPE_SECRET_KEY is required",
    );
    expect(() =>
      browserE2eHostConfiguration({ STRIPE_SECRET_KEY: "sk_live_forbidden" }),
    ).toThrow("requires a Stripe test key");
  });

  test("requires workload identity and exact owner binding", () => {
    const missingWorkload = environment();
    delete missingWorkload["E2E_WORKLOAD_JWT"];
    expect(() => browserE2eHostConfiguration(missingWorkload)).toThrow(
      "E2E_WORKLOAD_JWT is required",
    );

    const invalidOwner = environment();
    invalidOwner["E2E_EXPECTED_OWNER_EXTERNAL_REF"] = " browser-user";
    expect(() => browserE2eHostConfiguration(invalidOwner)).toThrow();
  });

  test("refuses a non-loopback listener or mismatched JWKS issuer", () => {
    const publicHost = environment();
    publicHost["E2E_BACKEND_HOST"] = "0.0.0.0";
    expect(() => browserE2eHostConfiguration(publicHost)).toThrow(
      "must be a loopback host",
    );

    const mismatchedIssuer = environment();
    mismatchedIssuer["E2E_JWT_ISSUER"] = "https://127.0.0.1:9443/e2e/issuer";
    expect(() => browserE2eHostConfiguration(mismatchedIssuer)).toThrow(
      "must be the browser host issuer URL",
    );
  });
});

describe("TypeScript browser E2E host-only API CORS contract", () => {
  const paths = ["/api/e2e/portal-evidence", "/api/e2e/jobs"] as const;

  function routeHarness() {
    const portal = vi.fn(async () =>
      Response.json({ route: "portal", verified: true }),
    );
    const jobs = vi.fn(async () =>
      Response.json({ route: "jobs", verified: true }),
    );
    return {
      portal,
      jobs,
      handler: createBrowserE2eApiHandler({
        allowedOrigins: [FRONTEND_ORIGIN],
        portal,
        jobs,
      }),
    };
  }

  test.each(paths)("answers a real preflight and POST for %s", async (path) => {
    const { handler, portal, jobs } = routeHarness();
    const preflight = await handler(
      new Request(`${BACKEND_ORIGIN}${path}`, {
        method: "OPTIONS",
        headers: {
          Origin: FRONTEND_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type, authorization",
        },
      }),
    );
    expect(preflight).toBeInstanceOf(Response);
    expect(preflight?.status).toBe(204);
    expect(preflight?.headers.get("access-control-allow-origin")).toBe(
      FRONTEND_ORIGIN,
    );
    expect(preflight?.headers.get("access-control-allow-methods")).toBe("POST");
    expect(preflight?.headers.get("access-control-allow-headers")).toBe(
      "Authorization, Content-Type",
    );
    expect(
      preflight?.headers.get("access-control-allow-credentials"),
    ).toBeNull();
    expect(portal).not.toHaveBeenCalled();
    expect(jobs).not.toHaveBeenCalled();

    const post = await handler(
      new Request(`${BACKEND_ORIGIN}${path}`, {
        method: "POST",
        headers: {
          Authorization: "Bearer public-sentinel",
          "Content-Type": "application/json",
          Origin: FRONTEND_ORIGIN,
        },
        body: "{}",
      }),
    );
    expect(post).toBeInstanceOf(Response);
    expect(post?.status).toBe(200);
    expect(post?.headers.get("access-control-allow-origin")).toBe(
      FRONTEND_ORIGIN,
    );
    expect(post?.headers.get("access-control-allow-credentials")).toBeNull();
    expect(post?.headers.get("vary")).toBe("Origin");
    expect(await post?.json()).toEqual({
      route: path.endsWith("portal-evidence") ? "portal" : "jobs",
      verified: true,
    });
    expect(portal).toHaveBeenCalledTimes(
      path.endsWith("portal-evidence") ? 1 : 0,
    );
    expect(jobs).toHaveBeenCalledTimes(path.endsWith("jobs") ? 1 : 0);
  });

  test("rejects foreign origins and expanded preflight headers", async () => {
    const { handler, portal, jobs } = routeHarness();
    const foreign = await handler(
      new Request(`${BACKEND_ORIGIN}/api/e2e/jobs`, {
        method: "POST",
        headers: {
          Authorization: "Bearer public-sentinel",
          "Content-Type": "application/json",
          Origin: "https://attacker.example",
        },
        body: "{}",
      }),
    );
    expect(foreign?.status).toBe(403);
    expect(foreign?.headers.get("access-control-allow-origin")).toBeNull();

    const expanded = await handler(
      new Request(`${BACKEND_ORIGIN}/api/e2e/portal-evidence`, {
        method: "OPTIONS",
        headers: {
          Origin: FRONTEND_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers":
            "authorization, content-type, x-unreviewed-header",
        },
      }),
    );
    expect(expanded?.status).toBe(400);
    expect(expanded?.headers.get("access-control-allow-origin")).toBeNull();
    expect(portal).not.toHaveBeenCalled();
    expect(jobs).not.toHaveBeenCalled();
  });

  test("keeps non-browser calls credential-free and ignores unrelated paths", async () => {
    const { handler, jobs } = routeHarness();
    const serverSide = await handler(
      new Request(`${BACKEND_ORIGIN}/api/e2e/jobs`, {
        method: "POST",
        headers: {
          Authorization: "Bearer workload",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(serverSide?.status).toBe(200);
    expect(serverSide?.headers.get("access-control-allow-origin")).toBeNull();
    expect(
      serverSide?.headers.get("access-control-allow-credentials"),
    ).toBeNull();
    expect(jobs).toHaveBeenCalledTimes(1);

    await expect(
      handler(new Request(`${BACKEND_ORIGIN}/api/account`)),
    ).resolves.toBeUndefined();
  });

  test("refuses wildcard or empty host origin configuration", () => {
    const route = async () => Response.json({ ok: true });
    expect(() =>
      createBrowserE2eApiHandler({
        allowedOrigins: [],
        portal: route,
        jobs: route,
      }),
    ).toThrow("requires explicit frontend origins");
    expect(() =>
      createBrowserE2eApiHandler({
        allowedOrigins: ["*"],
        portal: route,
        jobs: route,
      }),
    ).toThrow("requires explicit frontend origins");
  });
});
