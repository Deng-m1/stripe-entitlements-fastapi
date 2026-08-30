import { describe, expect, it, vi } from "vitest";
import {
  createSupabaseBrowserAuth,
  type SupabaseBrowserAuthClient,
} from "@/lib/supabase-auth";

function client(
  session: { access_token: string } | null,
  error: unknown = null,
): SupabaseBrowserAuthClient {
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session }, error })),
    },
  };
}

describe("Supabase browser authentication adapter", () => {
  it("returns the current compact JWT as production identity evidence", async () => {
    const auth = createSupabaseBrowserAuth(client({ access_token: "aaa.bbb.ccc" }));
    expect(auth.kind).toBe("production");
    await expect(auth.getAccessToken()).resolves.toBe("aaa.bbb.ccc");
  });

  it("accepts the HTTP adapter's exact 8,192-byte boundary", async () => {
    const token = `${"a".repeat(8_188)}.b.c`;
    expect(new TextEncoder().encode(token)).toHaveLength(8_192);
    const auth = createSupabaseBrowserAuth(client({ access_token: token }));
    await expect(auth.getAccessToken()).resolves.toBe(token);
  });

  it("returns no token for a signed-out browser", async () => {
    const auth = createSupabaseBrowserAuth(client(null));
    await expect(auth.getAccessToken()).resolves.toBeNull();
  });

  it("sanitizes provider errors", async () => {
    const auth = createSupabaseBrowserAuth(
      client(null, new Error("private provider detail")),
    );
    await expect(auth.getAccessToken()).rejects.toThrow(
      "Supabase session lookup failed.",
    );
    await expect(auth.getAccessToken()).rejects.not.toThrow(
      "private provider detail",
    );
  });

  it("sanitizes a rejected provider lookup", async () => {
    const auth = createSupabaseBrowserAuth({
      auth: {
        getSession: vi.fn(async () => {
          throw new Error("private rejected detail");
        }),
      },
    });
    await expect(auth.getAccessToken()).rejects.toThrow(
      "Supabase session lookup failed.",
    );
    await expect(auth.getAccessToken()).rejects.not.toThrow(
      "private rejected detail",
    );
  });

  it("sanitizes a malformed provider response", async () => {
    const malformed = {
      auth: {
        getSession: vi.fn(async () => null),
      },
    } as unknown as SupabaseBrowserAuthClient;
    const auth = createSupabaseBrowserAuth(malformed);

    await expect(auth.getAccessToken()).rejects.toThrow(
      "Supabase session lookup failed.",
    );
    await expect(auth.getAccessToken()).rejects.not.toThrow(TypeError);
  });

  it.each([
    "",
    "opaque-token",
    "two.parts",
    "four.part.jwt.extra",
    "aaa.bbb.ccc\n",
    `${"a".repeat(8_189)}.b.c`,
  ])("rejects a malformed or oversized access token", async (accessToken) => {
    const auth = createSupabaseBrowserAuth(
      client({ access_token: accessToken }),
    );
    await expect(auth.getAccessToken()).rejects.toThrow(
      "Supabase session returned an invalid access token.",
    );
  });
});
