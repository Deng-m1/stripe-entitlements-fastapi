import {
  DemoBearerAuthAdapter,
  RejectAllAuthAdapter,
  type AuthAccountAdapter,
} from "./auth.js";
import { PlanCatalog } from "./catalog.js";
import { CheckoutCoordinator } from "./checkout.js";
import type { Settings } from "./config.js";
import { loadSettings, stripeTestMode } from "./config.js";
import { CreditPackCoordinator } from "./credit-pack-coordinator.js";
import { Database, databasePoolOptions } from "./database.js";
import { EntitlementService } from "./entitlements.js";
import { EventProcessor } from "./event-processor.js";
import { CreditPackReconciliationService } from "./pack-reconcile.js";
import { PlanChangeCoordinator } from "./plan-changes.js";
import { StripeGateway } from "./stripe-gateway.js";
import { SubscriptionEventProjector } from "./subscription-projector.js";

const DATABASE_KERNEL_OWNERS = new WeakSet<Database>();

export interface BillingServices {
  readonly processor: EventProcessor;
  readonly checkout: CheckoutCoordinator;
  readonly planChanges: PlanChangeCoordinator;
  readonly entitlements: EntitlementService;
  readonly creditPacks: CreditPackCoordinator;
  readonly creditPackReconciliation: CreditPackReconciliationService;
}

export interface BillingKernelOptions {
  readonly settings?: Settings;
  readonly environment?:
    | NodeJS.ProcessEnv
    | Readonly<Record<string, string | undefined>>;
  readonly database?: Database;
  readonly gateway?: StripeGateway;
  readonly auth?: AuthAccountAdapter;
  readonly catalog?: PlanCatalog;
}

export interface BillingKernelStartOptions {
  /** Explicit opt-in. Production deployments should normally run migrations separately. */
  readonly applyMigrations?: boolean;
}

function configuredOrigins(settings: Settings): readonly string[] {
  const origins = settings.frontendOrigins
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/u, ""))
    .filter((origin) => origin.length > 0);
  if (origins.includes("*") || new Set(origins).size !== origins.length) {
    throw new TypeError(
      "FRONTEND_ORIGINS must contain unique bare HTTP(S) origins",
    );
  }
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new TypeError(
        "FRONTEND_ORIGINS must contain unique bare HTTP(S) origins",
      );
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.origin !== origin
    ) {
      throw new TypeError(
        "FRONTEND_ORIGINS must contain unique bare HTTP(S) origins",
      );
    }
  }
  if (!stripeTestMode(settings)) {
    for (const value of [
      ...origins,
      settings.checkoutSuccessUrl,
      settings.checkoutCancelUrl,
      settings.portalReturnUrl,
    ]) {
      if (new URL(value).protocol !== "https:") {
        throw new TypeError(
          "live Stripe deployments require HTTPS public URLs",
        );
      }
    }
  }
  return Object.freeze(origins);
}

function defaultAuth(settings: Settings): AuthAccountAdapter {
  if (
    settings.appEnv === "development" &&
    stripeTestMode(settings) &&
    settings.demoBearerToken !== null
  ) {
    return new DemoBearerAuthAdapter(
      settings.demoBearerToken,
      settings.demoBearerSubject,
      settings.demoBearerEmail ?? undefined,
    );
  }
  return new RejectAllAuthAdapter();
}

function databaseConnected(database: Database): boolean {
  try {
    database.requirePool();
    return true;
  } catch {
    return false;
  }
}

/**
 * One lifespan-owned service graph shared by HTTP requests and bounded workers.
 *
 * Construction validates configuration but performs no network I/O. `start()` owns
 * only the database connection that it opens; `stop()` never closes an injected,
 * already-connected pool.
 */
export class BillingKernel {
  public readonly settings: Settings;
  public readonly database: Database;
  public readonly gateway: StripeGateway;
  public readonly auth: AuthAccountAdapter;
  public readonly catalog: PlanCatalog;
  public readonly origins: readonly string[];
  public readonly stripeTestMode: boolean;

  #services: BillingServices | undefined;
  #state: "idle" | "starting" | "running" | "stopping" = "idle";
  #connectedHere = false;

