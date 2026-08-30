import { fileURLToPath } from "node:url";

import type Stripe from "stripe";
import { beforeAll, describe, expect, test, vi } from "vitest";

import { PlanCatalog } from "../../src/catalog.js";
import {
  CheckoutActiveSubscriptionError,
  CheckoutBusyError,
  CheckoutCreationRejected,
  CheckoutCoordinator,
  type CheckoutCreator,
  CheckoutReplayUnsafeError,
  validateCheckoutSessionIdentity,
} from "../../src/checkout.js";
import {
  CreditPackBusyError,
  CreditPackConflictError,
  CreditPackCoordinator,
  type CreditPackCheckoutCreator,
} from "../../src/credit-pack-coordinator.js";
import {
  buildCreditPackCheckoutRequestSnapshot,
  buildSubscriptionCheckoutRequestSnapshot,
  type CheckoutRequestSnapshot,
} from "../../src/stripe-request-snapshots.js";
import { StripeGateway } from "../../src/stripe-gateway.js";
import { postgresDatabase } from "../support/postgres-setup.js";

const ROOT_CATALOG = fileURLToPath(
  new URL("../../../plans.toml", import.meta.url),
);
let catalog: PlanCatalog;

function subscriptionSnapshot(
  input: Parameters<CheckoutCreator["prepareCheckoutSession"]>[0],
): CheckoutRequestSnapshot {
  return buildSubscriptionCheckoutRequestSnapshot({
    accountId: input.accountId,
    claimToken: input.claimToken,
    ...(input.customerId === undefined ? {} : { customerId: input.customerId }),
    priceId: "price_starter_month",
    lookupKey: input.lookupKey,
    currency: input.expectedCurrency,
    unitAmount: input.expectedUnitAmount,
    interval: input.expectedInterval,
    planKey: input.planKey,
    productLine: "example-entitlements",
    successUrl: `https://app.example.test/success?plan=${input.planKey}`,
    cancelUrl: "https://app.example.test/pricing",
    expiresAt: input.expiresAtEpoch,
    requestApiVersion: "2026-06-24.dahlia",
  });
}

function packSnapshot(
  input: Parameters<
    CreditPackCheckoutCreator["prepareCreditPackCheckoutSession"]
  >[0],
): CheckoutRequestSnapshot {
  return buildCreditPackCheckoutRequestSnapshot({
    orderId: input.orderId,
    accountId: input.accountId,
    ...(input.customerId === undefined ? {} : { customerId: input.customerId }),
    priceId: "price_pack",
    lookupKey: input.lookupKey,
    currency: input.expectedCurrency,
    unitAmount: input.expectedUnitAmount,
    packKey: input.packKey,
    packCredits: input.packCredits,
    expiresDays: input.expiresDays,
    productLine: "example-entitlements",
    successUrl: `https://app.example.test/success?pack=${input.packKey}`,
    cancelUrl: "https://app.example.test/pricing",
    expiresAt: input.expiresAtEpoch,
    requestApiVersion: "2026-06-24.dahlia",
  });
}

function recurringPrice(): Record<string, unknown> {
  return {
    id: "price_starter_month",
    lookup_key: "ent_starter_month",
    active: true,
    type: "recurring",
    currency: "usd",
    unit_amount: 1900,
    billing_scheme: "per_unit",
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    tax_behavior: "unspecified",
    tiers_mode: null,
    transform_quantity: null,
    custom_unit_amount: null,
    currency_options: null,
    product: {
      id: "prod_starter",
      active: true,
      metadata: { product_line: "old-line", plan: "starter" },
    },
  };
}

function oneTimePrice(): Record<string, unknown> {
  return {
    id: "price_pack_boost_100",
    lookup_key: "ent_pack_boost-100",
    active: true,
    type: "one_time",
    currency: "usd",
    unit_amount: 1500,
    billing_scheme: "per_unit",
    recurring: null,
    tax_behavior: "unspecified",
    tiers_mode: null,
    transform_quantity: null,
    custom_unit_amount: null,
    currency_options: null,
    metadata: { product_line: "old-line", credit_pack: "boost-100" },
    product: {
      id: "prod_pack_boost_100",
      active: true,
      metadata: { product_line: "old-line", credit_pack: "boost-100" },
    },
  };
}

function gateway(
  client: Stripe,
  options: {
    readonly apiVersion: string;
    readonly productLine: string;
    readonly successUrl: string;
  },
): StripeGateway {
  return new StripeGateway("sk_test_checkout_snapshot", "whsec_snapshot", {
    client,
    apiVersion: options.apiVersion,
    productLine: options.productLine,
    checkoutSuccessUrl: options.successUrl,
    checkoutCancelUrl: `${new URL(options.successUrl).origin}/pricing`,
  });
}

function subscriptionCreator(value: StripeGateway): CheckoutCreator {
  return {
    prepareCheckoutSession: (input) => value.prepareCheckoutSession(input),
    createCheckoutSessionFromSnapshot: (snapshot) =>
      value.createCheckoutSessionFromSnapshot(snapshot),
  };
}

function creditPackCreator(value: StripeGateway): CreditPackCheckoutCreator {
  return {
    prepareCreditPackCheckoutSession: (input) =>
      value.prepareCreditPackCheckoutSession(input),
    createCheckoutSessionFromSnapshot: (snapshot) =>
      value.createCheckoutSessionFromSnapshot(snapshot),
  };
}

beforeAll(async () => {
  catalog = await PlanCatalog.fromToml(ROOT_CATALOG);
});

async function account(
  externalRef: string,
  customerId?: string,
): Promise<string> {
  const id = await postgresDatabase().createAccount(externalRef);
  if (customerId !== undefined) {
    await postgresDatabase().query(
      "update billing_accounts set stripe_customer_id=$2 where id=$1::uuid",
      [id, customerId],
    );
  }
  return id;
}

