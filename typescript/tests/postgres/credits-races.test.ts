import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";
import { describe, expect, test } from "vitest";

import {
  CreditService,
  CreditsUnavailableError,
  InsufficientCreditsError,
} from "../../src/credits.js";
import { postgresDatabase } from "../support/postgres-setup.js";

const CREDITS = 1_000_000n;

async function activeAccount(): Promise<string> {
  const accountId = await postgresDatabase().createAccount(
    `race:user:${randomUUID()}`,
  );
  await postgresDatabase().query(
    `update billing_accounts
        set plan_key='starter',plan_interval='month',
            subscription_status='active',credits_balance=$2::bigint,
            grant_epoch=1,entitlement_revoked=false,
            credit_expires_at=clock_timestamp()+interval '30 days'
      where id=$1::uuid`,
    [accountId, (300n * CREDITS).toString()],
  );
  return accountId;
}

async function freeAccountWithPack(): Promise<{
  readonly accountId: string;
  readonly lotId: string;
}> {
  const accountId = await postgresDatabase().createAccount(
    `race:user:${randomUUID()}`,
  );
  const orderId = randomUUID();
  const lotId = randomUUID();
  const identity = randomUUID();
  await postgresDatabase().transaction(async (transaction) => {
    await transaction.query(
      `insert into credit_pack_orders(
         id,account_id,client_idempotency_key,stripe_request_key,pack_key,
         pack_credits,price_amount,currency,expires_days,price_lookup_key,
         checkout_status,payment_status,stripe_checkout_session_id,
         stripe_payment_intent_id,stripe_charge_id,claim_expires_at,
         amount_paid,paid_at)
       values($1::uuid,$2::uuid,$3,$4,'boost-100',$5::bigint,1500,'usd',365,
              'ent_pack_boost-100','completed','paid',$6,$7,$8,
              clock_timestamp()+interval '1 hour',1500,clock_timestamp())`,
      [
        orderId,
        accountId,
        `pack-request:${identity}`,
        `pack-stripe:${identity}`,
        (100n * CREDITS).toString(),
        `cs_${identity}`,
        `pi_${identity}`,
        `ch_${identity}`,
      ],
    );
    await transaction.query(
      `insert into credit_funding_lots(
         id,order_id,account_id,original_credits,remaining_credits,expires_at)
       values($1::uuid,$2::uuid,$3::uuid,$4::bigint,$4::bigint,
              clock_timestamp()+interval '30 days')`,
      [lotId, orderId, accountId, (100n * CREDITS).toString()],
    );
  });
  return { accountId, lotId };
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

describe("CreditService database races", () => {
  test("commits one charge and replays nineteen calls with the same key", async () => {
    const accountId = await activeAccount();
    const service = new CreditService(postgresDatabase());
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.charge(accountId, 25, "same-race-job"),
      ),
    );

    expect(
      results.filter((result) => result.outcome === "charged"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.outcome === "replayed"),
    ).toHaveLength(19);
    expect(new Set(results.map((result) => result.balanceAtoms))).toEqual(
      new Set([275n * CREDITS]),
    );
  });

  test("allows one global-key winner and gives the other account a deterministic conflict", async () => {
    const firstId = await activeAccount();
    const secondId = await activeAccount();
    const service = new CreditService(postgresDatabase());

    const charge = async (accountId: string): Promise<string> => {
      try {
        return (await service.charge(accountId, 25, "global-race-job")).outcome;
      } catch (error) {
        if (
          error instanceof TypeError &&
          error.message.includes("different parameters")
        ) {
          return "conflict";
        }
        throw error;
      }
    };
    const results = await Promise.all([charge(firstId), charge(secondId)]);
    expect([...results].sort()).toEqual(["charged", "conflict"]);

    const state = await postgresDatabase().query<
      {
        readonly credits_balance: string;
      } & QueryResultRow
    >(
      `select credits_balance from billing_accounts
        where id=any($1::uuid[]) order by credits_balance`,
      [[firstId, secondId]],
    );
    expect(state.rows.map((row) => row.credits_balance)).toEqual([
      (275n * CREDITS).toString(),
      (300n * CREDITS).toString(),
    ]);
  });

  test("serializes distinct keys so concurrent calls cannot overdraw", async () => {
    const accountId = await activeAccount();
    const service = new CreditService(postgresDatabase());
    const charge = async (index: number): Promise<string> => {
      try {
        return (
          await service.charge(accountId, 100, `distinct-job:${String(index)}`)
        ).outcome;
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          return "insufficient";
        }
        throw error;
      }
    };
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => charge(index)),
    );
    expect(results.filter((result) => result === "charged")).toHaveLength(3);
    expect(results.filter((result) => result === "insufficient")).toHaveLength(
      7,
    );
  });

  test("serializes concurrent refunds so the original sources restore once", async () => {
    const accountId = await activeAccount();
    const service = new CreditService(postgresDatabase());
    await service.charge(accountId, 80, "refund-race-job");
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.refund("refund-race-job")),
    );

    expect(
      results.filter((result) => result.outcome === "refunded"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.outcome === "replayed"),
    ).toHaveLength(19);
    expect(
      results.every(
        (result) =>
          result.balanceAtoms === 300n * CREDITS &&
          result.restoredAtoms === 80n * CREDITS,
      ),
    ).toBe(true);
  });

  test("samples wall clock after an account-lock wait before restoring subscription credits", async () => {
    const accountId = await activeAccount();
    const service = new CreditService(postgresDatabase());
    await service.charge(accountId, 40, "expiry-lock-refund");
    const blocker = await postgresDatabase().pool.connect();
    await blocker.query("begin");
    try {
      await blocker.query(
        "select id from billing_accounts where id=$1::uuid for update",
        [accountId],
      );
      await blocker.query(
        `update billing_accounts
            set credit_expires_at=clock_timestamp()+interval '200 milliseconds'
          where id=$1::uuid`,
        [accountId],
      );
      const refundPromise = service.refund("expiry-lock-refund");
      await pause(350);
      await blocker.query("commit");
      const result = await refundPromise;
      expect([result.outcome, result.restoredAtoms]).toEqual([
        "epoch_expired",
        0n,
      ]);
    } catch (error) {
      await blocker.query("rollback");
      throw error;
    } finally {
      blocker.release();
    }
  });

  test("samples wall clock after an account-lock wait before spending an expiring pack", async () => {
    const { accountId, lotId } = await freeAccountWithPack();
    const service = new CreditService(postgresDatabase());
    const blocker = await postgresDatabase().pool.connect();
    await blocker.query("begin");
    try {
      await blocker.query(
        "select id from billing_accounts where id=$1::uuid for update",
        [accountId],
      );
      await blocker.query(
        `update credit_funding_lots
            set expires_at=clock_timestamp()+interval '200 milliseconds'
          where id=$1::uuid`,
        [lotId],
      );
      const chargePromise = service.charge(accountId, 1, "expiry-lock-charge");
      await pause(350);
      await blocker.query("commit");
      await expect(chargePromise).rejects.toBeInstanceOf(
        CreditsUnavailableError,
      );
      const debit = await postgresDatabase().query<
        { readonly count: string } & QueryResultRow
      >(
        "select count(*) from credit_debits where idempotency_key='expiry-lock-charge'",
      );
      expect(debit.rows[0]?.count).toBe("0");
    } catch (error) {
      await blocker.query("rollback");
      throw error;
    } finally {
      blocker.release();
    }
  });

  test("samples wall clock after an account-lock wait before restoring an expiring pack", async () => {
    const { accountId, lotId } = await freeAccountWithPack();
    const service = new CreditService(postgresDatabase());
    await service.charge(accountId, 10, "pack-expiry-lock-refund");
    const blocker = await postgresDatabase().pool.connect();
    await blocker.query("begin");
    try {
      await blocker.query(
        "select id from billing_accounts where id=$1::uuid for update",
        [accountId],
      );
      await blocker.query(
        `update credit_funding_lots
            set expires_at=clock_timestamp()+interval '200 milliseconds'
          where id=$1::uuid`,
        [lotId],
      );
      const refundPromise = service.refund("pack-expiry-lock-refund");
      await pause(350);
      await blocker.query("commit");
      const result = await refundPromise;
      expect([
        result.outcome,
        result.balanceAtoms,
        result.restoredAtoms,
      ]).toEqual(["epoch_expired", 0n, 0n]);
      const state = await postgresDatabase().query<
        {
          readonly expired_credits: string;
          readonly refunded_amount: string;
        } & QueryResultRow
      >(
        `select l.expired_credits,a.refunded_amount
           from credit_funding_lots l
           join credit_debit_allocations a on a.funding_lot_id=l.id
          where l.id=$1::uuid`,
        [lotId],
      );
      expect(state.rows[0]).toEqual({
        expired_credits: (100n * CREDITS).toString(),
        refunded_amount: (10n * CREDITS).toString(),
      });
    } catch (error) {
      await blocker.query("rollback");
      throw error;
    } finally {
      blocker.release();
    }
  });
});
