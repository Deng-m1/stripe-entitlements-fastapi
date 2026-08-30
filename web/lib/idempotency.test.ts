import { afterEach, describe, expect, it } from "vitest";
import {
  clearAllIdempotentIntents,
  completeIdempotentIntent,
  idempotencyKeyForIntent,
} from "@/lib/idempotency";

describe("idempotent intent keys", () => {
  const intent = "test:checkout:starter:month";

  afterEach(() => {
    clearAllIdempotentIntents();
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

  it("clears every billing intent but preserves unrelated host state", () => {
    const first = idempotencyKeyForIntent(intent);
    const second = idempotencyKeyForIntent("test:portal");
    window.sessionStorage.setItem("host:theme", "dark");

    clearAllIdempotentIntents();

    expect(idempotencyKeyForIntent(intent)).not.toBe(first);
    expect(idempotencyKeyForIntent("test:portal")).not.toBe(second);
    expect(window.sessionStorage.getItem("host:theme")).toBe("dark");
  });
});
