import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach } from "vitest";

import { CORRECTNESS_TABLES, Database } from "../../src/database.js";

let database: Database | undefined;

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

export async function dropDisposableDatabase(name: string): Promise<void> {
  if (!/^[a-z][a-z0-9_]+$/u.test(name)) {
    throw new Error("temporary database name is invalid");
  }
  await postgresDatabase().query(
    `drop database if exists "${name}" with (force)`,
  );
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
