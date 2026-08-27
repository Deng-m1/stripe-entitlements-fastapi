import { describe, expect, it } from "vitest";
import { browserProcessEnvironment } from "@/lib/browser-process-environment";

describe("browser process environment", () => {
  it("passes only browser runtime variables and excludes server-side secrets", () => {
    const result = browserProcessEnvironment({
      PATH: "/usr/bin",
      HOME: "/tmp/browser-home",
      LANG: "C.UTF-8",
      NODE_ENV: "test",
      STRIPE_SECRET_KEY: "sk_test_must_not_reach_chromium",
      STRIPE_WEBHOOK_SECRET: "whsec_must_not_reach_chromium",
      E2E_DATABASE_URL: "postgresql://secret",
      E2E_DEMO_BEARER_TOKEN: "must-not-reach-chromium",
      NODE_EXTRA_CA_CERTS: "/tmp/node-route-fetch-only.crt",
      DATABASE_URL: "postgresql://also-secret",
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_public",
    });

    expect(result).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/browser-home",
      LANG: "C.UTF-8",
    });
  });
});
