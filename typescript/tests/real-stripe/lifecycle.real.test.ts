import { fileURLToPath } from "node:url";

import type { QueryResultRow } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { AnnualGrantService } from "../../src/annual.js";
import { PlanCatalog } from "../../src/catalog.js";
import { CORRECTNESS_TABLES, Database } from "../../src/database.js";
import { EventProcessor } from "../../src/event-processor.js";
import { PlanChangeCoordinator } from "../../src/plan-changes.js";
import { CreditPackCoordinator } from "../../src/credit-pack-coordinator.js";
import { CreditService } from "../../src/credits.js";
import { StripeGateway } from "../../src/stripe-gateway.js";
import { optionalStripeTestSecret } from "./guard.js";
import {
  STRIPE_API_VERSION,
  type RealStripeRun,
  plainStripeObject,
  stripeId,
  withRealStripeRun,
} from "./support.js";

const CATALOG_PATH = fileURLToPath(
  new URL("../../../plans.toml", import.meta.url),
);
const STARTER_ATOMS = 300_000_000n;
const PRO_ATOMS = 1_000_000_000n;
const PACK_ATOMS = 100_000_000n;
const secretKey = optionalStripeTestSecret(process.env["STRIPE_SECRET_KEY"]);
const ready = secretKey !== undefined;

let database: Database;
let rootCatalog: PlanCatalog;

function key(): string {
  if (secretKey === undefined) {
    throw new Error("real Stripe test credential was not initialized");
  }
  return secretKey;
}

function epochTimestamp(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Stripe epoch second must be a positive safe integer");
  }
  return new Date(value * 1000).toISOString().replace(".000Z", ".000000Z");
}

function eventApiVersion(event: Readonly<Record<string, unknown>>): string {
  const version = event["api_version"];
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("Stripe Event has no observable API snapshot version");
  }
  return version;
}

function gateway(run: RealStripeRun): StripeGateway {
  return new StripeGateway(key(), "whsec_real_test_not_used", {
    productLine: run.productLine,
    apiVersion: STRIPE_API_VERSION,
  });
}

async function linkAccount(
  accountId: string,
  customerId: string,
  subscriptionId?: string,
): Promise<void> {
  await database.query(
    `update billing_accounts
        set stripe_customer_id=$2,
            stripe_subscription_id=coalesce($3,stripe_subscription_id)
      where id=$1::uuid`,
    [accountId, customerId, subscriptionId ?? null],
  );
}

async function projectInitialSubscription(
  run: RealStripeRun,
  accountId: string,
  subscriptionId: string,
): Promise<{
  readonly gateway: StripeGateway;
  readonly processor: EventProcessor;
  readonly invoiceId: string;
  readonly eventVersion: string;
}> {
  const invoice = await run.waitForPaidInvoice(subscriptionId);
  const event = await run.waitForEvent(
    "invoice.paid",
    (object) => object["id"] === invoice.id,
  );
  const eventVersion = eventApiVersion(event);
  const catalog = new PlanCatalog(
    rootCatalog.plans,
    run.prefix,
    rootCatalog.creditPacks,
  );
  const stripeGateway = gateway(run);
  // Every Stripe retrieval and pagination call above, including prepareEvent,
  // completes before EventProcessor opens its short PostgreSQL transaction.
  const prepared = await stripeGateway.prepareEvent(event);
  const processor = new EventProcessor(database, catalog, run.productLine, {
    expectedApiVersion: eventVersion,
  });
  const result = await processor.process(prepared);
  expect(result, JSON.stringify(result)).toMatchObject({
    outcome: "handled",
    accountId,
  });
  return {
    gateway: stripeGateway,
    processor,
    invoiceId: invoice.id,
    eventVersion,
  };
}

async function accountState(accountId: string): Promise<
  {
    readonly plan_key: string;
    readonly plan_interval: string | null;
    readonly credits_balance: string;
    readonly grant_epoch: string;
    readonly entitlement_revoked: boolean;
  } & QueryResultRow
