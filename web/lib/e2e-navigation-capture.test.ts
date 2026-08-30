import { describe, expect, it, vi } from "vitest";

import { E2ENavigationCapture } from "./e2e-navigation-capture";

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("browser E2E navigation capture ordering", () => {
  it("keeps wait and release blocked through fulfill until navigation abort", async () => {
    const capture = new E2ENavigationCapture<{ session_id: string }>();
    const delivery = deferred();
    const fulfill = vi.fn(() => delivery.promise);
    const publishing = capture.publishAfterFulfill(
      { session_id: "bps_fixture" },
      fulfill,
    );

    expect(capture.readyValue()).toBeUndefined();
    expect(() => capture.assertReleasable()).toThrow(
      /before response fulfillment/,
    );

    delivery.resolve();
    await publishing;
    expect(fulfill).toHaveBeenCalledOnce();
    expect(capture.readyValue()).toBeUndefined();
    expect(() => capture.assertReleasable()).toThrow(/and abort/);

    capture.markNavigationAborted();
    expect(capture.readyValue()).toEqual({ session_id: "bps_fixture" });
    expect(() => capture.assertReleasable()).not.toThrow();
  });

  it("also handles navigation abort racing ahead of response fulfillment", async () => {
    const capture = new E2ENavigationCapture<string>();
    const delivery = deferred();
    const publishing = capture.publishAfterFulfill(
      "captured",
      () => delivery.promise,
    );

    capture.markNavigationAborted();
    expect(capture.readyValue()).toBeUndefined();
    expect(() => capture.assertReleasable()).toThrow(
      /before response fulfillment/,
    );

    delivery.resolve();
    await publishing;
    expect(capture.readyValue()).toBe("captured");
    expect(() => capture.assertReleasable()).not.toThrow();
  });

  it("propagates capture failure instead of releasing routes", () => {
    const capture = new E2ENavigationCapture<string>();
    const failure = new Error("route fulfillment failed");
    capture.fail(failure);

    expect(() => capture.readyValue()).toThrow(failure);
    expect(() => capture.assertReleasable()).toThrow(failure);
  });
});
