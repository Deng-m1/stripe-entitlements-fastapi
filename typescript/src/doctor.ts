import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { QueryResultRow } from "pg";
import Stripe from "stripe";

import { PlanCatalog } from "./catalog.js";
import type { Settings } from "./config.js";
import { loadSettings } from "./config.js";
import { Database, databasePoolOptions } from "./database.js";
import { portalConfigurationIsSafe } from "./portal-policy.js";
import {
  catalogOneTimePriceMatches,
  catalogPriceMatches,
} from "./price-policy.js";
import { defaultMigrationDirectory } from "./resources.js";
import { isPlainRecord } from "./validation.js";

export const TYPESCRIPT_PACKAGE_VERSION = "0.4.0";

export type DoctorStatus = "pass" | "warning" | "fail" | "skipped";

export class DoctorCheck {
  public readonly name: string;
  public readonly status: DoctorStatus;
  public readonly summary: string;

  public constructor(name: string, status: DoctorStatus, summary: string) {
    this.name = name;
    this.status = status;
    this.summary = summary;
    Object.freeze(this);
  }

  public asObject(): Readonly<Record<string, string>> {
    return { name: this.name, status: this.status, summary: this.summary };
  }
}

export class DoctorReport {
  public readonly version: string;
  public readonly checks: readonly DoctorCheck[];

  public constructor(version: string, checks: readonly DoctorCheck[]) {
    this.version = version;
    this.checks = Object.freeze([...checks]);
    Object.freeze(this);
  }

  public get ok(): boolean {
    return this.checks.every((check) => check.status !== "fail");
  }

  public asObject(): Readonly<Record<string, unknown>> {
    const summary = Object.fromEntries(
      (["pass", "warning", "fail", "skipped"] as const).map((status) => [
        status,
        this.checks.filter((check) => check.status === status).length,
      ]),
    );
    return {
      ok: this.ok,
      version: this.version,
      summary,
      checks: this.checks.map((check) => check.asObject()),
    };
  }
}

export interface DoctorStripeNetwork {
  retrieveAccount(): Promise<unknown>;
  pricesForLookup(lookupKey: string): Promise<readonly unknown[]>;
  retrievePortalConfiguration(configurationId: string): Promise<unknown>;
}

export interface RunDoctorOptions {
  readonly settings?: Settings;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly database?: Database;
  readonly stripeNetwork?: boolean;
  readonly network?: DoctorStripeNetwork;
  readonly migrationDirectory?: string;
}

const PLACEHOLDER_MARKERS = [
  "replace_me",
  "replace-with",
  "replace_with",
  "changeme",
  "change_me",
  "dummy",
  "your_key",
  "your_secret",
] as const;
const VERSION = /^\d{4}-\d{2}-\d{2}\.[a-z][a-z0-9_]*$/u;

function isPlaceholder(value: string | null): boolean {
  if (value === null) {
    return false;
  }
  const normalized = value.toLowerCase().replaceAll(" ", "_");
  return PLACEHOLDER_MARKERS.some((marker) => normalized.includes(marker));
}

function exceptionKind(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "UnknownError";
}

function check(
  name: string,
  status: DoctorStatus,
  summary: string,
): DoctorCheck {
  return new DoctorCheck(name, status, summary);
}

interface MigrationDigest {
  readonly filename: string;
  readonly sha256: string;
}

async function migrationDigests(directory: string): Promise<MigrationDigest[]> {
  // The operator-selected doctor target is intentionally dynamic and read-only.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) {
    throw new Error("empty migration bundle");
  }
  return Promise.all(
    files.map(async (filename) => {
      // `filename` comes only from the just-enumerated directory entries.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const payload = await readFile(resolve(directory, filename));
      return {
        filename: basename(filename),
        sha256: createHash("sha256").update(payload).digest("hex"),
      };
    }),
  );
}

