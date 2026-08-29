import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "vitest";

import { PlanCatalog } from "../../src/catalog.js";
import {
  CreditPackCoordinator,
  type CreditPackReservation,
} from "../../src/credit-pack-coordinator.js";
import { CreditPackEventProcessor } from "../../src/credit-pack-events.js";
import { CreditService } from "../../src/credits.js";
import type { StripeObject } from "../../src/processor-primitives.js";
import { postgresDatabase } from "../support/postgres-setup.js";

const ROOT_CATALOG = fileURLToPath(
  new URL("../../../plans.toml", import.meta.url),
);
const PRODUCT_LINE = "typescript-tests";
let catalog: PlanCatalog;

beforeAll(async () => {
  catalog = await PlanCatalog.fromToml(ROOT_CATALOG);
});

async function reservedPack(subject: string): Promise<{
  readonly accountId: string;
  readonly reservation: CreditPackReservation;
}> {
  const accountId = await postgresDatabase().createAccount(subject);
  await postgresDatabase().query(
    "update billing_accounts set stripe_customer_id='cus_pack_test' where id=$1::uuid",
    [accountId],
  );
  const coordinator = new CreditPackCoordinator(postgresDatabase(), catalog);
  const reservation = await coordinator.reserve(
    accountId,
    catalog.requireCreditPack("boost-100"),
    `request-${subject}`,
  );
  return { accountId, reservation };
}

