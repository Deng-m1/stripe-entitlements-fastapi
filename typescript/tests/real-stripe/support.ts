/* eslint-disable security/detect-non-literal-fs-filename -- recovery paths are constrained to the private /tmp runner namespace before use. */
import { randomUUID } from "node:crypto";
import { chmod, open, rename, unlink } from "node:fs/promises";

import Stripe from "stripe";

import { isPlainRecord } from "../../src/validation.js";

export const STRIPE_API_VERSION = "2026-06-24.dahlia";
const EVENT_WAIT_MS = 60_000;
const POLL_MS = 750;
const MAX_INVENTORY_ITEMS = 20_000;

type StripeMetadata = Record<string, string>;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function plainStripeObject(value: unknown): Record<string, unknown> {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("Stripe returned a value that cannot be serialized");
  }
  const parsed: unknown = JSON.parse(encoded);
  if (!isPlainRecord(parsed)) {
    throw new TypeError("Stripe returned a non-object response");
  }
  return parsed;
}

function metadataOf(value: unknown): Readonly<Record<string, unknown>> {
  return isPlainRecord(value) ? value : {};
}

function idOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return isPlainRecord(value) && typeof value["id"] === "string"
    ? value["id"]
    : undefined;
}

async function collectAll<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) {
    collected.push(value);
    if (collected.length > MAX_INVENTORY_ITEMS) {
      throw new Error("Stripe inventory exceeded the bounded cleanup limit");
    }
  }
  return collected;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "UnknownError";
}

function errorObject(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("non-Error failure from real Stripe scenario", {
        cause: error,
      });
}

export interface RecurringFixture {
  readonly product: Stripe.Product;
  readonly starterPrice: Stripe.Price;
  readonly proPrice?: Stripe.Price;
  readonly customer: Stripe.Customer;
  readonly subscription: Stripe.Subscription;
}

/**
 * One isolated real-test namespace. Cleanup first verifies run metadata and
 * customer lineage, then mutates only those positively owned objects. A final
 * complete auto-pagination sweep catches successful creates whose response was
 * lost before the ID could be recorded.
 */
export class RealStripeRun {
  public readonly runId = randomUUID().replaceAll("-", "").slice(0, 16);
  public readonly createdAfter = Math.floor(Date.now() / 1000) - 30;
  public readonly prefix = `ts${this.runId}`;
  public readonly productLine: string;
  public readonly stripe: Stripe;

  readonly #createdCustomers = new Set<string>();
  readonly #createdProducts = new Set<string>();
  readonly #createdPrices = new Set<string>();
  readonly #createdSubscriptions = new Set<string>();
  readonly #createdPaymentIntents = new Set<string>();
  readonly #createdSchedules = new Set<string>();
  readonly #createdTestClocks = new Set<string>();
  readonly #cleanupErrors: string[] = [];
  readonly #recoveryManifest: string | undefined;

  public constructor(secretKey: string, purpose: string) {
    this.productLine = `stripe-entitlements-ts-${purpose}-${this.runId}`;
    const configuredDirectory =
      process.env["STRIPE_TS_REAL_RECOVERY_DIR"]?.trim();
    if (
      configuredDirectory !== undefined &&
      configuredDirectory.length > 0 &&
      !/^\/tmp\/stripe-entitlements-ts-real\.[A-Za-z0-9]+$/u.test(
        configuredDirectory,
      )
    ) {
      throw new Error(
        "real Stripe recovery directory is outside its private runner namespace",
      );
    }
    this.#recoveryManifest =
      configuredDirectory === undefined || configuredDirectory.length === 0
        ? undefined
        : `${configuredDirectory}/recovery-${this.runId}.json`;
    this.stripe = new Stripe(secretKey, {
      apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
      maxNetworkRetries: 2,
      timeout: 30_000,
    });
  }

