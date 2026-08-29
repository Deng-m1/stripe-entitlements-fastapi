import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import pg from "pg";
import type {
  CustomTypesConfig,
  PoolConfig,
  QueryResult,
  QueryResultRow,
} from "pg";

import type {
  BillingAccountRow,
  BillingPlanChangeRow,
  TransactionClient,
} from "./db-types.js";
import type { DatabaseSettings } from "./config.js";
import { asTransactionClient } from "./db-types.js";
import { validateOwnerExternalRef } from "./owner-reference.js";
import { defaultMigrationDirectory } from "./resources.js";

const { Pool, types: defaultTypes } = pg;

const MIGRATION_NAME = /^(\d{3})_[a-z0-9][a-z0-9_]*\.sql$/u;
const V3_BASELINE_MIGRATION = "001_v3_baseline.sql";
const PRE_V3_BASELINE_MIGRATION = "001_schema.sql";
const MIGRATION_ADVISORY_LOCK = "7769476304708398194";
const STRING_TYPE_OIDS = new Set([20, 1114, 1184, 1700]);

const PRIVATE_PG_TYPES: CustomTypesConfig = {
  getTypeParser(oid, format = "text") {
    if (format === "text" && STRING_TYPE_OIDS.has(oid)) {
      return (value: string): string => value;
    }
    return defaultTypes.getTypeParser(oid, format) as (
      value: string,
    ) => unknown;
  },
};

const CORRECTNESS_TABLES = [
  "billing_accounts",
  "stripe_webhook_events",
  "stripe_invoice_state",
  "credit_ledger",
  "credit_debits",
  "credit_pack_orders",
  "credit_funding_lots",
  "credit_debit_allocations",
  "credit_pack_clawback_debts",
  "checkout_claims",
  "billing_plan_changes",
  "billing_funding_allocations",
  "billing_clawback_debts",
  "billing_incidents",
] as const;

interface MigrationFile {
  readonly filename: string;
  readonly sql: string;
  readonly sha256: string;
}

interface MigrationHistoryRow extends QueryResultRow {
  readonly filename: string;
  readonly sha256: string;
}

export type DatabasePoolOptions = Omit<
  PoolConfig,
  "connectionString" | "types"
>;

export function databasePoolOptions(
  settings: DatabaseSettings,
): DatabasePoolOptions {
  return {
    min: settings.databasePoolMin,
    max: settings.databasePoolMax,
    idleTimeoutMillis: settings.databasePoolIdleTimeoutMs,
    connectionTimeoutMillis: settings.databaseConnectTimeoutMs,
  };
}

function errorWithCause(message: string, cause: unknown): Error {
  return new Error(message, { cause });
}

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function migrationPaths(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw errorWithCause(
      `migration directory does not exist: ${directory}`,
      error,
    );
  }
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new Error(`migration directory contains no SQL files: ${directory}`);
  }
  const sequences = names.map((name) => {
    const match = MIGRATION_NAME.exec(name);
    if (match?.[1] === undefined) {
      throw new Error(`invalid migration filename: ${JSON.stringify(name)}`);
    }
    return Number.parseInt(match[1], 10);
  });
  const expected = sequences.map((_, index) => index + 1);
  if (sequences.some((sequence, index) => sequence !== expected[index])) {
    throw new Error(
      `migration filenames must form one contiguous append-only sequence starting at 001; observed=${sequences.join(",")}`,
    );
  }
  return names.map((name) => resolve(directory, name));
}

async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return Promise.all(
    (await migrationPaths(directory)).map(async (path) => {
      const payload = await readFile(path);
      return {
        filename: basename(path),
        sql: decoder.decode(payload),
        sha256: createHash("sha256").update(payload).digest("hex"),
      };
    }),
  );
}

export class Database {
  readonly #dsn: string;
  readonly #options: DatabasePoolOptions;
  #pool: InstanceType<typeof Pool> | undefined;

