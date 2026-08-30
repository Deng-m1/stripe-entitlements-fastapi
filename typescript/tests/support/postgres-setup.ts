import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach } from "vitest";

import { CORRECTNESS_TABLES, Database } from "../../src/database.js";

let database: Database | undefined;
const DROP_DATABASE_RETRY_TIMEOUT_MS = 5_000;
const DROP_DATABASE_RETRY_DELAY_MS = 10;

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function postgresDsn(): string {
  const dsn = process.env["STRIPE_ENTITLEMENTS_TS_TEST_DSN"];
  if (dsn === undefined || dsn.length === 0) {
    throw new Error("the disposable PostgreSQL test DSN is unavailable");
  }
  return dsn;
}

export function postgresDatabase(): Database {
  if (database === undefined) {
    throw new Error("the PostgreSQL test database is not initialized");
  }
  return database;
}

function databaseDsn(databaseName: string): string {
  const url = new URL(postgresDsn());
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function safeDatabaseName(prefix: string): string {
  if (!/^[a-z][a-z0-9_]{0,30}$/u.test(prefix)) {
    throw new Error("temporary database prefix is invalid");
  }
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export async function createDisposableDatabase(prefix: string): Promise<{
  readonly name: string;
  readonly dsn: string;
}> {
  const name = safeDatabaseName(prefix);
  await postgresDatabase().query(`create database "${name}"`);
  return { name, dsn: databaseDsn(name) };
}

export async function dropDisposableDatabase(
  name: string,
  retryTimeoutMs = DROP_DATABASE_RETRY_TIMEOUT_MS,
): Promise<void> {
  if (!/^[a-z][a-z0-9_]+$/u.test(name)) {
    throw new Error("temporary database name is invalid");
  }
  const deadline = Date.now() + retryTimeoutMs;
  for (;;) {
    try {
      await postgresDatabase().query(`drop database if exists "${name}"`);
      return;
    } catch (error) {
      // pg-pool resolves Pool.end() after it has started closing idle clients,
      // not after PostgreSQL has necessarily observed every socket close. A
      // force-drop can therefore kill those expected in-flight shutdowns and
      // emit an unhandled 57P01 on the client. Retry only PostgreSQL's precise
      // "database is being accessed" signal; every other failure is real.
      if (databaseErrorCode(error) !== "55006" || Date.now() >= deadline) {
        throw error;
      }
      await delay(DROP_DATABASE_RETRY_DELAY_MS);
    }
  }
}

beforeAll(async () => {
  database = new Database(postgresDsn(), { max: 30 });
  await database.connect();
  await database.applyMigrations();
});

beforeEach(async () => {
  const tableList = [...CORRECTNESS_TABLES].reverse().join(",");
  await postgresDatabase().query(
    `truncate ${tableList} restart identity cascade`,
  );
});

afterAll(async () => {
  const current = database;
  database = undefined;
  await current?.close();
});
