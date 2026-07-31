import { afterEach, describe, expect, it } from "vitest";
import {
  completeIdempotentIntent,
  idempotencyKeyForIntent,
} from "@/lib/idempotency";

describe("idempotent intent keys", () => {
  const intent = "test:checkout:starter:month";

  afterEach(() => {
    completeIdempotentIntent(intent);
    window.sessionStorage.clear();
  });

  it("reuses a key from session storage until the intent completes", () => {
    const first = idempotencyKeyForIntent(intent);
    const second = idempotencyKeyForIntent(intent);
    expect(second).toBe(first);
    expect(JSON.stringify(window.sessionStorage)).not.toContain("client_secret");

    completeIdempotentIntent(intent);
    expect(idempotencyKeyForIntent(intent)).not.toBe(first);
  });
});
