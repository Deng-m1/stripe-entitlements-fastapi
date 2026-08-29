import { createHash } from "node:crypto";

import Stripe from "stripe";

import type { CreditPack, Plan } from "./catalog.js";
import { PlanCatalog } from "./catalog.js";
import { portalConfigurationIsSafe } from "./portal-policy.js";
import {
  catalogOneTimePriceMatches,
  catalogPriceMatches,
} from "./price-policy.js";
import { defaultPlanCatalogPath } from "./resources.js";
import type { BillingInterval } from "./types.js";
import { isPlainRecord } from "./validation.js";

const DEFAULT_STRIPE_API_VERSION = "2026-06-24.dahlia";
const VERSION = /^\d{4}-\d{2}-\d{2}\.[a-z][a-z0-9_]*$/u;
const PRODUCT_LINE = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const SECRET_KEY = /^sk_(test|live)_[A-Za-z0-9]{8,}$/u;
const PLACEHOLDER_MARKERS = [
  "replace_me",
  "replaceme",
  "replace-with",
  "replace_with",
  "changeme",
  "change_me",
  "dummy",
  "your_key",
  "your_secret",
] as const;

export interface StripeBootstrapPage {
  readonly data: readonly unknown[];
  readonly hasMore: boolean;
}

export interface BootstrapProductParams {
  readonly name: string;
  readonly description: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface BootstrapPriceParams {
  readonly product: string;
  readonly currency: string;
  readonly unitAmount: number;
  readonly lookupKey: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly interval: BillingInterval | null;
}

export interface BootstrapPortalParams {
  readonly businessProfile: {
    readonly headline: string;
  };
  readonly features: {
    readonly customerUpdate: {
      readonly enabled: true;
      readonly allowedUpdates: readonly ["email"];
    };
    readonly invoiceHistory: { readonly enabled: true };
    readonly paymentMethodUpdate: { readonly enabled: true };
    readonly subscriptionCancel: {
      readonly enabled: true;
      readonly mode: "at_period_end";
    };
    readonly subscriptionUpdate: { readonly enabled: false };
  };
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * Transaction-free, narrow Stripe operator surface. Implementations must not receive a
 * database connection: bootstrap inventory and mutations are remote operator work only.
 */
export interface StripeBootstrapNetwork {
  listActiveProducts(
    startingAfter: string | null,
  ): Promise<StripeBootstrapPage>;
  createProduct(
    params: BootstrapProductParams,
    idempotencyKey: string,
  ): Promise<unknown>;
  updateProduct(
    productId: string,
    params: BootstrapProductParams,
    idempotencyKey: string,
  ): Promise<unknown>;
  listActivePricesForLookup(
    lookupKey: string,
    startingAfter: string | null,
  ): Promise<StripeBootstrapPage>;
  createPrice(
    params: BootstrapPriceParams,
    idempotencyKey: string,
  ): Promise<unknown>;
  deactivatePrice(priceId: string, idempotencyKey: string): Promise<unknown>;
  listActivePortalConfigurations(
    startingAfter: string | null,
  ): Promise<StripeBootstrapPage>;
  retrievePortalConfiguration(configurationId: string): Promise<unknown>;
  createPortalConfiguration(
    params: BootstrapPortalParams,
    idempotencyKey: string,
  ): Promise<unknown>;
  updatePortalConfiguration(
    configurationId: string,
    params: BootstrapPortalParams,
    idempotencyKey: string,
  ): Promise<unknown>;
}

export type StripeBootstrapNetworkFactory = (
  secretKey: string,
  apiVersion: string,
) => StripeBootstrapNetwork;

export interface RunStripeBootstrapOptions {
  readonly secretKey: string | undefined;
  readonly apiVersion?: string | undefined;
  readonly catalogPath?: string | undefined;
  readonly lookupPrefix?: string | undefined;
  readonly productLine?: string | undefined;
  readonly verifyOnly?: boolean;
  readonly allowLive?: boolean;
  readonly confirmedLiveProductLine?: string | null;
  readonly networkFactory?: StripeBootstrapNetworkFactory | undefined;
}

export type StripeBootstrapMutationKind =
  | "product.create"
  | "product.update"
  | "price.create"
  | "price.deactivate"
  | "portal.create"
  | "portal.update";

export interface StripeBootstrapMutation {
  readonly kind: StripeBootstrapMutationKind;
  readonly logicalKey: string;
  readonly objectId: string;
}

export interface StripeBootstrapReport {
  readonly ok: true;
  readonly command: "bootstrap";
  readonly mode: "test" | "live";
  readonly verifyOnly: boolean;
  readonly productLine: string;
  readonly stripeApiVersion: string;
  readonly planProducts: number;
  readonly recurringPrices: number;
  readonly creditPackProducts: number;
  readonly creditPackPrices: number;
  readonly portalConfigurationId: string;
  readonly mutations: readonly StripeBootstrapMutation[];
}

function requestOptions(idempotencyKey: string): Stripe.RequestOptions {
  return { idempotencyKey };
}

class StripeSdkBootstrapNetwork implements StripeBootstrapNetwork {
  readonly #stripe: Stripe;

