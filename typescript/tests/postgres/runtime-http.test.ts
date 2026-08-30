import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AuthAccountAdapter } from "../../src/auth.js";
import { DefaultBillingHttpServices } from "../../src/billing-http-services.js";
import { PlanCatalog } from "../../src/catalog.js";
import { loadSettings } from "../../src/config.js";
import { Database } from "../../src/database.js";
import { createBillingFetchHandler } from "../../src/http/index.js";
import { BillingKernel } from "../../src/kernel.js";
import {
  buildCreditPackCheckoutRequestSnapshot,
  buildPlanChangeRequestSnapshot,
  buildSubscriptionCheckoutRequestSnapshot,
  type CheckoutRequestSnapshot,
} from "../../src/stripe-request-snapshots.js";
import { StripeGateway } from "../../src/stripe-gateway.js";
import type {
  CreateCheckoutSessionInput,
  CreateCreditPackCheckoutSessionInput,
  PlanChangeContext,
  RemotePlanChange,
} from "../../src/stripe-gateway.js";
import { postgresDatabase, postgresDsn } from "../support/postgres-setup.js";

const ROOT_CATALOG = fileURLToPath(
  new URL("../../../plans.toml", import.meta.url),
);
const CRON_SECRET = "runtime-http-cron-secret";

class RuntimeGateway extends StripeGateway {
  public checkoutInput: CreateCheckoutSessionInput | undefined;
  public packInput: CreateCreditPackCheckoutSessionInput | undefined;
  public readonly checkoutInputs: CreateCheckoutSessionInput[] = [];
  public readonly packInputs: CreateCreditPackCheckoutSessionInput[] = [];
  public readonly checkoutSnapshots: CheckoutRequestSnapshot[] = [];
  public readonly packSnapshots: CheckoutRequestSnapshot[] = [];
  public failNextCheckout = false;
  public failNextPackCheckout = false;
  public webhookBytes: Buffer | undefined;
  public planChangeVerifyCalls = 0;
  public planChangeExecuteCalls = 0;
  public portalCalls = 0;

  public constructor(
    secretKey = "sk_test_runtime",
    apiVersion = "2026-06-24.dahlia",
    overrides: {
      readonly productLine?: string;
      readonly portalConfigurationId?: string | null;
      readonly checkoutSuccessUrl?: string;
      readonly checkoutCancelUrl?: string;
      readonly portalReturnUrl?: string;
    } = {},
  ) {
    super(secretKey, "whsec_runtime", {
      // No inherited test method reaches this seam.
      client: {} as ConstructorParameters<typeof StripeGateway>[2] extends {
        readonly client?: infer Client;
      }
        ? Client
        : never,
      productLine: overrides.productLine ?? "example-entitlements",
      apiVersion,
      portalConfigurationId:
        overrides.portalConfigurationId === undefined
          ? "bpc_runtime"
          : overrides.portalConfigurationId,
      checkoutSuccessUrl:
        overrides.checkoutSuccessUrl ?? "https://app.example/billing/success",
      checkoutCancelUrl:
        overrides.checkoutCancelUrl ?? "https://app.example/pricing",
      portalReturnUrl:
        overrides.portalReturnUrl ?? "https://app.example/account",
    });
  }

  public override prepareCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<CheckoutRequestSnapshot> {
    this.checkoutInput = input;
    this.checkoutInputs.push(input);
    return Promise.resolve(
      buildSubscriptionCheckoutRequestSnapshot({
        accountId: input.accountId,
        claimToken: input.claimToken,
        ...(input.customerId === undefined
          ? {}
          : { customerId: input.customerId }),
        priceId: "price_runtime_subscription",
        lookupKey: input.lookupKey,
        currency: input.expectedCurrency,
        unitAmount: input.expectedUnitAmount,
        interval: input.expectedInterval,
        planKey: input.planKey,
        productLine: this.productLine,
        successUrl: `https://app.example/billing/success?expected_plan=${input.planKey}&expected_interval=${input.interval}&checkout_session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: "https://app.example/pricing",
        expiresAt: input.expiresAtEpoch,
        requestApiVersion: this.apiVersion,
      }),
    );
  }

  public override prepareCreditPackCheckoutSession(
    input: CreateCreditPackCheckoutSessionInput,
  ): Promise<CheckoutRequestSnapshot> {
    this.packInput = input;
    this.packInputs.push(input);
    return Promise.resolve(
      buildCreditPackCheckoutRequestSnapshot({
        orderId: input.orderId,
        accountId: input.accountId,
        ...(input.customerId === undefined
          ? {}
          : { customerId: input.customerId }),
        priceId: "price_runtime_pack",
        lookupKey: input.lookupKey,
        currency: input.expectedCurrency,
        unitAmount: input.expectedUnitAmount,
        packKey: input.packKey,
        packCredits: input.packCredits,
        expiresDays: input.expiresDays,
        productLine: this.productLine,
        successUrl: `https://app.example/billing/success?expected_credit_pack=${input.packKey}&checkout_session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: "https://app.example/pricing",
        expiresAt: input.expiresAtEpoch,
        requestApiVersion: this.apiVersion,
      }),
    );
  }

