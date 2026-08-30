import { loadDatabaseSettings } from "../config.js";
import { Database, databasePoolOptions } from "../database.js";
import { createBillingRuntimeFromEnvironment } from "../deployment.js";
import { runDoctor, TYPESCRIPT_PACKAGE_VERSION } from "../doctor.js";
import {
  runStripeBootstrap,
  type StripeBootstrapNetworkFactory,
} from "../stripe-bootstrap.js";
import { startNodeBillingApplicationFromEnvironment } from "./application.js";

export type NodeBillingCommand =
  | { readonly name: "serve" }
  | { readonly name: "version" }
  | { readonly name: "migrate" }
  | {
      readonly name: "doctor";
      readonly json: boolean;
      readonly stripeNetwork: boolean;
    }
  | {
      readonly name: "bootstrap";
      readonly verifyOnly: boolean;
      readonly allowLive: boolean;
      readonly confirmedLiveProductLine: string | null;
      readonly catalogPath: string | null;
      readonly lookupPrefix: string | null;
      readonly productLine: string | null;
    }
  | { readonly name: "cron"; readonly job: "annual-grants" | "reconcile" };

export interface BillingCliIo {
  out(value: string): void;
  error(value: string): void;
}

export interface BillingCliDependencies {
  readonly bootstrapNetworkFactory?: StripeBootstrapNetworkFactory;
}

const BOOTSTRAP_VALUE_FLAGS = new Set([
  "--confirm-live-product-line",
  "--catalog",
  "--lookup-prefix",
  "--product-line",
]);

function parseBootstrapCommand(argv: readonly string[]): NodeBillingCommand {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) {
      throw new TypeError("invalid bootstrap command");
    }
    if (flag === "--verify-only" || flag === "--allow-live") {
      if (booleans.has(flag)) {
        throw new TypeError("duplicate bootstrap flag");
      }
      booleans.add(flag);
      continue;
    }
    if (!BOOTSTRAP_VALUE_FLAGS.has(flag) || values.has(flag)) {
      throw new TypeError("invalid bootstrap flag");
    }
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new TypeError("bootstrap flag requires a value");
    }
    values.set(flag, value);
    index += 1;
  }
  return {
    name: "bootstrap",
    verifyOnly: booleans.has("--verify-only"),
    allowLive: booleans.has("--allow-live"),
    confirmedLiveProductLine: values.get("--confirm-live-product-line") ?? null,
    catalogPath: values.get("--catalog") ?? null,
    lookupPrefix: values.get("--lookup-prefix") ?? null,
    productLine: values.get("--product-line") ?? null,
  };
}

export function parseNodeBillingCommand(
  argv: readonly string[],
): NodeBillingCommand {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "serve")) {
    return { name: "serve" };
  }
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "version")) {
    return { name: "version" };
  }
  if (argv.length === 1 && argv[0] === "migrate") {
    return { name: "migrate" };
  }
  if (argv[0] === "bootstrap") {
    try {
      return parseBootstrapCommand(argv.slice(1));
    } catch {
      throw new TypeError(
        "usage: stripe-entitlements bootstrap [--verify-only] [--catalog PATH] [--lookup-prefix PREFIX] [--product-line LINE] [--allow-live --confirm-live-product-line LINE]",
      );
    }
  }
  if (argv[0] === "doctor") {
    const flags = argv.slice(1);
    if (
      flags.some((flag) => flag !== "--json" && flag !== "--stripe-network") ||
      new Set(flags).size !== flags.length
    ) {
      throw new TypeError(
        "usage: stripe-entitlements doctor [--json] [--stripe-network]",
      );
    }
    return {
      name: "doctor",
      json: flags.includes("--json"),
      stripeNetwork: flags.includes("--stripe-network"),
    };
  }
  if (
    argv.length === 2 &&
    argv[0] === "cron" &&
    (argv[1] === "annual-grants" || argv[1] === "reconcile")
  ) {
    return { name: "cron", job: argv[1] };
  }
  throw new TypeError(
    "usage: stripe-entitlements [--version|serve|migrate|bootstrap|doctor|cron annual-grants|cron reconcile]",
  );
}

function sanitizedFailure(error: unknown): string {
  const kind = error instanceof Error ? error.constructor.name : "UnknownError";
  return JSON.stringify({ ok: false, error: kind });
}

export async function runNodeBillingCommand(
  command: NodeBillingCommand,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  io: BillingCliIo = {
    out: (value) => console.log(value),
    error: (value) => console.error(value),
  },
  dependencies: BillingCliDependencies = {},
): Promise<number> {
  try {
    if (command.name === "version") {
      io.out(`stripe-entitlements ${TYPESCRIPT_PACKAGE_VERSION}`);
      return 0;
    }

    if (command.name === "serve") {
      const application =
        await startNodeBillingApplicationFromEnvironment(environment);
      io.out(
        JSON.stringify({
          ok: true,
          command: "serve",
          host: application.host,
          port: application.port,
        }),
      );
      const shutdown = async (): Promise<void> => {
        await application.close();
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
      return 0;
    }

    if (command.name === "migrate") {
      const settings = loadDatabaseSettings(environment);
      const database = new Database(
        settings.databaseUrl,
        databasePoolOptions(settings),
      );
      await database.connect();
      try {
        await database.applyMigrations();
      } finally {
        await database.close();
      }
      io.out(JSON.stringify({ ok: true, command: "migrate" }));
      return 0;
    }

    if (command.name === "doctor") {
      const report = await runDoctor({
        environment,
        stripeNetwork: command.stripeNetwork,
      });
      if (command.json) {
        io.out(JSON.stringify(report.asObject()));
      } else {
        const labels: Readonly<Record<string, string>> = {
          pass: "PASS",
          warning: "WARN",
          fail: "FAIL",
          skipped: "SKIP",
        };
        for (const item of report.checks) {
          io.out(
            `${labels[item.status] ?? "????"} ${item.name}: ${item.summary}`,
          );
        }
        const summary = report.asObject()["summary"] as Readonly<
          Record<string, number>
        >;
        io.out(
          `doctor summary: pass=${String(summary["pass"])} warning=${String(summary["warning"])} fail=${String(summary["fail"])} skipped=${String(summary["skipped"])}`,
        );
      }
      return report.ok ? 0 : 1;
    }

    if (command.name === "bootstrap") {
      const report = await runStripeBootstrap({
        secretKey: environment["STRIPE_SECRET_KEY"],
        apiVersion: environment["STRIPE_API_VERSION"],
        catalogPath: command.catalogPath ?? environment["PLAN_CATALOG_PATH"],
        lookupPrefix: command.lookupPrefix ?? environment["LOOKUP_PREFIX"],
        productLine: command.productLine ?? environment["PRODUCT_LINE"],
        verifyOnly: command.verifyOnly,
        allowLive: command.allowLive,
        confirmedLiveProductLine: command.confirmedLiveProductLine,
        networkFactory: dependencies.bootstrapNetworkFactory,
      });
      io.out(JSON.stringify(report));
      return 0;
    }

    const runtime = await createBillingRuntimeFromEnvironment(environment);
    try {
      const response = await runtime.services.runCron(
        command.job,
        new Request(`http://localhost/api/cron/${command.job}`),
      );
      io.out(JSON.stringify(response.body));
      return response.status >= 200 && response.status < 300 ? 0 : 2;
    } finally {
      await runtime.close();
    }
  } catch (error) {
    io.error(sanitizedFailure(error));
    return 1;
  }
}