  public constructor(secretKey: string, apiVersion: string) {
    this.#stripe = new Stripe(secretKey, {
      apiVersion: apiVersion as Stripe.LatestApiVersion,
    });
  }

  public async listActiveProducts(
    startingAfter: string | null,
  ): Promise<StripeBootstrapPage> {
    const page = await this.#stripe.products.list({
      active: true,
      limit: 100,
      ...(startingAfter === null ? {} : { starting_after: startingAfter }),
    });
    return { data: page.data, hasMore: page.has_more };
  }

  public async createProduct(
    params: BootstrapProductParams,
    idempotencyKey: string,
  ): Promise<unknown> {
    return this.#stripe.products.create(
      {
        name: params.name,
        description: params.description,
        metadata: { ...params.metadata },
      },
      requestOptions(idempotencyKey),
    );
  }

  public async updateProduct(
    productId: string,
    params: BootstrapProductParams,
    idempotencyKey: string,
  ): Promise<unknown> {
    return this.#stripe.products.update(
      productId,
      {
        name: params.name,
        description: params.description,
        metadata: { ...params.metadata },
      },
      requestOptions(idempotencyKey),
    );
  }

  public async listActivePricesForLookup(
    lookupKey: string,
    startingAfter: string | null,
  ): Promise<StripeBootstrapPage> {
    const page = await this.#stripe.prices.list({
      lookup_keys: [lookupKey],
      active: true,
      limit: 100,
      expand: ["data.currency_options", "data.product"],
      ...(startingAfter === null ? {} : { starting_after: startingAfter }),
    });
    return { data: page.data, hasMore: page.has_more };
  }

  public async createPrice(
    params: BootstrapPriceParams,
    idempotencyKey: string,
  ): Promise<unknown> {
    const recurring =
      params.interval === null
        ? {}
        : {
            recurring: {
              interval: params.interval,
              interval_count: 1,
              usage_type: "licensed" as const,
            },
          };
    return this.#stripe.prices.create(
      {
        product: params.product,
        currency: params.currency,
        unit_amount: params.unitAmount,
        lookup_key: params.lookupKey,
        transfer_lookup_key: true,
        metadata: { ...params.metadata },
        expand: ["currency_options", "product"],
        ...recurring,
      },
      requestOptions(idempotencyKey),
    );
  }

  public async deactivatePrice(
    priceId: string,
    idempotencyKey: string,
  ): Promise<unknown> {
    return this.#stripe.prices.update(
      priceId,
      { active: false },
      requestOptions(idempotencyKey),
    );
  }

  public async listActivePortalConfigurations(
    startingAfter: string | null,
  ): Promise<StripeBootstrapPage> {
    const page = await this.#stripe.billingPortal.configurations.list({
      active: true,
      limit: 100,
      ...(startingAfter === null ? {} : { starting_after: startingAfter }),
    });
    return { data: page.data, hasMore: page.has_more };
  }

  public async retrievePortalConfiguration(
    configurationId: string,
  ): Promise<unknown> {
    return this.#stripe.billingPortal.configurations.retrieve(configurationId);
  }

  public async createPortalConfiguration(
    params: BootstrapPortalParams,
    idempotencyKey: string,
  ): Promise<unknown> {
    return this.#stripe.billingPortal.configurations.create(
      portalCreateParams(params),
      requestOptions(idempotencyKey),
    );
  }

  public async updatePortalConfiguration(
    configurationId: string,
    params: BootstrapPortalParams,
    idempotencyKey: string,
  ): Promise<unknown> {
    return this.#stripe.billingPortal.configurations.update(
      configurationId,
      portalUpdateParams(params),
      requestOptions(idempotencyKey),
    );
  }
}

