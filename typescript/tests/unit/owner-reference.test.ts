import { describe, expect, it } from "vitest";

import { validateOwnerExternalRef } from "../../src/owner-reference.js";

describe("host owner references", () => {
  it.each([
    "",
    " padded ",
    "line\nbreak",
    "delete\u007f",
    "zero\u200bwidth",
    "x".repeat(513),
    "00000000-0000-4000-8000-000000000001",
    "cus_database_owner",
    "sub_database_owner",
    "acct_database_owner",
  ])("rejects unsafe selector %#", (value) => {
    expect(() => validateOwnerExternalRef(value)).toThrow();
  });

  it.each(["user_123", "auth0|stable-subject", "person@example.test"])(
    "accepts a stable host selector %#",
    (value) => {
      expect(validateOwnerExternalRef(value)).toBe(value);
    },
  );
});