function bareOrigin(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.username.length === 0 &&
    parsed.password.length === 0 &&
    parsed.pathname === "/" &&
    parsed.search.length === 0 &&
    parsed.hash.length === 0 &&
    parsed.origin === value.replace(/\/$/u, "")
  );
}

function safePublicUrl(value: string, allowQuery: boolean): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.host.length > 0 &&
    parsed.username.length === 0 &&
    parsed.password.length === 0 &&
    parsed.hash.length === 0 &&
    (allowQuery || parsed.search.length === 0)
  );
}

function configurationChecks(settings: Settings): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const sensitive: readonly [string, string | null][] = [
    ["STRIPE_SECRET_KEY", settings.stripeSecretKey],
    ["STRIPE_WEBHOOK_SECRET", settings.stripeWebhookSecret],
    ["DEMO_BEARER_TOKEN", settings.demoBearerToken],
  ];
  const placeholders = sensitive
    .filter(([, value]) => isPlaceholder(value))
    .map(([name]) => name)
    .sort();
  checks.push(
    placeholders.length === 0
      ? check(
          "config.placeholders",
          "pass",
          "no known secret placeholders detected",
        )
      : check(
          "config.placeholders",
          "fail",
          `placeholder value detected in: ${placeholders.join(", ")}`,
        ),
  );

  const live = settings.stripeSecretKey.startsWith("sk_live_");
  checks.push(
    live && settings.appEnv === "development"
      ? check(
          "stripe.mode",
          "warning",
          "live Stripe credentials are paired with development mode; demo auth remains disabled",
        )
      : check(
          "stripe.mode",
          "pass",
          `configuration selects ${live ? "live" : "test"} mode`,
        ),
  );

  const portal = settings.stripePortalConfigurationId;
  if (portal === null) {
    checks.push(
      check(
        "stripe.portal_configuration",
        "fail",
        "STRIPE_PORTAL_CONFIGURATION_ID is required for Portal sessions",
      ),
    );
  } else if (isPlaceholder(portal)) {
    checks.push(
      check(
        "stripe.portal_configuration",
        "fail",
        "Portal configuration ID is still a placeholder",
      ),
    );
  } else {
    checks.push(
      check(
        "stripe.portal_configuration",
        "pass",
        "Portal configuration ID format is valid",
      ),
    );
  }

  checks.push(
    VERSION.test(settings.stripeApiVersion) &&
      VERSION.test(settings.stripeWebhookApiVersion)
      ? check(
          "stripe.version_contracts",
          "pass",
          "outbound and signed webhook API versions are independently pinned",
        )
      : check(
          "stripe.version_contracts",
          "fail",
          "one or both Stripe version formats are invalid",
        ),
  );

  const origins = settings.frontendOrigins
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/u, ""))
    .filter((origin) => origin.length > 0);
  const publicValues = [
    settings.checkoutSuccessUrl,
    settings.checkoutCancelUrl,
    settings.portalReturnUrl,
  ];
  let urlsValid =
    safePublicUrl(settings.checkoutSuccessUrl, false) &&
    safePublicUrl(settings.checkoutCancelUrl, true) &&
    safePublicUrl(settings.portalReturnUrl, true);
  let corsValid =
    origins.length > 0 &&
    !origins.includes("*") &&
    new Set(origins).size === origins.length &&
    origins.every((origin) => bareOrigin(origin));
  if (live) {
    const values = [...publicValues, ...origins];
    urlsValid =
      urlsValid &&
      values.every((value) => {
        const parsed = new URL(value);
        return (
          parsed.protocol === "https:" &&
          !["localhost", "127.0.0.1", "[::1]", "::1"].includes(
            parsed.hostname.toLowerCase(),
          )
        );
      });
    corsValid =
      corsValid &&
      origins.every((origin) => new URL(origin).protocol === "https:");
  }
  checks.push(
    urlsValid && corsValid
      ? check(
          "http.urls_and_cors",
          "pass",
          `configured URLs and ${String(origins.length)} credentialed CORS origin(s) are structurally safe`,
        )
      : check(
          "http.urls_and_cors",
          "fail",
          "URL/CORS contract is invalid for the configured Stripe mode",
        ),
  );
  return checks;
}