function packMetadata(
  reservation: CreditPackReservation,
): Record<string, string> {
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

function paymentEvent(
  reservation: CreditPackReservation,
  id = "evt_pack_paid",
): StripeObject {
  return {
    id,
    type: "payment_intent.succeeded",
    created: 1_788_000_000,
    livemode: false,
    data: {
      object: {
        id: "pi_pack_test",
        object: "payment_intent",
        status: "succeeded",
        customer: "cus_pack_test",
        latest_charge: "ch_pack_test",
        amount: 1500,
        amount_received: 1500,
        currency: "usd",
        metadata: packMetadata(reservation),
      },
    },
  };
}

function refundEvent(
  reservation: CreditPackReservation,
  amountRefunded: number,
  id = `evt_pack_refund_${amountRefunded}`,
): StripeObject {
  const paymentIntent = (
    paymentEvent(reservation)["data"] as { object: StripeObject }
  ).object;
  return {
    id,
    type: "charge.refunded",
    created: 1_788_000_100,
    livemode: false,
    data: {
      object: {
        id: "ch_pack_test",
        object: "charge",
        payment_intent: "pi_pack_test",
        customer: "cus_pack_test",
        amount: 1500,
        amount_refunded: amountRefunded,
        refunded: amountRefunded === 1500,
        disputed: false,
        paid: true,
        currency: "usd",
        _resolved_payment_intent: paymentIntent,
      },
    },
  };
}

function disputeEvent(
  reservation: CreditPackReservation,
  id = "evt_pack_dispute",
): StripeObject {
  const paymentIntent = (
    paymentEvent(reservation)["data"] as {
      object: StripeObject;
    }
  ).object;
  const charge: StripeObject = {
    id: "ch_pack_test",
    object: "charge",
    payment_intent: "pi_pack_test",
    customer: "cus_pack_test",
    amount: 1500,
    amount_refunded: 0,
    refunded: false,
    disputed: true,
    paid: true,
    currency: "usd",
  };
  return {
    id,
    type: "charge.dispute.created",
    created: 1_788_000_200,
    livemode: false,
    data: {
      object: {
        id: "dp_pack_test",
        object: "dispute",
        charge: "ch_pack_test",
        amount: 1500,
        currency: "usd",
        _resolved_charge: charge,
        _resolved_payment_intent: paymentIntent,
      },
    },
  };
}

async function projectPayment(
  processor: CreditPackEventProcessor,
  event: StripeObject,
) {
  return postgresDatabase().transaction((transaction) =>
    processor.paymentSucceeded(transaction, event),
  );
}

async function projectClawback(
  processor: CreditPackEventProcessor,
  event: StripeObject,
) {
  return postgresDatabase().transaction((transaction) =>
    processor.clawback(transaction, event),
  );
}

describe("credit-pack payment projection", () => {
  test("grants one exact funding lot and business-replays a second Event", async () => {
    const { accountId, reservation } = await reservedPack("pack-paid-once");
    const processor = new CreditPackEventProcessor(catalog, PRODUCT_LINE);
    await expect(
      projectPayment(processor, paymentEvent(reservation)),
    ).resolves.toMatchObject({
      outcome: "handled",
      accountId,
    });
    await expect(
      projectPayment(
        processor,
        paymentEvent(reservation, "evt_pack_paid_duplicate"),
      ),
    ).resolves.toMatchObject({ outcome: "replayed" });
    const result = await postgresDatabase().query<{
      readonly lot_count: string;
      readonly remaining_credits: string;
      readonly amount_paid: string;
      readonly paid_at: string;
    }>(
      `select count(l.id)::text as lot_count,max(l.remaining_credits)::text as remaining_credits,
              max(o.amount_paid)::text as amount_paid,max(o.paid_at)::text as paid_at
         from credit_pack_orders o left join credit_funding_lots l on l.order_id=o.id
        where o.id=$1::uuid`,
      [reservation.orderId],
    );
    expect(result.rows[0]).toMatchObject({
      lot_count: "1",
      remaining_credits: "100000000",
      amount_paid: "1500",
    });
    expect(result.rows[0]?.paid_at).toContain("2026");
  });

  test("fails closed on metadata drift without creating funding", async () => {
    const { reservation } = await reservedPack("pack-metadata-drift");
    const processor = new CreditPackEventProcessor(catalog, PRODUCT_LINE);
    const event = paymentEvent(reservation);
    const object = (event["data"] as { object: Record<string, unknown> })
      .object;
    object["metadata"] = { ...packMetadata(reservation), pack_credits: "101" };
    await expect(projectPayment(processor, event)).resolves.toMatchObject({
      outcome: "ignored",
    });
    const facts = await postgresDatabase().query<{
      readonly lots: string;
      readonly incidents: string;
    }>(
      `select (select count(*) from credit_funding_lots)::text as lots,
              (select count(*) from billing_incidents
                where kind='credit_pack_payment_contract_mismatch')::text as incidents`,
    );
    expect(facts.rows[0]).toEqual({ lots: "0", incidents: "1" });
  });
});

describe("credit-pack cash clawback convergence", () => {
  test("applies cumulative partial then full refunds exactly once", async () => {
    const { reservation } = await reservedPack("pack-refund-after-paid");
    const processor = new CreditPackEventProcessor(catalog, PRODUCT_LINE);
    await projectPayment(processor, paymentEvent(reservation));
    await expect(
      projectClawback(processor, refundEvent(reservation, 750)),
    ).resolves.toMatchObject({
      outcome: "handled",
    });
    await expect(
      projectClawback(
        processor,
        refundEvent(reservation, 750, "evt_same_cash_other_event"),
      ),
    ).resolves.toMatchObject({ outcome: "replayed" });
    await expect(
      projectClawback(processor, refundEvent(reservation, 1500)),
    ).resolves.toMatchObject({
      outcome: "handled",
    });
    const state = await postgresDatabase().query<{
      readonly refunded_credits: string;
      readonly amount_refunded: string;
      readonly remaining_credits: string;
      readonly cash_clawed_back_credits: string;
      readonly status: string;
    }>(
      `select o.refunded_credits,o.amount_refunded,l.remaining_credits,
              l.cash_clawed_back_credits,l.status
         from credit_pack_orders o join credit_funding_lots l on l.order_id=o.id
        where o.id=$1::uuid`,
      [reservation.orderId],
    );
    expect(state.rows[0]).toEqual({
      refunded_credits: "100000000",
      amount_refunded: "1500",
      remaining_credits: "0",
      cash_clawed_back_credits: "100000000",
      status: "refunded",
    });
  });

  test("refund-before-payment lowers the later lot without creating debt", async () => {
    const { reservation } = await reservedPack("pack-refund-before-paid");
    const processor = new CreditPackEventProcessor(catalog, PRODUCT_LINE);
    await expect(
      projectClawback(processor, refundEvent(reservation, 750)),
    ).resolves.toMatchObject({
      outcome: "handled",
    });
    await projectPayment(processor, paymentEvent(reservation));
    const state = await postgresDatabase().query<{
      readonly remaining_credits: string;
      readonly cash_clawed_back_credits: string;
      readonly debts: string;
    }>(
      `select l.remaining_credits,l.cash_clawed_back_credits,
              (select count(*) from credit_pack_clawback_debts)::text as debts
         from credit_funding_lots l where order_id=$1::uuid`,
      [reservation.orderId],
    );
    expect(state.rows[0]).toEqual({
      remaining_credits: "50000000",
      cash_clawed_back_credits: "50000000",
      debts: "0",
    });
  });

  test("turns already-consumed refunded funding into durable debt", async () => {
    const { accountId, reservation } = await reservedPack("pack-spent-refund");
    const processor = new CreditPackEventProcessor(catalog, PRODUCT_LINE);
    await projectPayment(processor, paymentEvent(reservation));
    await postgresDatabase().transaction(async (transaction) => {
      const lot = await transaction.query<{ readonly id: string }>(
        "select id::text from credit_funding_lots where order_id=$1::uuid for update",
        [reservation.orderId],
      );
      const lotId = lot.rows[0]?.id;
      if (lotId === undefined) throw new Error("lot missing");
      await transaction.query(
        `insert into credit_debits(idempotency_key,account_id,amount,grant_epoch)
         values('spent-pack',$1::uuid,100000000,0)`,
        [accountId],
      );
      await transaction.query(
        `update credit_funding_lots set remaining_credits=0 where id=$1::uuid`,
        [lotId],
      );
      await transaction.query(
        `insert into credit_debit_allocations(
           debit_idempotency_key,account_id,source_type,funding_lot_id,amount)
         values('spent-pack',$1::uuid,'credit_pack',$2::uuid,100000000)`,
        [accountId, lotId],
      );
    });
    await projectClawback(processor, refundEvent(reservation, 1500));
    const debt = await postgresDatabase().query<{
      readonly target_credits: string;
      readonly collected_credits: string;
      readonly released_credits: string;
    }>(
      "select target_credits,collected_credits,released_credits from credit_pack_clawback_debts",
    );
    expect(debt.rows[0]).toEqual({
      target_credits: "100000000",
      collected_credits: "0",
      released_credits: "0",
    });
  });

  test("advances a fully refunded lot to disputed without a second clawback", async () => {
    const { reservation } = await reservedPack("pack-dispute-after-refund");
    const processor = new CreditPackEventProcessor(catalog, PRODUCT_LINE);
    await projectPayment(processor, paymentEvent(reservation));
    await projectClawback(processor, refundEvent(reservation, 1500));

    await expect(
      projectClawback(processor, disputeEvent(reservation)),
    ).resolves.toMatchObject({ outcome: "handled" });
    await expect(
      projectClawback(
        processor,
        disputeEvent(reservation, "evt_pack_dispute_duplicate"),
      ),
    ).resolves.toMatchObject({ outcome: "replayed" });

    const state = await postgresDatabase().query<{
      readonly payment_status: string;
      readonly amount_refunded: string;
      readonly refunded_credits: string;
      readonly remaining_credits: string;
      readonly cash_clawed_back_credits: string;
      readonly lot_status: string;
      readonly debts: string;
    }>(
      `select o.payment_status,o.amount_refunded,o.refunded_credits,
              l.remaining_credits,l.cash_clawed_back_credits,
              l.status as lot_status,
              (select count(*) from credit_pack_clawback_debts)::text as debts
         from credit_pack_orders o join credit_funding_lots l on l.order_id=o.id
        where o.id=$1::uuid`,
      [reservation.orderId],
    );
    expect(state.rows[0]).toEqual({
      payment_status: "disputed",
      amount_refunded: "1500",
      refunded_credits: "100000000",
      remaining_credits: "0",
      cash_clawed_back_credits: "100000000",
      lot_status: "disputed",
      debts: "0",
    });
  });

  test("a dispute before payment creates one closed lot when payment arrives", async () => {
    const { accountId, reservation } = await reservedPack(
      "pack-dispute-before-paid",
    );
    const processor = new CreditPackEventProcessor(catalog, PRODUCT_LINE);

    await expect(
      projectClawback(processor, disputeEvent(reservation)),
    ).resolves.toMatchObject({ outcome: "handled", accountId });
    await expect(
      projectPayment(processor, paymentEvent(reservation)),
    ).resolves.toMatchObject({ outcome: "handled", accountId });

    const state = await postgresDatabase().query<{
      readonly payment_status: string;
      readonly lots: string;
      readonly remaining_credits: string;
      readonly cash_clawed_back_credits: string;
      readonly lot_status: string;
      readonly debts: string;
    }>(
      `select o.payment_status,count(l.id)::text as lots,
              max(l.remaining_credits)::text as remaining_credits,
              max(l.cash_clawed_back_credits)::text as cash_clawed_back_credits,
              max(l.status) as lot_status,
              (select count(*) from credit_pack_clawback_debts)::text as debts
         from credit_pack_orders o left join credit_funding_lots l on l.order_id=o.id
        where o.id=$1::uuid group by o.id`,
      [reservation.orderId],
    );
    expect(state.rows[0]).toEqual({
      payment_status: "disputed",
      lots: "1",
      remaining_credits: "0",
      cash_clawed_back_credits: "100000000",
      lot_status: "disputed",
      debts: "0",
    });
  });

  test("serializes concurrent cash and product refunds without double credit", async () => {
    const { accountId, reservation } = await reservedPack(
      "pack-concurrent-cash-product-refund",
    );
    const processor = new CreditPackEventProcessor(catalog, PRODUCT_LINE);
    await projectPayment(processor, paymentEvent(reservation));
    const credits = new CreditService(postgresDatabase());
    await credits.charge(accountId, "80", "pack-concurrent-cash-product-job");

    const [cash, product] = await Promise.all([
      projectClawback(processor, refundEvent(reservation, 750)),
      credits.refund("pack-concurrent-cash-product-job"),
    ]);

    expect(cash?.outcome).toBe("handled");
    expect([50_000_000n, 80_000_000n]).toContain(product.restoredAtoms);
    const state = await postgresDatabase().query<{
      readonly remaining_credits: string;
      readonly cash_clawed_back_credits: string;
      readonly outstanding_debt: string;
      readonly debit_amount: string;
      readonly restored_credits: string;
      readonly refunded: boolean;
    }>(
      `select l.remaining_credits,l.cash_clawed_back_credits,
              (select coalesce(sum(
                 target_credits-collected_credits-released_credits),0)::text
                 from credit_pack_clawback_debts) as outstanding_debt,
              d.amount as debit_amount,d.restored_credits,
              d.refunded_at is not null as refunded
         from credit_funding_lots l
         join credit_debits d
           on d.idempotency_key='pack-concurrent-cash-product-job'
        where l.order_id=$1::uuid`,
      [reservation.orderId],
    );
    expect(state.rows[0]).toEqual({
      remaining_credits: "50000000",
      cash_clawed_back_credits:
        product.restoredAtoms === 50_000_000n ? "20000000" : "50000000",
      outstanding_debt: "0",
      debit_amount: "80000000",
      restored_credits: product.restoredAtoms.toString(),
      refunded: true,
    });
  });
});