function portalCreateParams(
  params: BootstrapPortalParams,
): Stripe.BillingPortal.ConfigurationCreateParams {
  return {
    business_profile: { headline: params.businessProfile.headline },
    features: {
      customer_update: {
        enabled: true,
        allowed_updates: [...params.features.customerUpdate.allowedUpdates],
      },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: { enabled: false },
    },
    metadata: { ...params.metadata },
  };
}

function portalUpdateParams(
  params: BootstrapPortalParams,
): Stripe.BillingPortal.ConfigurationUpdateParams {
  return portalCreateParams(params);
}

function defaultNetworkFactory(
  secretKey: string,
  apiVersion: string,
): StripeBootstrapNetwork {
  return new StripeSdkBootstrapNetwork(secretKey, apiVersion);
}

function plainStripeObject(
  value: unknown,
  description: string,
): Readonly<Record<string, unknown>> {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`Stripe returned an invalid ${description}`);
  }
  if (serialized === undefined) {
    throw new Error(`Stripe returned an invalid ${description}`);
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!isPlainRecord(parsed)) {
    throw new Error(`Stripe returned an invalid ${description}`);
  }
  return parsed;
}

function requiredStripeId(
  value: unknown,
  prefix: "prod_" | "price_" | "bpc_",
  description: string,
): string {
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    value.length > 255 ||
    /\s/u.test(value)
  ) {
    throw new Error(`Stripe returned an invalid ${description} id`);
  }
  return value;
}

async function collectAllPages(
  loader: (startingAfter: string | null) => Promise<StripeBootstrapPage>,
  prefix: "prod_" | "price_" | "bpc_",
  description: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const result: Readonly<Record<string, unknown>>[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const page = await loader(cursor);
    if (!Array.isArray(page.data) || typeof page.hasMore !== "boolean") {
      throw new Error(`Stripe returned an invalid ${description} page`);
    }
    for (const raw of page.data) {
      const item = plainStripeObject(raw, description);
      const id = requiredStripeId(item["id"], prefix, description);
      if (seen.has(id)) {
        throw new Error(`Stripe repeated a ${description} across pages`);
      }
      seen.add(id);
      result.push(item);
    }
    if (!page.hasMore) {
      return result;
    }
    const last = result.at(-1);
    if (page.data.length === 0 || last === undefined) {
      throw new Error(`Stripe returned an empty continued ${description} page`);
    }
    const next = requiredStripeId(last["id"], prefix, description);
    if (next === cursor) {
      throw new Error(`Stripe returned a non-advancing ${description} cursor`);
    }
    cursor = next;
  }
}

function metadata(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
  const result = value["metadata"];
  return isPlainRecord(result) ? result : null;
}

function objectId(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (isPlainRecord(value) && typeof value["id"] === "string") {
    return value["id"];
  }
  return null;
}

function planProductParams(
  productLine: string,
  plan: Plan,
): BootstrapProductParams {
  return {
    name: `Example Entitlements ${plan.name}`,
    description: `Reference catalog plan: ${plan.monthlyCredits.toString()} credits per month`,
    metadata: { product_line: productLine, plan: plan.key },
  };
}

function packProductParams(
  productLine: string,
  pack: CreditPack,
): BootstrapProductParams {
  return {
    name: `Example Entitlements ${pack.name}`,
    description: `One-time reference credit pack: ${pack.credits.toString()} credits`,
    metadata: { product_line: productLine, credit_pack: pack.key },
  };
}

function productMatchesParams(
  product: Readonly<Record<string, unknown>>,
  params: BootstrapProductParams,
  expectedLive: boolean,
): boolean {
  const actualMetadata = metadata(product);
  return (
    product["object"] === "product" &&
    product["active"] === true &&
    product["livemode"] === expectedLive &&
    product["name"] === params.name &&
    product["description"] === params.description &&
    actualMetadata !== null &&
    Object.entries(params.metadata).every(
      ([key, value]) => actualMetadata[key] === value,
    ) &&
    (params.metadata["plan"] === undefined
      ? actualMetadata["plan"] === undefined
      : actualMetadata["credit_pack"] === undefined)
  );
}

