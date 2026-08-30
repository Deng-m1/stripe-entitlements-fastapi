import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import type { TransactionClient } from "../../src/db-types.js";
import { pgBigInt } from "../../src/db-types.js";
import { postgresDatabase } from "../support/postgres-setup.js";

describe("Database", () => {
  test("keeps bigint, numeric, and microsecond timestamptz exact in a private pool", async () => {
    const result = await postgresDatabase().query<{
      readonly maximum: string;
      readonly signed: string;
      readonly aggregate: string;
      readonly observed_at: string;
      readonly timezone: string;
    }>(
      `select 9223372036854775807::bigint as maximum,
              (-9223372036854775807)::bigint as signed,
              27670116110564327421::numeric as aggregate,
              '2026-08-29 01:02:03.123456+00'::timestamptz as observed_at,
              current_setting('TimeZone') as timezone`,
    );
    const row = result.rows[0];
    expect(row).toBeDefined();
    expect(row?.maximum).toBe("9223372036854775807");
    expect(row?.signed).toBe("-9223372036854775807");
    expect(row?.aggregate).toBe("27670116110564327421");
    expect(row?.observed_at).toBe("2026-08-29 01:02:03.123456+00");
    expect(row?.timezone).toBe("UTC");
    expect(pgBigInt(row?.maximum)).toBe(9_223_372_036_854_775_807n);
  });

  test("runs explicit read-committed transactions and invalidates the scoped client", async () => {
    let escaped: TransactionClient | undefined;
    const isolation = await postgresDatabase().transaction(
      async (transaction) => {
        escaped = transaction;
        const result = await transaction.query<{ readonly isolation: string }>(
          "select current_setting('transaction_isolation') as isolation",
        );
        return result.rows[0]?.isolation;
      },
    );
    expect(isolation).toBe("read committed");
    await expect(escaped?.query("select 1")).rejects.toThrow(
      "no longer active",
    );
  });

  test("rolls back a thrown operation and returns the client to the pool", async () => {
    const accountId = randomUUID();
    await expect(
      postgresDatabase().transaction(async (transaction) => {
        await transaction.query(
          "insert into billing_accounts(id,external_ref) values($1::uuid,$2)",
          [accountId, "transaction-rollback-owner"],
        );
        throw new Error("simulated failure");
      }),
    ).rejects.toThrow("simulated failure");
    const count = await postgresDatabase().query<{ readonly count: string }>(
      "select count(*) from billing_accounts where id=$1::uuid",
      [accountId],
    );
    expect(count.rows[0]?.count).toBe("0");
    expect(postgresDatabase().pool.waitingCount).toBe(0);
    expect(postgresDatabase().pool.idleCount).toBe(
      postgresDatabase().pool.totalCount,
    );
  });

  test("resolves one immutable external owner concurrently without rewriting reads", async () => {
    const accounts = await Promise.all(
      Array.from({ length: 32 }, () =>
        postgresDatabase().accountForExternalRef("host:user:concurrent-owner"),
      ),
    );
    expect(new Set(accounts.map((account) => account.id))).toHaveLength(1);
    expect(
      accounts.every((account) => typeof account.database_now === "string"),
    ).toBe(true);

    const accountId = accounts[0]?.id;
    expect(accountId).toBeDefined();
    const before = await postgresDatabase().query<{
      readonly xmin: string;
      readonly ctid: string;
    }>(
      "select xmin::text as xmin,ctid::text as ctid from billing_accounts where id=$1::uuid",
      [accountId],
    );
    await Promise.all(
      Array.from({ length: 10 }, () =>
        postgresDatabase().accountForExternalRef("host:user:concurrent-owner"),
      ),
    );
    const after = await postgresDatabase().query<{
      readonly xmin: string;
      readonly ctid: string;
    }>(
      "select xmin::text as xmin,ctid::text as ctid from billing_accounts where id=$1::uuid",
      [accountId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  test("rejects infrastructure selectors before creating an account", async () => {
    await expect(
      postgresDatabase().accountForExternalRef("cus_not_an_owner"),
    ).rejects.toThrow("Stripe identifier");
    await expect(
      postgresDatabase().accountForExternalRef(
        "00000000-0000-4000-8000-000000000001",
      ),
    ).rejects.toThrow("internal account ID");
    const count = await postgresDatabase().query<{ readonly count: string }>(
      "select count(*) from billing_accounts",
    );
    expect(count.rows[0]?.count).toBe("0");
  });
});
