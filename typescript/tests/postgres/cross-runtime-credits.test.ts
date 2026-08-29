import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { CreditService, InsufficientCreditsError } from "../../src/credits.js";
import { postgresDatabase, postgresDsn } from "../support/postgres-setup.js";

const CREDIT = 1_000_000n;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const temporaryDirectories: string[] = [];

interface WorkerResult {
  readonly outcomes: readonly string[];
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  throw new Error("the Python cross-runtime worker did not reach its barrier");
}

async function startPythonWorker(input: {
  readonly action: "charge" | "refund";
  readonly accountId: string;
  readonly keyPrefix: string;
  readonly amount: string;
  readonly count: number;
  readonly sameKey: boolean;
}): Promise<{
  readonly barrier: string;
  readonly result: Promise<WorkerResult>;
}> {
  const barrier = await mkdtemp(join(tmpdir(), "stripe-cross-runtime-"));
  temporaryDirectories.push(barrier);
  const child = spawn(
    "uv",
    [
      "run",
      "python",
      "typescript/tests/support/python-credit-worker.py",
      input.action,
    ],
    {
      cwd: REPOSITORY_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env["PATH"],
        UV_CACHE_DIR: process.env["UV_CACHE_DIR"],
        CROSS_RUNTIME_DATABASE_URL: postgresDsn(),
        CROSS_RUNTIME_ACCOUNT_ID: input.accountId,
        CROSS_RUNTIME_KEY_PREFIX: input.keyPrefix,
        CROSS_RUNTIME_AMOUNT: input.amount,
        CROSS_RUNTIME_COUNT: String(input.count),
        CROSS_RUNTIME_SAME_KEY: input.sameKey ? "1" : "0",
        CROSS_RUNTIME_BARRIER_DIRECTORY: barrier,
      },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const result = new Promise<WorkerResult>((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(
          new Error(
            `Python cross-runtime worker failed (${String(code)}): ${stderr}`,
          ),
        );
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout) as WorkerResult);
      } catch (error) {
        rejectPromise(
          new Error("Python cross-runtime worker returned invalid JSON", {
            cause: error,
          }),
        );
      }
    });
  });
  await waitForFile(resolve(barrier, "python-ready"));
  return { barrier, result };
}

async function activeAccount(): Promise<string> {
  const accountId = await postgresDatabase().createAccount(
    `cross-runtime:user:${randomUUID()}`,
  );
  await postgresDatabase().query(
    `update billing_accounts
        set plan_key='starter',plan_interval='month',
            subscription_status='active',credits_balance=$2::bigint,
            grant_epoch=1,entitlement_revoked=false,
            credit_expires_at=clock_timestamp()+interval '30 days'
      where id=$1::uuid`,
    [accountId, (300n * CREDIT).toString()],
  );
  return accountId;
}

async function accountBalance(accountId: string): Promise<string | undefined> {
  const result = await postgresDatabase().query<{
    readonly credits_balance: string;
  }>("select credits_balance from billing_accounts where id=$1::uuid", [
    accountId,
  ]);
  return result.rows[0]?.credits_balance;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("mixed Python and TypeScript credit races", () => {
  test("one shared idempotency key commits exactly once across runtimes", async () => {
    const accountId = await activeAccount();
    const key = `cross-runtime:same:${randomUUID()}`;
    const blocker = await postgresDatabase().pool.connect();
    await blocker.query("begin");
    await blocker.query(
      "select id from billing_accounts where id=$1::uuid for update",
      [accountId],
    );
    const worker = await startPythonWorker({
      action: "charge",
      accountId,
      keyPrefix: key,
      amount: "25",
      count: 10,
      sameKey: true,
    });
    const service = new CreditService(postgresDatabase());
    const typescript = Array.from({ length: 10 }, () =>
      service.charge(accountId, "25", key),
    );
    await writeFile(resolve(worker.barrier, "release"), "go\n", "utf8");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
    await blocker.query("commit");
    blocker.release();

    const [python, typescriptResults] = await Promise.all([
      worker.result,
      Promise.all(typescript),
    ]);
    const outcomes = [
      ...python.outcomes,
      ...typescriptResults.map((result) => result.outcome),
    ];
    expect(outcomes.filter((outcome) => outcome === "charged")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "replayed")).toHaveLength(
      19,
    );
    expect(await accountBalance(accountId)).toBe((275n * CREDIT).toString());
  });

  test("distinct keys cannot overdraw under mixed-runtime contention", async () => {
    const accountId = await activeAccount();
    const runId = randomUUID();
    const blocker = await postgresDatabase().pool.connect();
    await blocker.query("begin");
    await blocker.query(
      "select id from billing_accounts where id=$1::uuid for update",
      [accountId],
    );
    const worker = await startPythonWorker({
      action: "charge",
      accountId,
      keyPrefix: `cross-runtime:py:${runId}`,
      amount: "100",
      count: 10,
      sameKey: false,
    });
    const service = new CreditService(postgresDatabase());
    const typescript = Array.from({ length: 10 }, async (_, index) => {
      try {
        return (
          await service.charge(
            accountId,
            "100",
            `cross-runtime:ts:${runId}:${String(index)}`,
          )
        ).outcome;
      } catch (error) {
        if (error instanceof InsufficientCreditsError) return "insufficient";
        throw error;
      }
    });
    await writeFile(resolve(worker.barrier, "release"), "go\n", "utf8");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
    await blocker.query("commit");
    blocker.release();

    const [python, typescriptOutcomes] = await Promise.all([
      worker.result,
      Promise.all(typescript),
    ]);
    const outcomes = [...python.outcomes, ...typescriptOutcomes];
    expect(outcomes.filter((outcome) => outcome === "charged")).toHaveLength(3);
    expect(
      outcomes.filter((outcome) => outcome === "insufficient"),
    ).toHaveLength(17);
    expect(await accountBalance(accountId)).toBe("0");
  });

  test("a mixed-runtime refund restores the original funding once", async () => {
    const accountId = await activeAccount();
    const key = `cross-runtime:refund:${randomUUID()}`;
    const service = new CreditService(postgresDatabase());
    await service.charge(accountId, "80", key);
    const blocker = await postgresDatabase().pool.connect();
    await blocker.query("begin");
    await blocker.query(
      "select id from billing_accounts where id=$1::uuid for update",
      [accountId],
    );
    const worker = await startPythonWorker({
      action: "refund",
      accountId,
      keyPrefix: key,
      amount: "80",
      count: 10,
      sameKey: true,
    });
    const typescript = Array.from({ length: 10 }, () => service.refund(key));
    await writeFile(resolve(worker.barrier, "release"), "go\n", "utf8");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
    await blocker.query("commit");
    blocker.release();

    const [python, typescriptResults] = await Promise.all([
      worker.result,
      Promise.all(typescript),
    ]);
    const outcomes = [
      ...python.outcomes,
      ...typescriptResults.map((result) => result.outcome),
    ];
    expect(outcomes.filter((outcome) => outcome === "refunded")).toHaveLength(
      1,
    );
    expect(outcomes.filter((outcome) => outcome === "replayed")).toHaveLength(
      19,
    );
    expect(await accountBalance(accountId)).toBe((300n * CREDIT).toString());
  });
});
