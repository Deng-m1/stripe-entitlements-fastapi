import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  parseNodeBillingCommand,
  runNodeBillingCommand,
} from "../../src/node/cli.js";
import type {
  BootstrapPortalParams,
  BootstrapPriceParams,
  BootstrapProductParams,
  StripeBootstrapNetwork,
  StripeBootstrapPage,
} from "../../src/stripe-bootstrap.js";
import { runStripeBootstrap } from "../../src/stripe-bootstrap.js";

const CATALOG = fileURLToPath(new URL("../../../plans.toml", import.meta.url));
const TEST_KEY = "sk_test_12345678";
const LIVE_KEY = "sk_live_12345678";
const PRODUCT_LINE = "bootstrap-unit";

type Remote = Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class FakeBootstrapNetwork implements StripeBootstrapNetwork {
  public readonly products: Remote[] = [];
  public readonly prices: Remote[] = [];
  public readonly portals: Remote[] = [];
  public readonly idempotencyKeys: string[] = [];
  public readonly productCursors: (string | null)[] = [];
  public readonly priceCursors: ReadonlyArray<{
    lookupKey: string;
    cursor: string | null;
  }> = [];
  public readonly portalCursors: (string | null)[] = [];
  public readonly mutationCalls: string[] = [];
  public pageSize = 100;
  public emptyContinuedProducts = false;
  readonly #live: boolean;
  readonly #replays = new Map<string, Remote>();
  #nextProduct = 1;
  #nextPrice = 1;
  #nextPortal = 1;

  public constructor(live = false) {
    this.#live = live;
  }

  private page(
    values: readonly Remote[],
    startingAfter: string | null,
  ): StripeBootstrapPage {
    const start =
      startingAfter === null
        ? 0
        : values.findIndex((item) => item["id"] === startingAfter) + 1;
    if (startingAfter !== null && start === 0) {
      throw new Error("unknown fake cursor");
    }
    const data = values.slice(start, start + this.pageSize).map(clone);
    return { data, hasMore: start + data.length < values.length };
  }

  private replay(key: string, create: () => Remote): Remote {
    this.idempotencyKeys.push(key);
    const prior = this.#replays.get(key);
    if (prior !== undefined) {
      return clone(prior);
    }
    const result = create();
    this.#replays.set(key, clone(result));
    return clone(result);
  }

  public async listActiveProducts(
    startingAfter: string | null,
  ): Promise<StripeBootstrapPage> {
    this.productCursors.push(startingAfter);
    if (this.emptyContinuedProducts && startingAfter === null) {
      return { data: [], hasMore: true };
    }
    return this.page(
      this.products.filter((item) => item["active"] === true),
      startingAfter,
    );
  }

  public async createProduct(
    params: BootstrapProductParams,
    idempotencyKey: string,
  ): Promise<unknown> {
    this.mutationCalls.push("product.create");
    return this.replay(idempotencyKey, () => {
      const product: Remote = {
        id: `prod_fake_${String(this.#nextProduct++)}`,
        object: "product",
        active: true,
        livemode: this.#live,
        name: params.name,
        description: params.description,
        metadata: { ...params.metadata },
      };
      this.products.push(product);
      return product;
    });
  }

  public async updateProduct(
    productId: string,
    params: BootstrapProductParams,
    idempotencyKey: string,
  ): Promise<unknown> {
    this.mutationCalls.push("product.update");
    return this.replay(idempotencyKey, () => {
      const product = this.products.find((item) => item["id"] === productId);
      if (product === undefined) {
        throw new Error("missing fake Product");
      }
      Object.assign(product, {
        name: params.name,
        description: params.description,
        metadata: { ...params.metadata },
      });
      return product;
    });
  }

  public async listActivePricesForLookup(
    lookupKey: string,
    startingAfter: string | null,
  ): Promise<StripeBootstrapPage> {
    (this.priceCursors as { lookupKey: string; cursor: string | null }[]).push({
      lookupKey,
      cursor: startingAfter,
    });
    return this.page(
      this.prices.filter(
        (item) => item["active"] === true && item["lookup_key"] === lookupKey,
      ),
      startingAfter,
    );
  }

  private expandedProduct(productId: string): Remote {
    const product = this.products.find((item) => item["id"] === productId);
    if (product === undefined) {
      throw new Error("missing fake Product for Price");
    }
    return clone(product);
  }

  public async createPrice(
    params: BootstrapPriceParams,
    idempotencyKey: string,
  ): Promise<unknown> {
    this.mutationCalls.push("price.create");
    return this.replay(idempotencyKey, () => {
      for (const old of this.prices) {
        if (old["lookup_key"] === params.lookupKey) {
          old["lookup_key"] = null;
        }
      }
      const price: Remote = {
        id: `price_fake_${String(this.#nextPrice++)}`,
        object: "price",
        active: true,
        livemode: this.#live,
        currency: params.currency,
        unit_amount: params.unitAmount,
        lookup_key: params.lookupKey,
        metadata: { ...params.metadata },
        product: this.expandedProduct(params.product),
        type: params.interval === null ? "one_time" : "recurring",
        billing_scheme: "per_unit",
        recurring:
          params.interval === null
            ? null
            : {
                interval: params.interval,
                interval_count: 1,
                usage_type: "licensed",
              },
        custom_unit_amount: null,
        currency_options: {},
        tax_behavior: null,
        tiers_mode: null,
        transform_quantity: null,
      };
      this.prices.push(price);
      return price;
    });
  }

  public async deactivatePrice(
    priceId: string,
    idempotencyKey: string,
  ): Promise<unknown> {
    this.mutationCalls.push("price.deactivate");
    return this.replay(idempotencyKey, () => {
      const price = this.prices.find((item) => item["id"] === priceId);
      if (price === undefined) {
        throw new Error("missing fake Price");
      }
      price["active"] = false;
      return price;
    });
  }

  public async listActivePortalConfigurations(
    startingAfter: string | null,
  ): Promise<StripeBootstrapPage> {
    this.portalCursors.push(startingAfter);
    return this.page(
      this.portals.filter((item) => item["active"] === true),
      startingAfter,
    );
  }

  public async retrievePortalConfiguration(
    configurationId: string,
  ): Promise<unknown> {
    const portal = this.portals.find((item) => item["id"] === configurationId);
    if (portal === undefined) {
      throw new Error("missing fake Portal configuration");
    }
    return clone(portal);
  }

  private portalObject(id: string, params: BootstrapPortalParams): Remote {
    return {
      id,
      object: "billing_portal.configuration",
      active: true,
      livemode: this.#live,
      business_profile: {
        headline: params.businessProfile.headline,
      },
      features: {
        customer_update: {
          enabled: params.features.customerUpdate.enabled,
          allowed_updates: [...params.features.customerUpdate.allowedUpdates],
        },
        invoice_history: { enabled: params.features.invoiceHistory.enabled },
        payment_method_update: {
          enabled: params.features.paymentMethodUpdate.enabled,
        },
        subscription_cancel: {
          enabled: params.features.subscriptionCancel.enabled,
          mode: params.features.subscriptionCancel.mode,
        },
        subscription_update: {
          enabled: params.features.subscriptionUpdate.enabled,
        },
      },
      metadata: { ...params.metadata },
    };
  }

  public async createPortalConfiguration(
    params: BootstrapPortalParams,
    idempotencyKey: string,
  ): Promise<unknown> {
    this.mutationCalls.push("portal.create");
    return this.replay(idempotencyKey, () => {
      const portal = this.portalObject(
        `bpc_fake_${String(this.#nextPortal++)}`,
        params,
      );
      this.portals.push(portal);
      return portal;
    });
  }

  public async updatePortalConfiguration(
    configurationId: string,
    params: BootstrapPortalParams,
    idempotencyKey: string,
  ): Promise<unknown> {
    this.mutationCalls.push("portal.update");
    return this.replay(idempotencyKey, () => {
      const index = this.portals.findIndex(
        (item) => item["id"] === configurationId,
      );
      if (index < 0) {
        throw new Error("missing fake Portal configuration");
      }
      const portal = this.portalObject(configurationId, params);
      this.portals[index] = portal;
      return portal;
    });
  }

  public resetEvidence(): void {
    this.idempotencyKeys.length = 0;
    this.productCursors.length = 0;
    (
      this.priceCursors as { lookupKey: string; cursor: string | null }[]
    ).length = 0;
    this.portalCursors.length = 0;
    this.mutationCalls.length = 0;
  }
}

