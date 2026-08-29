import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "vitest";

import { PlanCatalog } from "../../src/catalog.js";
import {
  BillingOwnerNotFoundError,
  CreditIdempotencyConflictError,
  EntitlementService,
  InvalidCreditRequestError,
} from "../../src/entitlements.js";
import type { Database } from "../../src/database.js";
import { postgresDatabase } from "../support/postgres-setup.js";

const CATALOG_PATH = fileURLToPath(
  new URL("../../../plans.toml", import.meta.url),
);
const CREDITS = 1_000_000n;

let database: Database;
let catalog: PlanCatalog;

beforeAll(async () => {
  database = postgresDatabase();
  catalog = await PlanCatalog.fromToml(CATALOG_PATH);
});

async function fundedOwner(): Promise<{
  readonly accountId: string;
  readonly owner: string;
}> {
  const owner = `parity:user:${randomUUID()}`;
  const accountId = await database.createAccount(owner);
  await database.query(
    `update billing_accounts
        set plan_key='starter',plan_interval='month',
            subscription_status='active',credits_balance=$2::bigint,
            grant_epoch=1,entitlement_revoked=false,
            credit_expires_at=clock_timestamp()+interval '30 days'
      where id=$1::uuid`,
    [accountId, (300n * CREDITS).toString()],
  );
  return { accountId, owner };
}

describe("EntitlementService Python parity boundaries", () => {
  test("distinguishes an unavailable limit from an exceeded catalog limit", async () => {
    const { owner } = await fundedOwner();
    const service = new EntitlementService(database, catalog);

    const unavailable = await service.check(owner, {
      requiredLimits: { custom_operation_limit: 0 },
    });
    expect([unavailable.allowed, unavailable.reason]).toEqual([
      false,
      "limit_not_available",
    ]);
    expect(unavailable.limits["custom_operation_limit"]).toEqual({
      requested: 0,
      maximum: null,
      allowed: false,
    });
  });

  test("requires exact decimal strings and an existing billing owner", async () => {
    const { owner } = await fundedOwner();
    const service = new EntitlementService(database, catalog);

    await expect(
      service.charge(owner, 0.1 as unknown as string, "numeric-amount"),
    ).rejects.toBeInstanceOf(InvalidCreditRequestError);
    await expect(
      service.charge(owner, "1e-1", "exponent-amount"),
    ).rejects.toBeInstanceOf(InvalidCreditRequestError);
    await expect(
      service.charge(
        `parity:user:${randomUUID()}`,
        "1",
        "missing-owner-operation",
      ),
    ).rejects.toBeInstanceOf(BillingOwnerNotFoundError);
  });

  test("maps a global debit-key collision across owners to a facade conflict", async () => {
    const first = await fundedOwner();
    const second = await fundedOwner();
    const service = new EntitlementService(database, catalog);

    await service.charge(first.owner, "10", "cross-owner-global-key");
    await expect(
      service.charge(second.owner, "10", "cross-owner-global-key"),
    ).rejects.toBeInstanceOf(CreditIdempotencyConflictError);
  });
});
