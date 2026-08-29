import type { QueryResultRow } from "pg";

import {
  MAX_CREDIT_ATOMS,
  CreditAmount,
  checkedAddAtoms,
} from "./credit-amount.js";
import type { Database } from "./database.js";
import {
  pgBigInt,
  type BillingAccountRow,
  type TransactionClient,
} from "./db-types.js";
import { collectClawbackDebts } from "./clawbacks.js";
import {
  collectPackDebtsFromLot,
  collectPackDebtsFromSubscription,
  packBalanceAtoms,
} from "./credit-pack-funding.js";
import {
  spendableSubscriptionAtoms,
  subscriptionCreditsAreSpendable,
} from "./subscription-state.js";
import type { PgTimestamp } from "./types.js";
import { isPrintable } from "./validation.js";

const ZERO_CREDIT_AMOUNT = CreditAmount.fromAtoms(0n);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export class InsufficientCreditsError extends Error {}
export class CreditsUnavailableError extends Error {}
export class CreditDebitOwnerMismatchError extends Error {}
export class CreditAccountNotFoundError extends Error {}
export class CreditDebitNotFoundError extends Error {}

export type CreditOutcome =
  | "charged"
  | "refunded"
  | "replayed"
  | "epoch_expired";

export class CreditResult {
  public readonly outcome: CreditOutcome;
  public readonly balance: CreditAmount;
  public readonly requested: CreditAmount;
  public readonly restored: CreditAmount;

  public constructor(
    outcome: CreditOutcome,
    balance: CreditAmount,
    options: {
      readonly requested?: CreditAmount;
      readonly restored?: CreditAmount;
    } = {},
  ) {
    this.outcome = outcome;
    this.balance = balance;
    this.requested = options.requested ?? ZERO_CREDIT_AMOUNT;
    this.restored = options.restored ?? ZERO_CREDIT_AMOUNT;
  }

  public get balanceAtoms(): bigint {
    return this.balance.atoms;
  }

  public get requestedAtoms(): bigint {
    return this.requested.atoms;
  }

  public get restoredAtoms(): bigint {
    return this.restored.atoms;
  }
}

export type CreditInput = CreditAmount | string | number | bigint;

interface ClockRow extends QueryResultRow {
  readonly database_now: PgTimestamp;
}

interface FundingLotRow extends QueryResultRow {
  readonly id: string;
  readonly order_id: string;
  readonly account_id: string;
  readonly original_credits: string;
  readonly remaining_credits: string;
  readonly expired_credits: string;
  readonly cash_clawed_back_credits: string;
  readonly expires_at: PgTimestamp;
  readonly status: "active" | "expired" | "refunded" | "disputed";
  readonly before_subscription: boolean;
  readonly expires_now?: boolean;
}

interface DebitRow extends QueryResultRow {
  readonly idempotency_key: string;
  readonly account_id: string;
  readonly amount: string;
  readonly grant_epoch: string;
  readonly kind: "usage" | "credit_pack_debt_collection";
  readonly restored_credits: string;
  readonly refunded_at: PgTimestamp | null;
}

interface AllocationRow extends QueryResultRow {
  readonly id: string;
  readonly debit_idempotency_key: string;
  readonly account_id: string;
  readonly source_type: "subscription" | "credit_pack";
  readonly subscription_grant_epoch: string | null;
  readonly funding_lot_id: string | null;
  readonly amount: string;
  readonly refunded_amount: string;
}

interface PackDebtRow extends QueryResultRow {
  readonly order_id: string;
  readonly account_id: string;
  readonly target_credits: string;
  readonly collected_credits: string;
  readonly released_credits: string;
}

interface CollectionAllocationRow extends AllocationRow {
  readonly idempotency_key: string;
  readonly debit_account_id: string;
  readonly debit_amount: string;
  readonly restored_credits: string;
  readonly allocation_id: string;
  readonly allocation_account_id: string;
  readonly allocation_amount: string;
}