  async #writeRecovery(
    status: string,
    cleanupErrors: readonly string[] = [],
  ): Promise<void> {
    const manifest = this.#recoveryManifest;
    if (manifest === undefined) {
      return;
    }
    const temporary = `${manifest}.${randomUUID()}.tmp`;
    const state = {
      schema_version: 1,
      secret_free: true,
      implementation: "typescript",
      stripe_api_version: STRIPE_API_VERSION,
      status,
      run_id: this.runId,
      product_line: this.productLine,
      customers: [...this.#createdCustomers].sort(),
      products: [...this.#createdProducts].sort(),
      prices: [...this.#createdPrices].sort(),
      subscriptions: [...this.#createdSubscriptions].sort(),
      payment_intents: [...this.#createdPaymentIntents].sort(),
      schedules: [...this.#createdSchedules].sort(),
      test_clocks: [...this.#createdTestClocks].sort(),
      cleanup_errors: [...cleanupErrors],
      updated_at_epoch: Math.floor(Date.now() / 1000),
    };
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, manifest);
      await chmod(manifest, 0o600);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  public async initializeRecovery(): Promise<void> {
    await this.#writeRecovery("initialized");
  }

  async #recordCreatedObject(): Promise<void> {
    await this.#writeRecovery("running");
  }

  public metadata(extra: StripeMetadata = {}): StripeMetadata {
    return {
      automated_test: "true",
      implementation: "typescript",
      run_id: this.runId,
      product_line: this.productLine,
      ...extra,
    };
  }

  public request(label: string): Stripe.RequestOptions {
    return { idempotencyKey: `real-ts:${this.runId}:${label}` };
  }

  public async createProduct(label: string): Promise<Stripe.Product> {
    const product = await this.stripe.products.create(
      {
        name: `Stripe Entitlements TypeScript ${label} ${this.runId}`,
        metadata: this.metadata(),
      },
      this.request(`${label}:product`),
    );
    this.#createdProducts.add(product.id);
    await this.#recordCreatedObject();
    return product;
  }

  public async createRecurringPrice(
    productId: string,
    plan: "starter" | "pro",
    interval: "month" | "year" = "month",
  ): Promise<Stripe.Price> {
    const major =
      plan === "starter"
        ? interval === "month"
          ? 19
          : 137
        : interval === "month"
          ? 49
          : 353;
    const price = await this.stripe.prices.create(
      {
        product: productId,
        currency: "usd",
        unit_amount: major * 100,
        recurring: { interval },
        lookup_key: `${this.prefix}_${plan}_${interval}`,
        metadata: this.metadata({ plan }),
      },
      this.request(`${plan}:${interval}:price`),
    );
    this.#createdPrices.add(price.id);
    await this.#recordCreatedObject();
    return price;
  }

  public async createPackPrice(
    productId: string,
    packKey = "boost-100",
  ): Promise<Stripe.Price> {
    const price = await this.stripe.prices.create(
      {
        product: productId,
        currency: "usd",
        unit_amount: 1500,
        lookup_key: `${this.prefix}_pack_${packKey}`,
        metadata: this.metadata({ credit_pack: packKey }),
      },
      this.request(`${packKey}:price`),
    );
    this.#createdPrices.add(price.id);
    await this.#recordCreatedObject();
    return price;
  }

  public async createTestClock(): Promise<Stripe.TestHelpers.TestClock> {
    const clock = await this.stripe.testHelpers.testClocks.create(
      {
        frozen_time: Math.floor(Date.now() / 1000),
        name: `stripe-entitlements-ts-clock-${this.runId}`,
      },
      this.request("test-clock"),
    );
    this.#createdTestClocks.add(clock.id);
    await this.#recordCreatedObject();
    return clock;
  }

  public async advanceTestClock(
    clockId: string,
    frozenTime: number,
  ): Promise<Stripe.TestHelpers.TestClock> {
    if (!Number.isSafeInteger(frozenTime) || frozenTime <= 0) {
      throw new TypeError("Test Clock target must be a positive epoch second");
    }
    const owned = await this.stripe.testHelpers.testClocks.retrieve(clockId);
    if (
      owned.livemode ||
      owned.name !== `stripe-entitlements-ts-clock-${this.runId}`
    ) {
      throw new Error("Test Clock ownership verification failed");
    }
    await this.stripe.testHelpers.testClocks.advance(clockId, {
      frozen_time: frozenTime,
    });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const clock = await this.stripe.testHelpers.testClocks.retrieve(clockId);
      if (clock.status === "ready" && clock.frozen_time === frozenTime) {
        return clock;
      }
      if (clock.status === "internal_failure") {
        throw new Error("Stripe Test Clock entered internal_failure");
      }
      await sleep(POLL_MS);
    }
    throw new Error("Stripe Test Clock did not return to ready");
  }

  public async createCustomer(
    accountId: string,
    options: { readonly testClockId?: string } = {},
  ): Promise<Stripe.Customer> {
    const customer = await this.stripe.customers.create(
      {
        name: `Automated TypeScript test ${this.runId}`,
        metadata: this.metadata({ account_id: accountId }),
        ...(options.testClockId === undefined
          ? {}
          : { test_clock: options.testClockId }),
      },
      this.request("customer"),
    );
    this.#createdCustomers.add(customer.id);
    await this.#recordCreatedObject();
    return customer;
  }

  public async attachWorkingCard(customerId: string): Promise<string> {
    const paymentMethod = await this.stripe.paymentMethods.attach(
      "pm_card_visa",
      { customer: customerId },
    );
    await this.stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethod.id },
    });
    return paymentMethod.id;
  }

  public async createSubscription(
    accountId: string,
    customerId: string,
    priceId: string,
    label = "subscription",
  ): Promise<Stripe.Subscription> {
    const subscription = await this.stripe.subscriptions.create(
      {
        customer: customerId,
        items: [{ price: priceId }],
        payment_behavior: "error_if_incomplete",
        metadata: this.metadata({ account_id: accountId }),
      },
      this.request(label),
    );
    this.#createdSubscriptions.add(subscription.id);
    await this.#recordCreatedObject();
    return subscription;
  }

  public async createRecurringFixture(
    accountId: string,
    options: {
      readonly label: string;
      readonly includePro?: boolean;
      readonly interval?: "month" | "year";
    },
  ): Promise<RecurringFixture> {
    const product = await this.createProduct(options.label);
    const interval = options.interval ?? "month";
    const starterPrice = await this.createRecurringPrice(
      product.id,
      "starter",
      interval,
    );
    const proPrice = options.includePro
      ? await this.createRecurringPrice(product.id, "pro", interval)
      : undefined;
    const customer = await this.createCustomer(accountId);
    await this.attachWorkingCard(customer.id);
    const subscription = await this.createSubscription(
      accountId,
      customer.id,
      starterPrice.id,
      `${options.label}:subscription`,
    );
    return {
      product,
      starterPrice,
      ...(proPrice === undefined ? {} : { proPrice }),
      customer,
      subscription,
    };
  }

  public async recordPaymentIntent(paymentIntentId: string): Promise<void> {
    this.#createdPaymentIntents.add(paymentIntentId);
    await this.#recordCreatedObject();
  }

  public async recordSchedule(scheduleId: string): Promise<void> {
    this.#createdSchedules.add(scheduleId);
    await this.#recordCreatedObject();
  }

  public async waitForEvent(
    eventType: Stripe.Event.Type,
    predicate: (object: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + EVENT_WAIT_MS;
    while (Date.now() < deadline) {
      const events = await collectAll(
        this.stripe.events.list({
          type: eventType,
          created: { gte: this.createdAfter },
          limit: 100,
        }),
      );
      for (const event of events) {
        const raw = plainStripeObject(event);
        const data = raw["data"];
        const object = isPlainRecord(data) ? data["object"] : undefined;
        if (
          isPlainRecord(object) &&
          object["livemode"] !== true &&
          predicate(object)
        ) {
          return raw;
        }
      }
      await sleep(POLL_MS);
    }
    throw new Error(`Stripe did not expose the expected ${eventType} Event`);
  }

  public async waitForPaidInvoice(
    subscriptionId: string,
    excluding: ReadonlySet<string> = new Set(),
  ): Promise<Stripe.Invoice> {
    const deadline = Date.now() + EVENT_WAIT_MS;
    while (Date.now() < deadline) {
      const invoices = await collectAll(
        this.stripe.invoices.list({
          subscription: subscriptionId,
          status: "paid",
          limit: 100,
        }),
      );
      const invoice = invoices.find(
        (candidate) => !excluding.has(candidate.id),
      );
      if (invoice !== undefined) {
        return invoice;
      }
      await sleep(POLL_MS);
    }
    throw new Error("Stripe did not expose the expected paid Invoice");
  }

  public async latestChargeForInvoice(invoiceId: string): Promise<string> {
    const payments = await collectAll(
      this.stripe.invoicePayments.list({ invoice: invoiceId, limit: 100 }),
    );
    for (const payment of payments) {
      const details = payment.payment;
      if (
        details.type === "payment_intent" &&
        details.payment_intent !== null
      ) {
        const paymentIntentId = idOf(details.payment_intent);
        if (paymentIntentId === undefined) {
          continue;
        }
        const intent =
          await this.stripe.paymentIntents.retrieve(paymentIntentId);
        const chargeId = idOf(intent.latest_charge);
        if (chargeId !== undefined) {
          return chargeId;
        }
      }
    }
    throw new Error("paid Invoice has no retrievable Charge");
  }

  async #ownedCustomer(customerId: string): Promise<Stripe.Customer> {
    const customer = await this.stripe.customers.retrieve(customerId);
    if (
      customer.deleted ||
      customer.livemode ||
      customer.metadata["run_id"] !== this.runId
    ) {
      throw new Error("Customer ownership verification failed");
    }
    return customer;
  }

  async #ownedSubscription(
    subscriptionId: string,
  ): Promise<Stripe.Subscription> {
    const subscription =
      await this.stripe.subscriptions.retrieve(subscriptionId);
    if (
      subscription.livemode ||
      subscription.metadata["run_id"] !== this.runId
    ) {
      throw new Error("Subscription ownership verification failed");
    }
    return subscription;
  }

  async #refundCustomerPayments(customerId: string): Promise<void> {
    await this.#ownedCustomer(customerId);
    const intents = await collectAll(
      this.stripe.paymentIntents.list({ customer: customerId, limit: 100 }),
    );
    for (const intent of intents) {
      if (intent.livemode || idOf(intent.customer) !== customerId) {
        throw new Error("PaymentIntent customer ownership verification failed");
      }
      const chargeId = idOf(intent.latest_charge);
      if (chargeId === undefined) {
        continue;
      }
      const charge = await this.stripe.charges.retrieve(chargeId);
      if (
        charge.livemode ||
        idOf(charge.customer) !== customerId ||
        idOf(charge.payment_intent) !== intent.id
      ) {
        throw new Error("Charge ownership verification failed");
      }
      if (!charge.paid) {
        if (charge.amount_refunded !== 0) {
          throw new Error("failed run-owned Charge has refund drift");
        }
        continue;
      }
      if (charge.amount_refunded < charge.amount) {
        await this.stripe.refunds.create(
          {
            charge: charge.id,
            amount: charge.amount - charge.amount_refunded,
            metadata: this.metadata({ cleanup: "true" }),
          },
          this.request(`cleanup:${charge.id}`),
        );
      }
      const finalCharge = await this.stripe.charges.retrieve(charge.id);
      if (
        finalCharge.amount_refunded !== finalCharge.amount ||
        !finalCharge.refunded
      ) {
        throw new Error("run-owned Charge still has refundable cash");
      }
    }
  }

  async #releaseSchedule(scheduleId: string): Promise<void> {
    const schedule =
      await this.stripe.subscriptionSchedules.retrieve(scheduleId);
    const subscriptionId = idOf(schedule.subscription);
    const productLine = schedule.metadata?.["product_line"];
    if (
      schedule.livemode ||
      subscriptionId === undefined ||
      (productLine !== undefined && productLine !== this.productLine)
    ) {
      throw new Error("Subscription Schedule ownership verification failed");
    }
    // A crash can leave the from_subscription Schedule before its metadata
    // configuration call. Exact linkage to a separately verified run-owned
    // Subscription is sufficient cleanup authority in that intermediate state.
    await this.#ownedSubscription(subscriptionId);
    if (!["released", "canceled", "completed"].includes(schedule.status)) {
      await this.stripe.subscriptionSchedules.release(schedule.id);
    }
  }

  async #cancelSubscription(subscriptionId: string): Promise<void> {
    const subscription = await this.#ownedSubscription(subscriptionId);
    if (subscription.status !== "canceled") {
      await this.stripe.subscriptions.cancel(subscription.id);
    }
  }

  async #deleteCustomer(customerId: string): Promise<void> {
    await this.#refundCustomerPayments(customerId);
    await this.#ownedCustomer(customerId);
    await this.stripe.customers.del(customerId);
  }

  async #deactivatePrice(priceId: string): Promise<void> {
    const price = await this.stripe.prices.retrieve(priceId);
    if (price.livemode || price.metadata["run_id"] !== this.runId) {
      throw new Error("Price ownership verification failed");
    }
    if (price.active) {
      await this.stripe.prices.update(price.id, { active: false });
    }
  }

  async #deactivateProduct(productId: string): Promise<void> {
    const product = await this.stripe.products.retrieve(productId);
    if (product.livemode || product.metadata["run_id"] !== this.runId) {
      throw new Error("Product ownership verification failed");
    }
    if (product.active) {
      await this.stripe.products.update(product.id, { active: false });
    }
  }

  async #captureCleanup(
    label: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.#cleanupErrors.push(`${label}:${errorKind(error)}`);
    }
  }

  async #discoverRunInventory(): Promise<{
    readonly schedules: Stripe.SubscriptionSchedule[];
    readonly subscriptions: Stripe.Subscription[];
    readonly customers: Stripe.Customer[];
    readonly prices: Stripe.Price[];
    readonly products: Stripe.Product[];
    readonly testClocks: Stripe.TestHelpers.TestClock[];
  }> {
    const [schedules, subscriptions, customers, prices, products, testClocks] =
      await Promise.all([
        collectAll(this.stripe.subscriptionSchedules.list({ limit: 100 })),
        collectAll(
          this.stripe.subscriptions.list({ status: "all", limit: 100 }),
        ),
        collectAll(this.stripe.customers.list({ limit: 100 })),
        collectAll(this.stripe.prices.list({ limit: 100 })),
        collectAll(this.stripe.products.list({ limit: 100 })),
        collectAll(this.stripe.testHelpers.testClocks.list({ limit: 100 })),
      ]);
    const runSubscriptions = subscriptions.filter(
      (item) => item.metadata["run_id"] === this.runId,
    );
    const subscriptionIds = new Set(runSubscriptions.map((item) => item.id));
    return {
      schedules: schedules.filter((item) => {
        const subscriptionId = idOf(item.subscription);
        return (
          item.metadata?.["product_line"] === this.productLine ||
          (subscriptionId !== undefined && subscriptionIds.has(subscriptionId))
        );
      }),
      subscriptions: runSubscriptions,
      customers: customers.filter(
        (item) => item.metadata["run_id"] === this.runId,
      ),
      prices: prices.filter((item) => item.metadata["run_id"] === this.runId),
      products: products.filter(
        (item) => item.metadata["run_id"] === this.runId,
      ),
      testClocks: testClocks.filter(
        (item) => item.name === `stripe-entitlements-ts-clock-${this.runId}`,
      ),
    };
  }

  public async cleanup(
    options: { readonly retainRecovery?: boolean } = {},
  ): Promise<void> {
    await this.#writeRecovery("cleanup_started");
    let inventory;
    try {
      inventory = await this.#discoverRunInventory();
    } catch (error) {
      await this.#writeRecovery("cleanup_failed", [
        `inventory:${errorKind(error)}`,
      ]);
      throw new Error(
        `real Stripe cleanup inventory failed: ${errorKind(error)}`,
      );
    }
    for (const id of new Set([
      ...this.#createdSchedules,
      ...inventory.schedules.map((item) => item.id),
    ])) {
      await this.#captureCleanup(`schedule:${id}`, () =>
        this.#releaseSchedule(id),
      );
    }
    for (const id of new Set([
      ...this.#createdSubscriptions,
      ...inventory.subscriptions.map((item) => item.id),
    ])) {
      await this.#captureCleanup(`subscription:${id}`, () =>
        this.#cancelSubscription(id),
      );
    }
    for (const id of new Set([
      ...this.#createdCustomers,
      ...inventory.customers.map((item) => item.id),
    ])) {
      await this.#captureCleanup(`customer:${id}`, () =>
        this.#deleteCustomer(id),
      );
    }
    for (const id of new Set([
      ...this.#createdPrices,
      ...inventory.prices.map((item) => item.id),
    ])) {
      await this.#captureCleanup(`price:${id}`, () =>
        this.#deactivatePrice(id),
      );
    }
    for (const id of new Set([
      ...this.#createdProducts,
      ...inventory.products.map((item) => item.id),
    ])) {
      await this.#captureCleanup(`product:${id}`, () =>
        this.#deactivateProduct(id),
      );
    }
    for (const id of new Set([
      ...this.#createdTestClocks,
      ...inventory.testClocks.map((item) => item.id),
    ])) {
      await this.#captureCleanup(`test_clock:${id}`, async () => {
        const clock = await this.stripe.testHelpers.testClocks.retrieve(id);
        if (
          clock.livemode ||
          clock.name !== `stripe-entitlements-ts-clock-${this.runId}`
        ) {
          throw new Error("Test Clock ownership verification failed");
        }
        await this.stripe.testHelpers.testClocks.del(id);
      });
    }

    // PaymentIntents are not deletable. The customer pass above proves every
    // run-owned Charge is fully refunded; this set exists to ensure no caller
    // accidentally treats a pre-existing PaymentIntent as a fixture.
    for (const id of this.#createdPaymentIntents) {
      await this.#captureCleanup(`payment_intent:${id}`, async () => {
        const intent = await this.stripe.paymentIntents.retrieve(id);
        if (
          intent.livemode ||
          intent.metadata["run_id"] !== this.runId ||
          intent.amount_received !== intent.amount
        ) {
          throw new Error("PaymentIntent ownership verification failed");
        }
        const chargeId = idOf(intent.latest_charge);
        if (chargeId !== undefined) {
          const charge = await this.stripe.charges.retrieve(chargeId);
          if (charge.amount_refunded !== charge.amount || !charge.refunded) {
            throw new Error(
              "run-owned PaymentIntent still has refundable cash",
            );
          }
        }
      });
    }

    let residual;
    try {
      residual = await this.#discoverRunInventory();
    } catch (error) {
      this.#cleanupErrors.push(`post_cleanup_inventory:${errorKind(error)}`);
      residual = undefined;
    }
    if (residual !== undefined) {
      const unfinishedSchedules = residual.schedules.filter(
        (item) => !["released", "canceled", "completed"].includes(item.status),
      );
      const activeSubscriptions = residual.subscriptions.filter(
        (item) => item.status !== "canceled",
      );
      const activePrices = residual.prices.filter((item) => item.active);
      const activeProducts = residual.products.filter((item) => item.active);
      const counts = [
        ["unfinished_schedules", unfinishedSchedules.length],
        ["non_canceled_subscriptions", activeSubscriptions.length],
        ["customers", residual.customers.length],
        ["active_prices", activePrices.length],
        ["active_products", activeProducts.length],
        ["test_clocks", residual.testClocks.length],
      ] as const;
      for (const [label, count] of counts) {
        if (count > 0) {
          this.#cleanupErrors.push(`post_cleanup_${label}:${count}`);
        }
      }
    }
    if (this.#cleanupErrors.length > 0) {
      await this.#writeRecovery("cleanup_failed", this.#cleanupErrors);
      throw new Error(
        `real Stripe cleanup failed: ${this.#cleanupErrors.join(", ")}`,
      );
    }
    if (options.retainRecovery === true) {
      // A scenario assertion can fail even when strict cleanup succeeds. Keep
      // that run's independent, secret-free manifest as audit/recovery state;
      // a later successful scenario must not erase or overwrite it.
      await this.#writeRecovery("scenario_failed_cleanup_complete");
    } else if (this.#recoveryManifest !== undefined) {
      await unlink(this.#recoveryManifest);
    }
  }
}

export async function withRealStripeRun(
  secretKey: string,
  purpose: string,
  operation: (run: RealStripeRun) => Promise<void>,
): Promise<void> {
  const run = new RealStripeRun(secretKey, purpose);
  await run.initializeRecovery();
  let bodyError: unknown;
  try {
    await operation(run);
  } catch (error) {
    bodyError = error;
  }
  let cleanupError: unknown;
  try {
    await run.cleanup({ retainRecovery: bodyError !== undefined });
  } catch (error) {
    cleanupError = error;
  }
  if (bodyError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [errorObject(bodyError), errorObject(cleanupError)],
      "real Stripe scenario and strict cleanup both failed",
    );
  }
  if (bodyError !== undefined) {
    throw errorObject(bodyError);
  }
  if (cleanupError !== undefined) {
    throw errorObject(cleanupError);
  }
}

export function stripeId(value: unknown): string {
  const id = idOf(value);
  if (id === undefined) {
    throw new TypeError("Stripe object is missing an identity");
  }
  return id;
}

export function stripeMetadata(
  value: unknown,
): Readonly<Record<string, unknown>> {
  return metadataOf(value);
}
