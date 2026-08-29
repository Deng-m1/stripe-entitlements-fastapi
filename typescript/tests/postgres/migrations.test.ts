import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { CORRECTNESS_TABLES, Database } from "../../src/database.js";
import { defaultMigrationDirectory } from "../../src/resources.js";
import {
  createDisposableDatabase,
  dropDisposableDatabase,
} from "../support/postgres-setup.js";

const BASELINE = "001_v3_baseline.sql";
const BASELINE_SHA256 =
  "8db1d8dec549a9a06148d0df3d73d7e3880dd77858cf1a13cff8837a45b07e11";
const REQUEST_SNAPSHOTS = "002_stripe_request_snapshots.sql";
const REQUEST_SNAPSHOTS_SHA256 =
  "052b9ed201c19621a2bf9230b1e5c1eca6ba5dba6be760a5ac40ce40b7289e13";

async function withTemporaryDirectory<T>(
  prefix: string,
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("migration runner", () => {
  test("uses the byte-identical canonical migration bundle", async () => {
    for (const [filename, expected] of [
      [BASELINE, BASELINE_SHA256],
      [REQUEST_SNAPSHOTS, REQUEST_SNAPSHOTS_SHA256],
    ] as const) {
      const payload = await readFile(
        resolve(defaultMigrationDirectory(), filename),
      );
      expect(createHash("sha256").update(payload).digest("hex")).toBe(expected);
    }
  });

  test("rejects missing, empty, and non-contiguous migration bundles", async () => {
    const temporary = await createDisposableDatabase("ts_migration_invalid");
    const database = new Database(temporary.dsn);
    try {
      await database.connect();
      await withTemporaryDirectory(
        "stripe-entitlements-invalid-",
        async (directory) => {
          await expect(
            database.applyMigrations(resolve(directory, "missing")),
          ).rejects.toThrow("does not exist");
          await expect(database.applyMigrations(directory)).rejects.toThrow(
            "contains no SQL",
          );
          await writeFile(
            resolve(directory, "002_gap.sql"),
            "select 1;\n",
            "utf8",
          );
          await expect(database.applyMigrations(directory)).rejects.toThrow(
            "contiguous",
          );
        },
      );
      const relation = await database.query<{
        readonly history: string | null;
      }>("select to_regclass('public.schema_migrations')::text as history");
      expect(relation.rows[0]?.history).toBeNull();
    } finally {
      await database.close();
      await dropDisposableDatabase(temporary.name);
    }
  });

  test("serializes concurrent first apply and records one checksum", async () => {
    const temporary = await createDisposableDatabase("ts_migration_concurrent");
    const databases = Array.from(
      { length: 8 },
      () => new Database(temporary.dsn, { max: 2 }),
    );
    try {
      await Promise.all(databases.map((database) => database.connect()));
      await Promise.all(
        databases.map((database) => database.applyMigrations()),
      );
      await Promise.all(
        databases.map((database) => database.applyMigrations()),
      );
      const history = await databases[0]?.query<{
        readonly filename: string;
        readonly sha256: string;
      }>("select filename,sha256 from schema_migrations order by filename");
      expect(history?.rows).toEqual([
        { filename: BASELINE, sha256: BASELINE_SHA256 },
        {
          filename: REQUEST_SNAPSHOTS,
          sha256: REQUEST_SNAPSHOTS_SHA256,
        },
      ]);
      const tables = await databases[0]?.query<{ readonly tablename: string }>(
        `select tablename from pg_tables
          where schemaname='public' and tablename=any($1::text[]) order by tablename`,
        [[...CORRECTNESS_TABLES]],
      );
      expect(tables?.rows.map((row) => row.tablename)).toEqual(
        [...CORRECTNESS_TABLES].sort(),
      );
      expect(
        await Promise.all(databases.map((database) => database.schemaReady())),
      ).toEqual(Array.from({ length: 8 }, () => true));
    } finally {
      await Promise.all(databases.map((database) => database.close()));
      await dropDisposableDatabase(temporary.name);
    }
  });

  test("rolls back every schema effect when the baseline fails", async () => {
    const temporary = await createDisposableDatabase("ts_migration_rollback");
    const database = new Database(temporary.dsn);
    try {
      await database.connect();
      await withTemporaryDirectory(
        "stripe-entitlements-broken-",
        async (directory) => {
          const baseline = await readFile(
            resolve(defaultMigrationDirectory(), BASELINE),
            "utf8",
          );
          await writeFile(
            resolve(directory, BASELINE),
            `${baseline}\nselect * from baseline_statement_that_must_not_exist;\n`,
            "utf8",
          );
          await expect(
            database.applyMigrations(directory),
          ).rejects.toMatchObject({
            code: "42P01",
          });
        },
      );
      const relations = await database.query<{
        readonly history: string | null;
        readonly accounts: string | null;
        readonly incidents: string | null;
      }>(
        `select to_regclass('public.schema_migrations')::text as history,
                to_regclass('public.billing_accounts')::text as accounts,
                to_regclass('public.billing_incidents')::text as incidents`,
      );
      expect(relations.rows[0]).toEqual({
        history: null,
        accounts: null,
        incidents: null,
      });
      await database.applyMigrations();
      expect(await database.schemaReady()).toBe(true);
    } finally {
      await database.close();
      await dropDisposableDatabase(temporary.name);
    }
  });

  test("atomically upgrades an 001 database through 002 and requires it for readiness", async () => {
    const temporary = await createDisposableDatabase("ts_migration_002");
    const database = new Database(temporary.dsn);
    try {
      await database.connect();
      await withTemporaryDirectory(
        "stripe-entitlements-baseline-only-",
        async (baselineDirectory) => {
          await writeFile(
            resolve(baselineDirectory, BASELINE),
            await readFile(resolve(defaultMigrationDirectory(), BASELINE)),
          );
          await database.applyMigrations(baselineDirectory);
          expect(await database.schemaReady()).toBe(false);

          await withTemporaryDirectory(
            "stripe-entitlements-broken-002-",
            async (brokenDirectory) => {
              await writeFile(
                resolve(brokenDirectory, BASELINE),
                await readFile(resolve(defaultMigrationDirectory(), BASELINE)),
              );
              const migration = await readFile(
                resolve(defaultMigrationDirectory(), REQUEST_SNAPSHOTS),
                "utf8",
              );
              await writeFile(
                resolve(brokenDirectory, REQUEST_SNAPSHOTS),
                `${migration}\nselect * from migration_002_statement_that_must_not_exist;\n`,
                "utf8",
              );
              await expect(
                database.applyMigrations(brokenDirectory),
              ).rejects.toMatchObject({ code: "42P01" });
            },
          );
        },
      );
      const rolledBack = await database.query<{
        readonly filenames: string[];
        readonly snapshotColumns: string;
      }>(
        `select
           array(select filename from schema_migrations order by filename) as filenames,
           (select count(*)::text from information_schema.columns
             where table_schema='public'
               and table_name in (
                 'checkout_claims','credit_pack_orders','billing_plan_changes'
               )
               and column_name in (
                 'request_snapshot_version','stripe_request_snapshot'
               )) as "snapshotColumns"`,
      );
      expect(rolledBack.rows[0]).toEqual({
        filenames: [BASELINE],
        snapshotColumns: "0",
      });

      await database.applyMigrations();
      expect(await database.schemaReady()).toBe(true);
      const history = await database.query<{ readonly filename: string }>(
        "select filename from schema_migrations order by filename",
      );
      expect(history.rows.map((row) => row.filename)).toEqual([
        BASELINE,
        REQUEST_SNAPSHOTS,
      ]);
    } finally {
      await database.close();
      await dropDisposableDatabase(temporary.name);
    }
  });

  test("enforces reserved and frozen snapshot state pairs", async () => {
    const temporary = await createDisposableDatabase(
      "ts_migration_snapshot_state",
    );
    const database = new Database(temporary.dsn);
    const accountId = randomUUID();
    const packId = randomUUID();
    const planChangeId = randomUUID();
    try {
      await database.connect();
      await database.applyMigrations();
      await database.query(
        "insert into billing_accounts(id,external_ref) values($1::uuid,$2)",
        [accountId, `ts-migration-snapshot-${accountId}`],
      );
      await database.query(
        `insert into checkout_claims(
           account_id,claim_token,plan_key,plan_interval,expires_at,
           client_request_key,request_snapshot_version
         ) values($1::uuid,$2::uuid,'starter','month',clock_timestamp()+interval '1 hour',
                  $3,0)`,
        [accountId, randomUUID(), `checkout-${randomUUID()}`],
      );
      await database.query(
        `insert into credit_pack_orders(
           id,account_id,client_idempotency_key,stripe_request_key,
           pack_key,pack_credits,price_amount,currency,expires_days,
           price_lookup_key,claim_expires_at,request_snapshot_version
         ) values($1::uuid,$2::uuid,$3,$4,'boost_100',100000000,900,'usd',365,
                  'pack_boost_100',clock_timestamp()+interval '1 hour',0)`,
        [
          packId,
          accountId,
          `pack-client-${randomUUID()}`,
          `pack-stripe-${randomUUID()}`,
        ],
      );
      await database.query(
        `insert into billing_plan_changes(
           id,account_id,idempotency_key,stripe_subscription_id,
           from_plan_key,from_interval,target_plan_key,target_interval,
           effective_mode,status,stripe_request_key,expected_grant_epoch,
           expected_subscription_status,expected_cancel_at_period_end,
           request_snapshot_version
         ) values($1::uuid,$2::uuid,$3,'sub_snapshot','starter','month','pro','month',
                  'immediate','failed',$4,0,'active',false,0)`,
        [
          planChangeId,
          accountId,
          `plan-client-${randomUUID()}`,
          `plan-stripe-${randomUUID()}`,
        ],
      );

      const rows = [
        ["checkout_claims", "account_id", accountId],
        ["credit_pack_orders", "id", packId],
        ["billing_plan_changes", "id", planChangeId],
      ] as const;
      for (const [table, key, value] of rows) {
        await expect(
          database.query(
            `update ${table} set stripe_request_snapshot='{}'::jsonb where ${key}=$1::uuid`,
            [value],
          ),
        ).rejects.toMatchObject({ code: "23514" });
        await database.query(
          `update ${table} set request_snapshot_version=1,
             stripe_request_snapshot='{}'::jsonb where ${key}=$1::uuid`,
          [value],
        );
        await expect(
          database.query(
            `update ${table} set request_snapshot_version=2 where ${key}=$1::uuid`,
            [value],
          ),
        ).rejects.toMatchObject({ code: "23514" });
        await expect(
          database.query(
            `update ${table} set stripe_request_snapshot=null where ${key}=$1::uuid`,
            [value],
          ),
        ).rejects.toMatchObject({ code: "23514" });
        await expect(
          database.query(
            `update ${table} set request_snapshot_version=null where ${key}=$1::uuid`,
            [value],
          ),
        ).rejects.toMatchObject({ code: "23514" });
        for (const invalidJson of ["[]", '"scalar"', "null"]) {
          await expect(
            database.query(
              `update ${table} set stripe_request_snapshot=$2::jsonb where ${key}=$1::uuid`,
              [value, invalidJson],
            ),
          ).rejects.toMatchObject({ code: "23514" });
        }
      }
    } finally {
      await database.close();
      await dropDisposableDatabase(temporary.name);
    }
  });

  test("rejects pre-v3 lineage and changed applied bytes without partial effects", async () => {
    const temporary = await createDisposableDatabase("ts_migration_lineage");
    const database = new Database(temporary.dsn);
    try {
      await database.connect();
      await database.query(
        `create table schema_migrations(
           filename text primary key,
           sha256 text not null check(length(sha256)=64),
           applied_at timestamptz not null default now()
         )`,
      );
      await database.query(
        "insert into schema_migrations(filename,sha256) values('001_schema.sql',$1)",
        ["a".repeat(64)],
      );
      await expect(database.applyMigrations()).rejects.toThrow(
        "unsupported pre-0.3",
      );
      const accountTable = await database.query<{
        readonly relation: string | null;
      }>("select to_regclass('public.billing_accounts')::text as relation");
      expect(accountTable.rows[0]?.relation).toBeNull();

      await database.query("drop table schema_migrations");
      await database.applyMigrations();
      await withTemporaryDirectory(
        "stripe-entitlements-drift-",
        async (directory) => {
          const baseline = await readFile(
            resolve(defaultMigrationDirectory(), BASELINE),
            "utf8",
          );
          await writeFile(
            resolve(directory, BASELINE),
            `${baseline}\n-- changed\n`,
            "utf8",
          );
          await expect(database.applyMigrations(directory)).rejects.toThrow(
            "checksum changed",
          );
        },
      );
    } finally {
      await database.close();
      await dropDisposableDatabase(temporary.name);
    }
  });

  test("allows a database ahead of an older migration bundle", async () => {
    const temporary = await createDisposableDatabase("ts_migration_ahead");
    const database = new Database(temporary.dsn);
    try {
      await database.connect();
      await database.applyMigrations();
      await database.query(
        "insert into schema_migrations(filename,sha256) values('003_forward_probe.sql',$1)",
        ["b".repeat(64)],
      );
      await database.applyMigrations();
      expect(await database.schemaReady()).toBe(true);
    } finally {
      await database.close();
      await dropDisposableDatabase(temporary.name);
    }
  });
});
