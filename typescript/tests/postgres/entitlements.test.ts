import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "vitest";

import { PlanCatalog } from "../../src/catalog.js";
import { CreditPackCoordinator } from "../../src/credit-pack-coordinator.js";
import {
  CreditIdempotencyConflictError,
  CreditOperationNotFoundError,
  EntitlementService,
} from "../../src/entitlements.js";
import { InsufficientCreditsError } from "../../src/credits.js";
import type { Database } from "../../src/database.js";
import { postgresDatabase } from "../support/postgres-setup.js";

const CATALOG_PATH = fileURLToPath(
  new URL("../../../plans.toml", import.meta.url),
);
const STARTER_ATOMS = 300_000_000n;

let database: Database;
let catalog: PlanCatalog;

async function fundedOwner(
  options: {
    readonly owner?: string;
    readonly credits?: bigint;
    readonly epoch?: bigint;
  } = {},
): Promise<{ readonly accountId: string; readonly owner: string }> {
  const owner = options.owner ?? `v1:user:${randomUUID()}`;
  const accountId = await database.createAccount(owner);
  await database.query(
    `update billing_accounts set
       stripe_customer_id=$2,stripe_subscription_id=$3,
       plan_key='starter',plan_interval='month',subscription_status='active',
       credits_balance=$4::bigint,grant_epoch=$5::bigint,
       current_period_end=clock_timestamp()+interval '30 days',
       entitlement_period_end=clock_timestamp()+interval '30 days',
       credit_expires_at=clock_timestamp()+interval '30 days'
     where id=$1::uuid`,
    [
      accountId,
      `cus_${randomUUID()}`,
      `sub_${randomUUID()}`,
      (options.credits ?? STARTER_ATOMS).toString(),
      (options.epoch ?? 1n).toString(),
    ],
  );
  return { accountId, owner };
}

async function addPaidPack(accountId: string): Promise<void> {
  const coordinator = new CreditPackCoordinator(database, catalog);
  const reservation = await coordinator.reserve(
    accountId,
    catalog.requireCreditPack("boost-100"),
    `pack-${randomUUID()}`,
  );
  await database.transaction(async (transaction) => {
    await transaction.query(
      `update credit_pack_orders set
         checkout_status='completed',payment_status='paid',
         stripe_checkout_session_id=$2,stripe_payment_intent_id=$3,
         stripe_charge_id=$4,amount_paid=price_amount,paid_at=clock_timestamp()
       where id=$1::uuid`,
      [
        reservation.orderId,
        `cs_${reservation.orderId}`,
        `pi_${reservation.orderId}`,
        `ch_${reservation.orderId}`,
      ],
    );
    await transaction.query(
      `insert into credit_funding_lots(
         id,order_id,account_id,original_credits,remaining_credits,expires_at
       ) values(
         $1::uuid,$2::uuid,$3::uuid,100000000,100000000,
         clock_timestamp()+interval '30 days'
       )`,
      [randomUUID(), reservation.orderId, accountId],
    );
  });
}

beforeAll(async () => {
  database = postgresDatabase();
  catalog = await PlanCatalog.fromToml(CATALOG_PATH);
});

