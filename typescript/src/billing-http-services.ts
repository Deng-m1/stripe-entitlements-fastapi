import type { QueryResultRow } from "pg";

import type { Plan } from "./catalog.js";
import {
  BodyReadError,
  BodyTooLargeError,
  readBoundedRequestBody,
} from "./bounded-body.js";
import {
  CheckoutActiveSubscriptionError,
  CheckoutBusyError,
  CheckoutCreationRejected,
  CheckoutReplayUnsafeError,
  type CheckoutCreator,
} from "./checkout.js";
import { CREDIT_SCALE, creditDecimal } from "./credit-amount.js";
import {
  CreditPackBusyError,
  type CreditPackCheckoutCreator,
  CreditPackConflictError,
} from "./credit-pack-coordinator.js";
import type { BillingAccountRow } from "./db-types.js";
import { pgBigInt } from "./db-types.js";
import type {
  BillingCronJob,
  BillingHttpResult,
  BillingHttpServices,
  BillingRequestContext,
  StripeWebhookContext,
} from "./http/contracts.js";
import type { BillingKernel } from "./kernel.js";
import {
  PlanChangeBusyError,
  PlanChangeConflictError,
  type PlanChangeResult,
  PlanChangeUnavailableError,
} from "./plan-changes.js";
import { runAnnualGrantBatch, runReconciliationBatch } from "./scheduled.js";
import { PortalConfigurationUnavailableError } from "./stripe-gateway.js";
import {
  rfc3339Timestamp,
  spendableSubscriptionAtoms,
  subscriptionCreditsAreSpendable,
} from "./subscription-state.js";
import type { BillingInterval, JsonValue, PgTimestamp } from "./types.js";
import { isPlainRecord, isPrintable } from "./validation.js";

const MAX_JSON_BODY_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const FEATURE_LABELS: Readonly<Record<string, string>> = {
  pdf_to_ppt: "PDF to PowerPoint",
  image_to_ppt: "Image to PowerPoint",
  batch_conversion: "Batch conversion",
  api_access: "API access",
  priority_queue: "Priority queue",
};

const LIMIT_PRESENTATION: Readonly<
  Record<string, readonly [label: string, unit: string | null]>
> = {
  max_file_mb: ["Maximum file size", "MB"],
  max_pages_per_job: ["Maximum pages per job", "pages"],
  concurrent_jobs: ["Concurrent jobs", "jobs"],
  api_keys: ["API keys", "keys"],
};

class RequestContractError extends Error {}

interface PurchasedLotRow extends QueryResultRow {
  readonly id: string;
  readonly remaining_credits: string;
  readonly expires_at: PgTimestamp;
  readonly pack_key: string;
  readonly stripe_checkout_session_id: string;
}

function result(status: number, body: JsonValue): BillingHttpResult {
  return { status, body };
}

function errorResult(status: number, detail: string): BillingHttpResult {
  return result(status, { detail });
}

function titleFromKey(value: string): string {
  return value
    .split("_")
    .map((part) =>
      part.length === 0
        ? part
        : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
    )
    .join(" ");
}

function entitlementRows(plan: Plan | undefined): JsonValue[] {
  if (plan === undefined) {
    return [];
  }
  const rows: JsonValue[] = [
    {
      key: "monthly_credits",
      label: "Credits per monthly grant",
      value: plan.monthlyCredits.toString(),
      value_atoms: plan.monthlyCredits.atoms.toString(),
      scale: Number(CREDIT_SCALE),
      unit: "credits",
    },
  ];
  for (const feature of [...plan.features].sort()) {
    rows.push({
      key: feature,
      label: FEATURE_LABELS[feature] ?? titleFromKey(feature),
      value: true,
    });
  }
  for (const [key, value] of Object.entries(plan.limits).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const presentation = LIMIT_PRESENTATION[key];
    rows.push({
      key,
      label: presentation?.[0] ?? titleFromKey(key),
      value,
      unit: presentation?.[1] ?? null,
    });
  }
  return rows;
}

function contentLength(request: Request): number | undefined {
  const raw = request.headers.get("content-length");
  if (raw === null) {
    return undefined;
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new RequestContractError("invalid Content-Length");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new RequestContractError("invalid Content-Length");
  }
  return value;
}