  public constructor(dsn: string, options: DatabasePoolOptions = {}) {
    if (typeof dsn !== "string" || dsn.trim().length === 0) {
      throw new TypeError("database DSN must be a non-empty string");
    }
    this.#dsn = dsn;
    this.#options = { ...options };
  }

  public get pool(): InstanceType<typeof Pool> {
    return this.requirePool();
  }

  public requirePool(): InstanceType<typeof Pool> {
    if (this.#pool === undefined) {
      throw new Error("database is not connected");
    }
    return this.#pool;
  }

  public async connect(): Promise<void> {
    if (this.#pool !== undefined) {
      throw new Error("database is already connected");
    }
    const startupOptions = [
      this.#options.options,
      "-c timezone=UTC",
      "-c datestyle=ISO,MDY",
    ]
      .filter(
        (value): value is string => value !== undefined && value.length > 0,
      )
      .join(" ");
    const pool = new Pool({
      min: 1,
      max: 20,
      application_name: "stripe-entitlements-typescript",
      ...this.#options,
      connectionString: this.#dsn,
      options: startupOptions,
      types: PRIVATE_PG_TYPES,
    });
    try {
      const client = await pool.connect();
      client.release();
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
    this.#pool = pool;
  }

  public async close(): Promise<void> {
    const pool = this.#pool;
    this.#pool = undefined;
    if (pool !== undefined) {
      await pool.end();
    }
  }

  public async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    return this.requirePool().query<R>(text, [...values]);
  }

