import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";
import { describe, expect, test } from "vitest";

import { MAX_CREDIT_ATOMS, CreditAmount } from "../../src/credit-amount.js";
import {
  CreditService,
  CreditsUnavailableError,
  InsufficientCreditsError,
} from "../../src/credits.js";
import {
  collectPackDebtsFromLot,
  collectPackDebtsFromSubscription,
} from "../../src/credit-pack-funding.js";
import { postgresDatabase } from "../support/postgres-setup.js";

const CREDITS = 1_000_000n;

async function activeAccount(balance = 300n * CREDITS): Promise<string> {
  const accountId = await postgresDatabase().createAccount(
    `test:user:${randomUUID()}`,
  );
  await postgresDatabase().query(
    `update billing_accounts
        set plan_key='starter',plan_interval='month',
            subscription_status='active',credits_balance=$2::bigint,
            grant_epoch=1,entitlement_revoked=false,
            credit_expires_at=clock_timestamp()+interval '30 days',
            entitlement_period_end=clock_timestamp()+interval '30 days'
      where id=$1::uuid`,
    [accountId, balance.toString()],
  );
  return accountId;
}

async function grantPack(
  accountId: string,
  options: { readonly credits?: bigint; readonly expiresIn?: string } = {},
): Promise<{ readonly lotId: string; readonly orderId: string }> {
  const credits = options.credits ?? 100n * CREDITS;
  const expiresIn = options.expiresIn ?? "1 day";
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
        credits.toString(),
        `cs_${identity}`,
        `pi_${identity}`,
        `ch_${identity}`,
      ],
    );
    await transaction.query(
      `insert into credit_funding_lots(
         id,order_id,account_id,original_credits,remaining_credits,expires_at)
       values($1::uuid,$2::uuid,$3::uuid,$4::bigint,$4::bigint,
              clock_timestamp()+$5::interval)`,
      [lotId, orderId, accountId, credits.toString(), expiresIn],
    );
  });
  return { lotId, orderId };
}

async function applyHalfCashClawback(input: {
  readonly accountId: string;
  readonly lotId: string;
  readonly orderId: string;
}): Promise<void> {
  await postgresDatabase().transaction(async (transaction) => {
    await transaction.query(
      "select id from billing_accounts where id=$1::uuid for update",
      [input.accountId],
    );
    await transaction.query(
      `update credit_pack_orders
          set payment_status='partially_refunded',amount_refunded=750,
              refunded_credits=$2::bigint,updated_at=clock_timestamp()
        where id=$1::uuid`,
      [input.orderId, (50n * CREDITS).toString()],
    );
    await transaction.query(
      `update credit_funding_lots
          set remaining_credits=0,cash_clawed_back_credits=$2::bigint,
              updated_at=clock_timestamp()
        where id=$1::uuid`,
      [input.lotId, (20n * CREDITS).toString()],
    );
    await transaction.query(
      `insert into credit_pack_clawback_debts(
         order_id,account_id,target_credits)
       values($1::uuid,$2::uuid,$3::bigint)`,
      [input.orderId, input.accountId, (30n * CREDITS).toString()],
    );
  });
}