async function requestObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const declared = contentLength(request);
  if (declared !== undefined && declared > MAX_JSON_BODY_BYTES) {
    throw new RequestContractError("request body is too large");
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedRequestBody(request, MAX_JSON_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      throw new RequestContractError("request body is too large");
    }
    if (error instanceof BodyReadError) {
      throw new RequestContractError("request body could not be read");
    }
    throw error;
  }
  if (declared !== undefined && declared !== bytes.byteLength) {
    throw new RequestContractError(
      "Content-Length does not match request body",
    );
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RequestContractError("request body must be UTF-8 JSON");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new RequestContractError("request body must be valid JSON");
  }
  if (!isPlainRecord(parsed)) {
    throw new RequestContractError("request body must be a JSON object");
  }
  return parsed;
}

function exactFields(
  body: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const observed = Object.keys(body).sort();
  const required = [...expected].sort();
  if (
    observed.length !== required.length ||
    observed.some((field, index) => field !== required[index])
  ) {
    throw new RequestContractError(
      `request fields must be exactly: ${required.join(", ")}`,
    );
  }
}

function visibleString(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > maximum ||
    !isPrintable(value)
  ) {
    throw new RequestContractError(`${field} is invalid`);
  }
  return value;
}

function interval(value: unknown): BillingInterval {
  if (value !== "month" && value !== "year") {
    throw new RequestContractError("interval must be month or year");
  }
  return value;
}

function idempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (
    key === null ||
    key.length === 0 ||
    key !== key.trim() ||
    Buffer.byteLength(key, "utf8") > 200 ||
    !isPrintable(key)
  ) {
    throw new RequestContractError(
      "Idempotency-Key must contain 1 to 200 visible characters without padding",
    );
  }
  return key;
}

function requireConfiguredUrl(
  value: string,
  expected: string,
  field: string,
): void {
  if (value.replace(/\/$/u, "") !== expected.replace(/\/$/u, "")) {
    throw new RequestContractError(
      `${field} must match the server allowlisted URL`,
    );
  }
}

function queryEntries(url: URL): readonly [string, string][] {
  const entries = [...url.searchParams.entries()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw new RequestContractError("success_url query contains duplicate keys");
  }
  return entries;
}

function matchingSuccessUrl(
  supplied: string,
  configured: string,
  expectedQuery: Readonly<Record<string, string>>,
  target: string,
): void {
  let actual: URL;
  let expected: URL;
  try {
    actual = new URL(supplied);
    expected = new URL(configured);
  } catch {
    throw new RequestContractError("success_url must be a valid HTTP(S) URL");
  }
  if (
    actual.protocol !== expected.protocol ||
    actual.host !== expected.host ||
    actual.pathname !== expected.pathname ||
    actual.hash.length > 0 ||
    actual.username.length > 0 ||
    actual.password.length > 0
  ) {
    throw new RequestContractError(
      "success_url must match the server allowlisted URL",
    );
  }
  const entries = queryEntries(actual);
  const matches =
    entries.length === Object.keys(expectedQuery).length &&
    entries.every(([key, value]) => expectedQuery[key] === value);
  if (entries.length !== 0 && !matches) {
    throw new RequestContractError(
      `success_url query does not match the ${target}`,
    );
  }
}

function stripeModeRequirement(request: Request, testMode: boolean): void {
  const requirement = request.headers.get("x-stripe-mode-requirement");
  if (requirement !== null && requirement !== "test") {
    throw new RequestContractError(
      "X-Stripe-Mode-Requirement must be test when supplied",
    );
  }
  if (requirement === "test" && !testMode) {
    throw new PlanChangeUnavailableError(
      "billing backend is not in the required Stripe test mode",
    );
  }
}

