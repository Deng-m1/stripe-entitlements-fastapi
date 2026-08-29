import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import { postgresDatabase } from "../support/postgres-setup.js";

describe("deferred database equations", () => {
  test("surfaces a commit-time violation, rolls it all back, and releases the client", async () => {
    const accountId = await postgresDatabase().createAccount(
      "host:user:deferred-rollback",
    );
    await expect(
      postgresDatabase().transaction(async (transaction) => {
        await transaction.query(
          `insert into credit_debits(idempotency_key,account_id,amount,grant_epoch)
             values('missing-allocation',$1::uuid,1000000,0)`,
          [accountId],
        );
        const visibleBeforeCommit = await transaction.query<{
          readonly count: string;
        }>(
          "select count(*) from credit_debits where idempotency_key='missing-allocation'",
        );
        expect(visibleBeforeCommit.rows[0]?.count).toBe("1");
      }),
    ).rejects.toMatchObject({ code: "23514" });

    const persisted = await postgresDatabase().query<{
      readonly count: string;
    }>(
      "select count(*) from credit_debits where idempotency_key='missing-allocation'",
    );
    expect(persisted.rows[0]?.count).toBe("0");
    expect(postgresDatabase().pool.waitingCount).toBe(0);
    expect(postgresDatabase().pool.idleCount).toBe(
      postgresDatabase().pool.totalCount,
    );
    expect((await postgresDatabase().query("select 1")).rowCount).toBe(1);
  });

  test("allows a debit and its exact source allocation to commit together", async () => {
    const accountId = await postgresDatabase().createAccount(
      "host:user:deferred-success",
      {
        accountId: randomUUID(),
      },
    );
    await postgresDatabase().transaction(async (transaction) => {
      await transaction.query(
        `insert into credit_debits(idempotency_key,account_id,amount,grant_epoch)
           values('complete-allocation',$1::uuid,1250000,7)`,
        [accountId],
      );
      await transaction.query(
        `insert into credit_debit_allocations(
           debit_idempotency_key,account_id,source_type,subscription_grant_epoch,amount)
         values('complete-allocation',$1::uuid,'subscription',7,1250000)`,
        [accountId],
      );
    });
    const rows = await postgresDatabase().query<{
      readonly debit_amount: string;
      readonly allocation_amount: string;
    }>(
      `select d.amount as debit_amount,a.amount as allocation_amount
         from credit_debits d join credit_debit_allocations a
           on a.debit_idempotency_key=d.idempotency_key
        where d.idempotency_key='complete-allocation'`,
    );
    expect(rows.rows[0]).toEqual({
      debit_amount: "1250000",
      allocation_amount: "1250000",
    });
  });
});