  public override createCheckoutSessionFromSnapshot(
    snapshot: unknown,
  ): Promise<readonly [string, string]> {
    const prepared = snapshot as CheckoutRequestSnapshot;
    if (prepared.kind === "subscription") {
      this.checkoutSnapshots.push(prepared);
      if (this.failNextCheckout) {
        this.failNextCheckout = false;
        return Promise.reject(new Error("simulated unknown Stripe outcome"));
      }
      const suffix =
        this.checkoutSnapshots.length === 1
          ? ""
          : `_${String(this.checkoutSnapshots.length)}`;
      return Promise.resolve([
        `cs_test_runtime_subscription${suffix}`,
        "https://checkout.stripe.test/subscription",
      ]);
    }
    this.packSnapshots.push(prepared);
    if (this.failNextPackCheckout) {
      this.failNextPackCheckout = false;
      return Promise.reject(new Error("simulated unknown Stripe outcome"));
    }
    const suffix =
      this.packSnapshots.length === 1
        ? ""
        : `_${String(this.packSnapshots.length)}`;
    return Promise.resolve([
      `cs_test_runtime_pack${suffix}`,
      "https://checkout.stripe.test/pack",
    ]);
  }

  public override createPortalSession(): Promise<readonly [string, string]> {
    this.portalCalls += 1;
    return Promise.resolve([
      "bps_test_runtime",
      "https://billing.stripe.test/portal",
    ]);
  }

  public override verifyPlanChangeRequestSnapshot(
    _snapshot: unknown,
  ): Promise<PlanChangeContext> {
    this.planChangeVerifyCalls += 1;
    return Promise.reject(
      new Error("malformed snapshot crossed the Stripe verification boundary"),
    );
  }

  public override executePlanChangeRequestSnapshot(
    _snapshot: unknown,
  ): Promise<RemotePlanChange> {
    this.planChangeExecuteCalls += 1;
    return Promise.reject(
      new Error("malformed snapshot crossed the Stripe mutation boundary"),
    );
  }

  public override constructEvent(
    payload: Buffer | string,
    _signature: string,
  ): Record<string, unknown> {
    this.webhookBytes = Buffer.from(payload);
    return {
      id: "evt_runtime_unknown",
      object: "event",
      type: "runtime.contract.checked",
      created: 1_788_000_000,
      livemode: false,
      api_version: "2026-06-24.dahlia",
      data: { object: { id: "obj_runtime" } },
    };
  }

  public override prepareEvent(
    event: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    return Promise.resolve({ ...event });
  }
}

function settings(secretKey = "sk_test_runtime") {
  return loadSettings({
    DATABASE_URL: "postgresql://runtime.invalid/runtime",
    STRIPE_SECRET_KEY: secretKey,
    STRIPE_WEBHOOK_SECRET: "whsec_runtime",
    STRIPE_WEBHOOK_API_VERSION: "2026-06-24.dahlia",
    STRIPE_PORTAL_CONFIGURATION_ID: "bpc_runtime",
    PLAN_CATALOG_PATH: ROOT_CATALOG,
    APP_ENV: "test",
    FRONTEND_ORIGINS: "https://app.example",
    CHECKOUT_SUCCESS_URL: "https://app.example/billing/success",
    CHECKOUT_CANCEL_URL: "https://app.example/pricing",
    PORTAL_RETURN_URL: "https://app.example/account",
  });
}

let authenticatedEmail = "runtime@example.test";
let authenticatedExternalRef = "v1:user:11111111-1111-4111-8111-111111111111";

const auth: AuthAccountAdapter = {
  authenticate: (_request) =>
    Promise.resolve({
      externalRef: authenticatedExternalRef,
      email: authenticatedEmail,
    }),
};

