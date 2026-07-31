export interface AuthAdapter {
  readonly kind: "none" | "demo" | "production";
  getAccessToken(): Promise<string | null>;
}

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