function options(
  network: FakeBootstrapNetwork,
  overrides: Partial<Parameters<typeof runStripeBootstrap>[0]> = {},
): Parameters<typeof runStripeBootstrap>[0] {
  return {
    secretKey: TEST_KEY,
    catalogPath: CATALOG,
    lookupPrefix: "unit",
    productLine: PRODUCT_LINE,
    networkFactory: () => network,
    ...overrides,
  };
}

describe("native TypeScript Stripe catalog bootstrap", () => {
  it("rejects missing, malformed, and insufficiently confirmed live keys before client construction", async () => {
    const factory = vi.fn(() => new FakeBootstrapNetwork());
    for (const secretKey of [
      undefined,
      "",
      "sk_test_replace_me",
      "sk_test_replaceme",
      "rk_test_12345678",
      "sk_live_short",
    ]) {
      await expect(
        runStripeBootstrap({
          secretKey,
          catalogPath: CATALOG,
          productLine: PRODUCT_LINE,
          networkFactory: factory,
        }),
      ).rejects.toThrow(/STRIPE_SECRET_KEY/u);
    }
    for (const confirmation of [
      {},
      { allowLive: true },
      { confirmedLiveProductLine: PRODUCT_LINE },
      {
        allowLive: true,
        confirmedLiveProductLine: "another-product-line",
      },
    ]) {
      await expect(
        runStripeBootstrap({
          secretKey: LIVE_KEY,
          catalogPath: CATALOG,
          productLine: PRODUCT_LINE,
          networkFactory: factory,
          ...confirmation,
        }),
      ).rejects.toThrow(/live Stripe bootstrap refused/u);
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects test-mode use of live acknowledgements before client construction", async () => {
    const factory = vi.fn(() => new FakeBootstrapNetwork());
    await expect(
      runStripeBootstrap({
        secretKey: TEST_KEY,
        catalogPath: CATALOG,
        productLine: PRODUCT_LINE,
        allowLive: true,
        confirmedLiveProductLine: PRODUCT_LINE,
        networkFactory: factory,
      }),
    ).rejects.toThrow(/invalid with a test-mode key/u);
    expect(factory).not.toHaveBeenCalled();
  });

  it("creates the complete catalog and safe Portal with stable mutation identities", async () => {
    const first = new FakeBootstrapNetwork();
    first.pageSize = 2;
    const report = await runStripeBootstrap(options(first));

    expect(report).toMatchObject({
      ok: true,
      command: "bootstrap",
      mode: "test",
      verifyOnly: false,
      productLine: PRODUCT_LINE,
      planProducts: 3,
      recurringPrices: 6,
      creditPackProducts: 3,
      creditPackPrices: 3,
    });
    expect(first.products).toHaveLength(6);
    expect(
      first.prices.filter((price) => price["active"] === true),
    ).toHaveLength(9);
    expect(first.portals).toHaveLength(1);
    expect(first.portals[0]?.["features"]).toMatchObject({
      subscription_update: { enabled: false },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
    });
    expect(new Set(first.idempotencyKeys).size).toBe(16);
    expect(first.idempotencyKeys).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^stripe-entitlements:bootstrap:v1:[a-f0-9]{64}$/u,
        ),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain(TEST_KEY);

    const second = new FakeBootstrapNetwork();
    second.pageSize = 2;
    await runStripeBootstrap(options(second));
    expect(second.idempotencyKeys).toEqual(first.idempotencyKeys);
  });

  it("is mutation-free on rerun and in verify-only mode", async () => {
    const network = new FakeBootstrapNetwork();
    await runStripeBootstrap(options(network));
    network.resetEvidence();

    const rerun = await runStripeBootstrap(options(network));
    expect(rerun.mutations).toEqual([]);
    expect(network.mutationCalls).toEqual([]);
    network.resetEvidence();

    const verified = await runStripeBootstrap(
      options(network, { verifyOnly: true }),
    );
    expect(verified.verifyOnly).toBe(true);
    expect(verified.mutations).toEqual([]);
    expect(network.mutationCalls).toEqual([]);
  });

  it("repairs owned Product, Price, and Portal drift then verifies the final state", async () => {
    const network = new FakeBootstrapNetwork();
    await runStripeBootstrap(options(network));
    const product = network.products.find(
      (item) => (item["metadata"] as Remote)["plan"] === "starter",
    );
    const price = network.prices.find(
      (item) => item["lookup_key"] === "unit_starter_month",
    );
    const portal = network.portals[0];
    if (product === undefined || price === undefined || portal === undefined) {
      throw new Error("fake bootstrap seed failed");
    }
    product["name"] = "Drifted";
    price["unit_amount"] = 1;
    ((portal["features"] as Remote)["subscription_update"] as Remote)[
      "enabled"
    ] = true;
    network.resetEvidence();

    const report = await runStripeBootstrap(options(network));
    expect(report.mutations.map((item) => item.kind)).toEqual(
      expect.arrayContaining([
        "product.update",
        "price.create",
        "price.deactivate",
        "portal.update",
      ]),
    );
    expect(
      network.prices.filter(
        (item) =>
          item["active"] === true &&
          item["lookup_key"] === "unit_starter_month",
      ),
    ).toHaveLength(1);
  });

  it("never steals a lookup key owned by another Product", async () => {
    const network = new FakeBootstrapNetwork();
    await runStripeBootstrap(options(network));
    const price = network.prices.find(
      (item) => item["lookup_key"] === "unit_starter_month",
    );
    if (price === undefined) {
      throw new Error("fake bootstrap seed failed");
    }
    price["product"] = {
      id: "prod_foreign",
      object: "product",
      active: true,
      livemode: false,
      metadata: { product_line: "foreign", plan: "starter" },
    };
    network.resetEvidence();

    await expect(runStripeBootstrap(options(network))).rejects.toThrow(
      /belongs to a different Product/u,
    );
    expect(network.mutationCalls).not.toContain("price.create");
    expect(network.mutationCalls).not.toContain("price.deactivate");
  });

  it("walks every Product and Portal page before selecting owned objects", async () => {
    const network = new FakeBootstrapNetwork();
    await runStripeBootstrap(options(network));
    network.products.unshift({
      id: "prod_unrelated",
      object: "product",
      active: true,
      livemode: false,
      name: "Unrelated",
      description: "Unrelated",
      metadata: { product_line: "unrelated", plan: "starter" },
    });
    network.portals.unshift({
      id: "bpc_unrelated",
      object: "billing_portal.configuration",
      active: true,
      livemode: false,
      metadata: { product_line: "unrelated" },
      features: {},
    });
    network.pageSize = 1;
    network.resetEvidence();

    await runStripeBootstrap(options(network, { verifyOnly: true }));
    expect(network.productCursors.some((cursor) => cursor !== null)).toBe(true);
    expect(network.portalCursors.some((cursor) => cursor !== null)).toBe(true);
  });

  it("walks every Price page and rejects duplicate active lookup ownership", async () => {
    const network = new FakeBootstrapNetwork();
    await runStripeBootstrap(options(network));
    const price = network.prices.find(
      (item) => item["lookup_key"] === "unit_starter_month",
    );
    if (price === undefined) {
      throw new Error("fake bootstrap seed failed");
    }
    network.prices.push({ ...clone(price), id: "price_duplicate" });
    network.pageSize = 1;
    network.resetEvidence();

    await expect(
      runStripeBootstrap(options(network, { verifyOnly: true })),
    ).rejects.toThrow(/Price verification failed/u);
    expect(
      network.priceCursors.some(
        (item) =>
          item.lookupKey === "unit_starter_month" && item.cursor !== null,
      ),
    ).toBe(true);
  });

  it("fails closed on duplicate owned Portal configurations", async () => {
    const network = new FakeBootstrapNetwork();
    await runStripeBootstrap(options(network));
    const portal = network.portals[0];
    if (portal === undefined) {
      throw new Error("fake bootstrap seed failed");
    }
    network.portals.push({ ...clone(portal), id: "bpc_duplicate" });
    network.resetEvidence();

    await expect(runStripeBootstrap(options(network))).rejects.toThrow(
      /multiple active Portal configurations/u,
    );
    expect(network.mutationCalls).toEqual([]);
  });

  it("fails closed on missing, duplicate, and malformed paginated inventory", async () => {
    const missing = new FakeBootstrapNetwork();
    await expect(
      runStripeBootstrap(options(missing, { verifyOnly: true })),
    ).rejects.toThrow(/Product verification failed/u);

    const duplicate = new FakeBootstrapNetwork();
    await runStripeBootstrap(options(duplicate));
    const starter = duplicate.products.find(
      (item) => (item["metadata"] as Remote)["plan"] === "starter",
    );
    if (starter === undefined) {
      throw new Error("fake bootstrap seed failed");
    }
    duplicate.products.push({ ...clone(starter), id: "prod_duplicate" });
    await expect(runStripeBootstrap(options(duplicate))).rejects.toThrow(
      /multiple active Products/u,
    );

    const malformed = new FakeBootstrapNetwork();
    malformed.emptyContinuedProducts = true;
    await expect(runStripeBootstrap(options(malformed))).rejects.toThrow(
      /empty continued Product inventory page/u,
    );
  });

  it("requires both live acknowledgements and then reports live mode without a secret", async () => {
    const network = new FakeBootstrapNetwork(true);
    const report = await runStripeBootstrap(
      options(network, {
        secretKey: LIVE_KEY,
        allowLive: true,
        confirmedLiveProductLine: PRODUCT_LINE,
      }),
    );
    expect(report.mode).toBe("live");
    expect(JSON.stringify(report)).not.toContain(LIVE_KEY);
  });

  it("runs through the public Node CLI and emits only a secret-free JSON report", async () => {
    const network = new FakeBootstrapNetwork();
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await runNodeBillingCommand(
      parseNodeBillingCommand([
        "bootstrap",
        "--catalog",
        CATALOG,
        "--lookup-prefix",
        "unit",
        "--product-line",
        PRODUCT_LINE,
      ]),
      { STRIPE_SECRET_KEY: TEST_KEY },
      {
        out: (value) => output.push(value),
        error: (value) => errors.push(value),
      },
      { bootstrapNetworkFactory: () => network },
    );
    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] ?? "null")).toMatchObject({
      ok: true,
      command: "bootstrap",
      portalConfigurationId: "bpc_fake_1",
    });
    expect(output[0]).not.toContain(TEST_KEY);
  });

  it("sanitizes CLI guard failures and never invokes the network factory", async () => {
    const factory = vi.fn(() => new FakeBootstrapNetwork());
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await runNodeBillingCommand(
      parseNodeBillingCommand(["bootstrap"]),
      { STRIPE_SECRET_KEY: "sk_live_replace_me" },
      {
        out: (value) => output.push(value),
        error: (value) => errors.push(value),
      },
      { bootstrapNetworkFactory: factory },
    );
    expect(exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toEqual(['{"ok":false,"error":"TypeError"}']);
    expect(errors[0]).not.toContain("sk_live_replace_me");
    expect(factory).not.toHaveBeenCalled();
  });
});
