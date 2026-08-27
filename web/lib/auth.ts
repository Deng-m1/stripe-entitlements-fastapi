export interface AuthAdapter {
  readonly kind: "none" | "demo" | "e2e-route" | "production";
  getAccessToken(): Promise<string | null>;
}

/**
 * A public, deliberately invalid credential used only by the production browser
 * E2E build. Playwright replaces it outside the page for exact backend /api/
 * requests; the demo backend never accepts this fixed value on its own.
 */
export const E2E_ROUTE_AUTH_SENTINEL =
  "stripe-entitlements-e2e-route-auth-v1.invalid";

export const noAuthAdapter: AuthAdapter = {
  kind: "none",
  async getAccessToken() {
    return null;
  },
};

/**
 * Local integration helper only. Replace this adapter with the application's
 * session/OIDC provider before production deployment.
 */
export function createDemoBearerAuth(token: string): AuthAdapter {
  return {
    kind: "demo",
    async getAccessToken() {
      return token;
    },
  };
}

export function createE2ERouteAuth(sentinel: string): AuthAdapter {
  if (sentinel !== E2E_ROUTE_AUTH_SENTINEL) {
    throw new Error("Production E2E route authentication sentinel is invalid.");
  }
  return {
    kind: "e2e-route",
    async getAccessToken() {
      return E2E_ROUTE_AUTH_SENTINEL;
    },
  };
}
