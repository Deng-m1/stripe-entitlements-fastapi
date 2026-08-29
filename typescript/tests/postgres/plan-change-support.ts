import { randomUUID } from "node:crypto";

import type { PlanCatalog } from "../../src/catalog.js";
import type { Database } from "../../src/database.js";
import type { PlanChangeGateway } from "../../src/plan-changes.js";
import type {
  PlanChangeContext,
  PlanChangeEstimate,
  PreparePlanChangeInput,
  RemotePlanChange,
} from "../../src/stripe-gateway.js";
import type { TransitionPolicy } from "../../src/types.js";

export const PERIOD_START = "2026-07-01T00:00:00.000000Z";
export const PERIOD_END = "2030-08-01T00:00:00.000000Z";
export const PERIOD_START_EPOCH = 1_782_864_000n;
export const PERIOD_END_EPOCH = 1_911_772_800n;

export class FakePlanGateway implements PlanChangeGateway {
  public currentLookup: string;
  public previewCalls = 0;
  public readonly applyCalls: string[] = [];
  public remoteApplyMutations = 0;
  public readonly scheduleCalls: string[] = [];
  public remoteScheduleMutations = 0;
  public amountDue = 4_900n;
  public prorationCredit = 0n;
  public customerBalanceCredit = 0n;
  public safeShape = true;
  public sourceProrationAmount = 0n;
  public targetProrationAmount = 0n;
  public taxAmount = 0n;
  public discountAmount = 0n;
  public estimateCurrency = "usd";
  public pending = false;
  public observedPending = false;
  public remotePeriodStart = PERIOD_START_EPOCH;
  public remotePeriodEnd = PERIOD_END_EPOCH;
  public remoteStatus = "active";
  public remoteCancelAtPeriodEnd = false;
  public remoteScheduleId: string | null = null;
  public beforePreviewReturn: (() => Promise<void>) | undefined;
  public beforeApplyReturn: (() => Promise<void>) | undefined;
  public beforeScheduleReturn: (() => Promise<void>) | undefined;
  public previewPolicy: TransitionPolicy | undefined;
  public previewProrationDate: bigint | undefined;
  public applyPolicy: TransitionPolicy | undefined;
  public applyProrationDate: bigint | undefined;
  public settlementInvoiceId: string | null = "in_fake_plan_change";
  public prepareCalls = 0;

  readonly #appliedKeys = new Set<string>();
  readonly #scheduledKeys = new Set<string>();

  public constructor(currentLookup = "ent_starter_month") {
    this.currentLookup = currentLookup;
  }

  public preparePlanChange(
    input: PreparePlanChangeInput,
  ): Promise<PlanChangeContext> {
    this.prepareCalls += 1;
    return Promise.resolve({
      subscriptionId: input.subscriptionId,
      subscriptionItemId: "si_test",
      currentPriceId: "price_current",
      currentLookupKey: this.currentLookup,
      targetPriceId: `price_${input.targetLookupKey}`,
      targetInterval: input.targetInterval,
      currentPeriodStart: this.remotePeriodStart,
      currentPeriodEnd: this.remotePeriodEnd,
      scheduleId: this.remoteScheduleId,
      subscriptionStatus: this.remoteStatus,
      cancelAtPeriodEnd: this.remoteCancelAtPeriodEnd,
      pendingUpdate: this.observedPending,
      pendingExpiresAt: this.observedPending
        ? this.remotePeriodStart + 3_600n
        : null,
      recoveryUrl: this.observedPending ? "https://invoice.test/recover" : null,
      clientSecret: this.observedPending ? "observed-client-secret" : null,
    });
  }

