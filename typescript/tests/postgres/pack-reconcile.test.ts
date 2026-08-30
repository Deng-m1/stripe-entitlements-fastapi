import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "vitest";

import { PlanCatalog } from "../../src/catalog.js";
import {
  CreditPackCoordinator,
  type CreditPackReservation,
} from "../../src/credit-pack-coordinator.js";
import type { Database } from "../../src/database.js";
import { EventProcessor } from "../../src/event-processor.js";
import {
  CreditPackReconciliationService,
  type CreditPackReconciliationGateway,
} from "../../src/pack-reconcile.js";
import type { StripeObject } from "../../src/processor-primitives.js";
import { buildCreditPackCheckoutRequestSnapshot } from "../../src/stripe-request-snapshots.js";
import { postgresDatabase } from "../support/postgres-setup.js";

const CATALOG_PATH = fileURLToPath(
  new URL("../../../plans.toml", import.meta.url),
);
const PRODUCT_LINE = "typescript-tests";

let database: Database;
let catalog: PlanCatalog;

function metadata(reservation: CreditPackReservation): Record<string, string> {
  return {
    billing_kind: "credit_pack",
    pack_schema_version: "1",
    product_line: PRODUCT_LINE,
    credit_pack_order_id: reservation.orderId,
    account_id: reservation.accountId,
    pack_key: reservation.packKey,
    pack_credits: "100",
    price_amount: "1500",
    currency: "usd",
    expires_days: "365",
    lookup_key: reservation.lookupKey,
  };
}

class FakeGateway implements CreditPackReconciliationGateway {
  public session: StripeObject;
  public paymentIntent: StripeObject;
  public charge: StripeObject;
  public beforeSession: (() => Promise<void>) | undefined;
  public sessionCalls = 0;
  public paymentCalls = 0;
  public chargeCalls = 0;

  public constructor(reservation: CreditPackReservation) {
    const values = metadata(reservation);
    this.session = {
      id: `cs_${reservation.orderId}`,
      object: "checkout.session",
      mode: "payment",
      status: "complete",
      payment_status: "paid",
      livemode: false,
      client_reference_id: reservation.accountId,
      metadata: values,
      amount_total: 1500,
      currency: "usd",
      payment_intent: `pi_${reservation.orderId}`,
      customer: "cus_pack_reconcile",
      created: 1_788_000_000,
    };
    this.paymentIntent = {
      id: `pi_${reservation.orderId}`,
      object: "payment_intent",
      status: "succeeded",
      livemode: false,
      customer: "cus_pack_reconcile",
      latest_charge: `ch_${reservation.orderId}`,
      amount: 1500,
      amount_received: 1500,
      currency: "usd",
      metadata: values,
      created: 1_788_000_001,
    };
    this.charge = {
      id: `ch_${reservation.orderId}`,
      object: "charge",
      payment_intent: `pi_${reservation.orderId}`,
      customer: "cus_pack_reconcile",
      amount: 1500,
      amount_refunded: 0,
      disputed: false,
      refunded: false,
      paid: true,
      livemode: false,
      currency: "usd",
      created: 1_788_000_002,
    };
  }

  public async checkoutSessionObject(): Promise<StripeObject> {
    this.sessionCalls += 1;
    await this.beforeSession?.();
    return this.session;
  }

  public async paymentIntentObject(): Promise<StripeObject> {
    this.paymentCalls += 1;
    return this.paymentIntent;
  }

  public async chargeObject(): Promise<StripeObject> {
    this.chargeCalls += 1;
    return this.charge;
  }
}

