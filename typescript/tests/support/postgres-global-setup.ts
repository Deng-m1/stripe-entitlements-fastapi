import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execute = promisify(execFile);
const TEST_DATABASE = "stripe_entitlements_ts_test";
const TEST_PASSWORD = "local-test-only";
const TEST_SUITE = "typescript-postgres";
const TEST_SUITE_LABEL = "io.tosea.stripe-entitlements.test-suite";
const OWNER_PID_LABEL = "io.tosea.stripe-entitlements.owner-pid";
const RUN_ID_LABEL = "io.tosea.stripe-entitlements.run-id";
const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

type DockerRunner = (arguments_: readonly string[]) => Promise<string>;
type SynchronousDockerRunner = (arguments_: readonly string[]) => string;

interface TestContainer {
  readonly id: string;
  readonly ownerPid: number;
}

async function docker(arguments_: readonly string[]): Promise<string> {
  const result = await execute("docker", [...arguments_], {
    encoding: "utf8",
    timeout: 90_000,
  });
  return result.stdout.trim();
}

function dockerSynchronously(arguments_: readonly string[]): string {
  return execFileSync("docker", [...arguments_], {
    encoding: "utf8",
    timeout: 90_000,
  }).trim();
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

function parseOwnerPid(value: string): number | undefined {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseTestContainers(
  listing: string,
  warn: (message: string) => void = console.warn,
): readonly TestContainer[] {
  const containers: TestContainer[] = [];
  for (const line of listing.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const [id, ownerPidValue] = line.split("\t");
    const ownerPid = parseOwnerPid(ownerPidValue ?? "");
    if (id === undefined || id.length === 0 || ownerPid === undefined) {
      warn(`skipping malformed disposable PostgreSQL container: ${line}`);
      continue;
    }
    containers.push({ id, ownerPid });
  }
  return containers;
}

export async function removeContainer(
  container: string,
  runDocker: DockerRunner = docker,
): Promise<void> {
  await runDocker(["rm", "-f", container]);
}

export function removeContainerSynchronously(
  container: string,
  runDocker: SynchronousDockerRunner = dockerSynchronously,
): void {
  runDocker(["rm", "-f", container]);
}

export async function sweepOrphanedContainers(
  runDocker: DockerRunner = docker,
  isOwnerAlive: (pid: number) => boolean = processIsAlive,
  warn: (message: string) => void = console.warn,
): Promise<readonly string[]> {
  const listing = await runDocker([
    "ps",
    "--all",
    "--filter",
    `label=${TEST_SUITE_LABEL}=${TEST_SUITE}`,
    "--format",
    `{{.ID}}\t{{.Label "${OWNER_PID_LABEL}"}}`,
  ]);
  const removed: string[] = [];
  for (const container of parseTestContainers(listing, warn)) {
    if (isOwnerAlive(container.ownerPid)) {
      continue;
    }
    await removeContainer(container.id, runDocker);
    removed.push(container.id);
  }
  return removed;
}

function registerSignalCleanup(container: string): () => void {
  let receivedSignal: (typeof CLEANUP_SIGNALS)[number] | undefined;
  const handlers = new Map<NodeJS.Signals, () => void>();
  const unregister = (): void => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
    handlers.clear();
  };

  for (const signal of CLEANUP_SIGNALS) {
    const handler = (): void => {
      if (receivedSignal !== undefined) {
        return;
      }
      receivedSignal = signal;
      unregister();
      delete process.env["STRIPE_ENTITLEMENTS_TS_TEST_DSN"];
      try {
        // Vitest schedules process.exit() one millisecond after SIGINT/SIGTERM.
        // A normal async listener loses that race, so signal cleanup must block
        // until Docker confirms removal. The next setup's labeled orphan sweep
        // remains the SIGKILL and Docker-daemon-failure fallback.
        removeContainerSynchronously(container);
      } catch (error) {
        console.error(
          "failed to remove disposable PostgreSQL after process signal",
          error,
        );
      }
      const exitCodes: Record<(typeof CLEANUP_SIGNALS)[number], number> = {
        SIGINT: 130,
        SIGTERM: 143,
        SIGHUP: 129,
      };
      process.exitCode = exitCodes[signal];
      setTimeout(() => process.exit(), 100).unref();
    };
    handlers.set(signal, handler);
    process.prependListener(signal, handler);
  }
  return unregister;
}

export default async function postgresGlobalSetup(): Promise<
  () => Promise<void>
> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const container = `stripe-entitlements-ts-pg-${suffix}`;
  const runId = randomUUID();
  const configuredImage = process.env["TEST_POSTGRES_IMAGE"]?.trim();
  const image =
    configuredImage !== undefined && configuredImage.length > 0
      ? configuredImage
      : "postgres:17-alpine";
  let started = false;
  try {
    await sweepOrphanedContainers();
    await docker([
      "run",
      "-d",
      "--name",
      container,
      "--label",
      `${TEST_SUITE_LABEL}=${TEST_SUITE}`,
      "--label",
      `${OWNER_PID_LABEL}=${process.pid}`,
      "--label",
      `${RUN_ID_LABEL}=${runId}`,
      "--tmpfs",
      "/var/lib/postgresql/data:rw,nosuid,nodev,size=512m",
      "-e",
      `POSTGRES_PASSWORD=${TEST_PASSWORD}`,
      "-e",
      `POSTGRES_DB=${TEST_DATABASE}`,
      "-p",
      "127.0.0.1::5432",
      image,
    ]);
    started = true;

    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        await docker([
          "exec",
          container,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
          "-d",
          TEST_DATABASE,
        ]);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!ready) {
      throw new Error("disposable PostgreSQL 17 did not become ready");
    }
    const binding = await docker(["port", container, "5432/tcp"]);
    const match = /127\.0\.0\.1:(\d+)/u.exec(binding);
    if (match?.[1] === undefined) {
      throw new Error(
        `cannot determine the disposable PostgreSQL port: ${binding}`,
      );
    }
    process.env["STRIPE_ENTITLEMENTS_TS_TEST_DSN"] =
      `postgresql://postgres:${TEST_PASSWORD}@127.0.0.1:${match[1]}/${TEST_DATABASE}`;
  } catch (error) {
    if (started) {
      try {
        await removeContainer(container);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "disposable PostgreSQL setup and cleanup both failed",
        );
      }
    }
    throw error;
  }

  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async (): Promise<void> => {
      delete process.env["STRIPE_ENTITLEMENTS_TS_TEST_DSN"];
      await removeContainer(container);
    })();
    return cleanupPromise;
  };
  const unregisterSignalCleanup = registerSignalCleanup(container);

  return async (): Promise<void> => {
    try {
      await cleanup();
    } finally {
      unregisterSignalCleanup();
    }
  };
}
