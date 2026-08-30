import type { AuthAdapter } from "@/lib/auth";
import { MAXIMUM_ACCESS_TOKEN_BYTES } from "@/lib/http-api";

const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

export interface SupabaseBrowserSession {
  readonly access_token: string;
}

export interface SupabaseBrowserAuthClient {
  readonly auth: {
    getSession(): Promise<{
      readonly data: { readonly session: SupabaseBrowserSession | null };
      readonly error: unknown;
    }>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Adapt a Lovable/Supabase browser session to the reference billing UI.
 *
 * The token remains untrusted identity evidence. The host must still verify it on the
 * server. The repository's strict generic JWT starter is usable only when the provider
 * actually issues every required claim, including integer `nbf` and UUID `sub`.
 */
export function createSupabaseBrowserAuth(
  client: SupabaseBrowserAuthClient,
): AuthAdapter {
  return {
    kind: "production",
    async getAccessToken(): Promise<string | null> {
      let result: Awaited<ReturnType<SupabaseBrowserAuthClient["auth"]["getSession"]>>;
      try {
        result = await client.auth.getSession();
      } catch {
        throw new Error("Supabase session lookup failed.");
      }
      if (
        !isRecord(result) ||
        result.error ||
        !isRecord(result.data) ||
        !("session" in result.data)
      ) {
        throw new Error("Supabase session lookup failed.");
      }
      const session = result.data.session;
      if (session === null) return null;
      if (!isRecord(session)) {
        throw new Error("Supabase session lookup failed.");
      }
      const token = session.access_token;
      if (
        typeof token !== "string" ||
        token.length === 0 ||
        new TextEncoder().encode(token).byteLength > MAXIMUM_ACCESS_TOKEN_BYTES ||
        !COMPACT_JWT.test(token)
      ) {
        throw new Error("Supabase session returned an invalid access token.");
      }
      return token;
    },
  };
}