function safeJsonInteger(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${field} is outside the JSON-safe integer range`);
  }
  return Number(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredTimestamp(value: unknown): PgTimestamp {
  const timestamp = optionalString(value);
  if (timestamp === null) {
    throw new TypeError("database row requires a timestamp");
  }
  return timestamp;
}

async function databaseNow(kernel: BillingKernel): Promise<PgTimestamp> {
  const response = await kernel.database.query<
    { readonly value: PgTimestamp } & QueryResultRow
  >("select clock_timestamp() as value");
  const value = response.rows[0]?.value;
  if (value === undefined) {
    throw new Error("database clock query returned no row");
  }
  return value;
}

/** Concrete HTTP facade over the connected billing kernel. */
export class DefaultBillingHttpServices implements BillingHttpServices {
  readonly #kernel: BillingKernel;

  public constructor(kernel: BillingKernel) {
    this.#kernel = kernel;
  }

  public async health(_request: Request): Promise<BillingHttpResult> {
    try {
      await this.#kernel.database.query("select 1");
      const schema = await this.#kernel.database.schemaReady();
      return result(schema ? 200 : 503, {
        ok: schema,
        database: true,
        schema,
        stripe_mode: this.#kernel.stripeTestMode ? "test" : "live",
        transition_policy: this.#kernel.settings.billingTransitionPolicy,
      });
    } catch {
      return result(503, {
        ok: false,
        database: false,
        schema: false,
        stripe_mode: this.#kernel.stripeTestMode ? "test" : "live",
        transition_policy: this.#kernel.settings.billingTransitionPolicy,
      });
    }
  }

  public catalog(_context: BillingRequestContext): Promise<BillingHttpResult> {
    const plans = this.#kernel.catalog.ordered().map((plan) => ({
      key: plan.key,
      name: plan.name,
      description: plan.description,
      display_order: plan.rank,
      prices: {
        month: {
          currency: plan.currency,
          unit_amount: plan.monthUsd * 100,
          interval: "month",
        },
        year: {
          currency: plan.currency,
          unit_amount: plan.yearUsd * 100,
          interval: "year",
        },
      },
      entitlements: entitlementRows(plan),
    }));
    const creditPacks = this.#kernel.catalog
      .orderedCreditPacks()
      .map((pack) => ({
        key: pack.key,
        name: pack.name,
        description: pack.description,
        display_order: pack.rank,
        credits: pack.credits.toString(),
        credits_atoms: pack.credits.atoms.toString(),
        credit_scale: Number(CREDIT_SCALE),
        price: { currency: pack.currency, unit_amount: pack.priceUsd * 100 },
        expires_days: pack.expiresDays,
      }));
    return Promise.resolve(
      result(200, {
        transition_policy: this.#kernel.settings.billingTransitionPolicy,
        plans,
        credit_packs: creditPacks,
      }),
    );
  }

  async #accountPayload(account: BillingAccountRow): Promise<JsonValue> {
    const pending = await this.#kernel.database.pendingPlanChange(account.id);
    const plan = this.#kernel.catalog.plans.get(account.plan_key);
    const asOf = account.database_now ?? (await databaseNow(this.#kernel));
    const lots = await this.#kernel.database.query<PurchasedLotRow>(
      `select l.id::text,l.remaining_credits::text,l.expires_at,o.pack_key,
              o.stripe_checkout_session_id
         from credit_funding_lots l
         join credit_pack_orders o on o.id=l.order_id
        where l.account_id=$1::uuid and l.status='active'
          and l.remaining_credits>0 and l.expires_at>$2::timestamptz
        order by l.expires_at,l.id`,
      [account.id, asOf],
    );
    const purchasedAtoms = lots.rows.reduce(
      (total, row) => total + pgBigInt(row.remaining_credits),
      0n,
    );
    const normalizedAccount = {
      ...account,
      credits_balance: pgBigInt(account.credits_balance),
    };
    const subscriptionAtoms = spendableSubscriptionAtoms(normalizedAccount, {
      asOf,
    });
    const balanceAtoms = subscriptionAtoms + purchasedAtoms;
    const grantAtoms = plan?.monthlyCredits.atoms ?? 0n;
    let pendingChange: JsonValue = null;
    if (pending !== null) {
      pendingChange = {
        preview_id: optionalString(pending["id"]),
        target_plan_key: optionalString(pending["target_plan_key"]),
        target_interval: optionalString(pending["target_interval"]),
        timing: optionalString(pending["effective_mode"]),
        effective_at: rfc3339Timestamp(
          requiredTimestamp(pending["effective_at"] ?? pending["created_at"]),
        ),
        status: optionalString(pending["status"]),
        payment_url: optionalString(pending["recovery_url"]),
        transition_policy: optionalString(pending["transition_policy"]),
      };
    }
    return {
      account_id: account.id,
      transition_policy: this.#kernel.settings.billingTransitionPolicy,
      plan_key: account.plan_key,
      plan_interval: account.plan_interval,
      subscription_status: account.subscription_status,
      current_period_end:
        account.entitlement_period_end === null
          ? null
          : rfc3339Timestamp(account.entitlement_period_end),
      observed_period_end:
        account.current_period_end === null
          ? null
          : rfc3339Timestamp(account.current_period_end),
      credits: {
        balance: creditDecimal(balanceAtoms),
        balance_atoms: balanceAtoms.toString(),
        subscription_balance: creditDecimal(subscriptionAtoms),
        subscription_balance_atoms: subscriptionAtoms.toString(),
        purchased_balance: creditDecimal(purchasedAtoms),
        purchased_balance_atoms: purchasedAtoms.toString(),
        grant_amount: creditDecimal(grantAtoms),
        grant_amount_atoms: grantAtoms.toString(),
        scale: Number(CREDIT_SCALE),
        next_grant_at:
          account.credit_expires_at === null
            ? null
            : rfc3339Timestamp(account.credit_expires_at),
        credit_packs: lots.rows.map((row) => ({
          lot_id: row.id,
          pack_key: row.pack_key,
          checkout_session_id: row.stripe_checkout_session_id,
          remaining: creditDecimal(pgBigInt(row.remaining_credits)),
          remaining_atoms: row.remaining_credits,
          expires_at: rfc3339Timestamp(row.expires_at),
        })),
      },
      entitlements: entitlementRows(plan),
      entitlements_enforceable:
        plan !== undefined &&
        subscriptionCreditsAreSpendable(normalizedAccount, { asOf }),
      pending_change: pendingChange,
      pending_cancellation: account.cancel_at_period_end
        ? {
            target_plan_key: "free",
            timing: "period_end",
            effective_at:
              account.pending_free_at === null
                ? null
                : rfc3339Timestamp(account.pending_free_at),
          }
        : null,
    };
  }

  public async account(
    context: BillingRequestContext,
  ): Promise<BillingHttpResult> {
    const account = await this.#kernel.database.accountForExternalRef(
      context.identity.externalRef,
    );
    return result(200, await this.#accountPayload(account));
  }

  public async checkout(
    context: BillingRequestContext,
  ): Promise<BillingHttpResult> {
    try {
      stripeModeRequirement(context.request, this.#kernel.stripeTestMode);
      const requestKey = idempotencyKey(context.request);
      const body = await requestObject(context.request);
      exactFields(body, ["plan_key", "interval", "success_url", "cancel_url"]);
      const planKey = visibleString(body["plan_key"], "plan_key", 64);
      const targetInterval = interval(body["interval"]);
      const successUrl = visibleString(
        body["success_url"],
        "success_url",
        2048,
      );
      const cancelUrl = visibleString(body["cancel_url"], "cancel_url", 2048);
      let account = await this.#kernel.database.existingAccountForExternalRef(
        context.identity.externalRef,
      );
      const creator: CheckoutCreator = {
        // The durable claim snapshots Customer-vs-create mode. In first-Customer
        // mode, deliberately omit mutable login email so an unknown Stripe result
        // can be retried with byte-for-byte equivalent idempotency parameters.
        prepareCheckoutSession: (input) =>
          this.#kernel.gateway.prepareCheckoutSession(input),
        createCheckoutSessionFromSnapshot: (snapshot) =>
          this.#kernel.gateway.createCheckoutSessionFromSnapshot(snapshot),
      };
      if (account !== null) {
        const recovered = await this.#kernel
          .requireServices()
          .checkout.recoverFrozen(creator, {
            accountId: account.id,
            planKey,
            interval: targetInterval,
            requestKey,
          });
        if (recovered !== undefined) {
          return result(200, { url: recovered[1] });
        }
      }
      matchingSuccessUrl(
        successUrl,
        this.#kernel.settings.checkoutSuccessUrl,
        { expected_plan: planKey, expected_interval: targetInterval },
        "Checkout target",
      );
      requireConfiguredUrl(
        cancelUrl,
        this.#kernel.settings.checkoutCancelUrl,
        "cancel_url",
      );
      let plan: Plan;
      try {
        plan = this.#kernel.catalog.require(planKey);
      } catch (error) {
        throw new RequestContractError(
          error instanceof Error ? error.message : "unknown plan",
        );
      }
      account ??= await this.#kernel.database.accountForExternalRef(
        context.identity.externalRef,
      );
      const [, url] = await this.#kernel
        .requireServices()
        .checkout.create(creator, {
          accountId: account.id,
          planKey: plan.key,
          interval: targetInterval,
          lookupKey: this.#kernel.catalog.lookupKey(plan.key, targetInterval),
          expectedCurrency: plan.currency,
          expectedUnitAmount:
            BigInt(targetInterval === "month" ? plan.monthUsd : plan.yearUsd) *
            100n,
          expectedInterval: targetInterval,
          requestKey,
        });
      return result(200, { url });
    } catch (error) {
      if (error instanceof RequestContractError) {
        return errorResult(400, error.message);
      }
      if (
        error instanceof CheckoutBusyError ||
        error instanceof CheckoutActiveSubscriptionError ||
        error instanceof CheckoutCreationRejected ||
        error instanceof CheckoutReplayUnsafeError ||
        error instanceof PlanChangeUnavailableError
      ) {
        return errorResult(409, error.message);
      }
      return errorResult(
        502,
        "Stripe Checkout is temporarily unavailable; retry the same request",
      );
    }
  }

  public async creditPackCheckout(
    context: BillingRequestContext,
  ): Promise<BillingHttpResult> {
    try {
      stripeModeRequirement(context.request, this.#kernel.stripeTestMode);
      const requestKey = idempotencyKey(context.request);
      const body = await requestObject(context.request);
      exactFields(body, ["pack_key", "success_url", "cancel_url"]);
      const packKey = visibleString(body["pack_key"], "pack_key", 64);
      const successUrl = visibleString(
        body["success_url"],
        "success_url",
        2048,
      );
      const cancelUrl = visibleString(body["cancel_url"], "cancel_url", 2048);
      let account = await this.#kernel.database.existingAccountForExternalRef(
        context.identity.externalRef,
      );
      const creator: CreditPackCheckoutCreator = {
        // Match subscription Checkout recovery: do not make a mutable auth email
        // part of a first-Customer Stripe idempotency request.
        prepareCreditPackCheckoutSession: (input) =>
          this.#kernel.gateway.prepareCreditPackCheckoutSession(input),
        createCheckoutSessionFromSnapshot: (snapshot) =>
          this.#kernel.gateway.createCheckoutSessionFromSnapshot(snapshot),
      };
      if (account !== null) {
        const recovered = await this.#kernel
          .requireServices()
          .creditPacks.recoverFrozen(creator, {
            accountId: account.id,
            packKey,
            requestKey,
          });
        if (recovered !== undefined) {
          return result(200, { session_id: recovered[0], url: recovered[1] });
        }
      }
      try {
        this.#kernel.catalog.requireCreditPack(packKey);
      } catch (error) {
        throw new RequestContractError(
          error instanceof Error ? error.message : "unknown credit pack",
        );
      }
      matchingSuccessUrl(
        successUrl,
        this.#kernel.settings.checkoutSuccessUrl,
        { expected_credit_pack: packKey },
        "credit pack",
      );
      requireConfiguredUrl(
        cancelUrl,
        this.#kernel.settings.checkoutCancelUrl,
        "cancel_url",
      );
      account ??= await this.#kernel.database.accountForExternalRef(
        context.identity.externalRef,
      );
      const [sessionId, url] = await this.#kernel
        .requireServices()
        .creditPacks.create(creator, {
          accountId: account.id,
          packKey,
          requestKey,
        });
      return result(200, { session_id: sessionId, url });
    } catch (error) {
      if (error instanceof RequestContractError) {
        return errorResult(400, error.message);
      }
      if (
        error instanceof CreditPackBusyError ||
        error instanceof CreditPackConflictError ||
        error instanceof CheckoutCreationRejected ||
        error instanceof PlanChangeUnavailableError
      ) {
        return errorResult(409, error.message);
      }
      return errorResult(
        502,
        "Stripe credit-pack Checkout is temporarily unavailable; retry the same request",
      );
    }
  }

  public async portal(
    context: BillingRequestContext,
  ): Promise<BillingHttpResult> {
    try {
      stripeModeRequirement(context.request, this.#kernel.stripeTestMode);
      const requestKey = idempotencyKey(context.request);
      const body = await requestObject(context.request);
      exactFields(body, ["return_url"]);
      const returnUrl = visibleString(body["return_url"], "return_url", 2048);
      requireConfiguredUrl(
        returnUrl,
        this.#kernel.settings.portalReturnUrl,
        "return_url",
      );
      const account = await this.#kernel.database.existingAccountForExternalRef(
        context.identity.externalRef,
      );
      if (account === null || account.stripe_customer_id === null) {
        return errorResult(409, "account has no Stripe customer");
      }
      const [sessionId, url] = await this.#kernel.gateway.createPortalSession({
        customerId: account.stripe_customer_id,
        idempotencyKey: `portal:${account.id}:${requestKey}`,
      });
      return result(200, { session_id: sessionId, url });
    } catch (error) {
      if (error instanceof RequestContractError) {
        return errorResult(400, error.message);
      }
      if (error instanceof PortalConfigurationUnavailableError) {
        return errorResult(
          503,
          "Stripe Portal configuration is missing or invalid",
        );
      }
      if (error instanceof PlanChangeUnavailableError) {
        return errorResult(409, error.message);
      }
      return errorResult(502, "Stripe Portal is temporarily unavailable");
    }
  }

  #planChangeError(error: unknown): BillingHttpResult {
    if (error instanceof PlanChangeConflictError) {
      return errorResult(400, error.message);
    }
    if (
      error instanceof PlanChangeBusyError ||
      error instanceof PlanChangeUnavailableError
    ) {
      return errorResult(409, error.message);
    }
    return errorResult(
      502,
      "Stripe plan change failed; retry the same request",
    );
  }

  public async previewPlanChange(
    context: BillingRequestContext,
  ): Promise<BillingHttpResult> {
    try {
      stripeModeRequirement(context.request, this.#kernel.stripeTestMode);
      const requestKey = idempotencyKey(context.request);
      const body = await requestObject(context.request);
      exactFields(body, ["plan_key", "interval"]);
      const planKey = visibleString(body["plan_key"], "plan_key", 64);
      const targetInterval = interval(body["interval"]);
      try {
        this.#kernel.catalog.require(planKey);
      } catch (error) {
        throw new RequestContractError(
          error instanceof Error ? error.message : "unknown plan",
        );
      }
      const account = await this.#kernel.database.existingAccountForExternalRef(
        context.identity.externalRef,
      );
      if (account === null) {
        return errorResult(409, "an active paid subscription is required");
      }
      const preview = await this.#kernel
        .requireServices()
        .planChanges.previewRemote(
          account.id,
          planKey,
          targetInterval,
          requestKey,
        );
      if (preview.decision.timing === "noop") {
        return errorResult(409, "plan and interval are unchanged");
      }
      return result(200, await this.#previewPayload(preview));
    } catch (error) {
      if (error instanceof RequestContractError) {
        return errorResult(400, error.message);
      }
      return this.#planChangeError(error);
    }
  }

  async #previewPayload(preview: PlanChangeResult): Promise<JsonValue> {
    const target = this.#kernel.catalog.require(preview.decision.targetPlan);
    const immediate = preview.decision.timing === "immediate";
    const delta =
      immediate &&
      preview.transitionPolicy === "prorated_delta" &&
      preview.entitlementCreditDelta !== null
        ? preview.entitlementCreditDelta
        : null;
    return {
      preview_id: preview.changeId,
      current_plan_key: preview.decision.fromPlan,
      current_interval: preview.decision.fromInterval,
      target_plan_key: preview.decision.targetPlan,
      target_interval: preview.decision.targetInterval,
      timing: preview.decision.timing,
      transition_policy: preview.transitionPolicy,
      settlement_mode:
        immediate && preview.transitionPolicy === "prorated_delta"
          ? "current_period_prorated_delta"
          : immediate
            ? "new_period_full_price"
            : "period_end",
      effective_at: rfc3339Timestamp(
        preview.effectiveAt ?? (await databaseNow(this.#kernel)),
      ),
      currency: preview.estimateCurrency ?? target.currency,
      amount_due_now:
        immediate && preview.estimatedAmountDue !== null
          ? safeJsonInteger(preview.estimatedAmountDue, "estimated amount due")
          : 0,
      credit_applied:
        immediate && preview.estimatedCreditApplied !== null
          ? safeJsonInteger(
              preview.estimatedCreditApplied,
              "estimated credit applied",
            )
          : 0,
      entitlement_credit_delta: delta === null ? null : creditDecimal(delta),
      entitlement_credit_delta_atoms: delta === null ? null : delta.toString(),
      credit_scale: Number(CREDIT_SCALE),
      next_invoice_amount:
        (preview.decision.targetInterval === "month"
          ? target.monthUsd
          : target.yearUsd) * 100,
    };
  }

  public async confirmPlanChange(
    context: BillingRequestContext,
  ): Promise<BillingHttpResult> {
    try {
      stripeModeRequirement(context.request, this.#kernel.stripeTestMode);
      const body = await requestObject(context.request);
      exactFields(body, ["preview_id"]);
      const previewId = visibleString(body["preview_id"], "preview_id", 36);
      if (!UUID.test(previewId)) {
        throw new RequestContractError("preview_id must be a canonical UUID");
      }
      const account = await this.#kernel.database.existingAccountForExternalRef(
        context.identity.externalRef,
      );
      if (account === null) {
        return errorResult(409, "plan-change preview not found");
      }
      const confirmed = await this.#kernel
        .requireServices()
        .planChanges.confirm(account.id, previewId);
      if (confirmed.status === "previewed" || confirmed.status === "applying") {
        return errorResult(409, "this preview is currently being confirmed");
      }
      let responseStatus = "confirmed";
      if (confirmed.status === "requires_action") {
        responseStatus =
          confirmed.clientSecret === null
            ? "payment_required"
            : "action_required";
      }
      const payload: Record<string, JsonValue> = {
        status: responseStatus,
        timing: confirmed.decision.timing,
        transition_policy: confirmed.transitionPolicy,
        target_plan_key: confirmed.decision.targetPlan,
        target_interval: confirmed.decision.targetInterval,
      };
      if (confirmed.recoveryUrl !== null) {
        payload["payment_url"] = confirmed.recoveryUrl;
      }
      if (confirmed.clientSecret !== null) {
        payload["payment_client_secret"] = confirmed.clientSecret;
        payload["payment_confirmation_method"] = "confirm_payment";
      }
      if (
        confirmed.status === "completed" ||
        confirmed.status === "scheduled"
      ) {
        const refreshed = await this.#kernel.database.account(account.id);
        if (refreshed !== null) {
          payload["account"] = await this.#accountPayload(refreshed);
        }
      }
      return result(200, payload);
    } catch (error) {
      if (error instanceof RequestContractError) {
        return errorResult(400, error.message);
      }
      return this.#planChangeError(error);
    }
  }

  public async stripeWebhook(
    context: StripeWebhookContext,
  ): Promise<BillingHttpResult> {
    let event: Record<string, unknown>;
    try {
      event = this.#kernel.gateway.constructEvent(
        Buffer.from(context.rawBody),
        context.stripeSignature,
      );
    } catch {
      return result(400, { error: "invalid Stripe signature" });
    }
    try {
      const processor = this.#kernel.requireServices().processor;
      const prepared = (await processor.hasCommittedEvent(event["id"]))
        ? event
        : await this.#kernel.gateway.prepareEvent(event);
      const processed = await processor.process(prepared);
      return result(200, {
        received: true,
        outcome: processed.outcome,
        reason: processed.reason ?? null,
        account_id: processed.accountId ?? null,
      });
    } catch {
      return result(500, {
        error: "processing failed; Stripe should retry",
      });
    }
  }

  public async runCron(
    job: BillingCronJob,
    _request: Request,
  ): Promise<BillingHttpResult> {
    if (job === "annual-grants") {
      const batch = await runAnnualGrantBatch(this.#kernel);
      return result(batch.ok ? 200 : 503, batch.publicSummary());
    }
    const batch = await runReconciliationBatch(this.#kernel);
    return result(batch.ok ? 200 : 503, batch.publicSummary());
  }
}