function productCandidates(
  products: readonly Readonly<Record<string, unknown>>[],
  productLine: string,
  kind: "plan" | "credit_pack",
  key: string,
): readonly Readonly<Record<string, unknown>>[] {
  return products.filter((product) => {
    const values = metadata(product);
    return values?.["product_line"] === productLine && values[kind] === key;
  });
}

function idempotencyKey(
  mode: "test" | "live",
  productLine: string,
  operation: string,
  desired: unknown,
): string {
  const digest = createHash("sha256")
    .update(canonicalJson({ mode, productLine, operation, desired }))
    .digest("hex");
  return `stripe-entitlements:bootstrap:v1:${digest}`;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("idempotency input contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (!isPlainRecord(value)) {
    throw new TypeError("idempotency input must contain only JSON values");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function mutation(
  mutations: StripeBootstrapMutation[],
  kind: StripeBootstrapMutationKind,
  logicalKey: string,
  objectIdValue: string,
): void {
  mutations.push({ kind, logicalKey, objectId: objectIdValue });
}

async function ensureProduct(input: {
  readonly network: StripeBootstrapNetwork;
  readonly products: readonly Readonly<Record<string, unknown>>[];
  readonly productLine: string;
  readonly mode: "test" | "live";
  readonly kind: "plan" | "credit_pack";
  readonly logicalKey: string;
  readonly params: BootstrapProductParams;
  readonly mutations: StripeBootstrapMutation[];
}): Promise<void> {
  const candidates = productCandidates(
    input.products,
    input.productLine,
    input.kind,
    input.logicalKey,
  );
  if (candidates.length > 1) {
    throw new Error(
      `multiple active Products claim ${input.kind} ${input.logicalKey}`,
    );
  }
  const existing = candidates[0];
  const operation = `product:${input.kind}:${input.logicalKey}`;
  if (existing === undefined) {
    const created = plainStripeObject(
      await input.network.createProduct(
        input.params,
        idempotencyKey(input.mode, input.productLine, `${operation}:create`, {
          desired: input.params,
          observed: null,
        }),
      ),
      "Product",
    );
    const id = requiredStripeId(created["id"], "prod_", "Product");
    if (!productMatchesParams(created, input.params, input.mode === "live")) {
      throw new Error(`created Product drifted for ${input.logicalKey}`);
    }
    mutation(input.mutations, "product.create", input.logicalKey, id);
    return;
  }

  const id = requiredStripeId(existing["id"], "prod_", "Product");
  const existingMetadata = metadata(existing);
  const conflictingIdentity =
    input.kind === "plan"
      ? existingMetadata?.["credit_pack"]
      : existingMetadata?.["plan"];
  if (conflictingIdentity !== undefined) {
    throw new Error(`Product identity is ambiguous for ${input.logicalKey}`);
  }
  if (existing["livemode"] !== (input.mode === "live")) {
    throw new Error(`Product mode drifted for ${input.logicalKey}`);
  }
  if (productMatchesParams(existing, input.params, input.mode === "live")) {
    return;
  }
  const updated = plainStripeObject(
    await input.network.updateProduct(
      id,
      input.params,
      idempotencyKey(input.mode, input.productLine, `${operation}:update`, {
        desired: input.params,
        observed: existing,
      }),
    ),
    "Product",
  );
  if (
    requiredStripeId(updated["id"], "prod_", "Product") !== id ||
    !productMatchesParams(updated, input.params, input.mode === "live")
  ) {
    throw new Error(`updated Product drifted for ${input.logicalKey}`);
  }
  mutation(input.mutations, "product.update", input.logicalKey, id);
}

function priceParams(input: {
  readonly productId: string;
  readonly productLine: string;
  readonly lookupKey: string;
  readonly currency: string;
  readonly unitAmount: number;
  readonly interval: BillingInterval | null;
  readonly planKey?: string;
  readonly packKey?: string;
}): BootstrapPriceParams {
  const identity =
    input.planKey === undefined
      ? { credit_pack: input.packKey ?? "" }
      : { plan: input.planKey };
  return {
    product: input.productId,
    currency: input.currency,
    unitAmount: input.unitAmount,
    lookupKey: input.lookupKey,
    metadata: { product_line: input.productLine, ...identity },
    interval: input.interval,
  };
}

function priceMatches(
  price: Readonly<Record<string, unknown>>,
  params: BootstrapPriceParams,
  expectedLive: boolean,
): boolean {
  if (
    price["livemode"] !== expectedLive ||
    objectId(price["product"]) !== params.product
  ) {
    return false;
  }
  if (params.interval === null) {
    return catalogOneTimePriceMatches(price, {
      expectedCurrency: params.currency,
      expectedUnitAmount: params.unitAmount,
      expectedProductLine: params.metadata["product_line"] ?? "",
      expectedPackKey: params.metadata["credit_pack"] ?? "",
      expectedLookupKey: params.lookupKey,
    });
  }
  return catalogPriceMatches(price, {
    expectedCurrency: params.currency,
    expectedUnitAmount: params.unitAmount,
    expectedInterval: params.interval,
    expectedProductLine: params.metadata["product_line"] ?? "",
    expectedPlanKey: params.metadata["plan"] ?? "",
    expectedLookupKey: params.lookupKey,
  });
}

async function pricesForLookup(
  network: StripeBootstrapNetwork,
  lookupKey: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  return collectAllPages(
    (cursor) => network.listActivePricesForLookup(lookupKey, cursor),
    "price_",
    `Price inventory for ${lookupKey}`,
  );
}

async function ensurePrice(input: {
  readonly network: StripeBootstrapNetwork;
  readonly params: BootstrapPriceParams;
  readonly mode: "test" | "live";
  readonly productLine: string;
  readonly mutations: StripeBootstrapMutation[];
}): Promise<void> {
  const prices = await pricesForLookup(input.network, input.params.lookupKey);
  for (const price of prices) {
    if (price["livemode"] !== (input.mode === "live")) {
      throw new Error(`Price mode drifted for ${input.params.lookupKey}`);
    }
    if (objectId(price["product"]) !== input.params.product) {
      throw new Error(
        `lookup key ${input.params.lookupKey} belongs to a different Product`,
      );
    }
  }
  const matching = prices.filter((price) =>
    priceMatches(price, input.params, input.mode === "live"),
  );
  let retainedId: string;
  if (matching.length === 1) {
    retainedId = requiredStripeId(matching[0]?.["id"], "price_", "Price");
  } else {
    const created = plainStripeObject(
      await input.network.createPrice(
        input.params,
        idempotencyKey(
          input.mode,
          input.productLine,
          `price:${input.params.lookupKey}:create`,
          { desired: input.params, observed: prices },
        ),
      ),
      "Price",
    );
    retainedId = requiredStripeId(created["id"], "price_", "Price");
    mutation(
      input.mutations,
      "price.create",
      input.params.lookupKey,
      retainedId,
    );
  }

  for (const old of prices) {
    const oldId = requiredStripeId(old["id"], "price_", "Price");
    if (oldId === retainedId) {
      continue;
    }
    const deactivated = plainStripeObject(
      await input.network.deactivatePrice(
        oldId,
        idempotencyKey(
          input.mode,
          input.productLine,
          `price:${input.params.lookupKey}:deactivate:${oldId}`,
          { desired: { active: false }, observed: old },
        ),
      ),
      "Price",
    );
    if (
      requiredStripeId(deactivated["id"], "price_", "Price") !== oldId ||
      deactivated["active"] !== false
    ) {
      throw new Error(`Stripe did not deactivate stale Price ${oldId}`);
    }
    mutation(
      input.mutations,
      "price.deactivate",
      input.params.lookupKey,
      oldId,
    );
  }
}

function portalParams(productLine: string): BootstrapPortalParams {
  return {
    businessProfile: { headline: "Manage your example subscription" },
    features: {
      customerUpdate: { enabled: true, allowedUpdates: ["email"] },
      invoiceHistory: { enabled: true },
      paymentMethodUpdate: { enabled: true },
      subscriptionCancel: { enabled: true, mode: "at_period_end" },
      subscriptionUpdate: { enabled: false },
    },
    metadata: { product_line: productLine },
  };
}

async function matchingPortalConfigurations(
  network: StripeBootstrapNetwork,
  productLine: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const listed = await collectAllPages(
    (cursor) => network.listActivePortalConfigurations(cursor),
    "bpc_",
    "Portal configuration inventory",
  );
  const candidates = listed.filter(
    (configuration) =>
      metadata(configuration)?.["product_line"] === productLine,
  );
  const retrieved: Readonly<Record<string, unknown>>[] = [];
  for (const candidate of candidates) {
    const id = requiredStripeId(
      candidate["id"],
      "bpc_",
      "Portal configuration",
    );
    const full = plainStripeObject(
      await network.retrievePortalConfiguration(id),
      "Portal configuration",
    );
    if (requiredStripeId(full["id"], "bpc_", "Portal configuration") !== id) {
      throw new Error("Stripe retrieved a different Portal configuration");
    }
    retrieved.push(full);
  }
  return retrieved;
}

async function ensurePortal(input: {
  readonly network: StripeBootstrapNetwork;
  readonly productLine: string;
  readonly mode: "test" | "live";
  readonly mutations: StripeBootstrapMutation[];
}): Promise<void> {
  const candidates = await matchingPortalConfigurations(
    input.network,
    input.productLine,
  );
  if (candidates.length > 1) {
    throw new Error(
      "multiple active Portal configurations claim this product line",
    );
  }
  const params = portalParams(input.productLine);
  const existing = candidates[0];
  if (existing === undefined) {
    const created = plainStripeObject(
      await input.network.createPortalConfiguration(
        params,
        idempotencyKey(input.mode, input.productLine, "portal:create", {
          desired: params,
          observed: null,
        }),
      ),
      "Portal configuration",
    );
    const id = requiredStripeId(created["id"], "bpc_", "Portal configuration");
    if (
      !portalConfigurationIsSafe(created, {
        expectedLivemode: input.mode === "live",
        expectedProductLine: input.productLine,
      })
    ) {
      throw new Error(
        "created Portal configuration drifted from the safety policy",
      );
    }
    mutation(input.mutations, "portal.create", input.productLine, id);
    return;
  }
  const id = requiredStripeId(existing["id"], "bpc_", "Portal configuration");
  if (existing["livemode"] !== (input.mode === "live")) {
    throw new Error("Portal configuration mode drifted");
  }
  if (
    portalConfigurationIsSafe(existing, {
      expectedLivemode: input.mode === "live",
      expectedProductLine: input.productLine,
    })
  ) {
    return;
  }
  const updated = plainStripeObject(
    await input.network.updatePortalConfiguration(
      id,
      params,
      idempotencyKey(input.mode, input.productLine, `portal:update:${id}`, {
        desired: params,
        observed: existing,
      }),
    ),
    "Portal configuration",
  );
  if (
    requiredStripeId(updated["id"], "bpc_", "Portal configuration") !== id ||
    !portalConfigurationIsSafe(updated, {
      expectedLivemode: input.mode === "live",
      expectedProductLine: input.productLine,
    })
  ) {
    throw new Error(
      "updated Portal configuration drifted from the safety policy",
    );
  }
  mutation(input.mutations, "portal.update", input.productLine, id);
}

interface VerifiedCatalog {
  readonly portalConfigurationId: string;
}

async function verifyRemoteCatalog(input: {
  readonly network: StripeBootstrapNetwork;
  readonly catalog: PlanCatalog;
  readonly productLine: string;
  readonly mode: "test" | "live";
}): Promise<VerifiedCatalog> {
  const expectedLive = input.mode === "live";
  const products = await collectAllPages(
    (cursor) => input.network.listActiveProducts(cursor),
    "prod_",
    "Product inventory",
  );
  for (const plan of input.catalog.ordered()) {
    const params = planProductParams(input.productLine, plan);
    const candidates = productCandidates(
      products,
      input.productLine,
      "plan",
      plan.key,
    );
    if (
      candidates.length !== 1 ||
      candidates[0] === undefined ||
      !productMatchesParams(candidates[0], params, expectedLive)
    ) {
      throw new Error(`Product verification failed for plan ${plan.key}`);
    }
    const productId = requiredStripeId(candidates[0]["id"], "prod_", "Product");
    for (const interval of ["month", "year"] as const) {
      const lookupKey = input.catalog.lookupKey(plan.key, interval);
      const paramsForPrice = priceParams({
        productId,
        productLine: input.productLine,
        lookupKey,
        currency: plan.currency,
        unitAmount: (interval === "month" ? plan.monthUsd : plan.yearUsd) * 100,
        interval,
        planKey: plan.key,
      });
      const prices = await pricesForLookup(input.network, lookupKey);
      if (
        prices.length !== 1 ||
        prices[0] === undefined ||
        !priceMatches(prices[0], paramsForPrice, expectedLive)
      ) {
        throw new Error(`Price verification failed for ${lookupKey}`);
      }
    }
  }
  for (const pack of input.catalog.orderedCreditPacks()) {
    const params = packProductParams(input.productLine, pack);
    const candidates = productCandidates(
      products,
      input.productLine,
      "credit_pack",
      pack.key,
    );
    if (
      candidates.length !== 1 ||
      candidates[0] === undefined ||
      !productMatchesParams(candidates[0], params, expectedLive)
    ) {
      throw new Error(
        `Product verification failed for credit pack ${pack.key}`,
      );
    }
    const productId = requiredStripeId(candidates[0]["id"], "prod_", "Product");
    const lookupKey = input.catalog.creditPackLookupKey(pack.key);
    const paramsForPrice = priceParams({
      productId,
      productLine: input.productLine,
      lookupKey,
      currency: pack.currency,
      unitAmount: pack.priceUsd * 100,
      interval: null,
      packKey: pack.key,
    });
    const prices = await pricesForLookup(input.network, lookupKey);
    if (
      prices.length !== 1 ||
      prices[0] === undefined ||
      !priceMatches(prices[0], paramsForPrice, expectedLive)
    ) {
      throw new Error(`Price verification failed for ${lookupKey}`);
    }
  }

  const portals = await matchingPortalConfigurations(
    input.network,
    input.productLine,
  );
  if (
    portals.length !== 1 ||
    portals[0] === undefined ||
    !portalConfigurationIsSafe(portals[0], {
      expectedLivemode: expectedLive,
      expectedProductLine: input.productLine,
    })
  ) {
    throw new Error("Portal configuration verification failed");
  }
  return {
    portalConfigurationId: requiredStripeId(
      portals[0]["id"],
      "bpc_",
      "Portal configuration",
    ),
  };
}

async function reconcileRemoteCatalog(input: {
  readonly network: StripeBootstrapNetwork;
  readonly catalog: PlanCatalog;
  readonly productLine: string;
  readonly mode: "test" | "live";
  readonly mutations: StripeBootstrapMutation[];
}): Promise<void> {
  let products = await collectAllPages(
    (cursor) => input.network.listActiveProducts(cursor),
    "prod_",
    "Product inventory",
  );
  for (const plan of input.catalog.ordered()) {
    await ensureProduct({
      ...input,
      products,
      kind: "plan",
      logicalKey: plan.key,
      params: planProductParams(input.productLine, plan),
    });
  }
  for (const pack of input.catalog.orderedCreditPacks()) {
    await ensureProduct({
      ...input,
      products,
      kind: "credit_pack",
      logicalKey: pack.key,
      params: packProductParams(input.productLine, pack),
    });
  }

  // Refresh once after Product mutations so every Price is bound to the verified
  // canonical Product returned by Stripe, including an unknown-outcome replay.
  products = await collectAllPages(
    (cursor) => input.network.listActiveProducts(cursor),
    "prod_",
    "Product inventory",
  );
  for (const plan of input.catalog.ordered()) {
    const product = productCandidates(
      products,
      input.productLine,
      "plan",
      plan.key,
    )[0];
    if (product === undefined) {
      throw new Error(`Product disappeared for plan ${plan.key}`);
    }
    const productId = requiredStripeId(product["id"], "prod_", "Product");
    for (const interval of ["month", "year"] as const) {
      await ensurePrice({
        ...input,
        params: priceParams({
          productId,
          productLine: input.productLine,
          lookupKey: input.catalog.lookupKey(plan.key, interval),
          currency: plan.currency,
          unitAmount:
            (interval === "month" ? plan.monthUsd : plan.yearUsd) * 100,
          interval,
          planKey: plan.key,
        }),
      });
    }
  }
  for (const pack of input.catalog.orderedCreditPacks()) {
    const product = productCandidates(
      products,
      input.productLine,
      "credit_pack",
      pack.key,
    )[0];
    if (product === undefined) {
      throw new Error(`Product disappeared for credit pack ${pack.key}`);
    }
    const productId = requiredStripeId(product["id"], "prod_", "Product");
    await ensurePrice({
      ...input,
      params: priceParams({
        productId,
        productLine: input.productLine,
        lookupKey: input.catalog.creditPackLookupKey(pack.key),
        currency: pack.currency,
        unitAmount: pack.priceUsd * 100,
        interval: null,
        packKey: pack.key,
      }),
    });
  }
  await ensurePortal(input);
}

function stripeMode(secretKey: string | undefined): "test" | "live" {
  const normalized = secretKey?.toLowerCase() ?? "";
  if (
    secretKey === undefined ||
    !SECRET_KEY.test(secretKey) ||
    PLACEHOLDER_MARKERS.some((marker) => normalized.includes(marker))
  ) {
    throw new TypeError(
      "STRIPE_SECRET_KEY must be a non-placeholder sk_test_ or sk_live_ secret key",
    );
  }
  return secretKey.startsWith("sk_live_") ? "live" : "test";
}

/**
 * Create/repair or read-only verify the canonical Stripe catalog and safe Portal.
 * Every remote call occurs after mode/confirmation validation and outside PostgreSQL.
 */
export async function runStripeBootstrap(
  options: RunStripeBootstrapOptions,
): Promise<StripeBootstrapReport> {
  const secretKey = options.secretKey;
  const mode = stripeMode(secretKey);
  if (secretKey === undefined) {
    // `stripeMode` rejects this branch; retain an explicit narrowing boundary for TS.
    throw new TypeError("STRIPE_SECRET_KEY is required");
  }
  const productLine = options.productLine ?? "example-entitlements";
  if (!PRODUCT_LINE.test(productLine)) {
    throw new TypeError("PRODUCT_LINE must be a lowercase slug");
  }
  const allowLive = options.allowLive ?? false;
  const confirmation = options.confirmedLiveProductLine ?? null;
  if (mode === "live" && (!allowLive || confirmation !== productLine)) {
    throw new Error(
      "live Stripe bootstrap refused; pass --allow-live and confirm the exact product line",
    );
  }
  if (mode === "test" && (allowLive || confirmation !== null)) {
    throw new Error("live confirmation flags are invalid with a test-mode key");
  }
  const apiVersion = options.apiVersion ?? DEFAULT_STRIPE_API_VERSION;
  if (!VERSION.test(apiVersion)) {
    throw new TypeError(
      "STRIPE_API_VERSION must use YYYY-MM-DD.release format",
    );
  }
  const lookupPrefix = options.lookupPrefix ?? "ent";
  const catalog = await PlanCatalog.fromToml(
    options.catalogPath ?? defaultPlanCatalogPath(),
    lookupPrefix,
  );

  // The factory is intentionally invoked only after every key/mode/local-catalog
  // guard. Tests use this seam to prove rejected live or malformed keys make no client.
  const network = (options.networkFactory ?? defaultNetworkFactory)(
    secretKey,
    apiVersion,
  );
  const mutations: StripeBootstrapMutation[] = [];
  const verifyOnly = options.verifyOnly ?? false;
  if (!verifyOnly) {
    await reconcileRemoteCatalog({
      network,
      catalog,
      productLine,
      mode,
      mutations,
    });
  }
  const verified = await verifyRemoteCatalog({
    network,
    catalog,
    productLine,
    mode,
  });
  return Object.freeze({
    ok: true,
    command: "bootstrap",
    mode,
    verifyOnly,
    productLine,
    stripeApiVersion: apiVersion,
    planProducts: catalog.plans.size,
    recurringPrices: catalog.plans.size * 2,
    creditPackProducts: catalog.creditPacks.size,
    creditPackPrices: catalog.creditPacks.size,
    portalConfigurationId: verified.portalConfigurationId,
    mutations: Object.freeze([...mutations]),
  });
}