describe("connected TypeScript billing runtime", () => {
  let kernel: BillingKernel;
  let gateway: RuntimeGateway;
  let handler: ReturnType<typeof createBillingFetchHandler>;

  beforeEach(async () => {
    authenticatedEmail = "runtime@example.test";
    authenticatedExternalRef = "v1:user:11111111-1111-4111-8111-111111111111";
    gateway = new RuntimeGateway();
    kernel = await BillingKernel.create({
      settings: settings(),
      database: new Database(postgresDsn()),
      gateway,
      auth,
      catalog: await PlanCatalog.fromToml(ROOT_CATALOG),
    });
    await kernel.start();
    handler = createBillingFetchHandler({
      services: new DefaultBillingHttpServices(kernel),
      auth: kernel.auth,
      allowedOrigins: kernel.origins,
      cronSecret: CRON_SECRET,
    });
  });

  afterEach(async () => {
    await kernel.stop();
  });

  function authenticated(path: string): Request {
    return new Request(`https://billing.example${path}`, {
      headers: { Authorization: "Bearer verified" },
    });
  }

  function mutation(
    path: string,
    body: Record<string, unknown>,
    key = "runtime-request",
  ): Request {
    return new Request(`https://billing.example${path}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer verified",
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        Origin: "https://app.example",
      },
      body: JSON.stringify(body),
    });
  }

  function modeGuardedMutation(
    path: string,
    body: Record<string, unknown>,
    requirement: string,
  ): Request {
    return new Request(`https://billing.example${path}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer verified",
        "Content-Type": "application/json",
        "Idempotency-Key": "runtime-mode-guard",
        Origin: "https://app.example",
        "X-Stripe-Mode-Requirement": requirement,
      },
      body: JSON.stringify(body),
    });
  }

  function stripeMutationCases(): ReadonlyArray<
    readonly [string, Record<string, unknown>]
  > {
    return [
      [
        "/api/checkout",
        {
          plan_key: "starter",
          interval: "month",
          success_url:
            "https://app.example/billing/success?expected_plan=starter&expected_interval=month",
          cancel_url: "https://app.example/pricing",
        },
      ],
      [
        "/api/credit-packs/checkout",
        {
          pack_key: "boost-100",
          success_url:
            "https://app.example/billing/success?expected_credit_pack=boost-100",
          cancel_url: "https://app.example/pricing",
        },
      ],
      ["/api/billing/portal", { return_url: "https://app.example/account" }],
      ["/api/billing/change/preview", { plan_key: "pro", interval: "month" }],
      [
        "/api/billing/change/confirm",
        { preview_id: "33333333-3333-4333-8333-333333333333" },
      ],
    ];
  }

  test("serves health, catalog, account and bounded scheduler routes", async () => {
    const health = await handler(new Request("https://billing.example/health"));
    const catalog = await handler(authenticated("/api/catalog"));
    const account = await handler(authenticated("/api/account"));
    const annual = await handler(
      new Request("https://billing.example/api/cron/annual-grants", {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      }),
    );
    const reconcile = await handler(
      new Request("https://billing.example/api/cron/reconcile", {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      }),
    );

    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      database: true,
      schema: true,
      stripe_mode: "test",
    });
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({
      transition_policy: "full_period_reset",
    });
    const accountBody = (await account.json()) as Record<string, unknown>;
    expect(account.status).toBe(200);
    expect(accountBody["plan_key"]).toBe("free");
    expect(accountBody["credits"]).toMatchObject({
      balance: "0",
      balance_atoms: "0",
      purchased_balance_atoms: "0",
      scale: 1_000_000,
    });
    expect(await annual.json()).toMatchObject({ ok: true, attempted: 0 });
    expect(await reconcile.json()).toMatchObject({
      ok: true,
      accounts_attempted: 0,
      packs_attempted: 0,
    });
  });

  test("serializes account timestamps as RFC 3339 without losing microseconds", async () => {
    const account = await postgresDatabase().accountForExternalRef(
      authenticatedExternalRef,
    );
    const orderId = randomUUID();
    const lotId = randomUUID();
    const previewId = randomUUID();
    await postgresDatabase().query(
      `update billing_accounts set
         plan_key='starter',plan_interval='month',subscription_status='active',
         current_period_end='2030-08-30 12:34:56.123456+00'::timestamptz,
         entitlement_period_end='2030-08-30 12:34:56.123456+00'::timestamptz,
         credit_expires_at='2030-08-30 12:34:56.123456+00'::timestamptz,
         cancel_at_period_end=true,
         pending_free_at='2030-08-30 12:34:56.123456+00'::timestamptz,
         credits_balance=300000000
       where id=$1::uuid`,
      [account.id],
    );

    await postgresDatabase().query(
      `insert into credit_pack_orders(
         id,account_id,client_idempotency_key,stripe_request_key,pack_key,
         pack_credits,price_amount,currency,expires_days,price_lookup_key,
         checkout_status,payment_status,stripe_checkout_session_id,
         stripe_payment_intent_id,stripe_charge_id,stripe_customer_id,
         claim_expires_at,amount_paid,paid_at)
       values(
         $1::uuid,$2::uuid,'timestamp-pack','timestamp-pack-request','boost-100',
         100000000,1500,'usd',365,'ent_pack_boost_100',
         'completed','paid','cs_timestamp_pack','pi_timestamp_pack',
         'ch_timestamp_pack','cus_timestamp_pack',
         '2030-08-30 12:34:56.123456+00'::timestamptz,1500,
         '2029-08-30 12:34:56.123456+00'::timestamptz)`,
      [orderId, account.id],
    );
    await postgresDatabase().query(
      `insert into credit_funding_lots(
         id,order_id,account_id,original_credits,remaining_credits,expires_at)
       values(
         $1::uuid,$2::uuid,$3::uuid,100000000,100000000,
         '2030-08-30 12:34:56.123456+00'::timestamptz)`,
      [lotId, orderId, account.id],
    );
    await postgresDatabase().query(
      `insert into billing_plan_changes(
         id,account_id,idempotency_key,stripe_subscription_id,
         from_plan_key,from_interval,target_plan_key,target_interval,
         effective_mode,status,effective_at,stripe_request_key,
         expected_grant_epoch,expected_subscription_status,
         expected_cancel_at_period_end,transition_policy)
       values(
         $1::uuid,$2::uuid,'timestamp-preview','sub_timestamp_preview',
         'starter','month','pro','month','period_end','scheduled',
         '2030-08-30 12:34:56.123456+00'::timestamptz,
         'timestamp-preview-request',0,'active',false,'full_period_reset')`,
      [previewId, account.id],
    );

    const response = await handler(authenticated("/api/account"));
    const payload = (await response.json()) as {
      readonly current_period_end: string;
      readonly observed_period_end: string;
      readonly credits: {
        readonly next_grant_at: string;
        readonly credit_packs: readonly [{ readonly expires_at: string }];
      };
      readonly pending_change: { readonly effective_at: string };
      readonly pending_cancellation: { readonly effective_at: string };
    };

    expect(response.status).toBe(200);
    expect(payload.current_period_end).toBe("2030-08-30T12:34:56.123456+00:00");
    expect(payload.observed_period_end).toBe(payload.current_period_end);
    expect(payload.credits.next_grant_at).toBe(payload.current_period_end);
    expect(payload.credits.credit_packs[0]?.expires_at).toBe(
      payload.current_period_end,
    );
    expect(payload.pending_change.effective_at).toBe(
      payload.current_period_end,
    );
    expect(payload.pending_cancellation.effective_at).toBe(
      payload.current_period_end,
    );
  });

  test("rejects an invalid mode assertion on every Stripe-touching browser write before I/O", async () => {
    for (const [path, body] of stripeMutationCases()) {
      const response = await handler(modeGuardedMutation(path, body, "live"));
      expect(response.status, path).toBe(400);
      expect(await response.json(), path).toEqual({
        detail: "X-Stripe-Mode-Requirement must be test when supplied",
      });
    }
    expect(gateway.checkoutInputs).toHaveLength(0);
    expect(gateway.packInputs).toHaveLength(0);
    expect(gateway.portalCalls).toBe(0);
    expect(gateway.planChangeVerifyCalls).toBe(0);
    expect(gateway.planChangeExecuteCalls).toBe(0);
  });

  test("refuses every test-required browser write when the kernel is live", async () => {
    const liveGateway = new RuntimeGateway("sk_live_runtime");
    const liveKernel = await BillingKernel.create({
      settings: settings("sk_live_runtime"),
      database: new Database(postgresDsn()),
      gateway: liveGateway,
      auth,
      catalog: await PlanCatalog.fromToml(ROOT_CATALOG),
    });
    await liveKernel.start();
    const liveHandler = createBillingFetchHandler({
      services: new DefaultBillingHttpServices(liveKernel),
      auth: liveKernel.auth,
      allowedOrigins: liveKernel.origins,
      cronSecret: CRON_SECRET,
    });
    try {
      for (const [path, body] of stripeMutationCases()) {
        const response = await liveHandler(
          modeGuardedMutation(path, body, "test"),
        );
        expect(response.status, path).toBe(409);
        expect(await response.json(), path).toEqual({
          detail: "billing backend is not in the required Stripe test mode",
        });
      }
      expect(liveGateway.checkoutInputs).toHaveLength(0);
      expect(liveGateway.packInputs).toHaveLength(0);
      expect(liveGateway.portalCalls).toBe(0);
      expect(liveGateway.planChangeVerifyCalls).toBe(0);
      expect(liveGateway.planChangeExecuteCalls).toBe(0);
    } finally {
      await liveKernel.stop();
    }
  });

  test("creates and replays subscription Checkout through the durable claim", async () => {
    const body = {
      plan_key: "starter",
      interval: "month",
      success_url:
        "https://app.example/billing/success?expected_plan=starter&expected_interval=month",
      cancel_url: "https://app.example/pricing",
    };
    const first = await handler(mutation("/api/checkout", body));
    const replay = await handler(mutation("/api/checkout", body));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await first.json()).toEqual({
      url: "https://checkout.stripe.test/subscription",
    });
    expect(await replay.json()).toEqual({
      url: "https://checkout.stripe.test/subscription",
    });
    expect(gateway.checkoutInput?.customerEmail).toBeUndefined();
    const claims = await postgresDatabase().query<{ readonly count: string }>(
      "select count(*) from checkout_claims",
    );
    expect(claims.rows[0]?.count).toBe("1");
  });

  test("retries a frozen subscription after email, URL, and catalog drift while new keys fail", async () => {
    const body = {
      plan_key: "starter",
      interval: "month",
      success_url:
        "https://app.example/billing/success?expected_plan=starter&expected_interval=month",
      cancel_url: "https://app.example/pricing",
    };
    gateway.failNextCheckout = true;
    const first = await handler(
      mutation("/api/checkout", body, "runtime-unknown-subscription"),
    );
    const before = await postgresDatabase().query<{
      readonly claim_token: string;
    }>("select claim_token::text from checkout_claims");

    authenticatedEmail = "changed-after-timeout@example.test";
    (kernel.catalog.plans as Map<string, unknown>).delete("starter");
    const driftedBody = {
      ...body,
      success_url: "https://retired.example.test/old-success",
      cancel_url: "https://retired.example.test/old-pricing",
    };
    const retry = await handler(
      mutation("/api/checkout", driftedBody, "runtime-unknown-subscription"),
    );
    const newKey = await handler(
      mutation("/api/checkout", driftedBody, "runtime-new-subscription"),
    );
    const after = await postgresDatabase().query<{
      readonly claim_token: string;
      readonly count: string;
    }>(
      `select min(claim_token::text) as claim_token,count(*)::text as count
         from checkout_claims`,
    );

    expect(first.status).toBe(502);
    expect(retry.status).toBe(200);
    expect(newKey.status).toBe(400);
    expect(gateway.checkoutInputs).toHaveLength(1);
    expect(gateway.checkoutInput?.customerEmail).toBeUndefined();
    expect(gateway.checkoutSnapshots).toHaveLength(2);
    expect(gateway.checkoutSnapshots[1]).toEqual(gateway.checkoutSnapshots[0]);
    expect(before.rows[0]?.claim_token).toBe(after.rows[0]?.claim_token);
    expect(after.rows[0]?.count).toBe("1");
  });

  test("creates credit-pack Checkout and preserves immutable exact-credit facts", async () => {
    const response = await handler(
      mutation("/api/credit-packs/checkout", {
        pack_key: "boost-100",
        success_url:
          "https://app.example/billing/success?expected_credit_pack=boost-100",
        cancel_url: "https://app.example/pricing",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      session_id: "cs_test_runtime_pack",
      url: "https://checkout.stripe.test/pack",
    });
    expect(gateway.packInput?.packCredits).toBe("100");
    expect(gateway.packInput?.customerEmail).toBeUndefined();
    const order = await postgresDatabase().query<{
      readonly pack_credits: string;
      readonly price_amount: string;
    }>("select pack_credits::text,price_amount::text from credit_pack_orders");
    expect(order.rows[0]).toEqual({
      pack_credits: "100000000",
      price_amount: "1500",
    });
  });

  test("retries a frozen pack after email, URL, and catalog drift while new keys fail", async () => {
    const body = {
      pack_key: "boost-100",
      success_url:
        "https://app.example/billing/success?expected_credit_pack=boost-100",
      cancel_url: "https://app.example/pricing",
    };
    gateway.failNextPackCheckout = true;
    const first = await handler(
      mutation("/api/credit-packs/checkout", body, "runtime-unknown-pack"),
    );
    const before = await postgresDatabase().query<{
      readonly id: string;
      readonly stripe_request_key: string;
    }>("select id::text,stripe_request_key from credit_pack_orders");

    authenticatedEmail = "changed-after-timeout@example.test";
    (kernel.catalog.creditPacks as Map<string, unknown>).delete("boost-100");
    const driftedBody = {
      ...body,
      success_url: "https://retired.example.test/old-pack-success",
      cancel_url: "https://retired.example.test/old-pricing",
    };
    const retry = await handler(
      mutation(
        "/api/credit-packs/checkout",
        driftedBody,
        "runtime-unknown-pack",
      ),
    );
    const newKey = await handler(
      mutation("/api/credit-packs/checkout", driftedBody, "runtime-new-pack"),
    );
    const after = await postgresDatabase().query<{
      readonly id: string;
      readonly stripe_request_key: string;
      readonly count: string;
    }>(
      `select min(id::text) as id,min(stripe_request_key) as stripe_request_key,
              count(*)::text as count
         from credit_pack_orders`,
    );

    expect(first.status).toBe(502);
    expect(retry.status).toBe(200);
    expect(newKey.status).toBe(400);
    expect(gateway.packInputs).toHaveLength(1);
    expect(gateway.packInput?.customerEmail).toBeUndefined();
    expect(gateway.packSnapshots).toHaveLength(2);
    expect(gateway.packSnapshots[1]).toEqual(gateway.packSnapshots[0]);
    expect(after.rows[0]?.id).toBe(before.rows[0]?.id);
    expect(after.rows[0]?.stripe_request_key).toBe(
      before.rows[0]?.stripe_request_key,
    );
    expect(after.rows[0]?.count).toBe("1");
  });

  test("never replays another owner's frozen subscription or pack request", async () => {
    const subscriptionBody = {
      plan_key: "starter",
      interval: "month",
      success_url:
        "https://app.example/billing/success?expected_plan=starter&expected_interval=month",
      cancel_url: "https://app.example/pricing",
    };
    const packBody = {
      pack_key: "boost-100",
      success_url:
        "https://app.example/billing/success?expected_credit_pack=boost-100",
      cancel_url: "https://app.example/pricing",
    };
    const ownerB = "v1:user:22222222-2222-4222-8222-222222222222";
    const ownerC = "v1:user:33333333-3333-4333-8333-333333333333";
    const ownerD = "v1:user:44444444-4444-4444-8444-444444444444";

    gateway.failNextCheckout = true;
    const subscriptionA = await handler(
      mutation("/api/checkout", subscriptionBody, "cross-owner-subscription"),
    );
    authenticatedExternalRef = ownerB;
    const subscriptionB = await handler(
      mutation("/api/checkout", subscriptionBody, "cross-owner-subscription"),
    );

    authenticatedExternalRef = ownerC;
    gateway.failNextPackCheckout = true;
    const packA = await handler(
      mutation("/api/credit-packs/checkout", packBody, "cross-owner-pack"),
    );
    authenticatedExternalRef = ownerD;
    const packB = await handler(
      mutation("/api/credit-packs/checkout", packBody, "cross-owner-pack"),
    );

    expect(subscriptionA.status).toBe(502);
    expect(subscriptionB.status).toBe(200);
    expect(packA.status).toBe(502);
    expect(packB.status).toBe(200);
    expect(gateway.checkoutInputs).toHaveLength(2);
    expect(gateway.packInputs).toHaveLength(2);
    expect(gateway.checkoutSnapshots).toHaveLength(2);
    expect(gateway.packSnapshots).toHaveLength(2);
    expect(gateway.checkoutInputs[0]?.accountId).not.toBe(
      gateway.checkoutInputs[1]?.accountId,
    );
    expect(gateway.packInputs[0]?.accountId).not.toBe(
      gateway.packInputs[1]?.accountId,
    );
    const rows = await postgresDatabase().query<{
      readonly claims: string;
      readonly claim_accounts: string;
      readonly orders: string;
      readonly order_accounts: string;
    }>(
      `select (select count(*)::text from checkout_claims) as claims,
              (select count(distinct account_id)::text from checkout_claims)
                as claim_accounts,
              (select count(*)::text from credit_pack_orders) as orders,
              (select count(distinct account_id)::text from credit_pack_orders)
                as order_accounts`,
    );
    expect(rows.rows[0]).toEqual({
      claims: "2",
      claim_accounts: "2",
      orders: "2",
      order_accounts: "2",
    });
  });

  test("never inspects or mutates another owner's frozen plan-change request", async () => {
    const ownerA = await postgresDatabase().accountForExternalRef(
      authenticatedExternalRef,
    );
    const ownerBExternalRef = "v1:user:22222222-2222-4222-8222-222222222222";
    const ownerB =
      await postgresDatabase().accountForExternalRef(ownerBExternalRef);
    const previewId = randomUUID();
    const currentPeriodStart = 1_800_000_000n;
    const currentPeriodEnd = 1_802_592_000n;
    const subscriptionId = "sub_cross_owner_plan_runtime";
    const requestKey = `plan-change:${previewId}`;
    const snapshot = buildPlanChangeRequestSnapshot({
      context: {
        subscriptionId,
        subscriptionItemId: "si_cross_owner_plan_runtime",
        currentPriceId: "price_starter_month",
        currentLookupKey: "ent_starter_month",
        targetPriceId: "price_pro_month",
        targetInterval: "month",
        currentPeriodStart,
        currentPeriodEnd,
        scheduleId: null,
        subscriptionStatus: "active",
        cancelAtPeriodEnd: false,
        pendingUpdate: false,
        pendingExpiresAt: null,
        recoveryUrl: null,
        clientSecret: null,
      },
      timing: "immediate",
      policy: "full_period_reset",
      prorationDate: null,
      idempotencyKey: `${requestKey}:apply`,
      requestApiVersion: "2026-06-24.dahlia",
      productLine: "example-entitlements",
      sourceLookupKey: "ent_starter_month",
      targetLookupKey: "ent_pro_month",
      sourcePlanKey: "starter",
      targetPlanKey: "pro",
      sourceCurrency: "usd",
      targetCurrency: "usd",
      sourceUnitAmount: 1_900n,
      targetUnitAmount: 4_900n,
    });
    await postgresDatabase().query(
      `update billing_accounts
          set stripe_customer_id='cus_cross_owner_plan_runtime',
              stripe_subscription_id=$2,
              plan_key='starter',plan_interval='month',
              subscription_status='active',cancel_at_period_end=false,
              current_period_end=to_timestamp($3::bigint),
              entitlement_period_end=to_timestamp($3::bigint),
              credit_expires_at=to_timestamp($3::bigint),
              credits_balance=300000000,grant_epoch=1,
              entitlement_revoked=false
        where id=$1::uuid`,
      [ownerA.id, subscriptionId, currentPeriodEnd.toString()],
    );
    await postgresDatabase().query(
      `insert into billing_plan_changes(
         id,account_id,idempotency_key,stripe_subscription_id,
         from_plan_key,from_interval,target_plan_key,target_interval,
         effective_mode,status,stripe_request_key,expected_grant_epoch,
         expected_entitlement_period_end,expected_subscription_status,
         expected_cancel_at_period_end,expected_entitlement_revoked,
         transition_policy,preview_expires_at,
         request_snapshot_version,stripe_request_snapshot)
       values(
         $1::uuid,$2::uuid,'cross-owner-plan',$3,
         'starter','month','pro','month',
         'immediate','previewed',$4,1,
         to_timestamp($5::bigint),'active',false,false,
         'full_period_reset',now()+interval '10 minutes',1,$6::jsonb)`,
      [
        previewId,
        ownerA.id,
        subscriptionId,
        requestKey,
        currentPeriodEnd.toString(),
        JSON.stringify(snapshot),
      ],
    );

    authenticatedExternalRef = ownerBExternalRef;
    const response = await handler(
      mutation("/api/billing/change/confirm", { preview_id: previewId }),
    );
    const stored = await postgresDatabase().query<{
      readonly account_id: string;
      readonly status: string;
      readonly lease_token: string | null;
      readonly remote_started_at: string | null;
      readonly stripe_request_snapshot: unknown;
    }>(
      `select account_id::text,status,lease_token::text,
              remote_started_at::text,stripe_request_snapshot
         from billing_plan_changes where id=$1::uuid`,
      [previewId],
    );

    expect(ownerB.id).not.toBe(ownerA.id);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      detail: "plan-change preview not found",
    });
    expect(gateway.planChangeVerifyCalls).toBe(0);
    expect(gateway.planChangeExecuteCalls).toBe(0);
    expect(stored.rows[0]).toEqual({
      account_id: ownerA.id,
      status: "previewed",
      lease_token: null,
      remote_started_at: null,
      stripe_request_snapshot: snapshot,
    });
  });

  test("maps malformed frozen Checkout snapshots to operator conflicts without remote I/O", async () => {
    const account = await postgresDatabase().accountForExternalRef(
      "v1:user:11111111-1111-4111-8111-111111111111",
    );
    await postgresDatabase().query(
      "update billing_accounts set stripe_customer_id='cus_malformed_runtime' where id=$1::uuid",
      [account.id],
    );
    await kernel
      .requireServices()
      .checkout.reserve(account.id, "starter", "month", {
        requestKey: "malformed-runtime-sub",
      });
    await postgresDatabase().query(
      `update checkout_claims
          set request_snapshot_version=1,stripe_request_snapshot='{}'::jsonb
        where account_id=$1::uuid`,
      [account.id],
    );
    const subscription = await handler(
      mutation(
        "/api/checkout",
        {
          plan_key: "starter",
          interval: "month",
          success_url:
            "https://app.example/billing/success?expected_plan=starter&expected_interval=month",
          cancel_url: "https://app.example/pricing",
        },
        "malformed-runtime-sub",
      ),
    );

    const pack = kernel.catalog.requireCreditPack("boost-100");
    const order = await kernel
      .requireServices()
      .creditPacks.reserve(account.id, pack, "malformed-runtime-pack");
    await postgresDatabase().query(
      `update credit_pack_orders
          set request_snapshot_version=1,stripe_request_snapshot='{}'::jsonb
        where id=$1::uuid`,
      [order.orderId],
    );
    const creditPack = await handler(
      mutation(
        "/api/credit-packs/checkout",
        {
          pack_key: "boost-100",
          success_url:
            "https://app.example/billing/success?expected_credit_pack=boost-100",
          cancel_url: "https://app.example/pricing",
        },
        "malformed-runtime-pack",
      ),
    );

    expect(subscription.status).toBe(409);
    expect(await subscription.json()).toMatchObject({
      detail:
        "the persisted Checkout request snapshot is invalid; operator reconciliation is required",
    });
    expect(creditPack.status).toBe(409);
    expect(await creditPack.json()).toMatchObject({
      detail:
        "the persisted credit-pack Checkout request snapshot is invalid; operator reconciliation is required",
    });
    expect(gateway.checkoutInputs).toHaveLength(0);
    expect(gateway.packInputs).toHaveLength(0);
    expect(gateway.checkoutSnapshots).toHaveLength(0);
    expect(gateway.packSnapshots).toHaveLength(0);
  });

  test("maps a malformed frozen plan-change snapshot to an operator conflict without Stripe I/O", async () => {
    const account = await postgresDatabase().accountForExternalRef(
      "v1:user:11111111-1111-4111-8111-111111111111",
    );
    const previewId = randomUUID();
    await postgresDatabase().query(
      `update billing_accounts
          set stripe_customer_id='cus_malformed_plan_runtime',
              stripe_subscription_id='sub_malformed_plan_runtime',
              plan_key='starter',plan_interval='month',
              subscription_status='active',cancel_at_period_end=false,
              current_period_end=now()+interval '30 days',
              entitlement_period_end=now()+interval '30 days',
              credit_expires_at=now()+interval '30 days',
              credits_balance=300000000,grant_epoch=1,
              entitlement_revoked=false
        where id=$1::uuid`,
      [account.id],
    );
    await postgresDatabase().query(
      `insert into billing_plan_changes(
         id,account_id,idempotency_key,stripe_subscription_id,
         from_plan_key,from_interval,target_plan_key,target_interval,
         effective_mode,status,stripe_request_key,expected_grant_epoch,
         expected_entitlement_period_end,expected_subscription_status,
         expected_cancel_at_period_end,expected_entitlement_revoked,
         transition_policy,preview_expires_at,
         request_snapshot_version,stripe_request_snapshot)
       select $2::uuid,id,'malformed-runtime-plan',stripe_subscription_id,
              plan_key,plan_interval,'pro','month','immediate','previewed',
              $3,grant_epoch,entitlement_period_end,subscription_status,
              cancel_at_period_end,entitlement_revoked,'full_period_reset',
              now()+interval '10 minutes',1,'{}'::jsonb
         from billing_accounts where id=$1::uuid`,
      [account.id, previewId, `plan-change:${previewId}`],
    );

    const response = await handler(
      mutation("/api/billing/change/confirm", { preview_id: previewId }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      detail:
        "the persisted plan-change request snapshot is invalid; operator reconciliation is required",
    });
    expect(gateway.planChangeVerifyCalls).toBe(0);
    expect(gateway.planChangeExecuteCalls).toBe(0);
  });

  test("opens Portal only for a projected Stripe Customer", async () => {
    const created = await postgresDatabase().accountForExternalRef(
      "v1:user:11111111-1111-4111-8111-111111111111",
    );
    const missing = await handler(
      mutation("/api/billing/portal", {
        return_url: "https://app.example/account",
      }),
    );
    expect(missing.status).toBe(409);

    await postgresDatabase().query(
      "update billing_accounts set stripe_customer_id='cus_runtime' where id=$1::uuid",
      [created.id],
    );
    const portal = await handler(
      mutation("/api/billing/portal", {
        return_url: "https://app.example/account",
      }),
    );
    expect(portal.status).toBe(200);
    expect(await portal.json()).toEqual({
      session_id: "bps_test_runtime",
      url: "https://billing.stripe.test/portal",
    });
  });

  test("preserves signed webhook bytes and commits duplicate ids once", async () => {
    const bytes = new TextEncoder().encode(
      '{\n "raw": "海", "spaces": true\n}\n',
    );
    const request = (): Request =>
      new Request("https://billing.example/webhooks/stripe", {
        method: "POST",
        headers: { "Stripe-Signature": "t=1,v1=test" },
        body: bytes,
      });

    const first = await handler(request());
    const second = await handler(request());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(gateway.webhookBytes).toEqual(Buffer.from(bytes));
    expect(await first.json()).toMatchObject({
      received: true,
      outcome: "ignored",
    });
    expect(await second.json()).toMatchObject({
      received: true,
      outcome: "duplicate",
    });
    const events = await postgresDatabase().query<{ readonly count: string }>(
      "select count(*) from stripe_webhook_events where id='evt_runtime_unknown'",
    );
    expect(events.rows[0]?.count).toBe("1");
  });

  test("rejects extra request fields before creating remote or database work", async () => {
    const response = await handler(
      mutation("/api/checkout", {
        plan_key: "starter",
        interval: "month",
        success_url: "https://app.example/billing/success",
        cancel_url: "https://app.example/pricing",
        customer: "cus_attacker",
      }),
    );
    expect(response.status).toBe(400);
    expect(gateway.checkoutInput).toBeUndefined();
    const accounts = await postgresDatabase().query<{ readonly count: string }>(
      "select count(*) from billing_accounts",
    );
    expect(accounts.rows[0]?.count).toBe("0");
  });

  test("rejects current catalog and URL errors without creating empty billing accounts", async () => {
    const responses = [
      await handler(
        mutation(
          "/api/checkout",
          {
            plan_key: "retired",
            interval: "month",
            success_url:
              "https://app.example/billing/success?expected_plan=retired&expected_interval=month",
            cancel_url: "https://app.example/pricing",
          },
          "invalid-current-plan",
        ),
      ),
      await handler(
        mutation(
          "/api/checkout",
          {
            plan_key: "starter",
            interval: "month",
            success_url: "https://attacker.example/billing/success",
            cancel_url: "https://app.example/pricing",
          },
          "invalid-subscription-url",
        ),
      ),
      await handler(
        mutation(
          "/api/credit-packs/checkout",
          {
            pack_key: "retired-pack",
            success_url:
              "https://app.example/billing/success?expected_credit_pack=retired-pack",
            cancel_url: "https://app.example/pricing",
          },
          "invalid-current-pack",
        ),
      ),
      await handler(
        mutation(
          "/api/credit-packs/checkout",
          {
            pack_key: "boost-100",
            success_url: "https://attacker.example/billing/success",
            cancel_url: "https://app.example/pricing",
          },
          "invalid-pack-url",
        ),
      ),
    ];
    expect(responses.map((response) => response.status)).toEqual([
      400, 400, 400, 400,
    ]);
    expect(gateway.checkoutInput).toBeUndefined();
    expect(gateway.packInput).toBeUndefined();
    const accounts = await postgresDatabase().query<{ readonly count: string }>(
      "select count(*) from billing_accounts",
    );
    expect(accounts.rows[0]?.count).toBe("0");
  });

  test("cancels an undeclared oversized JSON stream before business work", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32 * 1024));
        controller.enqueue(new Uint8Array(32 * 1024 + 1));
      },
      cancel() {
        canceled = true;
      },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: {
        Authorization: "Bearer verified",
        "Content-Type": "application/json",
        "Idempotency-Key": "oversized-stream",
        Origin: "https://app.example",
      },
      body,
      duplex: "half",
    };
    const response = await handler(
      new Request("https://billing.example/api/checkout", init),
    );

    expect(response.status).toBe(400);
    expect(canceled).toBe(true);
    expect(gateway.checkoutInput).toBeUndefined();
    const accounts = await postgresDatabase().query<{
      readonly count: string;
    }>("select count(*) from billing_accounts");
    expect(accounts.rows[0]?.count).toBe("0");
  });
});