> {
  const result = await database.query<
    {
      readonly plan_key: string;
      readonly plan_interval: string | null;
      readonly credits_balance: string;
      readonly grant_epoch: string;
      readonly entitlement_revoked: boolean;
    } & QueryResultRow
  >(
    `select plan_key,plan_interval,credits_balance,grant_epoch,
            entitlement_revoked
       from billing_accounts where id=$1::uuid`,
    [accountId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("billing account disappeared during the real Stripe test");
  }
  return row;
}

describe.skipIf(!ready)("self-contained Stripe test-mode projection", () => {
  beforeAll(async () => {
    const dsn = process.env["STRIPE_ENTITLEMENTS_TS_TEST_DSN"];
    if (dsn === undefined || dsn.length === 0) {
      throw new Error("real Stripe disposable PostgreSQL DSN is unavailable");
    }
    database = new Database(dsn, { max: 20 });
    await database.connect();
    await database.applyMigrations();
    rootCatalog = await PlanCatalog.fromToml(CATALOG_PATH);
  });

  beforeEach(async () => {
    await database.query(
      `truncate ${[...CORRECTNESS_TABLES].reverse().join(",")}
       restart identity cascade`,
    );
  });

  afterAll(async () => {
    await database.close();
  });

  test("projects a real paid Invoice and cumulative partial/full refunds into PostgreSQL", async () => {
    await withRealStripeRun(key(), "paid-refund", async (run) => {
      const accountId = await database.createAccount(
        `v1:user:real-ts:${run.runId}`,
      );
      const fixture = await run.createRecurringFixture(accountId, {
        label: "paid-refund",
      });
      await linkAccount(
        accountId,
        fixture.customer.id,
        fixture.subscription.id,
      );
      const {
        gateway: stripeGateway,
        processor,
        invoiceId,
      } = await projectInitialSubscription(
        run,
        accountId,
        fixture.subscription.id,
      );

      expect((await accountState(accountId)).credits_balance).toBe(
        STARTER_ATOMS.toString(),
      );
      const chargeId = await run.latestChargeForInvoice(invoiceId);
      await run.stripe.refunds.create(
        {
          charge: chargeId,
          amount: 950,
          metadata: run.metadata({ phase: "partial-refund" }),
        },
        run.request("partial-refund"),
      );
      const partialEvent = await run.waitForEvent(
        "charge.refunded",
        (object) =>
          object["id"] === chargeId && object["amount_refunded"] === 950,
      );
      const partialResult = await processor.process(
        await stripeGateway.prepareEvent(partialEvent),
      );
      expect(partialResult.outcome).toBe("handled");
      expect((await accountState(accountId)).credits_balance).toBe("150000000");

      await run.stripe.refunds.create(
        {
          charge: chargeId,
          amount: 950,
          metadata: run.metadata({ phase: "full-refund" }),
        },
        run.request("full-refund"),
      );
      const fullEvent = await run.waitForEvent(
        "charge.refunded",
        (object) =>
          object["id"] === chargeId &&
          object["amount_refunded"] === 1900 &&
          object["refunded"] === true,
      );
      const fullResult = await processor.process(
        await stripeGateway.prepareEvent(fullEvent),
      );
      expect(fullResult.outcome).toBe("handled");
      const closed = await accountState(accountId);
      expect(closed.credits_balance).toBe("0");
      expect(closed.entitlement_revoked).toBe(true);

      await expect(processor.process(fullEvent)).resolves.toMatchObject({
        outcome: "duplicate",
      });
    });
  });

  test("full-period-reset upgrade is webhook-authoritative and grants one new pool", async () => {
    await withRealStripeRun(key(), "full-reset", async (run) => {
      const accountId = await database.createAccount(
        `v1:user:real-ts:${run.runId}`,
      );
      const fixture = await run.createRecurringFixture(accountId, {
        label: "full-reset",
        includePro: true,
      });
      await linkAccount(
        accountId,
        fixture.customer.id,
        fixture.subscription.id,
      );
      const initial = await projectInitialSubscription(
        run,
        accountId,
        fixture.subscription.id,
      );
      const catalog = new PlanCatalog(
        rootCatalog.plans,
        run.prefix,
        rootCatalog.creditPacks,
      );
      const coordinator = new PlanChangeCoordinator(
        database,
        catalog,
        initial.gateway,
        { transitionPolicy: "full_period_reset" },
      );
      const preview = await coordinator.previewRemote(
        accountId,
        "pro",
        "month",
        `real-ts-full-reset-${run.runId}`,
      );
      if (preview.decision.timing !== "immediate") {
        throw new Error(
          JSON.stringify({
            policy: preview.transitionPolicy,
            timing: preview.decision.timing,
            reason: preview.decision.reason,
            amount_due: preview.estimatedAmountDue?.toString() ?? null,
            credit_applied: preview.estimatedCreditApplied?.toString() ?? null,
            customer_balance_credit:
              preview.estimatedCustomerBalanceCredit?.toString() ?? null,
            currency: preview.estimateCurrency,
          }),
        );
      }
      expect(preview.transitionPolicy).toBe("full_period_reset");
      expect(preview.estimatedAmountDue).toBe(4900n);
      expect(preview.estimatedCreditApplied).toBe(0n);

      const confirmed = await coordinator.confirm(accountId, preview.changeId);
      expect(confirmed.status).toBe("applied");
      const remote = await run.stripe.subscriptions.retrieve(
        fixture.subscription.id,
      );
      const settlementInvoiceId = stripeId(remote.latest_invoice);
      expect(settlementInvoiceId).not.toBe(initial.invoiceId);
      const paid = await run.waitForEvent(
        "invoice.paid",
        (object) => object["id"] === settlementInvoiceId,
      );
      expect(eventApiVersion(paid)).toBe(initial.eventVersion);
      const processed = await initial.processor.process(
        await initial.gateway.prepareEvent(paid),
      );
      expect(processed.outcome).toBe("handled");
      expect(await accountState(accountId)).toMatchObject({
        plan_key: "pro",
        plan_interval: "month",
        credits_balance: PRO_ATOMS.toString(),
        entitlement_revoked: false,
      });
      const changes = await database.query<
        {
          readonly status: string;
          readonly settlement_invoice_id: string;
        } & QueryResultRow
      >(
        `select status,settlement_invoice_id from billing_plan_changes
          where id=$1::uuid`,
        [preview.changeId],
      );
      expect(changes.rows[0]).toEqual({
        status: "completed",
        settlement_invoice_id: settlementInvoiceId,
      });
    });
  });

  test("prorated-delta upgrade records lineage and a real full refund reverts only the delta", async () => {
    await withRealStripeRun(key(), "delta", async (run) => {
      const accountId = await database.createAccount(
        `v1:user:real-ts:${run.runId}`,
      );
      const fixture = await run.createRecurringFixture(accountId, {
        label: "delta",
        includePro: true,
      });
      await linkAccount(
        accountId,
        fixture.customer.id,
        fixture.subscription.id,
      );
      const initial = await projectInitialSubscription(
        run,
        accountId,
        fixture.subscription.id,
      );
      const catalog = new PlanCatalog(
        rootCatalog.plans,
        run.prefix,
        rootCatalog.creditPacks,
      );
      const coordinator = new PlanChangeCoordinator(
        database,
        catalog,
        initial.gateway,
        { transitionPolicy: "prorated_delta" },
      );
      const preview = await coordinator.previewRemote(
        accountId,
        "pro",
        "month",
        `real-ts-delta-${run.runId}`,
      );
      expect(preview).toMatchObject({
        transitionPolicy: "prorated_delta",
        entitlementCreditDelta: PRO_ATOMS - STARTER_ATOMS,
      });
      if (preview.decision.timing !== "immediate") {
        throw new Error(
          JSON.stringify({
            policy: preview.transitionPolicy,
            timing: preview.decision.timing,
            reason: preview.decision.reason,
            amount_due: preview.estimatedAmountDue?.toString() ?? null,
            credit_applied: preview.estimatedCreditApplied?.toString() ?? null,
            customer_balance_credit:
              preview.estimatedCustomerBalanceCredit?.toString() ?? null,
            currency: preview.estimateCurrency,
          }),
        );
      }
      expect(preview.estimatedAmountDue).not.toBeNull();
      expect(preview.estimatedAmountDue ?? 0n).toBeGreaterThan(0n);
      expect(preview.estimatedCreditApplied ?? 0n).toBeGreaterThan(0n);

      const confirmed = await coordinator.confirm(accountId, preview.changeId);
      expect(confirmed.status).toBe("applied");
      const remote = await run.stripe.subscriptions.retrieve(
        fixture.subscription.id,
      );
      const settlementInvoiceId = stripeId(remote.latest_invoice);
      expect(settlementInvoiceId).not.toBe(initial.invoiceId);
      const paid = await run.waitForEvent(
        "invoice.paid",
        (object) => object["id"] === settlementInvoiceId,
      );
      const paidResult = await initial.processor.process(
        await initial.gateway.prepareEvent(paid),
      );
      expect(paidResult.outcome).toBe("handled");
      expect(await accountState(accountId)).toMatchObject({
        plan_key: "pro",
        credits_balance: PRO_ATOMS.toString(),
        grant_epoch: "1",
      });
      const allocations = await database.query<
        {
          readonly source_invoice_id: string;
          readonly entitlement_delta: string;
          readonly amount_paid: string;
        } & QueryResultRow
      >(
        `select source_invoice_id,entitlement_delta,amount_paid
           from billing_funding_allocations
          where stripe_invoice_id=$1`,
        [settlementInvoiceId],
      );
      expect(allocations.rows[0]).toEqual({
        source_invoice_id: initial.invoiceId,
        entitlement_delta: (PRO_ATOMS - STARTER_ATOMS).toString(),
        amount_paid: preview.estimatedAmountDue?.toString(),
      });

      const chargeId = await run.latestChargeForInvoice(settlementInvoiceId);
      const charge = await run.stripe.charges.retrieve(chargeId);
      await run.stripe.refunds.create(
        {
          charge: chargeId,
          metadata: run.metadata({ phase: "delta-full-refund" }),
        },
        run.request("delta-full-refund"),
      );
      const refunded = await run.waitForEvent(
        "charge.refunded",
        (object) =>
          object["id"] === chargeId &&
          object["amount_refunded"] === charge.amount &&
          object["refunded"] === true,
      );
      const refundResult = await initial.processor.process(
        await initial.gateway.prepareEvent(refunded),
      );
      expect(refundResult.outcome).toBe("handled");
      expect(await accountState(accountId)).toMatchObject({
        plan_key: "starter",
        plan_interval: "month",
        credits_balance: STARTER_ATOMS.toString(),
        grant_epoch: "2",
        entitlement_revoked: false,
      });
      const closed = await database.query<
        {
          readonly status: string;
          readonly refunded_units: string;
        } & QueryResultRow
      >(
        `select status,refunded_units from billing_funding_allocations
          where stripe_invoice_id=$1`,
        [settlementInvoiceId],
      );
      expect(closed.rows[0]).toEqual({
        status: "closed",
        refunded_units: (PRO_ATOMS - STARTER_ATOMS).toString(),
      });
    });
  });

  test.each([
    ["full_period_reset", "pm_card_authenticationRequired"],
    ["full_period_reset", "pm_card_chargeCustomerFail"],
    ["prorated_delta", "pm_card_authenticationRequired"],
    ["prorated_delta", "pm_card_chargeCustomerFail"],
  ] as const)(
    "%s with %s keeps the old paid entitlement and stores no client secret",
    async (transitionPolicy, failurePaymentMethod) => {
      await withRealStripeRun(
        key(),
        `failed-change-${transitionPolicy}-${failurePaymentMethod}`,
        async (run) => {
          const accountId = await database.createAccount(
            `v1:user:real-ts:${run.runId}`,
          );
          const fixture = await run.createRecurringFixture(accountId, {
            label: `sca-${transitionPolicy}`,
            includePro: true,
          });
          await linkAccount(
            accountId,
            fixture.customer.id,
            fixture.subscription.id,
          );
          const initial = await projectInitialSubscription(
            run,
            accountId,
            fixture.subscription.id,
          );
          const catalog = new PlanCatalog(
            rootCatalog.plans,
            run.prefix,
            rootCatalog.creditPacks,
          );
          const coordinator = new PlanChangeCoordinator(
            database,
            catalog,
            initial.gateway,
            { transitionPolicy },
          );
          const preview = await coordinator.previewRemote(
            accountId,
            "pro",
            "month",
            `real-ts-failed-${transitionPolicy}-${failurePaymentMethod}-${run.runId}`,
          );
          expect(preview.decision.timing).toBe("immediate");

          const failingMethod = await run.stripe.paymentMethods.attach(
            failurePaymentMethod,
            { customer: fixture.customer.id },
          );
          await run.stripe.customers.update(fixture.customer.id, {
            invoice_settings: { default_payment_method: failingMethod.id },
          });
          const result = await coordinator.confirm(accountId, preview.changeId);
          expect(result.status).toBe("requires_action");
          expect(result.recoveryUrl ?? result.clientSecret).not.toBeNull();
          if (
            failurePaymentMethod === "pm_card_authenticationRequired" &&
            result.clientSecret === null
          ) {
            throw new Error("SCA response did not contain an ephemeral secret");
          }

          const remote = await run.stripe.subscriptions.retrieve(
            fixture.subscription.id,
            { expand: ["latest_invoice"] },
          );
          expect(remote.pending_update).not.toBeNull();
          expect(stripeId(remote.items.data[0]?.price)).toBe(
            fixture.starterPrice.id,
          );
          const invoiceId = stripeId(remote.latest_invoice);
          const rawInvoice = plainStripeObject(remote)["latest_invoice"];
          expect(
            typeof rawInvoice === "object" &&
              rawInvoice !== null &&
              "status" in rawInvoice
              ? rawInvoice.status
              : undefined,
          ).toBe("open");
          const failure = await run.waitForEvent(
            "invoice.payment_failed",
            (object) => object["id"] === invoiceId,
          );
          expect(eventApiVersion(failure)).toBe(initial.eventVersion);
          const failureResult = await initial.processor.process(
            await initial.gateway.prepareEvent(failure),
          );
          expect(failureResult).toEqual({
            outcome: "ignored",
            reason:
              "optional plan change payment failed; paid entitlement retained",
            accountId,
          });
          expect(await accountState(accountId)).toMatchObject({
            plan_key: "starter",
            plan_interval: "month",
            credits_balance: STARTER_ATOMS.toString(),
            grant_epoch: "1",
            entitlement_revoked: false,
          });
          const stored = await database.query<
            {
              readonly status: string;
              readonly transition_policy: string;
              readonly serialized: string;
              readonly ledger_count: string;
              readonly allocation_count: string;
              readonly incident_count: string;
            } & QueryResultRow
          >(
            `select p.status,p.transition_policy,row_to_json(p)::text as serialized,
                    (select count(*)::text from credit_ledger
                      where account_id=$2::uuid) as ledger_count,
                    (select count(*)::text from billing_funding_allocations
                      where account_id=$2::uuid) as allocation_count,
                    (select count(*)::text from billing_incidents
                      where account_id=$2::uuid
                        and kind='plan_change_payment_failed') as incident_count
               from billing_plan_changes p where p.id=$1::uuid`,
            [preview.changeId, accountId],
          );
          const row = stored.rows[0];
          expect(row).toMatchObject({
            status: "requires_action",
            transition_policy: transitionPolicy,
            ledger_count: "1",
            allocation_count: "0",
            incident_count: "1",
          });
          if (row === undefined) {
            throw new Error(
              "plan change disappeared during failed-payment verification",
            );
          }
          if (
            result.clientSecret !== null &&
            row.serialized.includes(result.clientSecret)
          ) {
            throw new Error("an ephemeral SCA secret was persisted");
          }
        },
      );
    },
  );

  test("annual-origin change creates a two-phase period-end Schedule", async () => {
    await withRealStripeRun(key(), "annual-schedule", async (run) => {
      const accountId = await database.createAccount(
        `v1:user:real-ts:${run.runId}`,
      );
      const fixture = await run.createRecurringFixture(accountId, {
        label: "annual-schedule",
        includePro: true,
        interval: "year",
      });
      await linkAccount(
        accountId,
        fixture.customer.id,
        fixture.subscription.id,
      );
      const initial = await projectInitialSubscription(
        run,
        accountId,
        fixture.subscription.id,
      );
      const catalog = new PlanCatalog(
        rootCatalog.plans,
        run.prefix,
        rootCatalog.creditPacks,
      );
      const coordinator = new PlanChangeCoordinator(
        database,
        catalog,
        initial.gateway,
        { transitionPolicy: "full_period_reset" },
      );
      const preview = await coordinator.previewRemote(
        accountId,
        "pro",
        "year",
        `real-ts-annual-${run.runId}`,
      );
      expect(preview.decision.timing).toBe("period_end");
      expect(preview.estimatedAmountDue).toBeNull();
      const confirmed = await coordinator.confirm(accountId, preview.changeId);
      expect(confirmed.status).toBe("scheduled");
      const stored = await database.query<
        { readonly stripe_schedule_id: string } & QueryResultRow
      >(
        `select stripe_schedule_id from billing_plan_changes
          where id=$1::uuid`,
        [preview.changeId],
      );
      const scheduleId = stored.rows[0]?.stripe_schedule_id;
      if (scheduleId === undefined) {
        throw new Error(
          "scheduled plan change has no Stripe Schedule identity",
        );
      }
      await run.recordSchedule(scheduleId);
      const schedule =
        await run.stripe.subscriptionSchedules.retrieve(scheduleId);
      expect(schedule.livemode).toBe(false);
      expect(schedule.end_behavior).toBe("release");
      expect(schedule.phases).toHaveLength(2);
      const current = schedule.phases[0];
      const target = schedule.phases[1];
      expect(current?.end_date).toBe(target?.start_date);
      expect(stripeId(target?.items[0]?.price)).toBe(fixture.proPrice?.id);
      expect(schedule.metadata?.["product_line"]).toBe(run.productLine);
    });
  });

  test("annual Test Clock advances monthly slots, skips downtime backfill, and renews", async () => {
    await withRealStripeRun(key(), "annual-clock", async (run) => {
      const accountId = await database.createAccount(
        `v1:user:real-ts:${run.runId}`,
      );
      const clock = await run.createTestClock();
      const product = await run.createProduct("annual-clock");
      const annualPrice = await run.createRecurringPrice(
        product.id,
        "starter",
        "year",
      );
      const customer = await run.createCustomer(accountId, {
        testClockId: clock.id,
      });
      await run.attachWorkingCard(customer.id);
      const subscription = await run.createSubscription(
        accountId,
        customer.id,
        annualPrice.id,
        "annual-clock:subscription",
      );
      const initialPeriodEnd = subscription.items.data[0]?.current_period_end;
      if (initialPeriodEnd === undefined) {
        throw new Error("annual Subscription has no item period end");
      }
      await linkAccount(accountId, customer.id, subscription.id);
      const initial = await projectInitialSubscription(
        run,
        accountId,
        subscription.id,
      );
      const catalog = new PlanCatalog(
        rootCatalog.plans,
        run.prefix,
        rootCatalog.creditPacks,
      );
      const annualService = new AnnualGrantService(
        database,
        catalog,
        initial.processor,
      );
      const initialState = await database.query<
        {
          readonly plan_interval: string;
          readonly credits_balance: string;
          readonly annual_grants_issued: number;
          readonly funding_invoice_id: string;
        } & QueryResultRow
      >(
        `select plan_interval,credits_balance,annual_grants_issued,
                funding_invoice_id
           from billing_accounts where id=$1::uuid`,
        [accountId],
      );
      expect(initialState.rows[0]).toEqual({
        plan_interval: "year",
        credits_balance: STARTER_ATOMS.toString(),
        annual_grants_issued: 1,
        funding_invoice_id: initial.invoiceId,
      });

      const slotTwoTarget = clock.frozen_time + 32 * 86_400;
      await run.advanceTestClock(clock.id, slotTwoTarget);
      const slotTwoSnapshot = await initial.gateway.subscriptionSnapshot(
        subscription.id,
      );
      const slotTwo = await annualService.grantDue(
        accountId,
        epochTimestamp(slotTwoTarget),
        slotTwoSnapshot,
      );
      expect(slotTwo).toMatchObject({
        outcome: "handled",
        reason: "granted annual slot 2",
      });

      const downtimeTarget = clock.frozen_time + 190 * 86_400;
      await run.advanceTestClock(clock.id, downtimeTarget);
      const targetSlotResult = await database.query<
        { readonly target_slot: number } & QueryResultRow
      >(
        `select least(coalesce(max(slot),0)+1,12)::integer as target_slot
           from billing_accounts a,
                lateral generate_series(1,12) slot
          where a.id=$1::uuid
            and a.annual_anchor + make_interval(months => slot)
                  <= $2::timestamptz`,
        [accountId, epochTimestamp(downtimeTarget)],
      );
      const targetSlot = targetSlotResult.rows[0]?.target_slot;
      if (targetSlot === undefined || targetSlot <= 2) {
        throw new Error("annual downtime target did not cross multiple slots");
      }
      const downtimeSnapshot = await initial.gateway.subscriptionSnapshot(
        subscription.id,
      );
      const downtime = await annualService.grantDue(
        accountId,
        epochTimestamp(downtimeTarget),
        downtimeSnapshot,
      );
      expect(downtime).toMatchObject({
        outcome: "handled",
        reason: `granted annual slot ${targetSlot}`,
      });
      const oldSlots = await database.query<
        { readonly grant_slot: number } & QueryResultRow
      >(
        `select grant_slot from credit_ledger
          where stripe_invoice_id=$1 order by grant_slot`,
        [initial.invoiceId],
      );
      expect(oldSlots.rows.map((row) => row.grant_slot)).toEqual([
        1,
        2,
        targetSlot,
      ]);

      const renewalTarget = initialPeriodEnd + 3600;
      await run.advanceTestClock(clock.id, renewalTarget);
      const renewalInvoice = await run.waitForPaidInvoice(
        subscription.id,
        new Set([initial.invoiceId]),
      );
      const renewalEvent = await run.waitForEvent(
        "invoice.paid",
        (object) => object["id"] === renewalInvoice.id,
      );
      expect(eventApiVersion(renewalEvent)).toBe(initial.eventVersion);
      const renewalResult = await initial.processor.process(
        await initial.gateway.prepareEvent(renewalEvent),
      );
      expect(renewalResult.outcome).toBe("handled");
      const renewed = await database.query<
        {
          readonly plan_interval: string;
          readonly credits_balance: string;
          readonly annual_grants_issued: number;
          readonly funding_invoice_id: string;
          readonly entitlement_revoked: boolean;
        } & QueryResultRow
      >(
        `select plan_interval,credits_balance,annual_grants_issued,
                funding_invoice_id,entitlement_revoked
           from billing_accounts where id=$1::uuid`,
        [accountId],
      );
      expect(renewed.rows[0]).toEqual({
        plan_interval: "year",
        credits_balance: STARTER_ATOMS.toString(),
        annual_grants_issued: 1,
        funding_invoice_id: renewalInvoice.id,
        entitlement_revoked: false,
      });
    });
  });

  test("credit-pack PaymentIntent and cash/product refunds converge without granting plan features", async () => {
    await withRealStripeRun(key(), "pack", async (run) => {
      const accountId = await database.createAccount(
        `v1:user:real-ts:${run.runId}`,
      );
      const product = await run.createProduct("pack");
      const price = await run.createPackPrice(product.id);
      const customer = await run.createCustomer(accountId);
      await run.attachWorkingCard(customer.id);
      await linkAccount(accountId, customer.id);
      const catalog = new PlanCatalog(
        rootCatalog.plans,
        run.prefix,
        rootCatalog.creditPacks,
      );
      expect(price.lookup_key).toBe(catalog.creditPackLookupKey("boost-100"));
      const pack = catalog.requireCreditPack("boost-100");
      const reservation = await new CreditPackCoordinator(
        database,
        catalog,
      ).reserve(accountId, pack, `real-ts-pack-${run.runId}`);
      const paymentMetadata = {
        ...run.metadata(),
        billing_kind: "credit_pack",
        pack_schema_version: "1",
        credit_pack_order_id: reservation.orderId,
        account_id: accountId,
        pack_key: pack.key,
        pack_credits: pack.credits.toString(),
        price_amount: reservation.priceAmount.toString(),
        currency: pack.currency,
        expires_days: pack.expiresDays.toString(),
        lookup_key: reservation.lookupKey,
      };
      const paymentMethod = await run.stripe.paymentMethods.attach(
        "pm_card_visa",
        { customer: customer.id },
      );
      const intent = await run.stripe.paymentIntents.create(
        {
          amount: Number(reservation.priceAmount),
          currency: reservation.currency,
          customer: customer.id,
          payment_method: paymentMethod.id,
          payment_method_types: ["card"],
          confirm: true,
          off_session: true,
          description: `Run-scoped TypeScript pack ${run.runId}`,
          metadata: paymentMetadata,
        },
        run.request("pack-payment-intent"),
      );
      await run.recordPaymentIntent(intent.id);
      expect(intent.status).toBe("succeeded");
      expect(intent.amount).toBe(1500);
      expect(intent.amount_received).toBe(1500);
      expect(intent.currency).toBe("usd");
      expect(stripeId(intent.customer)).toBe(customer.id);
      const chargeId = stripeId(intent.latest_charge);
      const paid = await run.waitForEvent(
        "payment_intent.succeeded",
        (object) => object["id"] === intent.id,
      );
      const eventVersion = eventApiVersion(paid);
      const stripeGateway = gateway(run);
      const processor = new EventProcessor(database, catalog, run.productLine, {
        expectedApiVersion: eventVersion,
      });
      const paidResult = await processor.process(
        await stripeGateway.prepareEvent(paid),
      );
      expect(paidResult).toMatchObject({ outcome: "handled", accountId });
      expect(await accountState(accountId)).toMatchObject({
        plan_key: "free",
        credits_balance: "0",
      });
      const lot = await database.query<
        {
          readonly original_credits: string;
          readonly remaining_credits: string;
          readonly status: string;
        } & QueryResultRow
      >(
        `select original_credits,remaining_credits,status
           from credit_funding_lots where order_id=$1::uuid`,
        [reservation.orderId],
      );
      expect(lot.rows[0]).toEqual({
        original_credits: PACK_ATOMS.toString(),
        remaining_credits: PACK_ATOMS.toString(),
        status: "active",
      });

      const creditService = new CreditService(database);
      const charged = await creditService.charge(
        accountId,
        "80",
        `real-ts-pack-job-${run.runId}`,
      );
      expect(charged).toMatchObject({ outcome: "charged" });
      expect(charged.balanceAtoms).toBe(20_000_000n);
      await run.stripe.refunds.create(
        {
          charge: chargeId,
          amount: 750,
          metadata: run.metadata({ phase: "pack-partial-refund" }),
        },
        run.request("pack-partial-refund"),
      );
      const partial = await run.waitForEvent(
        "charge.refunded",
        (object) =>
          object["id"] === chargeId && object["amount_refunded"] === 750,
      );
      expect(
        await processor.process(await stripeGateway.prepareEvent(partial)),
      ).toMatchObject({ outcome: "handled" });

      const productRefund = await creditService.refund(
        `real-ts-pack-job-${run.runId}`,
        { expectedAccountId: accountId },
      );
      expect(productRefund).toMatchObject({
        outcome: "refunded",
        requestedAtoms: 80_000_000n,
        restoredAtoms: 50_000_000n,
        balanceAtoms: 50_000_000n,
      });
      await run.stripe.refunds.create(
        {
          charge: chargeId,
          amount: 750,
          metadata: run.metadata({ phase: "pack-full-refund" }),
        },
        run.request("pack-full-refund"),
      );
      const full = await run.waitForEvent(
        "charge.refunded",
        (object) =>
          object["id"] === chargeId &&
          object["amount_refunded"] === 1500 &&
          object["refunded"] === true,
      );
      expect(
        await processor.process(await stripeGateway.prepareEvent(full)),
      ).toMatchObject({ outcome: "handled" });
      const final = await database.query<
        {
          readonly amount_refunded: string;
          readonly refunded_credits: string;
          readonly payment_status: string;
          readonly remaining_credits: string;
          readonly cash_clawed_back_credits: string;
          readonly lot_status: string;
          readonly restored_credits: string;
        } & QueryResultRow
      >(
        `select o.amount_refunded,o.refunded_credits,o.payment_status,
                l.remaining_credits,l.cash_clawed_back_credits,
                l.status as lot_status,d.restored_credits
           from credit_pack_orders o
           join credit_funding_lots l on l.order_id=o.id
           join credit_debits d on d.idempotency_key=$2
          where o.id=$1::uuid`,
        [reservation.orderId, `real-ts-pack-job-${run.runId}`],
      );
      expect(final.rows[0]).toEqual({
        amount_refunded: "1500",
        refunded_credits: PACK_ATOMS.toString(),
        payment_status: "refunded",
        remaining_credits: "0",
        cash_clawed_back_credits: "70000000",
        lot_status: "refunded",
        restored_credits: "50000000",
      });
      expect((await accountState(accountId)).plan_key).toBe("free");
    });
  });
});