  public async transaction<T>(
    operation: (transaction: TransactionClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.requirePool().connect();
    const guarded = asTransactionClient(client);
    let transactionStarted = false;
    let releaseError: Error | undefined;
    try {
      await client.query("begin isolation level read committed");
      transactionStarted = true;
      const result = await operation(guarded.view);
      await client.query("commit");
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("rollback");
          transactionStarted = false;
        } catch (rollbackError) {
          releaseError =
            rollbackError instanceof Error
              ? rollbackError
              : new Error("database rollback failed", { cause: rollbackError });
          throw new AggregateError(
            [error, rollbackError],
            "transaction and rollback failed",
          );
        }
      }
      throw error;
    } finally {
      guarded.deactivate();
      client.release(releaseError);
    }
  }

  public async applyMigrations(
    directory = defaultMigrationDirectory(),
  ): Promise<void> {
    const migrations = await loadMigrations(directory);
    await this.transaction(async (transaction) => {
      await transaction.query(
        `select pg_advisory_xact_lock(${MIGRATION_ADVISORY_LOCK})`,
      );
      await transaction.query(
        `create table if not exists schema_migrations(
           filename text primary key,
           sha256 text not null check(length(sha256)=64),
           applied_at timestamptz not null default now()
         )`,
      );
      const history = await transaction.query<MigrationHistoryRow>(
        "select filename,sha256 from schema_migrations order by filename",
      );
      const applied = new Map(
        history.rows.map((row) => [row.filename, row.sha256]),
      );
      const bundled = new Map(
        migrations.map((migration) => [migration.filename, migration.sha256]),
      );
      if (
        bundled.has(V3_BASELINE_MIGRATION) &&
        applied.has(PRE_V3_BASELINE_MIGRATION)
      ) {
        throw new Error(
          `database uses the unsupported pre-0.3 migration lineage (${PRE_V3_BASELINE_MIGRATION}); create a fresh database for the 0.3 baseline`,
        );
      }
      for (const [filename, checksum] of bundled) {
        const observed = applied.get(filename);
        if (observed !== undefined && observed !== checksum) {
          throw new Error(
            `applied migration checksum changed for ${JSON.stringify(filename)}`,
          );
        }
      }
      let maxApplied = [...applied.keys()].sort().at(-1) ?? "";
      for (const migration of migrations) {
        if (applied.has(migration.filename)) {
          continue;
        }
        if (maxApplied.length > 0 && migration.filename < maxApplied) {
          throw new Error(
            `migration ${JSON.stringify(migration.filename)} was inserted before already applied history`,
          );
        }
        await transaction.query(migration.sql);
        await transaction.query(
          "insert into schema_migrations(filename,sha256) values($1,$2)",
          [migration.filename, migration.sha256],
        );
        maxApplied = migration.filename;
      }
    });
  }

  public async schemaReady(
    directory = defaultMigrationDirectory(),
  ): Promise<boolean> {
    let expectedPaths: string[];
    try {
      expectedPaths = await migrationPaths(directory);
    } catch {
      return false;
    }
    try {
      const present = await this.query<{ readonly present: boolean }>(
        `select count(*) = $2::integer as present
           from unnest($1::text[]) as required(name)
          where to_regclass(required.name) is not null`,
        [
          [...CORRECTNESS_TABLES, "schema_migrations"],
          CORRECTNESS_TABLES.length + 1,
        ],
      );
      if (present.rows[0]?.present !== true) {
        return false;
      }
      const history = await this.query<{ readonly filename: string }>(
        "select filename from schema_migrations",
      );
      const applied = new Set(history.rows.map((row) => row.filename));
      const expected = new Set(expectedPaths.map((path) => basename(path)));
      if (
        expected.has(V3_BASELINE_MIGRATION) &&
        applied.has(PRE_V3_BASELINE_MIGRATION)
      ) {
        return false;
      }
      return [...expected].every((filename) => applied.has(filename));
    } catch (error) {
      if (databaseErrorCode(error) === "42P01") {
        return false;
      }
      throw error;
    }
  }

  public async createAccount(
    externalRef: string,
    options: { readonly accountId?: string } = {},
  ): Promise<string> {
    const normalized = validateOwnerExternalRef(externalRef);
    const accountId = options.accountId ?? randomUUID();
    await this.query(
      "insert into billing_accounts(id,external_ref) values($1::uuid,$2)",
      [accountId, normalized],
    );
    return accountId;
  }

  public async account(accountId: string): Promise<BillingAccountRow | null> {
    const result = await this.query<BillingAccountRow>(
      "select *,clock_timestamp() as database_now from billing_accounts where id=$1::uuid",
      [accountId],
    );
    return result.rows[0] ?? null;
  }

  public async existingAccountForExternalRef(
    externalRef: string,
  ): Promise<BillingAccountRow | null> {
    const normalized = validateOwnerExternalRef(externalRef);
    const result = await this.query<BillingAccountRow>(
      `select *,clock_timestamp() as database_now
         from billing_accounts where external_ref=$1`,
      [normalized],
    );
    return result.rows[0] ?? null;
  }

  public async accountForExternalRef(
    externalRef: string,
  ): Promise<BillingAccountRow> {
    const normalized = validateOwnerExternalRef(externalRef);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const inserted = await this.query<BillingAccountRow>(
        `insert into billing_accounts(id,external_ref) values($1::uuid,$2)
           on conflict(external_ref) do nothing
           returning *,clock_timestamp() as database_now`,
        [randomUUID(), normalized],
      );
      if (inserted.rows[0] !== undefined) {
        return inserted.rows[0];
      }
      const existing = await this.existingAccountForExternalRef(normalized);
      if (existing !== null) {
        return existing;
      }
    }
    throw new Error("billing account disappeared during identity resolution");
  }

  public async pendingPlanChange(
    accountId: string,
  ): Promise<BillingPlanChangeRow | null> {
    const result = await this.query<BillingPlanChangeRow>(
      `select * from billing_plan_changes where account_id=$1::uuid
         and status in (
           'reserved','previewed','applying','scheduled','applied','requires_action'
         ) order by created_at desc limit 1`,
      [accountId],
    );
    return result.rows[0] ?? null;
  }
}

export { CORRECTNESS_TABLES, PRIVATE_PG_TYPES };