describe("TypeScript billing kernel ownership and Stripe mode", () => {
  test("rejects a second kernel owner for the same Database object", async () => {
    const database = new Database("postgresql://ownership.invalid/runtime");
    const first = await BillingKernel.create({
      settings: settings(),
      database,
      gateway: new RuntimeGateway(),
      auth,
      catalog: await PlanCatalog.fromToml(ROOT_CATALOG),
    });

    await expect(
      BillingKernel.create({
        settings: settings(),
        database,
        gateway: new RuntimeGateway(),
        auth,
        catalog: await PlanCatalog.fromToml(ROOT_CATALOG),
      }),
    ).rejects.toThrow(
      "this Database is already bound to another BillingKernel",
    );
    expect(() => database.requirePool()).toThrow("database is not connected");
    await first.stop();
  });

  test("rejects injected Stripe contract mismatches before connecting", async () => {
    const database = new Database("postgresql://mismatch.invalid/runtime");
    const catalog = await PlanCatalog.fromToml(ROOT_CATALOG);

    await expect(
      BillingKernel.create({
        settings: settings(),
        database,
        gateway: new RuntimeGateway("sk_live_runtime"),
        auth,
        catalog,
      }),
    ).rejects.toThrow("settings and billing gateway Stripe modes do not match");
    await expect(
      BillingKernel.create({
        settings: settings(),
        database,
        gateway: new RuntimeGateway("sk_test_runtime", "2025-01-27.acacia"),
        auth,
        catalog,
      }),
    ).rejects.toThrow(
      "settings and billing gateway Stripe API versions do not match",
    );
    await expect(
      BillingKernel.create({
        settings: settings(),
        database,
        gateway: new RuntimeGateway("sk_test_runtime", undefined, {
          productLine: "other-product-line",
        }),
        auth,
        catalog,
      }),
    ).rejects.toThrow(
      "settings and billing gateway product lines do not match",
    );
    for (const [overrides, message] of [
      [
        { checkoutSuccessUrl: "https://old.example/billing/success" },
        "settings and billing gateway Checkout success URLs do not match",
      ],
      [
        { checkoutCancelUrl: "https://old.example/pricing" },
        "settings and billing gateway Checkout cancel URLs do not match",
      ],
      [
        { portalReturnUrl: "https://old.example/account" },
        "settings and billing gateway Portal return URLs do not match",
      ],
      [
        { portalConfigurationId: "bpc_other" },
        "settings and billing gateway Portal configuration IDs do not match",
      ],
    ] as const) {
      await expect(
        BillingKernel.create({
          settings: settings(),
          database,
          gateway: new RuntimeGateway(
            "sk_test_runtime",
            "2026-06-24.dahlia",
            overrides,
          ),
          auth,
          catalog,
        }),
      ).rejects.toThrow(message);
    }
    expect(() => database.requirePool()).toThrow("database is not connected");
  });
});