describe("CreditService", () => {
  test("charges and refunds subscription credits atomically with exact provenance", async () => {
    const accountId = await activeAccount();
    const service = new CreditService(postgresDatabase());

    const charged = await service.charge(accountId, 40, "subscription-job");
    const refunded = await service.refund("subscription-job");
    const replay = await service.refund("subscription-job");

    expect([charged.outcome, charged.balanceAtoms]).toEqual([
      "charged",
      260n * CREDITS,
    ]);
    expect([charged.requestedAtoms, charged.restoredAtoms]).toEqual([
      40n * CREDITS,
      0n,
    ]);
    expect([refunded.outcome, refunded.balanceAtoms]).toEqual([
      "refunded",
      300n * CREDITS,
    ]);
    expect(refunded.restoredAtoms).toBe(40n * CREDITS);
    expect([replay.outcome, replay.balanceAtoms, replay.restoredAtoms]).toEqual(
      ["replayed", 300n * CREDITS, 40n * CREDITS],
    );

    const allocation = await postgresDatabase().query<
      {
        readonly source_type: string;
        readonly amount: string;
        readonly refunded_amount: string;
      } & QueryResultRow
    >(
      `select source_type,amount,refunded_amount
         from credit_debit_allocations
        where debit_idempotency_key='subscription-job'`,
    );
    expect(allocation.rows).toEqual([
      {
        source_type: "subscription",
        amount: (40n * CREDITS).toString(),
        refunded_amount: (40n * CREDITS).toString(),
      },
    ]);
  });

  test("uses first-expiring pack funding before subscription and restores both sources", async () => {
    const accountId = await activeAccount();
    const { lotId } = await grantPack(accountId);
    const service = new CreditService(postgresDatabase());

    const charged = await service.charge(accountId, 150, "fefo-spanning-job");
    expect(charged.balanceAtoms).toBe(250n * CREDITS);

    const allocations = await postgresDatabase().query<
      {
        readonly source_type: string;
        readonly amount: string;
        readonly funding_lot_id: string | null;
      } & QueryResultRow
    >(
      `select source_type,amount,funding_lot_id
         from credit_debit_allocations
        where debit_idempotency_key='fefo-spanning-job'
        order by id`,
    );
    expect(
      allocations.rows.map((row) => [
        row.source_type,
        row.amount,
        row.funding_lot_id,
      ]),
    ).toEqual([
      ["credit_pack", (100n * CREDITS).toString(), lotId],
      ["subscription", (50n * CREDITS).toString(), null],
    ]);

    const refunded = await service.refund("fefo-spanning-job");
    expect([
      refunded.outcome,
      refunded.balanceAtoms,
      refunded.restoredAtoms,
    ]).toEqual(["refunded", 400n * CREDITS, 150n * CREDITS]);
    const balances = await postgresDatabase().query<
      {
        readonly credits_balance: string;
        readonly remaining_credits: string;
      } & QueryResultRow
    >(
      `select a.credits_balance,l.remaining_credits
         from billing_accounts a
         join credit_funding_lots l on l.account_id=a.id
        where a.id=$1::uuid`,
      [accountId],
    );
    expect(balances.rows[0]).toEqual({
      credits_balance: (300n * CREDITS).toString(),
      remaining_credits: (100n * CREDITS).toString(),
    });
  });

  test("uses an earlier subscription window before a later pack lot", async () => {
    const accountId = await activeAccount();
    await postgresDatabase().query(
      `update billing_accounts
          set credit_expires_at=clock_timestamp()+interval '1 day'
        where id=$1::uuid`,
      [accountId],
    );
    const { lotId } = await grantPack(accountId, { expiresIn: "30 days" });
    const service = new CreditService(postgresDatabase());

    await service.charge(accountId, 50, "subscription-first-job");
    const state = await postgresDatabase().query<
      {
        readonly source_type: string;
        readonly amount: string;
        readonly remaining_credits: string;
      } & QueryResultRow
    >(
      `select a.source_type,a.amount,l.remaining_credits
         from credit_debit_allocations a
         join credit_funding_lots l on l.id=$1::uuid
        where a.debit_idempotency_key='subscription-first-job'`,
      [lotId],
    );
    expect(state.rows[0]).toEqual({
      source_type: "subscription",
      amount: (50n * CREDITS).toString(),
      remaining_credits: (100n * CREDITS).toString(),
    });
  });

  test("normalizes exact fractional forms and never accumulates floating-point drift", async () => {
    const accountId = await activeAccount();
    const service = new CreditService(postgresDatabase());

    const first = await service.charge(accountId, "0.1", "fractional-job");
    const replay = await service.charge(
      accountId,
      CreditAmount.parse("0.100000"),
      "fractional-job",
    );
    for (let index = 0; index < 9; index += 1) {
      await service.charge(accountId, "0.1", `fractional-job:${String(index)}`);
    }

    expect(first.balanceAtoms).toBe(299_900_000n);
    expect([replay.outcome, replay.balanceAtoms]).toEqual([
      "replayed",
      299_900_000n,
    ]);
    const balance = await postgresDatabase().query<
      { readonly credits_balance: string } & QueryResultRow
    >("select credits_balance from billing_accounts where id=$1::uuid", [
      accountId,
    ]);
    expect(balance.rows[0]?.credits_balance).toBe("299000000");
  });

  test("treats the smallest supported decimal as exactly one atom", async () => {
    const accountId = await activeAccount();
    const service = new CreditService(postgresDatabase());

    const charged = await service.charge(accountId, "0.000001", "one-atom");
    expect([charged.requestedAtoms, charged.balanceAtoms]).toEqual([
      1n,
      299_999_999n,
    ]);
    const debit = await postgresDatabase().query<
      { readonly amount: string } & QueryResultRow
    >("select amount from credit_debits where idempotency_key='one-atom'");
    expect(debit.rows[0]?.amount).toBe("1");
  });

  test("rejects an oversized CreditAmount before opening a persisted debit", async () => {
    const accountId = await activeAccount();
    const service = new CreditService(postgresDatabase());
    await expect(
      service.charge(
        accountId,
        CreditAmount.fromAtoms(MAX_CREDIT_ATOMS + 1n),
        "oversized-amount",
      ),
    ).rejects.toThrow("bigint atom range");
    const count = await postgresDatabase().query<
      { readonly count: string } & QueryResultRow
    >("select count(*) from credit_debits");
    expect(count.rows[0]?.count).toBe("0");
  });

  test("rejects reuse of one debit key with a different normalized amount", async () => {
    const accountId = await activeAccount();
    const service = new CreditService(postgresDatabase());
    await service.charge(accountId, "0.1", "amount-conflict");
    await expect(
      service.charge(accountId, "0.100001", "amount-conflict"),
    ).rejects.toThrow("different parameters");
  });

  test("rolls back debit identity and allocations when funding is insufficient", async () => {
    const accountId = await activeAccount(10n * CREDITS);
    const service = new CreditService(postgresDatabase());

    await expect(
      service.charge(accountId, 11, "insufficient-job"),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
    const state = await postgresDatabase().query<
      {
        readonly debits: string;
        readonly allocations: string;
        readonly balance: string;
      } & QueryResultRow
    >(
      `select
         (select count(*) from credit_debits)::text as debits,
         (select count(*) from credit_debit_allocations)::text as allocations,
         (select credits_balance from billing_accounts where id=$1::uuid)::text
           as balance`,
      [accountId],
    );
    expect(state.rows[0]).toEqual({
      debits: "0",
      allocations: "0",
      balance: (10n * CREDITS).toString(),
    });
  });

  test("does not restore subscription funding across a grant epoch", async () => {
    const accountId = await activeAccount();
    const service = new CreditService(postgresDatabase());
    await service.charge(accountId, 50, "old-epoch-job");
    await postgresDatabase().query(
      `update billing_accounts
          set grant_epoch=grant_epoch+1,credits_balance=$2::bigint,
              credit_expires_at=clock_timestamp()+interval '30 days'
        where id=$1::uuid`,
      [accountId, (300n * CREDITS).toString()],
    );

    const result = await service.refund("old-epoch-job");
    const replay = await service.refund("old-epoch-job");
    expect([result.outcome, result.balanceAtoms, result.restoredAtoms]).toEqual(
      ["epoch_expired", 300n * CREDITS, 0n],
    );
    expect([replay.outcome, replay.balanceAtoms, replay.restoredAtoms]).toEqual(
      ["replayed", 300n * CREDITS, 0n],
    );
  });

  test("rolls back the complete refund when a bigint balance would overflow", async () => {
    const accountId = await activeAccount();
    const service = new CreditService(postgresDatabase());
    await service.charge(accountId, 1, "overflow-refund");
    await postgresDatabase().query(
      "update billing_accounts set credits_balance=$2::bigint where id=$1::uuid",
      [accountId, MAX_CREDIT_ATOMS.toString()],
    );

    await expect(service.refund("overflow-refund")).rejects.toThrow(
      "bigint atom range",
    );
    const state = await postgresDatabase().query<
      {
        readonly refunded: boolean;
        readonly allocation_refunded: string;
        readonly refund_ledgers: string;
      } & QueryResultRow
    >(
      `select d.refunded_at is not null as refunded,
              a.refunded_amount as allocation_refunded,
              (select count(*) from credit_ledger
                where stripe_event_id='usage-refund:overflow-refund')::text
                as refund_ledgers
         from credit_debits d
         join credit_debit_allocations a
           on a.debit_idempotency_key=d.idempotency_key
        where d.idempotency_key='overflow-refund'`,
    );
    expect(state.rows[0]).toEqual({
      refunded: false,
      allocation_refunded: "0",
      refund_ledgers: "0",
    });
  });

  test("retires a product refund when its exact pack funding window expired", async () => {
    const accountId = await postgresDatabase().createAccount(
      `test:user:${randomUUID()}`,
    );
    const { lotId } = await grantPack(accountId, { expiresIn: "30 days" });
    const service = new CreditService(postgresDatabase());
    await service.charge(accountId, 10, "expired-pack-source");
    await postgresDatabase().query(
      `update credit_funding_lots
          set expires_at=clock_timestamp()-interval '1 second'
        where id=$1::uuid`,
      [lotId],
    );

    const result = await service.refund("expired-pack-source");
    expect([result.outcome, result.balanceAtoms, result.restoredAtoms]).toEqual(
      ["epoch_expired", 0n, 0n],
    );
    const lot = await postgresDatabase().query<
      {
        readonly status: string;
        readonly remaining_credits: string;
        readonly expired_credits: string;
      } & QueryResultRow
    >(
      "select status,remaining_credits,expired_credits from credit_funding_lots where id=$1::uuid",
      [lotId],
    );
    expect(lot.rows[0]).toEqual({
      status: "expired",
      remaining_credits: "0",
      expired_credits: (100n * CREDITS).toString(),
    });
  });

  test("releases uncollected pack debt before returning only the net pack value", async () => {
    const accountId = await postgresDatabase().createAccount(
      `test:user:${randomUUID()}`,
    );
    const funding = await grantPack(accountId);
    const service = new CreditService(postgresDatabase());
    await service.charge(accountId, 80, "cash-then-product-refund");
    await applyHalfCashClawback({ accountId, ...funding });

    const result = await service.refund("cash-then-product-refund");
    expect([result.outcome, result.balanceAtoms, result.restoredAtoms]).toEqual(
      ["refunded", 50n * CREDITS, 50n * CREDITS],
    );
    const state = await postgresDatabase().query<
      {
        readonly remaining_credits: string;
        readonly target_credits: string;
        readonly collected_credits: string;
        readonly released_credits: string;
      } & QueryResultRow
    >(
      `select l.remaining_credits,d.target_credits,
              d.collected_credits,d.released_credits
         from credit_funding_lots l
         join credit_pack_clawback_debts d on d.order_id=l.order_id
        where l.id=$1::uuid`,
      [funding.lotId],
    );
    expect(state.rows[0]).toEqual({
      remaining_credits: (50n * CREDITS).toString(),
      target_credits: (30n * CREDITS).toString(),
      collected_credits: "0",
      released_credits: (30n * CREDITS).toString(),
    });
  });

  test("unwinds collected pack debt to its original subscription epoch", async () => {
    const accountId = await activeAccount();
    const funding = await grantPack(accountId);
    const service = new CreditService(postgresDatabase());
    await service.charge(accountId, 80, "subscription-funded-debt-refund");
    await applyHalfCashClawback({ accountId, ...funding });
    await postgresDatabase().transaction(async (transaction) => {
      await collectPackDebtsFromSubscription(transaction, {
        accountId,
        grantEpoch: 1n,
        eventId: "test:subscription-debt-collection",
      });
    });

    const result = await service.refund("subscription-funded-debt-refund");
    expect([result.balanceAtoms, result.restoredAtoms]).toEqual([
      350n * CREDITS,
      80n * CREDITS,
    ]);
    const state = await postgresDatabase().query<
      {
        readonly account_balance: string;
        readonly collected_credits: string;
        readonly released_credits: string;
        readonly collection_restored: string;
        readonly allocation_refunded: string;
      } & QueryResultRow
    >(
      `select a.credits_balance as account_balance,
              debt.collected_credits,debt.released_credits,
              d.restored_credits as collection_restored,
              da.refunded_amount as allocation_refunded
         from billing_accounts a
         join credit_pack_clawback_debts debt on debt.account_id=a.id
         join credit_debits d on d.clawback_order_id=debt.order_id
         join credit_debit_allocations da
           on da.debit_idempotency_key=d.idempotency_key
        where a.id=$1::uuid and d.kind='credit_pack_debt_collection'`,
      [accountId],
    );
    expect(state.rows[0]).toEqual({
      account_balance: (300n * CREDITS).toString(),
      collected_credits: "0",
      released_credits: (30n * CREDITS).toString(),
      collection_restored: (30n * CREDITS).toString(),
      allocation_refunded: (30n * CREDITS).toString(),
    });
  });

  test("does not unwind collected subscription debt into a newer grant epoch", async () => {
    const accountId = await activeAccount();
    const funding = await grantPack(accountId);
    const service = new CreditService(postgresDatabase());
    await service.charge(accountId, 80, "cross-epoch-debt-refund");
    await applyHalfCashClawback({ accountId, ...funding });
    await postgresDatabase().transaction(async (transaction) => {
      await collectPackDebtsFromSubscription(transaction, {
        accountId,
        grantEpoch: 1n,
        eventId: "test:old-epoch-debt-collection",
      });
    });
    await postgresDatabase().query(
      `update billing_accounts
          set grant_epoch=2,credits_balance=$2::bigint,
              credit_expires_at=clock_timestamp()+interval '30 days'
        where id=$1::uuid`,
      [accountId, (300n * CREDITS).toString()],
    );

    const result = await service.refund("cross-epoch-debt-refund");
    expect([result.balanceAtoms, result.restoredAtoms]).toEqual([
      350n * CREDITS,
      50n * CREDITS,
    ]);
    const collection = await postgresDatabase().query<
      {
        readonly restored_credits: string;
        readonly refunded: boolean;
      } & QueryResultRow
    >(
      `select restored_credits,refunded_at is not null as refunded
         from credit_debits where kind='credit_pack_debt_collection'`,
    );
    expect(collection.rows[0]).toEqual({
      restored_credits: "0",
      refunded: true,
    });
  });

  test("unwinds collected debt to the exact other pack lot", async () => {
    const accountId = await postgresDatabase().createAccount(
      `test:user:${randomUUID()}`,
    );
    const first = await grantPack(accountId);
    const service = new CreditService(postgresDatabase());
    await service.charge(accountId, 80, "other-pack-debt-refund");
    await applyHalfCashClawback({ accountId, ...first });
    const second = await grantPack(accountId, { expiresIn: "2 days" });
    await postgresDatabase().transaction(async (transaction) => {
      await collectPackDebtsFromLot(transaction, {
        accountId,
        lotId: second.lotId,
        availableAtoms: 100n * CREDITS,
      });
    });

    const result = await service.refund("other-pack-debt-refund");
    expect([result.balanceAtoms, result.restoredAtoms]).toEqual([
      150n * CREDITS,
      80n * CREDITS,
    ]);
    const lots = await postgresDatabase().query<
      {
        readonly id: string;
        readonly remaining_credits: string;
      } & QueryResultRow
    >("select id,remaining_credits from credit_funding_lots order by id");
    expect(
      new Map(lots.rows.map((row) => [row.id, row.remaining_credits])),
    ).toEqual(
      new Map([
        [first.lotId, (50n * CREDITS).toString()],
        [second.lotId, (100n * CREDITS).toString()],
      ]),
    );
    const collection = await postgresDatabase().query<
      { readonly funding_lot_id: string | null } & QueryResultRow
    >(
      `select a.funding_lot_id
         from credit_debits d
         join credit_debit_allocations a
           on a.debit_idempotency_key=d.idempotency_key
        where d.kind='credit_pack_debt_collection'`,
    );
    expect(collection.rows[0]?.funding_lot_id).toBe(second.lotId);
  });

  test("rejects an unavailable subscription without committing a debit", async () => {
    const accountId = await postgresDatabase().createAccount(
      `test:user:${randomUUID()}`,
    );
    const service = new CreditService(postgresDatabase());
    await expect(
      service.charge(accountId, 1, "inactive-job"),
    ).rejects.toBeInstanceOf(CreditsUnavailableError);
    const count = await postgresDatabase().query<
      { readonly count: string } & QueryResultRow
    >("select count(*) from credit_debits");
    expect(count.rows[0]?.count).toBe("0");
  });
});
