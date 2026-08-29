/* eslint-disable security/detect-non-literal-fs-filename -- the test owns its mkdtemp directory. */
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { isPlainRecord } from "../../src/validation.js";
import {
  optionalStripeTestSecret,
  requireStripeTestSecret,
} from "../real-stripe/guard.js";
import { RealStripeRun } from "../real-stripe/support.js";

describe("real Stripe credential preflight", () => {
  test.each([
    undefined,
    "",
    "sk_live_1234567890123456",
    "rk_test_1234567890123456",
    "sk_test_short",
    " sk_test_1234567890123456",
    "sk_test_1234567890123456\n",
  ])("rejects a missing, live, restricted, or malformed key %#", (value) => {
    expect(() => requireStripeTestSecret(value)).toThrow(
      /refuse live or malformed keys/u,
    );
  });

  test("accepts a structurally valid test secret without transforming it", () => {
    const value = "sk_test_1234567890ABCDEF";
    expect(requireStripeTestSecret(value)).toBe(value);
  });

  test("lets direct Vitest discovery skip only an absent credential", () => {
    expect(optionalStripeTestSecret(undefined)).toBeUndefined();
    expect(optionalStripeTestSecret("")).toBeUndefined();
    expect(() => optionalStripeTestSecret("sk_live_1234567890123456")).toThrow(
      /refuse/u,
    );
  });

  test("writes a private secret-free interruption manifest", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "stripe-entitlements-ts-real."),
    );
    await chmod(directory, 0o700);
    const previous = process.env["STRIPE_TS_REAL_RECOVERY_DIR"];
    process.env["STRIPE_TS_REAL_RECOVERY_DIR"] = directory;
    const fakeKey = "sk_test_1234567890ABCDEF";
    try {
      const run = new RealStripeRun(fakeKey, "manifest-unit");
      await run.initializeRecovery();
      const manifest = join(directory, `recovery-${run.runId}.json`);
      const payload = await readFile(manifest, "utf8");
      expect(payload).not.toContain(fakeKey);
      expect(payload).not.toContain("whsec_");
      expect(payload).not.toContain("postgresql://");
      expect(JSON.parse(payload)).toMatchObject({
        schema_version: 1,
        secret_free: true,
        implementation: "typescript",
        status: "initialized",
        run_id: run.runId,
      });
      expect((await stat(manifest)).mode & 0o777).toBe(0o600);
    } finally {
      if (previous === undefined) {
        delete process.env["STRIPE_TS_REAL_RECOVERY_DIR"];
      } else {
        process.env["STRIPE_TS_REAL_RECOVERY_DIR"] = previous;
      }
      const entries = await readdir(directory);
      await Promise.all(entries.map((entry) => unlink(join(directory, entry))));
      await rmdir(directory);
    }
  });

  test("keeps concurrent run recovery manifests independent", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "stripe-entitlements-ts-real."),
    );
    await chmod(directory, 0o700);
    const previous = process.env["STRIPE_TS_REAL_RECOVERY_DIR"];
    process.env["STRIPE_TS_REAL_RECOVERY_DIR"] = directory;
    try {
      const first = new RealStripeRun(
        "sk_test_1234567890ABCDEF",
        "manifest-first",
      );
      const second = new RealStripeRun(
        "sk_test_1234567890ABCDEF",
        "manifest-second",
      );
      expect(first.runId).not.toBe(second.runId);
      await Promise.all([
        first.initializeRecovery(),
        second.initializeRecovery(),
      ]);
      const entries = (await readdir(directory)).sort();
      expect(entries).toEqual(
        [
          `recovery-${first.runId}.json`,
          `recovery-${second.runId}.json`,
        ].sort(),
      );
      const manifestRunIds = await Promise.all(
        entries.map(async (entry) => {
          const parsed: unknown = JSON.parse(
            await readFile(join(directory, entry), "utf8"),
          );
          if (!isPlainRecord(parsed) || typeof parsed["run_id"] !== "string") {
            throw new Error("recovery manifest has no run identity");
          }
          return parsed["run_id"];
        }),
      );
      expect(new Set(manifestRunIds)).toEqual(
        new Set([first.runId, second.runId]),
      );
    } finally {
      if (previous === undefined) {
        delete process.env["STRIPE_TS_REAL_RECOVERY_DIR"];
      } else {
        process.env["STRIPE_TS_REAL_RECOVERY_DIR"] = previous;
      }
      const entries = await readdir(directory);
      await Promise.all(entries.map((entry) => unlink(join(directory, entry))));
      await rmdir(directory);
    }
  });

  test("retains one failed run manifest after successful strict cleanup", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "stripe-entitlements-ts-real."),
    );
    await chmod(directory, 0o700);
    const previous = process.env["STRIPE_TS_REAL_RECOVERY_DIR"];
    process.env["STRIPE_TS_REAL_RECOVERY_DIR"] = directory;
    const emptyList = (): AsyncIterable<never> => ({
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            Promise.resolve({ done: true, value: undefined as never } as const),
        };
      },
    });
    try {
      const run = new RealStripeRun(
        "sk_test_1234567890ABCDEF",
        "manifest-failed",
      );
      await run.initializeRecovery();
      vi.spyOn(run.stripe.subscriptionSchedules, "list").mockReturnValue(
        emptyList() as never,
      );
      vi.spyOn(run.stripe.subscriptions, "list").mockReturnValue(
        emptyList() as never,
      );
      vi.spyOn(run.stripe.customers, "list").mockReturnValue(
        emptyList() as never,
      );
      vi.spyOn(run.stripe.prices, "list").mockReturnValue(emptyList() as never);
      vi.spyOn(run.stripe.products, "list").mockReturnValue(
        emptyList() as never,
      );
      vi.spyOn(run.stripe.testHelpers.testClocks, "list").mockReturnValue(
        emptyList() as never,
      );
      await run.cleanup({ retainRecovery: true });
      const entries = await readdir(directory);
      expect(entries).toEqual([`recovery-${run.runId}.json`]);
      const parsed: unknown = JSON.parse(
        await readFile(join(directory, entries[0] ?? "missing"), "utf8"),
      );
      expect(parsed).toMatchObject({
        run_id: run.runId,
        status: "scenario_failed_cleanup_complete",
      });
    } finally {
      vi.restoreAllMocks();
      if (previous === undefined) {
        delete process.env["STRIPE_TS_REAL_RECOVERY_DIR"];
      } else {
        process.env["STRIPE_TS_REAL_RECOVERY_DIR"] = previous;
      }
      const entries = await readdir(directory);
      await Promise.all(entries.map((entry) => unlink(join(directory, entry))));
      await rmdir(directory);
    }
  });
});
