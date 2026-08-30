import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import { pgBigInt, type TransactionClient } from "./db-types.js";
import type { PgTimestamp } from "./types.js";

interface PackLotBalanceRow extends QueryResultRow {
  readonly remaining_credits: string;
}

interface PackDebtRow extends QueryResultRow {
  readonly order_id: string;
  readonly account_id: string;
  readonly target_credits: string;
  readonly collected_credits: string;
  readonly released_credits: string;
}

async function recordDebtCollection(
  transaction: TransactionClient,
  input: {
    readonly debt: PackDebtRow;
    readonly amount: bigint;
    readonly grantEpoch: bigint;
    readonly source:
      | { readonly type: "subscription" }
      | { readonly type: "credit_pack"; readonly lotId: string };
  },
): Promise<void> {
  const debitKey = `pack-debt:${randomUUID()}`;
  await transaction.query(
    `insert into credit_debits(
       idempotency_key,account_id,amount,grant_epoch,kind,clawback_order_id)
     values($1,$2::uuid,$3::bigint,$4::bigint,'credit_pack_debt_collection',$5::uuid)`,
    [
      debitKey,
      input.debt.account_id,
      input.amount.toString(),
      input.grantEpoch.toString(),
      input.debt.order_id,
    ],
  );
  if (input.source.type === "subscription") {
    await transaction.query(
      `insert into credit_debit_allocations(
         debit_idempotency_key,account_id,source_type,
         subscription_grant_epoch,amount)
       values($1,$2::uuid,'subscription',$3::bigint,$4::bigint)`,
      [
        debitKey,
        input.debt.account_id,
        input.grantEpoch.toString(),
        input.amount.toString(),
      ],
    );
  } else {
    await transaction.query(
      `insert into credit_debit_allocations(
         debit_idempotency_key,account_id,source_type,funding_lot_id,amount)
       values($1,$2::uuid,'credit_pack',$3::uuid,$4::bigint)`,
      [
        debitKey,
        input.debt.account_id,
        input.source.lotId,
        input.amount.toString(),
      ],
    );
  }
}

export async function packBalanceAtoms(
  transaction: TransactionClient,
  accountId: string,
  options: { readonly lock?: boolean; readonly asOf?: PgTimestamp } = {},
): Promise<bigint> {
  const suffix = options.lock === true ? " for update" : "";
  const rows = await transaction.query<PackLotBalanceRow>(
    `select remaining_credits from credit_funding_lots
       where account_id=$1::uuid and status='active'
         and expires_at > coalesce($2::timestamptz,clock_timestamp())
       order by expires_at,id${suffix}`,
    [accountId, options.asOf ?? null],
  );
  return rows.rows.reduce(
    (total, row) =>
      total + pgBigInt(row.remaining_credits, "pack remaining_credits"),
    0n,
  );
}

export async function collectPackDebtsFromLot(
  transaction: TransactionClient,
  input: {
    readonly accountId: string;
    readonly lotId: string;
    readonly availableAtoms: bigint;
  },
): Promise<bigint> {
  if (input.availableAtoms < 0n) {
    throw new RangeError("available pack atoms cannot be negative");
  }
  let remaining = input.availableAtoms;
  const debts = await transaction.query<PackDebtRow>(
    `select * from credit_pack_clawback_debts
       where account_id=$1::uuid
         and collected_credits + released_credits < target_credits
       order by created_at,order_id for update`,
    [input.accountId],
  );
  const epochResult = await transaction.query<
    { readonly grant_epoch: string } & QueryResultRow
  >("select grant_epoch from billing_accounts where id=$1::uuid", [
    input.accountId,
  ]);
  const epochRow = epochResult.rows[0];
  if (epochRow === undefined) {
    throw new Error("account not found");
  }
  const grantEpoch = pgBigInt(epochRow.grant_epoch, "account grant_epoch");
  for (const debt of debts.rows) {
    const outstanding =
      pgBigInt(debt.target_credits, "pack debt target") -
      pgBigInt(debt.collected_credits, "pack debt collected") -
      pgBigInt(debt.released_credits, "pack debt released");
    const amount = remaining < outstanding ? remaining : outstanding;
    if (amount <= 0n) {
      break;
    }
    await transaction.query(
      `update credit_pack_clawback_debts
          set collected_credits=collected_credits+$2::bigint,updated_at=now()
        where order_id=$1::uuid`,
      [debt.order_id, amount.toString()],
    );
    await recordDebtCollection(transaction, {
      debt,
      amount,
      grantEpoch,
      source: { type: "credit_pack", lotId: input.lotId },
    });
    remaining -= amount;
  }
  const collected = input.availableAtoms - remaining;
  if (collected > 0n) {
    const update = await transaction.query(
      `update credit_funding_lots
          set remaining_credits=remaining_credits-$2::bigint,updated_at=now()
        where id=$1::uuid and remaining_credits >= $2::bigint`,
      [input.lotId, collected.toString()],
    );
    if (update.rowCount !== 1) {
      throw new Error("pack lot changed while collecting clawback debt");
    }
  }
  return collected;
}

export async function collectPackDebtsFromSubscription(
  transaction: TransactionClient,
  input: {
    readonly accountId: string;
    readonly grantEpoch: bigint;
    readonly eventId: string;
  },
): Promise<bigint> {
  const accountResult = await transaction.query<
    { readonly credits_balance: string } & QueryResultRow
  >(
    "select credits_balance from billing_accounts where id=$1::uuid for update",
    [input.accountId],
  );
  const account = accountResult.rows[0];
  if (account === undefined) {
    throw new Error("account not found");
  }
  let balance = pgBigInt(account.credits_balance, "account credits_balance");
  const original = balance;
  const debts = await transaction.query<PackDebtRow>(
    `select * from credit_pack_clawback_debts
       where account_id=$1::uuid
         and collected_credits + released_credits < target_credits
       order by created_at,order_id for update`,
    [input.accountId],
  );
  for (const debt of debts.rows) {
    const outstanding =
      pgBigInt(debt.target_credits, "pack debt target") -
      pgBigInt(debt.collected_credits, "pack debt collected") -
      pgBigInt(debt.released_credits, "pack debt released");
    const amount = balance < outstanding ? balance : outstanding;
    if (amount <= 0n) {
      break;
    }
    balance -= amount;
    await transaction.query(
      `update credit_pack_clawback_debts
          set collected_credits=collected_credits+$2::bigint,updated_at=now()
        where order_id=$1::uuid`,
      [debt.order_id, amount.toString()],
    );
    await recordDebtCollection(transaction, {
      debt,
      amount,
      grantEpoch: input.grantEpoch,
      source: { type: "subscription" },
    });
    await transaction.query(
      `insert into credit_ledger(
         account_id,delta,balance_after,reason,grant_epoch,stripe_event_id)
       values($1::uuid,$2::bigint,$3::bigint,'credit_pack_debt_collection',
              $4::bigint,$5)`,
      [
        input.accountId,
        (-amount).toString(),
        balance.toString(),
        input.grantEpoch.toString(),
        input.eventId,
      ],
    );
  }
  if (balance !== original) {
    await transaction.query(
      "update billing_accounts set credits_balance=$2::bigint,updated_at=now() where id=$1::uuid",
      [input.accountId, balance.toString()],
    );
  }
  return original - balance;
}
