import { describe, expect, it } from "vitest";
import {
  createE2ERouteAuth,
  E2E_ROUTE_AUTH_SENTINEL,
} from "@/lib/auth";

describe("production browser E2E route authentication", () => {
  it("returns only the fixed, deliberately invalid public sentinel", async () => {
    const auth = createE2ERouteAuth(E2E_ROUTE_AUTH_SENTINEL);
    expect(auth.kind).toBe("e2e-route");
    await expect(auth.getAccessToken()).resolves.toBe(E2E_ROUTE_AUTH_SENTINEL);
  });

  it.each(["", "custom-sentinel", `${E2E_ROUTE_AUTH_SENTINEL}x`])(
    "rejects a configurable sentinel: %s",
    (sentinel) => {
      expect(() => createE2ERouteAuth(sentinel)).toThrow(/sentinel is invalid/);
    },
  );
});