describe("owner-bound entitlement facade", () => {
  test("enforces features and limits without creating a missing owner", async () => {
    const { owner } = await fundedOwner();
    const service = new EntitlementService(database, catalog);

    const allowed = await service.check(owner, {
      requiredFeatures: ["pdf_to_ppt"],
      requiredLimits: { max_file_mb: 30, max_pages_per_job: 100 },
    });
    const deniedFeature = await service.check(owner, {
      requiredFeatures: ["api_access"],
    });
    const deniedLimit = await service.check(owner, {
      requiredLimits: { max_file_mb: 31 },
    });
    const missing = await service.check(`v1:user:${randomUUID()}`);

    expect(allowed).toMatchObject({
      allowed: true,
      reason: "allowed",
      entitlementsEnforceable: true,
      creditsSpendable: true,
      features: { pdf_to_ppt: true },
    });
    expect(allowed.creditBalance.atoms).toBe(STARTER_ATOMS);
    expect(allowed.limits["max_file_mb"]).toEqual({
      requested: 30,
      maximum: 30,
      allowed: true,
    });
    expect(deniedFeature.reason).toBe("feature_not_available");
    expect(deniedLimit.reason).toBe("limit_exceeded");
    expect(missing.reason).toBe("owner_not_found");
    const count = await database.query<{ readonly count: string }>(
      "select count(*)::bigint from billing_accounts",
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  test("expired subscription funding fails closed", async () => {
    const { accountId, owner } = await fundedOwner();
    await database.query(
      `update billing_accounts set credit_expires_at=clock_timestamp()-interval '1 second'
        where id=$1::uuid`,
      [accountId],
    );

    const decision = await new EntitlementService(database, catalog).check(
      owner,
      {
        requiredFeatures: ["pdf_to_ppt"],
        requiredLimits: { max_file_mb: 1 },
      },
    );

    expect(decision).toMatchObject({
      allowed: false,
      reason: "entitlement_not_enforceable",
      entitlementsEnforceable: false,
      creditsSpendable: false,
      features: { pdf_to_ppt: false },
    });
    expect(decision.creditBalance.atoms).toBe(0n);
    expect(decision.creditExpiresAt).toBeNull();
  });

  test("pack funding remains spendable without granting subscription features", async () => {
    const owner = `v1:user:${randomUUID()}`;
    const accountId = await database.createAccount(owner);
    await addPaidPack(accountId);
    const service = new EntitlementService(database, catalog);

    const decision = await service.check(owner, {
      requiredFeatures: ["pdf_to_ppt"],
    });
    const charged = await service.charge(owner, "25", "pack-only-job");
    const after = await service.check(owner);

    expect(decision).toMatchObject({
      allowed: false,
      reason: "entitlement_not_enforceable",
      creditsSpendable: true,
      features: { pdf_to_ppt: false },
    });
    expect(decision.creditBalance.atoms).toBe(100_000_000n);
    expect(charged.balance.atoms).toBe(75_000_000n);
    expect(after.creditBalance.atoms).toBe(75_000_000n);
  });

  test("equivalent fractional decimals replay and changed amounts conflict", async () => {
    const { owner } = await fundedOwner();
    const service = new EntitlementService(database, catalog);

    const charged = await service.charge(owner, "0.125", "fractional-job");
    const replayed = await service.charge(owner, "0.125000", "fractional-job");

    expect(charged.outcome).toBe("charged");
    expect(charged.balance.atoms).toBe(299_875_000n);
    expect(replayed.outcome).toBe("replayed");
    expect(replayed.balance.atoms).toBe(299_875_000n);
    await expect(
      service.charge(owner, "0.125001", "fractional-job"),
    ).rejects.toBeInstanceOf(CreditIdempotencyConflictError);
  });

  test("same owner and idempotency key is effectively once under concurrency", async () => {
    const { owner } = await fundedOwner();
    const service = new EntitlementService(database, catalog);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.charge(owner, "25", "same-concurrent-job"),
      ),
    );

    expect(
      results.filter((result) => result.outcome === "charged"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.outcome === "replayed"),
    ).toHaveLength(19);
    expect(
      results.every((result) => result.balance.atoms === 275_000_000n),
    ).toBe(true);
  });

  test("distinct concurrent charges cannot overdraw", async () => {
    const { accountId, owner } = await fundedOwner();
    const service = new EntitlementService(database, catalog);
    const results = await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        try {
          return (
            await service.charge(owner, "100", `distinct-${String(index)}`)
          ).outcome;
        } catch (error) {
          if (error instanceof InsufficientCreditsError) {
            return "insufficient";
          }
          throw error;
        }
      }),
    );

    expect(results.filter((result) => result === "charged")).toHaveLength(3);
    expect(results.filter((result) => result === "insufficient")).toHaveLength(
      7,
    );
    const balance = await database.query<{ readonly credits_balance: string }>(
      "select credits_balance from billing_accounts where id=$1::uuid",
      [accountId],
    );
    expect(balance.rows[0]?.credits_balance).toBe("0");
  });

  test("refund is owner-bound, concurrent-safe, and cannot cross an epoch", async () => {
    const first = await fundedOwner();
    const second = await fundedOwner();
    const service = new EntitlementService(database, catalog);
    await service.charge(first.owner, "40", "owner-refund-job");

    await expect(
      service.refund(second.owner, "owner-refund-job"),
    ).rejects.toBeInstanceOf(CreditOperationNotFoundError);
    const refunds = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.refund(first.owner, "owner-refund-job"),
      ),
    );
    expect(
      refunds.filter((result) => result.outcome === "refunded"),
    ).toHaveLength(1);
    expect(
      refunds.filter((result) => result.outcome === "replayed"),
    ).toHaveLength(19);

    await service.charge(first.owner, "10", "old-epoch-job");
    await database.query(
      `update billing_accounts set grant_epoch=grant_epoch+1,credits_balance=$2::bigint
        where id=$1::uuid`,
      [first.accountId, STARTER_ATOMS.toString()],
    );
    const stale = await service.refund(first.owner, "old-epoch-job");
    expect(stale.outcome).toBe("epoch_expired");
    expect(stale.balance.atoms).toBe(STARTER_ATOMS);
  });
});