function plainStripeObject(value: unknown): Readonly<Record<string, unknown>> {
  const serialized = JSON.stringify(value);
  const parsed: unknown = JSON.parse(serialized);
  if (!isPlainRecord(parsed)) {
    throw new Error("Stripe returned a non-object value");
  }
  return parsed;
}

class StripeSdkDoctorNetwork implements DoctorStripeNetwork {
  readonly #client: Stripe;

  public constructor(settings: Settings) {
    this.#client = new Stripe(settings.stripeSecretKey, {
      apiVersion: settings.stripeApiVersion as Stripe.LatestApiVersion,
    });
  }

  public async retrieveAccount(): Promise<unknown> {
    return this.#client.accounts.retrieve(null);
  }

  public async pricesForLookup(lookupKey: string): Promise<readonly unknown[]> {
    const page = await this.#client.prices.list({
      lookup_keys: [lookupKey],
      active: true,
      limit: 2,
      expand: ["data.currency_options", "data.product"],
    });
    if (page.has_more) {
      throw new Error("Stripe catalog cardinality drift");
    }
    return page.data;
  }

  public async retrievePortalConfiguration(
    configurationId: string,
  ): Promise<unknown> {
    return this.#client.billingPortal.configurations.retrieve(configurationId);
  }
}

async function stripeChecks(
  settings: Settings,
  catalog: PlanCatalog | undefined,
  enabled: boolean,
  network: DoctorStripeNetwork | undefined,
): Promise<DoctorCheck[]> {
  if (!enabled) {
    return [
      check(
        "stripe.network",
        "skipped",
        "not requested; no Stripe API request was made (use --stripe-network)",
      ),
      check(
        "stripe.webhook_endpoint",
        "skipped",
        "no endpoint ID is configured; version configuration is not delivery evidence",
      ),
      check(
        "stripe.network.catalog",
        "skipped",
        "not requested; Stripe catalog inventory was not read",
      ),
    ];
  }
  if (isPlaceholder(settings.stripeSecretKey)) {
    return [
      check(
        "stripe.network",
        "skipped",
        "network verification refused because the Stripe key is a placeholder",
      ),
      check(
        "stripe.webhook_endpoint",
        "skipped",
        "no endpoint ID is configured; version configuration is not delivery evidence",
      ),
      check(
        "stripe.network.catalog",
        "skipped",
        "catalog inventory verification refused for a placeholder key",
      ),
    ];
  }
  const client = network ?? new StripeSdkDoctorNetwork(settings);
  const checks: DoctorCheck[] = [];
  try {
    await client.retrieveAccount();
    checks.push(
      check(
        "stripe.network.account",
        "pass",
        "read-only account retrieval succeeded",
      ),
    );
  } catch (error) {
    checks.push(
      check(
        "stripe.network.account",
        "fail",
        `read-only account retrieval failed (${exceptionKind(error)})`,
      ),
    );
  }

  if (catalog === undefined) {
    checks.push(
      check(
        "stripe.network.catalog",
        "skipped",
        "local catalog validation failed, so remote inventory was not checked",
      ),
    );
  } else {
    try {
      let recurring = 0;
      let packs = 0;
      for (const plan of catalog.ordered()) {
        for (const planInterval of ["month", "year"] as const) {
          const lookupKey = catalog.lookupKey(plan.key, planInterval);
          const prices = await client.pricesForLookup(lookupKey);
          if (
            prices.length !== 1 ||
            !catalogPriceMatches(plainStripeObject(prices[0]), {
              expectedCurrency: plan.currency,
              expectedUnitAmount:
                (planInterval === "month" ? plan.monthUsd : plan.yearUsd) * 100,
              expectedInterval: planInterval,
              expectedProductLine: settings.productLine,
              expectedPlanKey: plan.key,
              expectedLookupKey: lookupKey,
            })
          ) {
            throw new Error("Stripe recurring catalog contract drift");
          }
          recurring += 1;
        }
      }
      for (const pack of catalog.orderedCreditPacks()) {
        const lookupKey = catalog.creditPackLookupKey(pack.key);
        const prices = await client.pricesForLookup(lookupKey);
        if (
          prices.length !== 1 ||
          !catalogOneTimePriceMatches(plainStripeObject(prices[0]), {
            expectedCurrency: pack.currency,
            expectedUnitAmount: pack.priceUsd * 100,
            expectedProductLine: settings.productLine,
            expectedPackKey: pack.key,
            expectedLookupKey: lookupKey,
          })
        ) {
          throw new Error("Stripe credit-pack catalog contract drift");
        }
        packs += 1;
      }
      checks.push(
        check(
          "stripe.network.catalog",
          "pass",
          `${String(recurring)} recurring and ${String(packs)} one-time Price contract(s) match`,
        ),
      );
    } catch (error) {
      checks.push(
        check(
          "stripe.network.catalog",
          "fail",
          `read-only Stripe catalog verification failed (${exceptionKind(error)})`,
        ),
      );
    }
  }

  const portalId = settings.stripePortalConfigurationId;
  if (portalId === null || isPlaceholder(portalId)) {
    checks.push(
      check(
        "stripe.network.portal",
        "skipped",
        "Portal retrieval requires a non-placeholder configuration ID",
      ),
    );
  } else {
    try {
      const raw = plainStripeObject(
        await client.retrievePortalConfiguration(portalId),
      );
      const safe =
        raw["id"] === portalId &&
        portalConfigurationIsSafe(raw, {
          expectedLivemode: settings.stripeSecretKey.startsWith("sk_live_"),
          expectedProductLine: settings.productLine,
        });
      checks.push(
        check(
          "stripe.network.portal",
          safe ? "pass" : "fail",
          safe
            ? "Portal identity and mode match; updates are disabled and cancellation is period-end only"
            : "Portal identity or safety policy drifted from the server contract",
        ),
      );
    } catch (error) {
      checks.push(
        check(
          "stripe.network.portal",
          "fail",
          `read-only Portal retrieval failed (${exceptionKind(error)})`,
        ),
      );
    }
  }
  checks.push(
    check(
      "stripe.webhook_endpoint",
      "skipped",
      "no endpoint ID is configured; signed payload delivery still needs deployment evidence",
    ),
  );
  return checks;
}