async function order(subject: string): Promise<{
  readonly reservation: CreditPackReservation;
  readonly gateway: FakeGateway;
  readonly processor: EventProcessor;
}> {
  const accountId = await database.createAccount(subject);
  await database.query(
    "update billing_accounts set stripe_customer_id='cus_pack_reconcile' where id=$1::uuid",
    [accountId],
  );
  const coordinator = new CreditPackCoordinator(database, catalog);
  const requestKey = `request-${randomUUID()}`;
  const reservation = await coordinator.reserve(
    accountId,
    catalog.requireCreditPack("boost-100"),
    requestKey,
  );
  const gateway = new FakeGateway(reservation);
  await coordinator.create(
    {
      async prepareCreditPackCheckoutSession(input) {
        return buildCreditPackCheckoutRequestSnapshot({
          orderId: input.orderId,
          accountId: input.accountId,
          ...(input.customerId === undefined
            ? {}
            : { customerId: input.customerId }),
          priceId: "price_pack_reconcile",
          lookupKey: input.lookupKey,
          currency: input.expectedCurrency,
          unitAmount: input.expectedUnitAmount,
          packKey: input.packKey,
          packCredits: input.packCredits,
          expiresDays: input.expiresDays,
          productLine: PRODUCT_LINE,
          successUrl: "https://app.example.test/success",
          cancelUrl: "https://app.example.test/pricing",
          expiresAt: input.expiresAtEpoch,
          requestApiVersion: "2026-06-24.dahlia",
        });
      },
      async createCheckoutSessionFromSnapshot() {
        return [
          String(gateway.session["id"]),
          "https://checkout.stripe.test/pack-reconcile",
        ] as const;
      },
    },
    { accountId, packKey: "boost-100", requestKey },
  );
  return {
    reservation,
    gateway,
    processor: new EventProcessor(database, catalog, PRODUCT_LINE, {
      expectedLivemode: false,
    }),
  };
}

beforeAll(async () => {
  database = postgresDatabase();
  catalog = await PlanCatalog.fromToml(CATALOG_PATH);
});

