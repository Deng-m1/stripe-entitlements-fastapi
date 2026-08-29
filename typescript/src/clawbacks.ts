import type { QueryResultRow } from "pg";

import { pgBigInt, type TransactionClient } from "./db-types.js";

interface AccountBalanceRow extends QueryResultRow {
  readonly credits_balance: string;
}

interface ClawbackDebtRow extends QueryResultRow {
  readonly stripe_invoice_id: string;
  readonly target_units: string;
  readonly collected_units: string;
}

export async function collectClawbackDebts(
  transaction: TransactionClient,
  input: {
    readonly accountId: string;
    readonly grantEpoch: bigint;
    readonly eventId: string;
  },
): Promise<bigint> {
  const locked = await transaction.query<AccountBalanceRow>(
    "select credits_balance from billing_accounts where id=$1::uuid for update",
    [input.accountId],
  );
  const account = locked.rows[0];
  if (account === undefined) {
    throw new Error("account not found");
  }
  let balance = pgBigInt(account.credits_balance, "account credits_balance");
  const debts = await transaction.query<ClawbackDebtRow>(
    `select * from billing_clawback_debts
       where account_id=$1::uuid and grant_epoch=$2::bigint
         and collected_units < target_units
       order by created_at,stripe_invoice_id for update`,
    [input.accountId, input.grantEpoch.toString()],
  );
  let collected = 0n;
  for (const debt of debts.rows) {
    const outstanding =
      pgBigInt(debt.target_units, "clawback target_units") -
      pgBigInt(debt.collected_units, "clawback collected_units");
    const amount = outstanding < balance ? outstanding : balance;
    if (amount <= 0n) {
      break;
    }
    balance -= amount;
    collected += amount;
    await transaction.query(
      `update billing_clawback_debts set
         collected_units=collected_units+$4::bigint,updated_at=now()
       where account_id=$1::uuid and grant_epoch=$2::bigint and stripe_invoice_id=$3`,
      [
        input.accountId,
        input.grantEpoch.toString(),
        debt.stripe_invoice_id,
        amount.toString(),
      ],
    );
    await transaction.query(
      `insert into credit_ledger(
         account_id,delta,balance_after,reason,grant_epoch,
         stripe_event_id,stripe_invoice_id)
       values($1::uuid,$2::bigint,$3::bigint,'clawback_debt_collection',
              $4::bigint,$5,$6)`,
      [
        input.accountId,
        (-amount).toString(),
        balance.toString(),
        input.grantEpoch.toString(),
        input.eventId,
        debt.stripe_invoice_id,
      ],
    );
  }
  if (collected > 0n) {
    await transaction.query(
      "update billing_accounts set credits_balance=$2::bigint,updated_at=now() where id=$1::uuid",
      [input.accountId, balance.toString()],
    );
  }
  return collected;
}