describe("subscription Checkout single flight", () => {
  test("rejects malformed or origin-unsafe returned Session URLs", () => {
    for (const sessionUrl of [
      "not a URL",
      "http://checkout.stripe.test/session",
      "https://user:password@checkout.stripe.test/session",
    ]) {
      expect(() =>
        validateCheckoutSessionIdentity("cs_test_identity", sessionUrl),
      ).toThrow(/origin-safe HTTPS URL/u);
    }
  });

  test("validates reservation inputs before opening a transaction", async () => {
    const coordinator = new CheckoutCoordinator(postgresDatabase());
    for (const ttlSeconds of [0, 1.5, 86_401]) {
      await expect(
        coordinator.reserve(
          "00000000-0000-0000-0000-000000000000",
          "starter",
          "month",
          {
            ttlSeconds,
          },
        ),
      ).rejects.toBeInstanceOf(RangeError);
    }
    await expect(
      coordinator.reserve(
        "00000000-0000-0000-0000-000000000000",
        "bad_key",
        "month",
      ),
    ).rejects.toThrow(/underscore/u);
    await expect(
      coordinator.reserve(
        "00000000-0000-0000-0000-000000000000",
        "starter",
        "week" as never,
      ),
    ).rejects.toThrow(/month or year/u);
    await expect(
      coordinator.reserve(
        "00000000-0000-0000-0000-000000000000",
        "starter",
        "month",
      ),
    ).rejects.toThrow(/billing account not found/u);
  });

  test("rejects every existing-subscription authority state", async () => {
    const coordinator = new CheckoutCoordinator(postgresDatabase());
    const subscriptionId = await account(
      "ts-checkout-existing-id",
      "cus_existing_id",
    );
    await postgresDatabase().query(
      "update billing_accounts set stripe_subscription_id='sub_existing' where id=$1::uuid",
      [subscriptionId],
    );
    await expect(
      coordinator.reserve(subscriptionId, "starter", "month"),
    ).rejects.toBeInstanceOf(CheckoutActiveSubscriptionError);

    for (const status of ["active", "past_due"] as const) {
      const accountId = await account(
        `ts-checkout-existing-${status}`,
        `cus_${status}`,
      );
      await postgresDatabase().query(
        "update billing_accounts set subscription_status=$2 where id=$1::uuid",
        [accountId, status],
      );
      await expect(
        coordinator.reserve(accountId, "starter", "month"),
      ).rejects.toBeInstanceOf(CheckoutActiveSubscriptionError);
    }
  });

  test("deterministically rejects a first-Customer subscription while a pack owns authority", async () => {
    const accountId = await account("ts-checkout-pack-authority");
    const packs = new CreditPackCoordinator(postgresDatabase(), catalog);
    await packs.reserve(
      accountId,
      catalog.requireCreditPack("boost-100"),
      "pack-first",
    );
    await expect(
      new CheckoutCoordinator(postgresDatabase()).reserve(
        accountId,
        "starter",
        "month",
        { requestKey: "subscription-second" },
      ),
    ).rejects.toBeInstanceOf(CheckoutBusyError);
  });

  test("replaces only an expired Checkout claim", async () => {
    const accountId = await account(
      "ts-checkout-expired-replacement",
      "cus_expired",
    );
    const coordinator = new CheckoutCoordinator(postgresDatabase());
    const first = await coordinator.reserve(accountId, "starter", "month", {
      requestKey: "expired-first",
    });
    await postgresDatabase().query(
      "update checkout_claims set expires_at=clock_timestamp()-interval '1 second' where account_id=$1::uuid",
      [accountId],
    );
    const replacement = await coordinator.reserve(
      accountId,
      "starter",
      "month",
      {
        requestKey: "expired-second",
      },
    );
    expect(replacement.claimToken).not.toBe(first.claimToken);
    const count = await postgresDatabase().query<{ readonly count: string }>(
      "select count(*) from checkout_claims where account_id=$1::uuid",
      [accountId],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  test("fails snapshot freeze when its claim disappeared", async () => {
    const accountId = await account(
      "ts-checkout-freeze-missing",
      "cus_freeze_missing",
    );
    const coordinator = new CheckoutCoordinator(postgresDatabase());
    const reservation = await coordinator.reserve(
      accountId,
      "starter",
      "month",
      {
        requestKey: "freeze-missing",
      },
    );
    await postgresDatabase().query(
      "delete from checkout_claims where account_id=$1::uuid",
      [accountId],
    );
    const snapshot = buildSubscriptionCheckoutRequestSnapshot({
      accountId,
      claimToken: reservation.claimToken,
      customerId: "cus_freeze_missing",
      priceId: "price_starter_month",
      lookupKey: "ent_starter_month",
      currency: "usd",
      unitAmount: 1900n,
      interval: "month",
      planKey: "starter",
      productLine: "example-entitlements",
      successUrl: "https://app.example.test/success",
      cancelUrl: "https://app.example.test/pricing",
      expiresAt: reservation.expiresAtEpoch,
      requestApiVersion: "2026-06-24.dahlia",
    });
    await expect(
      coordinator.freezeRequestSnapshot(reservation, snapshot),
    ).rejects.toBeInstanceOf(CheckoutReplayUnsafeError);
  });

  test("rejects invalid frozen recovery identity and returns no match safely", async () => {
    const coordinator = new CheckoutCoordinator(postgresDatabase());
    const creator: CheckoutCreator = {
      async prepareCheckoutSession() {
        throw new Error("must not prepare");
      },
      async createCheckoutSessionFromSnapshot() {
        throw new Error("must not create");
      },
    };
    await expect(
      coordinator.recoverFrozen(creator, {
        accountId: "00000000-0000-0000-0000-000000000000",
        planKey: "bad_key",
        interval: "month",
        requestKey: "recover-bad-plan",
      }),
    ).rejects.toThrow(/invalid frozen Checkout recovery identity/u);
    await expect(
      coordinator.recoverFrozen(creator, {
        accountId: "00000000-0000-0000-0000-000000000000",
        planKey: "starter",
        interval: "week" as never,
        requestKey: "recover-bad-interval",
      }),
    ).rejects.toThrow(/invalid frozen Checkout recovery identity/u);
    await expect(
      coordinator.recoverFrozen(creator, {
        accountId: "00000000-0000-0000-0000-000000000000",
        planKey: "starter",
        interval: "month",
        requestKey: "recover-missing",
      }),
    ).resolves.toBeUndefined();
  });

  test("wraps an invalid Session identity returned after a frozen request", async () => {
    const accountId = await account("ts-checkout-invalid-created-session");
    const coordinator = new CheckoutCoordinator(postgresDatabase());
    const creator: CheckoutCreator = {
      async prepareCheckoutSession(input) {
        return subscriptionSnapshot(input);
      },
      async createCheckoutSessionFromSnapshot() {
        return ["cs_test_invalid_url", "not a URL"];
      },
    };
    await expect(
      coordinator.create(creator, {
        accountId,
        planKey: "starter",
        interval: "month",
        lookupKey: "ent_starter_month",
        expectedCurrency: "usd",
        expectedUnitAmount: 1900n,
        expectedInterval: "month",
        requestKey: "invalid-created-session",
      }),
    ).rejects.toThrow(/creator returned an invalid Session identity/u);
  });

  test("rejects interval mismatch before reservation, Price lookup, or remote creation", async () => {
    const accountId = await account("ts-checkout-interval-mismatch");
    const coordinator = new CheckoutCoordinator(postgresDatabase());
    let calls = 0;
    const creator: CheckoutCreator = {
      async prepareCheckoutSession() {
        calls += 1;
        throw new Error("must not prepare");
      },
      async createCheckoutSessionFromSnapshot() {
        calls += 1;
        throw new Error("must not create");
      },
    };
    await expect(
      coordinator.create(creator, {
        accountId,
        planKey: "starter",
        interval: "month",
        lookupKey: "ent_starter_month",
        expectedCurrency: "usd",
        expectedUnitAmount: 1900n,
        expectedInterval: "year",
        requestKey: "mismatch",
      }),
    ).rejects.toBeInstanceOf(CheckoutCreationRejected);
    expect(calls).toBe(0);
    const rows = await postgresDatabase().query<{ readonly count: string }>(
      "select count(*) from checkout_claims where account_id=$1::uuid",
      [accountId],
    );
    expect(rows.rows[0]?.count).toBe("0");
  });

  test("concurrent different intents allow exactly one claim", async () => {
    const accountId = await account("ts-checkout-concurrent");
    const coordinator = new CheckoutCoordinator(postgresDatabase());
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, index) => {
        try {
          const value = await coordinator.reserve(
            accountId,
            "starter",
            "month",
            {
              requestKey: `request-${index}`,
            },
          );
          return value.claimToken;
        } catch (error: unknown) {
          if (error instanceof CheckoutBusyError) {
            return "busy";
          }
          throw error;
        }
      }),
    );
    expect(results.filter((value) => value !== "busy")).toHaveLength(1);
  });

  test("same request replays immutable customer/create-mode facts", async () => {
    const accountId = await account("ts-checkout-replay", "cus_original");
    const coordinator = new CheckoutCoordinator(postgresDatabase());
    const first = await coordinator.reserve(accountId, "starter", "month", {
      requestKey: "stable-request",
    });
    await postgresDatabase().query(
      "update billing_accounts set stripe_customer_id='cus_later' where id=$1::uuid",
      [accountId],
    );
    const replay = await coordinator.reserve(accountId, "starter", "month", {
      requestKey: "stable-request",
    });
    expect(replay.claimToken).toBe(first.claimToken);
    expect(replay.requestCustomerId).toBe("cus_original");
    expect(replay.expiresAt).toMatch(/\.\d{6}Z$/u);
  });

  test("keeps an unknown remote outcome claim and replays the attached Session", async () => {
    const accountId = await account("ts-checkout-unknown");
    const coordinator = new CheckoutCoordinator(postgresDatabase());
    let attempts = 0;
    const creator: CheckoutCreator = {
      async prepareCheckoutSession(input) {
        return subscriptionSnapshot(input);
      },
      async createCheckoutSessionFromSnapshot(): Promise<
        readonly [string, string]
      > {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("unknown transport outcome");
        }
        return ["cs_test_recovered", "https://checkout.stripe.test/recovered"];
      },
    };
    const input = {
      accountId,
      planKey: "starter",
      interval: "month" as const,
      lookupKey: "ent_starter_month",
      expectedCurrency: "usd",
      expectedUnitAmount: 1900n,
      expectedInterval: "month" as const,
      requestKey: "unknown-outcome",
    };
    await expect(coordinator.create(creator, input)).rejects.toThrow(
      "unknown transport",
    );
    await expect(coordinator.create(creator, input)).resolves.toEqual([
      "cs_test_recovered",
      "https://checkout.stripe.test/recovered",
    ]);
    await expect(coordinator.create(creator, input)).resolves.toEqual([
      "cs_test_recovered",
      "https://checkout.stripe.test/recovered",
    ]);
    expect(attempts).toBe(2);
  });

  test("concurrent preparers execute outside transactions and replay the CAS winner exactly", async () => {
    const accountId = await account(
      "ts-checkout-concurrent-freeze",
      "cus_frozen",
    );
    const coordinator = new CheckoutCoordinator(postgresDatabase());
    let preparedCount = 0;
    let openBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      openBarrier = resolve;
    });
    const remoteSnapshots: CheckoutRequestSnapshot[] = [];
    const candidates: CheckoutRequestSnapshot[] = [];
    const creator: CheckoutCreator = {
      async prepareCheckoutSession(input) {
        const index = preparedCount;
        preparedCount += 1;
        if (preparedCount === 2) {
          openBarrier?.();
        }
        await barrier;
        const candidate = buildSubscriptionCheckoutRequestSnapshot({
          accountId: input.accountId,
          claimToken: input.claimToken,
          ...(input.customerId === undefined
            ? {}
            : { customerId: input.customerId }),
          priceId: `price_candidate_${String(index)}`,
          lookupKey: input.lookupKey,
          currency: input.expectedCurrency,
          unitAmount: input.expectedUnitAmount,
          interval: input.expectedInterval,
          planKey: input.planKey,
          productLine: `line-${String(index)}`,
          successUrl: `https://candidate-${String(index)}.example.test/success`,
          cancelUrl: `https://candidate-${String(index)}.example.test/pricing`,
          expiresAt: input.expiresAtEpoch,
          requestApiVersion: `202${String(5 + index)}-12-15.clover`,
        });
        candidates.push(candidate);
        return candidate;
      },
      async createCheckoutSessionFromSnapshot(snapshot) {
        remoteSnapshots.push(snapshot);
        return [
          "cs_test_cas_winner",
          "https://checkout.stripe.test/cas-winner",
        ];
      },
    };
    const input = {
      accountId,
      planKey: "starter",
      interval: "month" as const,
      lookupKey: "ent_starter_month",
      expectedCurrency: "usd",
      expectedUnitAmount: 1900n,
      expectedInterval: "month" as const,
      requestKey: "same-concurrent-request",
    };

    const results = await Promise.all([
      coordinator.create(creator, input),
      coordinator.create(creator, input),
    ]);

    expect(results[0]).toEqual(results[1]);
    expect(preparedCount).toBe(2);
    expect(remoteSnapshots).toHaveLength(2);
    expect(remoteSnapshots[1]).toEqual(remoteSnapshots[0]);
    expect(candidates).toContainEqual(remoteSnapshots[0]);
    const persisted = await postgresDatabase().query<{
      readonly request_snapshot_version: number;
      readonly stripe_request_snapshot: unknown;
    }>(
      "select request_snapshot_version,stripe_request_snapshot from checkout_claims where account_id=$1::uuid",
      [accountId],
    );
    expect(persisted.rows[0]?.request_snapshot_version).toBe(1);
    expect(persisted.rows[0]?.stripe_request_snapshot).toEqual(
      remoteSnapshots[0],
    );
  });

  test("a deterministic loser cannot release the winner's frozen claim", async () => {
    const accountId = await account("ts-checkout-freeze-release-race");
    const coordinator = new CheckoutCoordinator(postgresDatabase());
    let prepareCalls = 0;
    let remoteCalls = 0;
    let markWinnerFrozen: (() => void) | undefined;
    const winnerFrozen = new Promise<void>((resolve) => {
      markWinnerFrozen = resolve;
    });
    let markLoserReady: (() => void) | undefined;
    const loserReady = new Promise<void>((resolve) => {
      markLoserReady = resolve;
    });
    const creator: CheckoutCreator = {
      async prepareCheckoutSession(input) {
        prepareCalls += 1;
        if (prepareCalls === 1) {
          await loserReady;
          return subscriptionSnapshot(input);
        }
        markLoserReady?.();
        await winnerFrozen;
        throw new CheckoutCreationRejected("loser catalog rejection");
      },
      async createCheckoutSessionFromSnapshot() {
        remoteCalls += 1;
        markWinnerFrozen?.();
        return ["cs_test_frozen_winner", "https://checkout.stripe.test/winner"];
      },
    };
    const input = {
      accountId,
      planKey: "starter",
      interval: "month" as const,
      lookupKey: "ent_starter_month",
      expectedCurrency: "usd",
      expectedUnitAmount: 1900n,
      expectedInterval: "month" as const,
      requestKey: "freeze-release-race",
    };
    const outcomes = await Promise.allSettled([
      coordinator.create(creator, input),
      coordinator.create(creator, input),
    ]);
    expect(
      outcomes.filter((value) => value.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find((value) => value.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      CheckoutCreationRejected,
    );
    const row = await postgresDatabase().query<{
      readonly request_snapshot_version: number;
      readonly stripe_request_snapshot: unknown;
      readonly session_id: string | null;
    }>(
      "select request_snapshot_version,stripe_request_snapshot,session_id from checkout_claims where account_id=$1::uuid",
      [accountId],
    );
    expect(row.rows[0]).toMatchObject({
      request_snapshot_version: 1,
      session_id: "cs_test_frozen_winner",
    });
    expect(row.rows[0]?.stripe_request_snapshot).not.toBeNull();
    await expect(coordinator.create(creator, input)).resolves.toEqual([
      "cs_test_frozen_winner",
      "https://checkout.stripe.test/winner",
    ]);
    await expect(
      coordinator.reserve(accountId, "starter", "month", {
        requestKey: "different-key",
      }),
    ).rejects.toBeInstanceOf(CheckoutBusyError);
    expect(remoteCalls).toBe(1);
  });

  test("unknown success survives Customer, URL, API, product-line, lookup, and Price drift", async () => {
    const accountId = await account("ts-checkout-drift", "cus_original");
    const coordinator = new CheckoutCoordinator(postgresDatabase());
    const firstCreate = vi.fn().mockRejectedValue(new Error("unknown result"));
    const firstPrices = vi.fn().mockResolvedValue({
      data: [recurringPrice()],
      has_more: false,
    });
    const firstClient = {
      prices: { list: firstPrices },
      checkout: { sessions: { create: firstCreate } },
    } as unknown as Stripe;
    const firstGateway = gateway(firstClient, {
      apiVersion: "2025-12-15.clover",
      productLine: "old-line",
      successUrl: "https://old.example.test/success",
    });
    const baseInput = {
      accountId,
      planKey: "starter",
      interval: "month" as const,
      lookupKey: "ent_starter_month",
      expectedCurrency: "usd",
      expectedUnitAmount: 1900n,
      expectedInterval: "month" as const,
      requestKey: "unknown-drift",
    };
    await expect(
      coordinator.create(subscriptionCreator(firstGateway), baseInput),
    ).rejects.toThrow("unknown result");

    await postgresDatabase().query(
      "update billing_accounts set stripe_customer_id='cus_rotated' where id=$1::uuid",
      [accountId],
    );
    const secondPrices = vi
      .fn()
      .mockRejectedValue(new Error("Price.list must not run on replay"));
    const secondCreate = vi.fn().mockResolvedValue({
      id: "cs_test_recovered",
      url: "https://checkout.stripe.test/recovered",
    });
    const secondClient = {
      prices: { list: secondPrices },
      checkout: { sessions: { create: secondCreate } },
    } as unknown as Stripe;
    const secondGateway = gateway(secondClient, {
      apiVersion: "2026-06-24.dahlia",
      productLine: "new-line",
      successUrl: "https://new.example.test/success",
    });
    await expect(
      coordinator.create(subscriptionCreator(secondGateway), {
        ...baseInput,
        lookupKey: "rotated_starter_month",
        expectedCurrency: "eur",
        expectedUnitAmount: 7777n,
      }),
    ).resolves.toEqual([
      "cs_test_recovered",
      "https://checkout.stripe.test/recovered",
    ]);

    expect(firstPrices).toHaveBeenCalledTimes(1);
    expect(secondPrices).not.toHaveBeenCalled();
    expect(secondCreate.mock.calls[0]).toEqual(firstCreate.mock.calls[0]);
  });

  test("legacy, malformed, and v0-with-session claims fail closed without creator I/O", async () => {
    const coordinator = new CheckoutCoordinator(postgresDatabase());
    let calls = 0;
    const creator: CheckoutCreator = {
      async prepareCheckoutSession() {
        calls += 1;
        throw new Error("must not prepare");
      },
      async createCheckoutSessionFromSnapshot() {
        calls += 1;
        throw new Error("must not create");
      },
    };
    const inputFor = (accountId: string, requestKey: string) => ({
      accountId,
      planKey: "starter",
      interval: "month" as const,
      lookupKey: "ent_starter_month",
      expectedCurrency: "usd",
      expectedUnitAmount: 1900n,
      expectedInterval: "month" as const,
      requestKey,
    });

    const legacyId = await account("ts-checkout-legacy");
    await coordinator.reserve(legacyId, "starter", "month", {
      requestKey: "legacy",
    });
    await postgresDatabase().query(
      "update checkout_claims set request_snapshot_version=null where account_id=$1::uuid",
      [legacyId],
    );
    await expect(
      coordinator.create(creator, inputFor(legacyId, "legacy")),
    ).rejects.toBeInstanceOf(CheckoutReplayUnsafeError);

    const malformedId = await account("ts-checkout-malformed");
    await coordinator.reserve(malformedId, "starter", "month", {
      requestKey: "malformed",
    });
    await postgresDatabase().query(
      "update checkout_claims set request_snapshot_version=1,stripe_request_snapshot='{}'::jsonb where account_id=$1::uuid",
      [malformedId],
    );
    await expect(
      coordinator.create(creator, inputFor(malformedId, "malformed")),
    ).rejects.toThrow(
      /persisted Checkout request snapshot is invalid; operator reconciliation is required/u,
    );

    const v0Id = await account("ts-checkout-v0-session");
    const v0 = await coordinator.reserve(v0Id, "starter", "month", {
      requestKey: "v0-session",
    });
    expect(
      await coordinator.attachSession(
        v0,
        "cs_test_forbidden",
        "https://checkout.stripe.test/forbidden",
      ),
    ).toBe(false);
    expect(calls).toBe(0);
  });

  test("accepts webhook-before-attach but fences an unrelated claim replacement", async () => {
    const completedId = await account("ts-checkout-webhook-before-attach");
    const coordinator = new CheckoutCoordinator(postgresDatabase());
    const completedCreator: CheckoutCreator = {
      async prepareCheckoutSession(input) {
        return subscriptionSnapshot(input);
      },
      async createCheckoutSessionFromSnapshot() {
        await postgresDatabase().transaction(async (transaction) => {
          await transaction.query(
            "update billing_accounts set stripe_subscription_id='sub_early',subscription_status='active' where id=$1::uuid",
            [completedId],
          );
          await transaction.query(
            "delete from checkout_claims where account_id=$1::uuid",
            [completedId],
          );
        });
        return ["cs_test_early", "https://checkout.stripe.test/early"];
      },
    };
    await expect(
      coordinator.create(completedCreator, {
        accountId: completedId,
        planKey: "starter",
        interval: "month",
        lookupKey: "ent_starter_month",
        expectedCurrency: "usd",
        expectedUnitAmount: 1900n,
        expectedInterval: "month",
        requestKey: "webhook-first",
      }),
    ).resolves.toEqual(["cs_test_early", "https://checkout.stripe.test/early"]);

    const fencedId = await account("ts-checkout-fenced-replacement");
    const fencedCreator: CheckoutCreator = {
      async prepareCheckoutSession(input) {
        return subscriptionSnapshot(input);
      },
      async createCheckoutSessionFromSnapshot() {
        await postgresDatabase().query(
          "delete from checkout_claims where account_id=$1::uuid",
          [fencedId],
        );
        return ["cs_test_stale", "https://checkout.stripe.test/stale"];
      },
    };
    await expect(
      coordinator.create(fencedCreator, {
        accountId: fencedId,
        planKey: "starter",
        interval: "month",
        lookupKey: "ent_starter_month",
        expectedCurrency: "usd",
        expectedUnitAmount: 1900n,
        expectedInterval: "month",
        requestKey: "stale",
      }),
    ).rejects.toThrow(/identity changed/u);
  });
});