interface PackOrderRow extends QueryResultRow {
  readonly id: string;
  readonly account_id: string;
  readonly pack_credits: string;
  readonly refunded_credits: string;
}

function validateIdempotencyKey(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > 200 ||
    !isPrintable(value)
  ) {
    throw new TypeError(
      "idempotency_key must contain 1 to 200 visible characters without padding",
    );
  }
  return value;
}

function normalizeAmount(value: CreditInput): CreditAmount {
  const amount =
    value instanceof CreditAmount
      ? value
      : CreditAmount.parse(value, { field: "amount", allowZero: false });
  if (amount.atoms === 0n) {
    throw new RangeError("amount must be greater than zero");
  }
  if (amount.atoms > MAX_CREDIT_ATOMS) {
    throw new RangeError("amount exceeds the PostgreSQL bigint atom range");
  }
  return amount;
}

function normalizeUuid(value: string, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${field} must be a UUID string`);
  }
  return value.toLowerCase();
}

function accountWithExactBalance(
  account: BillingAccountRow,
): Readonly<Record<string, unknown>> {
  return {
    ...account,
    credits_balance: pgBigInt(
      account.credits_balance,
      "account credits_balance",
    ),
  };
}

function subscriptionAtoms(
  account: BillingAccountRow,
  asOf: PgTimestamp,
): bigint {
  return spendableSubscriptionAtoms(accountWithExactBalance(account), { asOf });
}

function subscriptionSpendable(
  account: BillingAccountRow,
  asOf: PgTimestamp,
): boolean {
  return subscriptionCreditsAreSpendable(accountWithExactBalance(account), {
    asOf,
  });
}

async function sampleDatabaseClock(
  transaction: TransactionClient,
): Promise<PgTimestamp> {
  const sampled = await transaction.query<ClockRow>(
    "select clock_timestamp() as database_now",
  );
  const databaseNow = sampled.rows[0]?.database_now;
  if (databaseNow === undefined) {
    throw new Error("database clock query returned no row");
  }
  return databaseNow;
}

/** Atomic FEFO consumption and source-safe product refund operations. */
export class CreditService {
  readonly #database: Database;

  public constructor(database: Database) {
    this.#database = database;
  }

  static async #expireAccountPackLots(
    transaction: TransactionClient,
    accountId: string,
    asOf: PgTimestamp,
  ): Promise<boolean> {
    const result = await transaction.query<
      { readonly expired: boolean } & QueryResultRow
    >(
      `with projected as (
         update credit_funding_lots
            set expired_credits=expired_credits+remaining_credits,
                status='expired',remaining_credits=0,
                closed_at=$2::timestamptz,updated_at=clock_timestamp()
          where account_id=$1::uuid and status='active'
            and expires_at <= $2::timestamptz
          returning 1
       )
       select exists(select 1 from projected)
           or exists(
                select 1 from credit_funding_lots
                 where account_id=$1::uuid and status='expired'
              ) as expired`,
      [accountId, asOf],
    );
    return result.rows[0]?.expired === true;
  }

  public async charge(
    accountId: string,
    amount: CreditInput,
    idempotencyKeyInput: string,
  ): Promise<CreditResult> {
    const normalized = normalizeAmount(amount);
    const amountAtoms = normalized.atoms;
    const idempotencyKey = validateIdempotencyKey(idempotencyKeyInput);
    return this.#database.transaction(async (transaction) => {
      const accountResult = await transaction.query<BillingAccountRow>(
        "select * from billing_accounts where id=$1::uuid for update",
        [accountId],
      );
      const account = accountResult.rows[0];
      if (account === undefined) {
        throw new CreditAccountNotFoundError("account not found");
      }
      const databaseNow = await sampleDatabaseClock(transaction);
      const packWindowExpired = await CreditService.#expireAccountPackLots(
        transaction,
        account.id,
        databaseNow,
      );
      const lotsResult = await transaction.query<FundingLotRow>(
        `select l.*,
                case when $3::timestamptz is null then true
                     else l.expires_at <= $3::timestamptz end
                  as before_subscription
           from credit_funding_lots l
          where l.account_id=$1::uuid and l.status='active'
            and l.expires_at > $2::timestamptz
          order by l.expires_at,l.id
          for update`,
        [account.id, databaseNow, account.credit_expires_at],
      );
      const lots = lotsResult.rows;
      const claimed = await transaction.query<
        { readonly idempotency_key: string } & QueryResultRow
      >(
        `insert into credit_debits(idempotency_key,account_id,amount,grant_epoch)
         values($1,$2::uuid,$3::bigint,$4::bigint)
         on conflict(idempotency_key) do nothing
         returning idempotency_key`,
        [
          idempotencyKey,
          account.id,
          amountAtoms.toString(),
          account.grant_epoch,
        ],
      );
      if (claimed.rowCount !== 1) {
        const existingResult = await transaction.query<DebitRow>(
          "select * from credit_debits where idempotency_key=$1",
          [idempotencyKey],
        );
        const existing = existingResult.rows[0];
        if (existing === undefined) {
          throw new Error(
            "credit debit identity disappeared during conflict handling",
          );
        }
        if (
          existing.account_id !== accountId ||
          pgBigInt(existing.amount, "credit debit amount") !== amountAtoms ||
          existing.kind !== "usage"
        ) {
          throw new TypeError(
            "idempotency key was already used with different parameters",
          );
        }
        const total =
          subscriptionAtoms(account, databaseNow) +
          lots.reduce(
            (sum, lot) =>
              sum + pgBigInt(lot.remaining_credits, "pack remaining_credits"),
            0n,
          );
        return new CreditResult("replayed", CreditAmount.fromAtoms(total), {
          requested: normalized,
          restored: CreditAmount.fromAtoms(
            pgBigInt(
              existing.restored_credits,
              "credit debit restored_credits",
            ),
          ),
        });
      }

      const subscriptionUsable = subscriptionSpendable(account, databaseNow);
      const subscriptionAvailable = subscriptionUsable
        ? pgBigInt(account.credits_balance, "account credits_balance")
        : 0n;
      const packAvailable = lots.reduce(
        (sum, lot) =>
          sum + pgBigInt(lot.remaining_credits, "pack remaining_credits"),
        0n,
      );
      const available = subscriptionAvailable + packAvailable;
      if (available < amountAtoms) {
        if (available === 0n && lots.length === 0 && !subscriptionUsable) {
          if (account.subscription_status !== "active" && !packWindowExpired) {
            throw new CreditsUnavailableError("subscription is not active");
          }
          if (account.entitlement_revoked && !packWindowExpired) {
            throw new CreditsUnavailableError(
              "the paid entitlement was revoked",
            );
          }
          throw new CreditsUnavailableError(
            "the paid credit window has expired",
          );
        }
        throw new InsufficientCreditsError("insufficient credits");
      }

      let remaining = amountAtoms;
      let subscriptionUsed = 0n;
      const consumeLot = async (lot: FundingLotRow): Promise<void> => {
        if (remaining === 0n) {
          return;
        }
        const lotAvailable = pgBigInt(
          lot.remaining_credits,
          "pack remaining_credits",
        );
        const used = remaining < lotAvailable ? remaining : lotAvailable;
        if (used <= 0n) {
          return;
        }
        const updated = await transaction.query(
          `update credit_funding_lots
              set remaining_credits=remaining_credits-$2::bigint,updated_at=now()
            where id=$1::uuid and remaining_credits >= $2::bigint`,
          [lot.id, used.toString()],
        );
        if (updated.rowCount !== 1) {
          throw new Error("pack lot changed while charging credits");
        }
        await transaction.query(
          `insert into credit_debit_allocations(
             debit_idempotency_key,account_id,source_type,funding_lot_id,amount)
           values($1,$2::uuid,'credit_pack',$3::uuid,$4::bigint)`,
          [idempotencyKey, account.id, lot.id, used.toString()],
        );
        remaining -= used;
      };

      const beforeSubscription = subscriptionUsable
        ? lots.filter((lot) => lot.before_subscription)
        : lots;
      const afterSubscription = subscriptionUsable
        ? lots.filter((lot) => !lot.before_subscription)
        : [];
      for (const lot of beforeSubscription) {
        await consumeLot(lot);
      }
      if (remaining > 0n && subscriptionAvailable > 0n) {
        subscriptionUsed =
          remaining < subscriptionAvailable ? remaining : subscriptionAvailable;
        await transaction.query(
          `insert into credit_debit_allocations(
             debit_idempotency_key,account_id,source_type,
             subscription_grant_epoch,amount)
           values($1,$2::uuid,'subscription',$3::bigint,$4::bigint)`,
          [
            idempotencyKey,
            account.id,
            account.grant_epoch,
            subscriptionUsed.toString(),
          ],
        );
        remaining -= subscriptionUsed;
      }
      for (const lot of afterSubscription) {
        await consumeLot(lot);
      }
      if (remaining !== 0n) {
        throw new Error("credit source allocation did not satisfy the debit");
      }

      if (subscriptionUsed > 0n) {
        const subscriptionBalance = subscriptionAvailable - subscriptionUsed;
        await transaction.query(
          `update billing_accounts set credits_balance=$2::bigint,updated_at=now()
            where id=$1::uuid`,
          [account.id, subscriptionBalance.toString()],
        );
        await transaction.query(
          `insert into credit_ledger(
             account_id,delta,balance_after,reason,grant_epoch,stripe_event_id)
           values($1::uuid,$2::bigint,$3::bigint,'usage_charge',$4::bigint,$5)`,
          [
            account.id,
            (-subscriptionUsed).toString(),
            subscriptionBalance.toString(),
            account.grant_epoch,
            `usage:${idempotencyKey}`,
          ],
        );
      }
      return new CreditResult(
        "charged",
        CreditAmount.fromAtoms(available - amountAtoms),
        { requested: normalized },
      );
    });
  }

  static async #returnSubscriptionAtoms(
    transaction: TransactionClient,
    input: {
      readonly account: BillingAccountRow;
      readonly amount: bigint;
      readonly eventId: string;
      readonly reason: string;
      readonly asOf: PgTimestamp;
    },
  ): Promise<bigint> {
    if (!subscriptionSpendable(input.account, input.asOf)) {
      return 0n;
    }
    const balanceResult = await transaction.query<
      { readonly credits_balance: string } & QueryResultRow
    >("select credits_balance from billing_accounts where id=$1::uuid", [
      input.account.id,
    ]);
    const currentBalance = pgBigInt(
      balanceResult.rows[0]?.credits_balance,
      "account credits_balance",
    );
    const balance = checkedAddAtoms(
      currentBalance,
      input.amount,
      "refunded subscription credit balance",
    );
    await transaction.query(
      `update billing_accounts set credits_balance=$2::bigint,updated_at=now()
        where id=$1::uuid`,
      [input.account.id, balance.toString()],
    );
    await transaction.query(
      `insert into credit_ledger(
         account_id,delta,balance_after,reason,grant_epoch,stripe_event_id)
       values($1::uuid,$2::bigint,$3::bigint,$4,$5::bigint,$6)`,
      [
        input.account.id,
        input.amount.toString(),
        balance.toString(),
        input.reason,
        input.account.grant_epoch,
        input.eventId,
      ],
    );
    const grantEpoch = pgBigInt(
      input.account.grant_epoch,
      "account grant_epoch",
    );
    await collectClawbackDebts(transaction, {
      accountId: input.account.id,
      grantEpoch,
      eventId: input.eventId,
    });
    await collectPackDebtsFromSubscription(transaction, {
      accountId: input.account.id,
      grantEpoch,
      eventId: input.eventId,
    });
    return input.amount;
  }

  async #relievePackDebt(
    transaction: TransactionClient,
    input: {
      readonly account: BillingAccountRow;
      readonly orderId: string;
      readonly amount: bigint;
      readonly visiting: Set<string>;
      readonly asOf: PgTimestamp;
    },
  ): Promise<readonly [relieved: bigint, recovered: bigint]> {
    const debtResult = await transaction.query<PackDebtRow>(
      "select * from credit_pack_clawback_debts where order_id=$1::uuid for update",
      [input.orderId],
    );
    const debt = debtResult.rows[0];
    if (debt === undefined || input.amount <= 0n) {
      return [0n, 0n];
    }
    if (debt.account_id !== input.account.id) {
      throw new Error("credit-pack clawback debt belongs to another account");
    }
    const activeDebt =
      pgBigInt(debt.target_credits, "pack debt target_credits") -
      pgBigInt(debt.released_credits, "pack debt released_credits");
    const relief = input.amount < activeDebt ? input.amount : activeDebt;
    if (relief <= 0n) {
      return [0n, 0n];
    }

    const uncollected =
      activeDebt -
      pgBigInt(debt.collected_credits, "pack debt collected_credits");
    const releaseUncollected = relief < uncollected ? relief : uncollected;
    if (releaseUncollected > 0n) {
      await transaction.query(
        `update credit_pack_clawback_debts
            set released_credits=released_credits+$2::bigint,updated_at=now()
          where order_id=$1::uuid`,
        [input.orderId, releaseUncollected.toString()],
      );
    }

    const reverseCollected = relief - releaseUncollected;
    if (reverseCollected <= 0n) {
      return [relief, 0n];
    }
    const collectionsResult = await transaction.query<CollectionAllocationRow>(
      `select d.idempotency_key,d.account_id as debit_account_id,
              d.amount as debit_amount,d.restored_credits,d.created_at,
              a.id as allocation_id,a.account_id as allocation_account_id,
              a.source_type,a.subscription_grant_epoch,a.funding_lot_id,
              a.amount as allocation_amount,a.refunded_amount
         from credit_debits d
         join credit_debit_allocations a
           on a.debit_idempotency_key=d.idempotency_key
        where d.kind='credit_pack_debt_collection'
          and d.clawback_order_id=$1::uuid
          and a.refunded_amount < a.amount
        order by d.created_at,d.idempotency_key,a.id
        for update of d,a`,
      [input.orderId],
    );
    let remaining = reverseCollected;
    let recovered = 0n;
    for (const collection of collectionsResult.rows) {
      if (remaining <= 0n) {
        break;
      }
      const collectionKey = collection.idempotency_key;
      if (input.visiting.has(collectionKey)) {
        throw new Error("credit-pack debt collection cycle detected");
      }
      if (
        collection.debit_account_id !== input.account.id ||
        collection.allocation_account_id !== input.account.id
      ) {
        throw new Error(
          "credit-pack debt collection belongs to another account",
        );
      }
      if (
        pgBigInt(collection.debit_amount, "debt collection debit amount") !==
        pgBigInt(
          collection.allocation_amount,
          "debt collection allocation amount",
        )
      ) {
        throw new Error(
          "credit-pack debt collection allocation is inconsistent",
        );
      }
      const pending =
        pgBigInt(
          collection.allocation_amount,
          "debt collection allocation amount",
        ) -
        pgBigInt(collection.refunded_amount, "debt collection refunded amount");
      const reversing = remaining < pending ? remaining : pending;
      if (reversing <= 0n) {
        continue;
      }
      const debtUpdate = await transaction.query(
        `update credit_pack_clawback_debts
            set collected_credits=collected_credits-$2::bigint,
                released_credits=released_credits+$2::bigint,updated_at=now()
          where order_id=$1::uuid and collected_credits >= $2::bigint`,
        [input.orderId, reversing.toString()],
      );
      if (debtUpdate.rowCount !== 1) {
        throw new Error("credit-pack collected debt changed during reversal");
      }
      input.visiting.add(collectionKey);
      let restored: bigint;
      try {
        restored = await this.#restoreAllocationEffect(transaction, {
          account: input.account,
          allocation: {
            ...collection,
            id: collection.allocation_id,
            account_id: collection.allocation_account_id,
            amount: collection.allocation_amount,
          },
          amount: reversing,
          eventId: `pack-debt-release:${collectionKey}`,
          reason: "credit_pack_debt_refund",
          visiting: input.visiting,
          asOf: input.asOf,
        });
      } finally {
        input.visiting.delete(collectionKey);
      }
      const newRestored = checkedAddAtoms(
        pgBigInt(
          collection.restored_credits,
          "debt collection restored credits",
        ),
        restored,
        "debt-collection restored credits",
      );
      const allocationUpdate = await transaction.query(
        `update credit_debit_allocations
            set refunded_amount=refunded_amount+$2::bigint,updated_at=now()
          where id=$1::bigint and refunded_amount+$2::bigint <= amount`,
        [collection.allocation_id, reversing.toString()],
      );
      if (allocationUpdate.rowCount !== 1) {
        throw new Error("debt collection allocation changed during reversal");
      }
      await transaction.query(
        `update credit_debits d set restored_credits=$2::bigint,
             refunded_at=case
               when not exists(
                 select 1 from credit_debit_allocations a
                  where a.debit_idempotency_key=d.idempotency_key
                    and a.refunded_amount < a.amount
               ) then now() else refunded_at end
           where d.idempotency_key=$1`,
        [collectionKey, newRestored.toString()],
      );
      recovered += restored;
      remaining -= reversing;
    }
    if (remaining !== 0n) {
      throw new Error("credit-pack debt has no reversible funding allocation");
    }
    return [relief, recovered];
  }

  async #restoreAllocationEffect(
    transaction: TransactionClient,
    input: {
      readonly account: BillingAccountRow;
      readonly allocation: AllocationRow;
      readonly amount: bigint;
      readonly eventId: string;
      readonly reason: string;
      readonly visiting: Set<string>;
      readonly asOf: PgTimestamp;
    },
  ): Promise<bigint> {
    if (input.allocation.source_type === "subscription") {
      if (
        pgBigInt(
          input.allocation.subscription_grant_epoch,
          "allocation subscription_grant_epoch",
        ) !== pgBigInt(input.account.grant_epoch, "account grant_epoch")
      ) {
        return 0n;
      }
      return CreditService.#returnSubscriptionAtoms(transaction, {
        account: input.account,
        amount: input.amount,
        eventId: input.eventId,
        reason: input.reason,
        asOf: input.asOf,
      });
    }

    if (input.allocation.funding_lot_id === null) {
      throw new Error("credit-pack allocation has no funding lot");
    }
    const lotResult = await transaction.query<FundingLotRow>(
      `select l.*,
              (l.status='active' and l.expires_at <= $2::timestamptz)
                as expires_now,
              false as before_subscription
         from credit_funding_lots l where l.id=$1::uuid for update`,
      [input.allocation.funding_lot_id, input.asOf],
    );
    let lot = lotResult.rows[0];
    if (lot?.account_id !== input.account.id) {
      throw new Error(
        "credit-pack allocation funding lot is missing or conflicting",
      );
    }
    if (lot.expires_now === true) {
      await transaction.query(
        `update credit_funding_lots
            set expired_credits=expired_credits+remaining_credits,
                status='expired',remaining_credits=0,
                closed_at=$2::timestamptz,updated_at=clock_timestamp()
          where id=$1::uuid`,
        [lot.id, input.asOf],
      );
      const refreshedLot = await transaction.query<FundingLotRow>(
        `select l.*,false as expires_now,false as before_subscription
           from credit_funding_lots l where l.id=$1::uuid for update`,
        [lot.id],
      );
      lot = refreshedLot.rows[0];
      if (lot === undefined) {
        throw new Error("credit-pack allocation funding lot disappeared");
      }
    }
    const orderResult = await transaction.query<PackOrderRow>(
      "select * from credit_pack_orders where id=$1::uuid for update",
      [lot.order_id],
    );
    const order = orderResult.rows[0];
    if (order?.account_id !== input.account.id) {
      throw new Error("credit-pack allocation order is missing or conflicting");
    }

    const [relieved, recovered] = await this.#relievePackDebt(transaction, {
      account: input.account,
      orderId: order.id,
      amount: input.amount,
      visiting: input.visiting,
      asOf: input.asOf,
    });
    const restorable = input.amount - relieved;
    let returned = 0n;
    if (restorable > 0n && lot.status === "active") {
      const headroom =
        pgBigInt(order.pack_credits, "pack order credits") -
        pgBigInt(order.refunded_credits, "pack order refunded credits") -
        pgBigInt(lot.remaining_credits, "pack remaining credits");
      const boundedHeadroom = headroom > 0n ? headroom : 0n;
      returned = restorable < boundedHeadroom ? restorable : boundedHeadroom;
      if (returned > 0n) {
        checkedAddAtoms(
          pgBigInt(lot.remaining_credits, "pack remaining credits"),
          returned,
          "refunded credit-pack lot balance",
        );
        await transaction.query(
          `update credit_funding_lots
              set remaining_credits=remaining_credits+$2::bigint,updated_at=now()
            where id=$1::uuid`,
          [lot.id, returned.toString()],
        );
        await collectPackDebtsFromLot(transaction, {
          accountId: input.account.id,
          lotId: lot.id,
          availableAtoms: returned,
        });
      }
    } else if (restorable > 0n && lot.status === "expired") {
      const expiredHeadroom =
        pgBigInt(order.pack_credits, "pack order credits") -
        pgBigInt(order.refunded_credits, "pack order refunded credits") -
        pgBigInt(lot.expired_credits, "pack expired credits");
      const boundedHeadroom = expiredHeadroom > 0n ? expiredHeadroom : 0n;
      const retired =
        restorable < boundedHeadroom ? restorable : boundedHeadroom;
      if (retired > 0n) {
        checkedAddAtoms(
          pgBigInt(lot.expired_credits, "pack expired credits"),
          retired,
          "expired product-refund credits",
        );
        await transaction.query(
          `update credit_funding_lots
              set expired_credits=expired_credits+$2::bigint,updated_at=now()
            where id=$1::uuid`,
          [lot.id, retired.toString()],
        );
      }
    }
    return recovered + returned;
  }

  public async refund(
    idempotencyKeyInput: string,
    options: { readonly expectedAccountId?: string } = {},
  ): Promise<CreditResult> {
    const idempotencyKey = validateIdempotencyKey(idempotencyKeyInput);
    const expectedAccountId =
      options.expectedAccountId === undefined
        ? undefined
        : normalizeUuid(options.expectedAccountId, "expectedAccountId");
    return this.#database.transaction(async (transaction) => {
      let accountId: string;
      if (expectedAccountId === undefined) {
        const snapshot = await transaction.query<
          { readonly account_id: string } & QueryResultRow
        >("select account_id from credit_debits where idempotency_key=$1", [
          idempotencyKey,
        ]);
        const row = snapshot.rows[0];
        if (row === undefined) {
          throw new CreditDebitNotFoundError("credit debit not found");
        }
        accountId = row.account_id;
      } else {
        accountId = expectedAccountId;
      }
      const accountResult = await transaction.query<BillingAccountRow>(
        "select * from billing_accounts where id=$1::uuid for update",
        [accountId],
      );
      const account = accountResult.rows[0];
      if (account === undefined) {
        throw new CreditAccountNotFoundError("billing account not found");
      }
      const databaseNow = await sampleDatabaseClock(transaction);
      await CreditService.#expireAccountPackLots(
        transaction,
        account.id,
        databaseNow,
      );
      const debitResult = await transaction.query<DebitRow>(
        "select * from credit_debits where idempotency_key=$1 for update",
        [idempotencyKey],
      );
      const debit = debitResult.rows[0];
      if (debit === undefined) {
        throw new CreditDebitNotFoundError("credit debit not found");
      }
      if (debit.account_id !== account.id) {
        throw new CreditDebitOwnerMismatchError(
          "credit debit belongs to another account",
        );
      }
      if (debit.kind !== "usage") {
        throw new CreditDebitNotFoundError(
          "credit debit is not a refundable product operation",
        );
      }

      const requested = CreditAmount.fromAtoms(
        pgBigInt(debit.amount, "credit debit amount"),
      );
      if (debit.refunded_at !== null) {
        const total =
          subscriptionAtoms(account, databaseNow) +
          (await packBalanceAtoms(transaction, account.id, {
            lock: true,
            asOf: databaseNow,
          }));
        return new CreditResult("replayed", CreditAmount.fromAtoms(total), {
          requested,
          restored: CreditAmount.fromAtoms(
            pgBigInt(debit.restored_credits, "credit debit restored credits"),
          ),
        });
      }

      const allocationsResult = await transaction.query<AllocationRow>(
        `select * from credit_debit_allocations
          where debit_idempotency_key=$1 order by id for update`,
        [idempotencyKey],
      );
      let restoredAtoms = 0n;
      if (allocationsResult.rows.length === 0) {
        if (
          pgBigInt(debit.grant_epoch, "credit debit grant_epoch") ===
          pgBigInt(account.grant_epoch, "account grant_epoch")
        ) {
          restoredAtoms = await CreditService.#returnSubscriptionAtoms(
            transaction,
            {
              account,
              amount: pgBigInt(debit.amount, "credit debit amount"),
              eventId: `usage-refund:${idempotencyKey}`,
              reason: "usage_refund",
              asOf: databaseNow,
            },
          );
        }
      } else {
        const visiting = new Set([idempotencyKey]);
        for (const allocation of allocationsResult.rows) {
          const pending =
            pgBigInt(allocation.amount, "credit allocation amount") -
            pgBigInt(
              allocation.refunded_amount,
              "credit allocation refunded amount",
            );
          if (pending <= 0n) {
            continue;
          }
          restoredAtoms += await this.#restoreAllocationEffect(transaction, {
            account,
            allocation,
            amount: pending,
            eventId: `usage-refund:${idempotencyKey}`,
            reason: "usage_refund",
            visiting,
            asOf: databaseNow,
          });
          const updated = await transaction.query(
            `update credit_debit_allocations
                set refunded_amount=refunded_amount+$2::bigint,updated_at=now()
              where id=$1::bigint and refunded_amount+$2::bigint <= amount`,
            [allocation.id, pending.toString()],
          );
          if (updated.rowCount !== 1) {
            throw new Error("credit allocation changed during refund");
          }
        }
      }

      const persistedRestored = checkedAddAtoms(
        pgBigInt(debit.restored_credits, "credit debit restored credits"),
        restoredAtoms,
        "product-operation restored credits",
      );
      if (persistedRestored > pgBigInt(debit.amount, "credit debit amount")) {
        throw new Error("restored credits exceed the original product debit");
      }
      await transaction.query(
        `update credit_debits
            set restored_credits=$2::bigint,refunded_at=now()
          where idempotency_key=$1`,
        [idempotencyKey, persistedRestored.toString()],
      );
      const refreshedResult = await transaction.query<BillingAccountRow>(
        "select * from billing_accounts where id=$1::uuid",
        [account.id],
      );
      const refreshed = refreshedResult.rows[0];
      if (refreshed === undefined) {
        throw new Error("billing account disappeared during credit refund");
      }
      const total =
        subscriptionAtoms(refreshed, databaseNow) +
        (await packBalanceAtoms(transaction, account.id, {
          lock: true,
          asOf: databaseNow,
        }));
      return new CreditResult(
        restoredAtoms > 0n ? "refunded" : "epoch_expired",
        CreditAmount.fromAtoms(total),
        {
          requested,
          restored: CreditAmount.fromAtoms(persistedRestored),
        },
      );
    });
  }
}