  public async previewImmediatePlanChange(
    context: PlanChangeContext,
    options: {
      readonly policy: TransitionPolicy;
      readonly prorationDate?: bigint;
    },
  ): Promise<PlanChangeEstimate> {
    this.previewCalls += 1;
    this.previewPolicy = options.policy;
    this.previewProrationDate = options.prorationDate;
    await this.beforePreviewReturn?.();
    return {
      amountDue: this.amountDue,
      prorationCredit: this.prorationCredit,
      customerBalanceCredit: this.customerBalanceCredit,
      currency: this.estimateCurrency,
      safeInvoiceShape: this.safeShape,
      sourceProrationAmount: this.sourceProrationAmount,
      targetProrationAmount: this.targetProrationAmount,
      taxAmount: this.taxAmount,
      discountAmount: this.discountAmount,
      periodStart:
        options.policy === "prorated_delta"
          ? (options.prorationDate ?? null)
          : null,
      periodEnd:
        options.policy === "prorated_delta" ? context.currentPeriodEnd : null,
    };
  }

  public async applyImmediatePlanChange(
    _context: PlanChangeContext,
    input: {
      readonly idempotencyKey: string;
      readonly policy: TransitionPolicy;
      readonly prorationDate?: bigint;
    },
  ): Promise<RemotePlanChange> {
    this.applyPolicy = input.policy;
    this.applyProrationDate = input.prorationDate;
    this.applyCalls.push(input.idempotencyKey);
    if (!this.#appliedKeys.has(input.idempotencyKey)) {
      this.#appliedKeys.add(input.idempotencyKey);
      this.remoteApplyMutations += 1;
    }
    await this.beforeApplyReturn?.();
    return {
      remoteId: "sub_test",
      pendingUpdate: this.pending,
      pendingExpiresAt: this.pending ? this.remotePeriodStart + 3_600n : null,
      recoveryUrl: this.pending ? "https://invoice.test/recover" : null,
      clientSecret: this.pending ? "ephemeral-client-secret" : null,
      settlementInvoiceId: this.settlementInvoiceId,
    };
  }

  public async schedulePlanChange(
    _context: PlanChangeContext,
    input: { readonly idempotencyKey: string },
  ): Promise<RemotePlanChange> {
    this.scheduleCalls.push(input.idempotencyKey);
    if (!this.#scheduledKeys.has(input.idempotencyKey)) {
      this.#scheduledKeys.add(input.idempotencyKey);
      this.remoteScheduleMutations += 1;
    }
    await this.beforeScheduleReturn?.();
    return {
      remoteId: "sub_sched_test",
      pendingUpdate: false,
      pendingExpiresAt: null,
      recoveryUrl: null,
      clientSecret: null,
      settlementInvoiceId: null,
    };
  }
}

export async function seedPaidAccount(
  database: Database,
  catalog: PlanCatalog,
  options: {
    readonly plan?: string;
    readonly interval?: "month" | "year";
    readonly withFundingInvoice?: boolean;
  } = {},
): Promise<string> {
  const plan = options.plan ?? "starter";
  const planInterval = options.interval ?? "month";
  const accountId = await database.createAccount(
    `v1:user:plan-change-${randomUUID()}`,
  );
  const credits = catalog.require(plan).monthlyCredits.atoms;
  const invoiceId = `in_seed_${accountId}`;
  await database.transaction(async (transaction) => {
    await transaction.query(
      `update billing_accounts set
         stripe_customer_id=$2,stripe_subscription_id=$3,
         plan_key=$4,plan_interval=$5,subscription_status='active',
         current_period_end=$6::timestamptz,
         entitlement_period_end=$6::timestamptz,
         credit_expires_at=$6::timestamptz,
         credits_balance=$7::bigint,grant_epoch=1,
         entitlement_revoked=false
       where id=$1::uuid`,
      [
        accountId,
        `cus_${randomUUID()}`,
        `sub_${randomUUID()}`,
        plan,
        planInterval,
        PERIOD_END,
        credits.toString(),
      ],
    );
    if (options.withFundingInvoice !== false) {
      await transaction.query(
        `insert into credit_ledger(
           account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
           stripe_invoice_id,grant_slot)
         values($1::uuid,$2::bigint,$2::bigint,$2::bigint,
                'subscription_grant',1,$3,1)`,
        [accountId, credits.toString(), invoiceId],
      );
    }
  });
  return accountId;
}