  private constructor(input: {
    readonly settings: Settings;
    readonly database: Database;
    readonly gateway: StripeGateway;
    readonly auth: AuthAccountAdapter;
    readonly catalog: PlanCatalog;
  }) {
    const configuredTestMode = stripeTestMode(input.settings);
    if (input.gateway.testMode !== configuredTestMode) {
      throw new TypeError(
        "settings and billing gateway Stripe modes do not match",
      );
    }
    if (input.gateway.apiVersion !== input.settings.stripeApiVersion) {
      throw new TypeError(
        "settings and billing gateway Stripe API versions do not match",
      );
    }
    if (input.gateway.productLine !== input.settings.productLine) {
      throw new TypeError(
        "settings and billing gateway product lines do not match",
      );
    }
    for (const [label, gatewayValue, settingsValue] of [
      [
        "Checkout success URLs",
        input.gateway.checkoutSuccessUrl,
        input.settings.checkoutSuccessUrl,
      ],
      [
        "Checkout cancel URLs",
        input.gateway.checkoutCancelUrl,
        input.settings.checkoutCancelUrl,
      ],
      [
        "Portal return URLs",
        input.gateway.portalReturnUrl,
        input.settings.portalReturnUrl,
      ],
    ] as const) {
      if (gatewayValue !== settingsValue) {
        throw new TypeError(
          `settings and billing gateway ${label} do not match`,
        );
      }
    }
    if (
      input.gateway.portalConfigurationId !==
      input.settings.stripePortalConfigurationId
    ) {
      throw new TypeError(
        "settings and billing gateway Portal configuration IDs do not match",
      );
    }
    const origins = configuredOrigins(input.settings);
    if (DATABASE_KERNEL_OWNERS.has(input.database)) {
      throw new Error(
        "this Database is already bound to another BillingKernel",
      );
    }
    DATABASE_KERNEL_OWNERS.add(input.database);
    this.settings = input.settings;
    this.database = input.database;
    this.gateway = input.gateway;
    this.auth = input.auth;
    this.catalog = input.catalog;
    this.origins = origins;
    this.stripeTestMode = configuredTestMode;
  }

  public static async create(
    options: BillingKernelOptions = {},
  ): Promise<BillingKernel> {
    const settings =
      options.settings ?? loadSettings(options.environment ?? process.env);
    const catalog =
      options.catalog ??
      (await PlanCatalog.fromToml(
        settings.planCatalogPath,
        settings.lookupPrefix,
      ));
    const database =
      options.database ??
      new Database(settings.databaseUrl, databasePoolOptions(settings));
    const gateway =
      options.gateway ??
      new StripeGateway(
        settings.stripeSecretKey,
        settings.stripeWebhookSecret,
        {
          productLine: settings.productLine,
          apiVersion: settings.stripeApiVersion,
          portalConfigurationId: settings.stripePortalConfigurationId,
          checkoutSuccessUrl: settings.checkoutSuccessUrl,
          checkoutCancelUrl: settings.checkoutCancelUrl,
          portalReturnUrl: settings.portalReturnUrl,
        },
      );
    return new BillingKernel({
      settings,
      database,
      gateway,
      auth: options.auth ?? defaultAuth(settings),
      catalog,
    });
  }

  public get running(): boolean {
    return this.#state === "running";
  }

  public requireServices(): BillingServices {
    if (this.#services === undefined || this.#state !== "running") {
      throw new Error(
        "billing services are available only while the kernel is running",
      );
    }
    return this.#services;
  }

  public async start(options: BillingKernelStartOptions = {}): Promise<void> {
    if (this.#state !== "idle") {
      throw new Error("billing kernel is already active");
    }
    this.#state = "starting";
    this.#connectedHere = !databaseConnected(this.database);
    try {
      if (this.#connectedHere) {
        await this.database.connect();
      }
      if (options.applyMigrations === true) {
        await this.database.applyMigrations();
      }
      const processor = new EventProcessor(
        this.database,
        this.catalog,
        this.settings.productLine,
        {
          expectedLivemode: !this.stripeTestMode,
          expectedApiVersion: this.settings.stripeWebhookApiVersion,
          projector: new SubscriptionEventProjector(),
        },
      );
      this.#services = Object.freeze({
        processor,
        checkout: new CheckoutCoordinator(this.database),
        planChanges: new PlanChangeCoordinator(
          this.database,
          this.catalog,
          this.gateway,
          { transitionPolicy: this.settings.billingTransitionPolicy },
        ),
        entitlements: new EntitlementService(this.database, this.catalog),
        creditPacks: new CreditPackCoordinator(this.database, this.catalog),
        creditPackReconciliation: new CreditPackReconciliationService(
          this.database,
          processor,
          this.gateway,
        ),
      });
      this.#state = "running";
    } catch (error) {
      this.#services = undefined;
      if (this.#connectedHere) {
        await this.database.close().catch(() => undefined);
      }
      this.#connectedHere = false;
      this.#state = "idle";
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.#state === "idle") {
      return;
    }
    if (this.#state !== "running") {
      throw new Error(
        "billing kernel lifecycle transition is already in progress",
      );
    }
    this.#state = "stopping";
    this.#services = undefined;
    try {
      if (this.#connectedHere) {
        await this.database.close();
      }
    } finally {
      this.#connectedHere = false;
      this.#state = "idle";
    }
  }
}