function connected(database: Database): boolean {
  try {
    database.requirePool();
    return true;
  } catch {
    return false;
  }
}

interface MigrationHistoryRow extends QueryResultRow {
  readonly filename: string;
  readonly sha256: string;
}

/** Run read-only local, PostgreSQL and explicitly opt-in Stripe checks. */
export async function runDoctor(
  options: RunDoctorOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    check(
      "package.version",
      "pass",
      `TypeScript runtime version is ${TYPESCRIPT_PACKAGE_VERSION}`,
    ),
  ];
  let digests: MigrationDigest[] | undefined;
  try {
    digests = await migrationDigests(
      options.migrationDirectory ?? defaultMigrationDirectory(),
    );
    checks.push(
      check(
        "package.migrations",
        "pass",
        `${String(digests.length)} bundled migration(s) are readable`,
      ),
    );
  } catch (error) {
    checks.push(
      check(
        "package.migrations",
        "fail",
        `bundled migrations are unavailable (${exceptionKind(error)})`,
      ),
    );
  }

  let settings: Settings;
  try {
    settings =
      options.settings ?? loadSettings(options.environment ?? process.env);
  } catch (error) {
    checks.push(
      check(
        "config.load",
        "fail",
        `configuration validation failed (${exceptionKind(error)})`,
      ),
      check("catalog.load", "skipped", "configuration is unavailable"),
      check("database.connection", "skipped", "configuration is unavailable"),
      check("database.schema", "skipped", "database was not checked"),
      check(
        "database.migration_checksums",
        "skipped",
        "database was not checked",
      ),
      check("stripe.network", "skipped", "configuration is unavailable"),
      check(
        "stripe.webhook_endpoint",
        "skipped",
        "configuration is unavailable and no delivery evidence was checked",
      ),
    );
    return new DoctorReport(TYPESCRIPT_PACKAGE_VERSION, checks);
  }
  checks.push(check("config.load", "pass", "typed configuration loaded"));
  checks.push(...configurationChecks(settings));

  let catalog: PlanCatalog | undefined;
  try {
    catalog = await PlanCatalog.fromToml(
      settings.planCatalogPath,
      settings.lookupPrefix,
    );
    checks.push(
      check(
        "catalog.load",
        "pass",
        `catalog contains ${String(catalog.plans.size)} validated plan(s) and ${String(catalog.creditPacks.size)} credit pack(s)`,
      ),
    );
  } catch (error) {
    checks.push(
      check(
        "catalog.load",
        "fail",
        `catalog validation failed (${exceptionKind(error)})`,
      ),
    );
  }

  const database =
    options.database ??
    new Database(settings.databaseUrl, databasePoolOptions(settings));
  const connectedHere = !connected(database);
  let reachable = false;
  try {
    if (connectedHere) {
      await database.connect();
    }
    await database.query("select 1");
    reachable = true;
    checks.push(
      check("database.connection", "pass", "PostgreSQL is reachable"),
    );
  } catch (error) {
    checks.push(
      check(
        "database.connection",
        "fail",
        `PostgreSQL connection failed (${exceptionKind(error)})`,
      ),
    );
  }

  if (reachable) {
    try {
      const ready = await database.schemaReady(
        options.migrationDirectory ?? defaultMigrationDirectory(),
      );
      checks.push(
        check(
          "database.schema",
          ready ? "pass" : "fail",
          ready
            ? "bundled schema is ready"
            : "schema is not ready; run migrate",
        ),
      );
    } catch (error) {
      checks.push(
        check(
          "database.schema",
          "fail",
          `schema readiness check failed (${exceptionKind(error)})`,
        ),
      );
    }
    if (digests === undefined) {
      checks.push(
        check(
          "database.migration_checksums",
          "skipped",
          "bundled migration digests are unavailable",
        ),
      );
    } else {
      try {
        const historyExists = await database.query<
          { readonly present: boolean } & QueryResultRow
        >(
          "select to_regclass('public.schema_migrations') is not null as present",
        );
        const rows =
          historyExists.rows[0]?.present === true
            ? await database.query<MigrationHistoryRow>(
                "select filename,sha256 from schema_migrations",
              )
            : { rows: [] as MigrationHistoryRow[] };
        const applied = new Map(
          rows.rows.map((row) => [row.filename, row.sha256]),
        );
        const valid = digests.every(
          (digest) => applied.get(digest.filename) === digest.sha256,
        );
        checks.push(
          check(
            "database.migration_checksums",
            valid ? "pass" : "fail",
            valid
              ? "all bundled migration checksums match applied history"
              : "migration history is missing or has a checksum mismatch",
          ),
        );
      } catch (error) {
        checks.push(
          check(
            "database.migration_checksums",
            "fail",
            `migration history check failed (${exceptionKind(error)})`,
          ),
        );
      }
    }
  } else {
    checks.push(
      check("database.schema", "skipped", "database connection failed"),
      check(
        "database.migration_checksums",
        "skipped",
        "database connection failed",
      ),
    );
  }
  if (connectedHere) {
    await database.close().catch(() => undefined);
  }

  checks.push(
    ...(await stripeChecks(
      settings,
      catalog,
      options.stripeNetwork === true,
      options.network,
    )),
  );
  return new DoctorReport(TYPESCRIPT_PACKAGE_VERSION, checks);
}