describe("credit-pack Checkout single flight", () => {
  test("validates pack reservation bounds and account identity", async () => {
    const coordinator = new CreditPackCoordinator(postgresDatabase(), catalog);
    const pack = catalog.requireCreditPack("boost-100");
    for (const ttlSeconds of [0, 1.5, 23 * 60 * 60 + 59 * 60 + 1]) {
      await expect(
        coordinator.reserve(
          "00000000-0000-0000-0000-000000000000",
          pack,
          "pack-invalid-ttl",
          { ttlSeconds },
        ),
      ).rejects.toBeInstanceOf(RangeError);
    }
    await expect(
      coordinator.reserve(
        "00000000-0000-0000-0000-000000000000",
        pack,
        "pack-missing-account",
      ),
    ).rejects.toThrow(/billing account not found/u);
  });

  test("deterministically rejects a first-Customer pack while subscription Checkout owns authority", async () => {
    const accountId = await account("ts-pack-subscription-authority");
    await new CheckoutCoordinator(postgresDatabase()).reserve(
      accountId,
      "starter",
      "month",
      { requestKey: "subscription-first" },
    );
    await expect(
      new CreditPackCoordinator(postgresDatabase(), catalog).reserve(
        accountId,
        catalog.requireCreditPack("boost-100"),
        "pack-second",
      ),
    ).rejects.toBeInstanceOf(CreditPackBusyError);
  });

  test("rejects explicit expired status through reserve and create recovery", async () => {
    const accountId = await account(
      "ts-pack-expired-status",
      "cus_pack_expired_status",
    );
    const coordinator = new CreditPackCoordinator(postgresDatabase(), catalog);
    const value = await coordinator.reserve(
      accountId,
      catalog.requireCreditPack("boost-100"),
      "expired-status",
    );
    await postgresDatabase().query(
      `update credit_pack_orders
          set checkout_status='expired',
              stripe_checkout_session_id='cs_test_expired_status',
              session_url='https://checkout.stripe.test/expired-status'
        where id=$1::uuid`,
      [value.orderId],
    );
    await expect(
      coordinator.reserve(
        accountId,
        catalog.requireCreditPack("boost-100"),
        "expired-status",
      ),
    ).rejects.toBeInstanceOf(CreditPackConflictError);
    const creator: CreditPackCheckoutCreator = {
      async prepareCreditPackCheckoutSession() {
        throw new Error("must not prepare");
      },
      async createCheckoutSessionFromSnapshot() {
        throw new Error("must not create");
      },
    };
    await expect(
      coordinator.create(creator, {
        accountId,
        packKey: "boost-100",
        requestKey: "expired-status",
      }),
    ).rejects.toBeInstanceOf(CreditPackConflictError);
  });

  test("create rejects a same key rebound to another pack", async () => {
    const accountId = await account(
      "ts-pack-create-conflict",
      "cus_pack_conflict",
    );
    const coordinator = new CreditPackCoordinator(postgresDatabase(), catalog);
    await coordinator.reserve(
      accountId,
      catalog.requireCreditPack("boost-100"),
      "create-conflict",
    );
    const creator: CreditPackCheckoutCreator = {
      async prepareCreditPackCheckoutSession() {
        throw new Error("must not prepare");
      },
      async createCheckoutSessionFromSnapshot() {
        throw new Error("must not create");
      },
    };
    await expect(
      coordinator.create(creator, {
        accountId,
        packKey: "boost-500",
        requestKey: "create-conflict",
      }),
    ).rejects.toBeInstanceOf(CreditPackConflictError);
  });

  test("fails pack snapshot freeze when its order disappeared", async () => {
    const accountId = await account(
      "ts-pack-freeze-missing",
      "cus_pack_freeze_missing",
    );
    const coordinator = new CreditPackCoordinator(postgresDatabase(), catalog);
    const value = await coordinator.reserve(
      accountId,
      catalog.requireCreditPack("boost-100"),
      "pack-freeze-missing",
    );
    await postgresDatabase().query(
      "delete from credit_pack_orders where id=$1::uuid",
      [value.orderId],
    );
    const snapshot = buildCreditPackCheckoutRequestSnapshot({
      orderId: value.orderId,
      accountId,
      customerId: "cus_pack_freeze_missing",
      priceId: "price_pack",
      lookupKey: value.lookupKey,
      currency: value.currency,
      unitAmount: value.priceAmount,
      packKey: value.packKey,
      packCredits: value.credits.toString(),
      expiresDays: value.expiresDays,
      productLine: "example-entitlements",
      successUrl: "https://app.example.test/success",
      cancelUrl: "https://app.example.test/pricing",
      expiresAt: value.claimExpiresAtEpoch,
      requestApiVersion: "2026-06-24.dahlia",
    });
    await expect(
      coordinator.freezeRequestSnapshot(value, snapshot),
    ).rejects.toBeInstanceOf(CreditPackConflictError);
  });

  test("returns undefined for an unfrozen recovery without remote I/O", async () => {
    const accountId = await account(
      "ts-pack-unfrozen-recovery",
      "cus_pack_unfrozen",
    );
    const coordinator = new CreditPackCoordinator(postgresDatabase(), catalog);
    await coordinator.reserve(
      accountId,
      catalog.requireCreditPack("boost-100"),
      "pack-unfrozen-recovery",
    );
    let calls = 0;
    const creator: CreditPackCheckoutCreator = {
      async prepareCreditPackCheckoutSession() {
        calls += 1;
        throw new Error("must not prepare");
      },
      async createCheckoutSessionFromSnapshot() {
        calls += 1;
        throw new Error("must not create");
      },
    };
    await expect(
      coordinator.recoverFrozen(creator, {
        accountId,
        packKey: "boost-100",
        requestKey: "pack-unfrozen-recovery",
      }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  test("rejects malformed pack Session URLs and reuses an attached Session", async () => {
    const accountId = await account(
      "ts-pack-session-validation",
      "cus_pack_session",
    );
    const coordinator = new CreditPackCoordinator(postgresDatabase(), catalog);
    let remoteCalls = 0;
    const invalidCreator: CreditPackCheckoutCreator = {
      async prepareCreditPackCheckoutSession(input) {
        return packSnapshot(input);
      },
      async createCheckoutSessionFromSnapshot() {
        remoteCalls += 1;
        return ["cs_test_pack_invalid", "not a URL"];
      },
    };
    const input = {
      accountId,
      packKey: "boost-100",
      requestKey: "pack-session-validation",
    };
    await expect(coordinator.create(invalidCreator, input)).rejects.toThrow(
      /origin-safe HTTPS URL/u,
    );
    const recoveredCreator: CreditPackCheckoutCreator = {
      async prepareCreditPackCheckoutSession() {
        throw new Error("must not prepare frozen request");
      },
      async createCheckoutSessionFromSnapshot() {
        remoteCalls += 1;
        return [
          "cs_test_pack_valid",
          "https://checkout.stripe.test/pack-valid",
        ];
      },
    };
    await expect(coordinator.create(recoveredCreator, input)).resolves.toEqual([
      "cs_test_pack_valid",
      "https://checkout.stripe.test/pack-valid",
    ]);
    await expect(coordinator.create(recoveredCreator, input)).resolves.toEqual([
      "cs_test_pack_valid",
      "https://checkout.stripe.test/pack-valid",
    ]);
    expect(remoteCalls).toBe(2);
  });

  test("same key replays and a changed immutable pack conflicts", async () => {
    const accountId = await account("ts-pack-replay", "cus_pack");
    const coordinator = new CreditPackCoordinator(postgresDatabase(), catalog);
    const first = await coordinator.reserve(
      accountId,
      catalog.requireCreditPack("boost-100"),
      "pack-request",
    );
    const replay = await coordinator.reserve(
      accountId,
      catalog.requireCreditPack("boost-100"),
      "pack-request",
    );
    expect(replay.orderId).toBe(first.orderId);
    expect(replay.credits.atoms).toBe(100_000_000n);
    expect(replay.priceAmount).toBe(1500n);
    await expect(
      coordinator.reserve(
        accountId,
        catalog.requireCreditPack("boost-500"),
        "pack-request",
      ),
    ).rejects.toBeInstanceOf(CreditPackConflictError);
  });

  test("serializes first-Customer authority across subscription and pack Checkouts", async () => {
    const accountId = await account("ts-cross-checkout");
    const subscriptions = new CheckoutCoordinator(postgresDatabase());
    const packs = new CreditPackCoordinator(postgresDatabase(), catalog);
    const results = await Promise.allSettled([
      subscriptions.reserve(accountId, "starter", "month", {
        requestKey: "subscription",
      }),
      packs.reserve(accountId, catalog.requireCreditPack("boost-100"), "pack"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toBeDefined();
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      results[0]?.status === "fulfilled"
        ? CreditPackBusyError
        : CheckoutBusyError,
    );
  });

  test("replays reservation customer facts after account mutation", async () => {
    const accountId = await account("ts-pack-customer", "cus_pack_original");
    const coordinator = new CreditPackCoordinator(postgresDatabase(), catalog);
    await coordinator.reserve(
      accountId,
      catalog.requireCreditPack("boost-100"),
      "customer-snapshot",
    );
    await postgresDatabase().query(
      "update billing_accounts set stripe_customer_id='cus_pack_later' where id=$1::uuid",
      [accountId],
    );
    let observedCustomer: string | undefined;
    const creator: CreditPackCheckoutCreator = {
      async prepareCreditPackCheckoutSession(input) {
        observedCustomer = input.customerId;
        return packSnapshot(input);
      },
      async createCheckoutSessionFromSnapshot(): Promise<
        readonly [string, string]
      > {
        return ["cs_test_pack", "https://checkout.stripe.test/pack"];
      },
    };
    await coordinator.create(creator, {
      accountId,
      packKey: "boost-100",
      requestKey: "customer-snapshot",
    });
    expect(observedCustomer).toBe("cus_pack_original");
  });

  test("rejects an expired same-key recovery window", async () => {
    const accountId = await account("ts-pack-expired", "cus_pack_expired");
    const coordinator = new CreditPackCoordinator(postgresDatabase(), catalog);
    const value = await coordinator.reserve(
      accountId,
      catalog.requireCreditPack("boost-100"),
      "expired-pack-request",
    );
    await postgresDatabase().query(
      "update credit_pack_orders set claim_expires_at=clock_timestamp()-interval '1 second' where id=$1::uuid",
      [value.orderId],
    );
    await expect(
      coordinator.reserve(
        accountId,
        catalog.requireCreditPack("boost-100"),
        "expired-pack-request",
      ),
    ).rejects.toBeInstanceOf(CreditPackConflictError);
  });

  test("concurrent pack preparers freeze one winner and both remote calls replay it", async () => {
    const accountId = await account(
      "ts-pack-concurrent-freeze",
      "cus_pack_cas",
    );
    const coordinator = new CreditPackCoordinator(postgresDatabase(), catalog);
    let preparedCount = 0;
    let openBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      openBarrier = resolve;
    });
    const candidates: CheckoutRequestSnapshot[] = [];
    const remoteSnapshots: CheckoutRequestSnapshot[] = [];
    const creator: CreditPackCheckoutCreator = {
      async prepareCreditPackCheckoutSession(input) {
        const index = preparedCount;
        preparedCount += 1;
        if (preparedCount === 2) {
          openBarrier?.();
        }
        await barrier;
        const candidate = buildCreditPackCheckoutRequestSnapshot({
          orderId: input.orderId,
          accountId: input.accountId,
          ...(input.customerId === undefined
            ? {}
            : { customerId: input.customerId }),
          priceId: `price_pack_candidate_${String(index)}`,
          lookupKey: input.lookupKey,
          currency: input.expectedCurrency,
          unitAmount: input.expectedUnitAmount,
          packKey: input.packKey,
          packCredits: input.packCredits,
          expiresDays: input.expiresDays,
          productLine: `line-${String(index)}`,
          successUrl: `https://pack-${String(index)}.example.test/success`,
          cancelUrl: `https://pack-${String(index)}.example.test/pricing`,
          expiresAt: input.expiresAtEpoch,
          requestApiVersion: `202${String(5 + index)}-12-15.clover`,
        });
        candidates.push(candidate);
        return candidate;
      },
      async createCheckoutSessionFromSnapshot(snapshot) {
        remoteSnapshots.push(snapshot);
        return ["cs_test_pack_cas", "https://checkout.stripe.test/pack-cas"];
      },
    };
    const input = {
      accountId,
      packKey: "boost-100",
      requestKey: "pack-cas-key",
    };

    const results = await Promise.all([
      coordinator.create(creator, input),
      coordinator.create(creator, input),
    ]);

    expect(results[0]).toEqual(results[1]);
    expect(preparedCount).toBe(2);
    expect(remoteSnapshots).toHaveLength(2);
    expect(remoteSnapshots[1]).toEqual(remoteSnapshots[0]);
    expect(candidates).toContainEqual(remoteSnapshots[0]);
    const persisted = await postgresDatabase().query<{
      readonly request_snapshot_version: number;
      readonly stripe_request_snapshot: unknown;
    }>(
      "select request_snapshot_version,stripe_request_snapshot from credit_pack_orders where account_id=$1::uuid",
      [accountId],
    );
    expect(persisted.rows[0]?.request_snapshot_version).toBe(1);
    expect(persisted.rows[0]?.stripe_request_snapshot).toEqual(
      remoteSnapshots[0],
    );
  });

  test("unknown pack success survives Customer, catalog, Price, URL, API, and product-line drift", async () => {
    const accountId = await account("ts-pack-drift", "cus_pack_original");
    const firstCoordinator = new CreditPackCoordinator(
      postgresDatabase(),
      catalog,
    );
    const firstPrices = vi.fn().mockResolvedValue({
      data: [oneTimePrice()],
      has_more: false,
    });
    const firstCreate = vi
      .fn()
      .mockRejectedValue(new Error("unknown pack result"));
    const firstGateway = gateway(
      {
        prices: { list: firstPrices },
        checkout: { sessions: { create: firstCreate } },
      } as unknown as Stripe,
      {
        apiVersion: "2025-12-15.clover",
        productLine: "old-line",
        successUrl: "https://old.example.test/success",
      },
    );
    const input = {
      accountId,
      packKey: "boost-100",
      requestKey: "unknown-pack-drift",
    };
    await expect(
      firstCoordinator.create(creditPackCreator(firstGateway), input),
    ).rejects.toThrow("unknown pack result");

    await postgresDatabase().query(
      "update billing_accounts set stripe_customer_id='cus_pack_rotated' where id=$1::uuid",
      [accountId],
    );
    const removedCatalog = new PlanCatalog(catalog.plans, "rotated", new Map());
    const secondCoordinator = new CreditPackCoordinator(
      postgresDatabase(),
      removedCatalog,
    );
    const secondPrices = vi
      .fn()
      .mockRejectedValue(new Error("Price.list must not run on pack replay"));
    const secondCreate = vi.fn().mockResolvedValue({
      id: "cs_test_pack_recovered",
      url: "https://checkout.stripe.test/pack-recovered",
    });
    const secondGateway = gateway(
      {
        prices: { list: secondPrices },
        checkout: { sessions: { create: secondCreate } },
      } as unknown as Stripe,
      {
        apiVersion: "2026-06-24.dahlia",
        productLine: "new-line",
        successUrl: "https://new.example.test/success",
      },
    );
    await expect(
      secondCoordinator.create(creditPackCreator(secondGateway), input),
    ).resolves.toEqual([
      "cs_test_pack_recovered",
      "https://checkout.stripe.test/pack-recovered",
    ]);

    expect(firstPrices).toHaveBeenCalledTimes(1);
    expect(secondPrices).not.toHaveBeenCalled();
    expect(secondCreate.mock.calls[0]).toEqual(firstCreate.mock.calls[0]);
  });

  test("legacy and malformed pack snapshots fail closed without creator I/O", async () => {
    let calls = 0;
    const creator: CreditPackCheckoutCreator = {
      async prepareCreditPackCheckoutSession() {
        calls += 1;
        throw new Error("must not prepare");
      },
      async createCheckoutSessionFromSnapshot() {
        calls += 1;
        throw new Error("must not create");
      },
    };

    const legacyId = await account("ts-pack-legacy", "cus_pack_legacy");
    const legacyCoordinator = new CreditPackCoordinator(
      postgresDatabase(),
      catalog,
    );
    const legacy = await legacyCoordinator.reserve(
      legacyId,
      catalog.requireCreditPack("boost-100"),
      "legacy-pack",
    );
    await postgresDatabase().query(
      "update credit_pack_orders set request_snapshot_version=null where id=$1::uuid",
      [legacy.orderId],
    );
    await expect(
      legacyCoordinator.create(creator, {
        accountId: legacyId,
        packKey: "boost-100",
        requestKey: "legacy-pack",
      }),
    ).rejects.toBeInstanceOf(CreditPackConflictError);

    const malformedId = await account(
      "ts-pack-malformed",
      "cus_pack_malformed",
    );
    const malformed = await legacyCoordinator.reserve(
      malformedId,
      catalog.requireCreditPack("boost-100"),
      "malformed-pack",
    );
    await postgresDatabase().query(
      "update credit_pack_orders set request_snapshot_version=1,stripe_request_snapshot='{}'::jsonb where id=$1::uuid",
      [malformed.orderId],
    );
    await expect(
      legacyCoordinator.create(creator, {
        accountId: malformedId,
        packKey: "boost-100",
        requestKey: "malformed-pack",
      }),
    ).rejects.toThrow(
      /persisted credit-pack Checkout request snapshot is invalid; operator reconciliation is required/u,
    );
    expect(calls).toBe(0);
  });

  test("accepts webhook-before-attach and fences conflicting Session identity or snapshot state", async () => {
    const accountId = await account(
      "ts-pack-webhook-before-attach",
      "cus_pack_early",
    );
    const coordinator = new CreditPackCoordinator(postgresDatabase(), catalog);
    let orderId = "";
    const earlyCreator: CreditPackCheckoutCreator = {
      async prepareCreditPackCheckoutSession(input) {
        orderId = input.orderId;
        return packSnapshot(input);
      },
      async createCheckoutSessionFromSnapshot() {
        await postgresDatabase().query(
          `update credit_pack_orders
              set stripe_checkout_session_id='cs_test_pack_early',
                  session_url='https://checkout.stripe.test/pack-early',
                  checkout_status='session_created'
            where id=$1::uuid`,
          [orderId],
        );
        return [
          "cs_test_pack_early",
          "https://checkout.stripe.test/pack-early",
        ];
      },
    };
    await expect(
      coordinator.create(earlyCreator, {
        accountId,
        packKey: "boost-100",
        requestKey: "pack-early",
      }),
    ).resolves.toEqual([
      "cs_test_pack_early",
      "https://checkout.stripe.test/pack-early",
    ]);

    const conflictId = await account("ts-pack-attach-fence", "cus_pack_fence");
    let conflictOrder = "";
    const conflictCreator: CreditPackCheckoutCreator = {
      async prepareCreditPackCheckoutSession(input) {
        conflictOrder = input.orderId;
        return packSnapshot(input);
      },
      async createCheckoutSessionFromSnapshot() {
        await postgresDatabase().query(
          "update credit_pack_orders set stripe_checkout_session_id='cs_test_other' where id=$1::uuid",
          [conflictOrder],
        );
        return ["cs_test_stale", "https://checkout.stripe.test/stale-pack"];
      },
    };
    await expect(
      coordinator.create(conflictCreator, {
        accountId: conflictId,
        packKey: "boost-100",
        requestKey: "pack-fence",
      }),
    ).rejects.toThrow(/changed during Checkout creation/u);

    const v0Id = await account("ts-pack-v0-fence", "cus_pack_v0");
    let v0Order = "";
    const v0Creator: CreditPackCheckoutCreator = {
      async prepareCreditPackCheckoutSession(input) {
        v0Order = input.orderId;
        return packSnapshot(input);
      },
      async createCheckoutSessionFromSnapshot() {
        await postgresDatabase().query(
          "update credit_pack_orders set request_snapshot_version=0,stripe_request_snapshot=null where id=$1::uuid",
          [v0Order],
        );
        return ["cs_test_v0", "https://checkout.stripe.test/v0-pack"];
      },
    };
    await expect(
      coordinator.create(v0Creator, {
        accountId: v0Id,
        packKey: "boost-100",
        requestKey: "pack-v0",
      }),
    ).rejects.toThrow(/changed during Checkout creation/u);
  });
});