describe("fenced credit-pack reconciliation", () => {
  test("rebuilds Checkout and payment facts into one exact funding lot", async () => {
    const setup = await order("pack-reconcile-paid");
    const result = await new CreditPackReconciliationService(
      database,
      setup.processor,
      setup.gateway,
    ).reconcileOrder(setup.reservation.orderId);

    expect(result.outcome).toBe("reconciled");
    expect(result.projections).toHaveLength(2);
    expect(result.projections.map((projection) => projection.outcome)).toEqual([
      "handled",
      "handled",
    ]);
    const state = await database.query<{
      readonly payment_status: string;
      readonly checkout_status: string;
      readonly amount_paid: string;
      readonly lots: string;
      readonly remaining_credits: string;
      readonly last_reconcile_error: string | null;
    }>(
      `select o.payment_status,o.checkout_status,o.amount_paid,
              count(l.id)::text as lots,
              max(l.remaining_credits)::text as remaining_credits,
              o.last_reconcile_error
         from credit_pack_orders o
         left join credit_funding_lots l on l.order_id=o.id
        where o.id=$1::uuid group by o.id`,
      [setup.reservation.orderId],
    );
    expect(state.rows[0]).toEqual({
      payment_status: "paid",
      checkout_status: "completed",
      amount_paid: "1500",
      lots: "1",
      remaining_credits: "100000000",
      last_reconcile_error: null,
    });
  });

  test("cumulative refunds replay prior facts and converge exactly", async () => {
    const setup = await order("pack-reconcile-refund");
    const service = new CreditPackReconciliationService(
      database,
      setup.processor,
      setup.gateway,
    );
    await service.reconcileOrder(setup.reservation.orderId);
    setup.gateway.charge = {
      ...setup.gateway.charge,
      amount_refunded: 750,
      refunded: false,
      created: 1_788_000_100,
    };
    const partial = await service.reconcileOrder(setup.reservation.orderId);
    setup.gateway.charge = {
      ...setup.gateway.charge,
      amount_refunded: 1500,
      refunded: true,
      created: 1_788_000_200,
    };
    const full = await service.reconcileOrder(setup.reservation.orderId);

    expect(partial.outcome).toBe("reconciled");
    expect(full.outcome).toBe("reconciled");
    const state = await database.query<{
      readonly payment_status: string;
      readonly amount_refunded: string;
      readonly refunded_credits: string;
      readonly status: string;
      readonly remaining_credits: string;
      readonly cash_clawed_back_credits: string;
    }>(
      `select o.payment_status,o.amount_refunded,o.refunded_credits,
              l.status,l.remaining_credits,l.cash_clawed_back_credits
         from credit_pack_orders o join credit_funding_lots l on l.order_id=o.id
        where o.id=$1::uuid`,
      [setup.reservation.orderId],
    );
    expect(state.rows[0]).toEqual({
      payment_status: "refunded",
      amount_refunded: "1500",
      refunded_credits: "100000000",
      status: "refunded",
      remaining_credits: "0",
      cash_clawed_back_credits: "100000000",
    });
  });

  test("remote contract drift fails closed with a stable code", async () => {
    const setup = await order("pack-reconcile-contract");
    setup.gateway.paymentIntent = {
      ...setup.gateway.paymentIntent,
      amount_received: 1499,
    };
    const result = await new CreditPackReconciliationService(
      database,
      setup.processor,
      setup.gateway,
    ).reconcileOrder(setup.reservation.orderId);

    expect(result).toMatchObject({
      outcome: "failed",
      errorCode: "payment_intent_settlement_mismatch",
    });
    const orderState = await database.query<{
      readonly payment_status: string;
      readonly last_reconcile_error: string | null;
      readonly reconcile_claim_token: string | null;
    }>(
      `select payment_status,last_reconcile_error,reconcile_claim_token
         from credit_pack_orders where id=$1::uuid`,
      [setup.reservation.orderId],
    );
    expect(orderState.rows[0]).toEqual({
      payment_status: "pending",
      last_reconcile_error: "payment_intent_settlement_mismatch",
      reconcile_claim_token: null,
    });
  });

  test("network exception messages never persist and the lease is released", async () => {
    const setup = await order("pack-reconcile-network");
    setup.gateway.beforeSession = async () => {
      throw new Error("sk_test_secret body must not persist");
    };
    const result = await new CreditPackReconciliationService(
      database,
      setup.processor,
      setup.gateway,
    ).reconcileOrder(setup.reservation.orderId);

    expect(result).toMatchObject({ outcome: "failed", errorCode: "Error" });
    const state = await database.query<{
      readonly last_reconcile_error: string | null;
      readonly reconcile_claim_token: string | null;
    }>(
      "select last_reconcile_error,reconcile_claim_token from credit_pack_orders where id=$1::uuid",
      [setup.reservation.orderId],
    );
    expect(state.rows[0]).toEqual({
      last_reconcile_error: "Error",
      reconcile_claim_token: null,
    });
    expect(JSON.stringify(state.rows[0])).not.toContain("sk_test_");
  });

  test("an expired network-return lease cannot project any fact", async () => {
    const setup = await order("pack-reconcile-lease-loss");
    setup.gateway.beforeSession = async () => {
      await database.query(
        `update credit_pack_orders set
           reconcile_claim_expires_at=clock_timestamp()-interval '1 second'
         where id=$1::uuid`,
        [setup.reservation.orderId],
      );
    };
    const result = await new CreditPackReconciliationService(
      database,
      setup.processor,
      setup.gateway,
    ).reconcileOrder(setup.reservation.orderId);

    expect(result).toMatchObject({
      outcome: "lost_lease",
      errorCode: "lease_lost",
    });
    const facts = await database.query<{
      readonly events: string;
      readonly lots: string;
    }>(
      `select (select count(*)::text from stripe_webhook_events) as events,
              (select count(*)::text from credit_funding_lots) as lots`,
    );
    expect(facts.rows[0]).toEqual({ events: "0", lots: "0" });
  });

  test("concurrent operators cannot share one live claim", async () => {
    const setup = await order("pack-reconcile-claim-race");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    setup.gateway.beforeSession = async () => {
      enteredResolve?.();
      await gate;
    };
    const service = new CreditPackReconciliationService(
      database,
      setup.processor,
      setup.gateway,
    );
    const first = service.reconcileOrder(setup.reservation.orderId);
    await entered;
    const competitors = await Promise.all(
      Array.from({ length: 19 }, () =>
        service.reconcileOrder(setup.reservation.orderId),
      ),
    );
    release?.();
    const winner = await first;

    expect(winner.outcome).toBe("reconciled");
    expect(
      competitors.every((result) => result.outcome === "unavailable"),
    ).toBe(true);
    const lots = await database.query<{ readonly count: string }>(
      "select count(*)::text from credit_funding_lots",
    );
    expect(lots.rows[0]?.count).toBe("1");
  });

  test("reserved orders without a remote identity become explicit idle work", async () => {
    const accountId = await database.createAccount("pack-reconcile-idle");
    const reservation = await new CreditPackCoordinator(
      database,
      catalog,
    ).reserve(accountId, catalog.requireCreditPack("boost-100"), "idle-order");
    const gateway: CreditPackReconciliationGateway = {
      async checkoutSessionObject() {
        throw new Error("must not be called");
      },
      async paymentIntentObject() {
        throw new Error("must not be called");
      },
      async chargeObject() {
        throw new Error("must not be called");
      },
    };
    const result = await new CreditPackReconciliationService(
      database,
      new EventProcessor(database, catalog, PRODUCT_LINE),
      gateway,
    ).reconcileOrder(reservation.orderId);

    expect(result).toMatchObject({
      outcome: "idle",
      errorCode: "checkout_replay_required",
      projections: [],
    });
  });
});
