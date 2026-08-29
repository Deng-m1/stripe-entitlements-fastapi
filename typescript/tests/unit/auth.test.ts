import { describe, expect, it } from "vitest";

import {
  AuthenticationError,
  DemoBearerAuthAdapter,
  RejectAllAuthAdapter,
} from "../../src/auth.js";

describe("authentication adapters", () => {
  it("fails closed by default", async () => {
    await expect(
      new RejectAllAuthAdapter().authenticate(new Request("https://app.test")),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("compares an explicit development bearer credential", async () => {
    const adapter = new DemoBearerAuthAdapter(
      "local-only-token",
      "host-user",
      "u@example.test",
    );
    const identity = await adapter.authenticate(
      new Request("https://app.test", {
        headers: { authorization: "Bearer local-only-token" },
      }),
    );
    expect(identity).toEqual({
      externalRef: "host-user",
      email: "u@example.test",
    });
    await expect(
      adapter.authenticate(
        new Request("https://app.test", {
          headers: { authorization: "Bearer wrong" },
        }),
      ),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it.each(["", " padded", "line\nbreak", "非ascii"])(
    "rejects unsafe demo tokens %#",
    (token) => {
      expect(() => new DemoBearerAuthAdapter(token, "subject")).toThrow();
    },
  );
});
