import type {
  AccountResponse,
  BillingApi,
  BillingInterval,
  CatalogPlan,
  CatalogResponse,
  ChangePreview,
  ChangePreviewRequest,
} from "@/lib/types";
import {
  referenceCatalog,
  referenceEntitlements,
  referencePlans,
} from "@/lib/reference-catalog";

const plans = referencePlans;
const catalog = referenceCatalog;

function futureIso(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function entitlementsFor(planKey: string) {
  return referenceEntitlements(planKey);
}

export function createMockBillingApi(
  initial?: Partial<AccountResponse>,
): BillingApi {
  let account: AccountResponse = {
    account_id: "00000000-0000-0000-0000-000000000001",
    transition_policy: catalog.transition_policy,
    plan_key: "starter",
    plan_interval: "month",
    subscription_status: "active",
    current_period_end: futureIso(21),
    credits: {
      balance: 214,
      grant_amount: 300,
      next_grant_at: futureIso(21),
    },
    entitlements: entitlementsFor("starter"),
    entitlements_enforceable: true,
    pending_change: null,
    pending_cancellation: null,
    ...initial,
  };
  const previews = new Map<string, ChangePreview>();
  let pendingProjection: AccountResponse | null = null;
  let projectionPollsRemaining = 0;
  let previewSequence = 0;

  function plan(key: string): CatalogPlan {
    const found = plans.find((item) => item.key === key);
    if (!found) throw new Error(`Unknown demo plan: ${key}`);
    return found;
  }

  function preview(input: ChangePreviewRequest): ChangePreview {
    const current = plan(account.plan_key);
    const target = plan(input.plan_key);
    // Demo policy is intentionally based on explicit catalog order, never price.
    // The production UI renders the server's timing field as authoritative.
    const currentInterval = account.plan_interval ?? "month";
    if (current.key === target.key && currentInterval === input.interval) {
      throw new Error("Plan and interval are unchanged.");
    }
    const timing =
      currentInterval === "year"
        ? "period_end"
        : target.display_order > current.display_order ||
            (target.key === current.key &&
              currentInterval === "month" &&
              input.interval === "year")
          ? "immediate"
          : "period_end";
    const targetPrice = target.prices[input.interval];
    // An accepted immediate preview is a full, independently funded target
    // invoice. Any old-invoice proration would make the real backend defer it.
    const creditApplied = 0;
    return {
      preview_id: `preview-${Date.now()}-${previewSequence++}`,
      current_plan_key: account.plan_key,
      current_interval: currentInterval,
      target_plan_key: target.key,
      target_interval: input.interval,
      timing,
      transition_policy: catalog.transition_policy,
      settlement_mode:
        timing === "immediate" ? "new_period_full_price" : "period_end",
      effective_at:
        timing === "immediate"
          ? new Date().toISOString()
          : account.current_period_end ?? futureIso(30),
      currency: targetPrice.currency,
      amount_due_now: timing === "immediate" ? targetPrice.unit_amount : 0,
      credit_applied: creditApplied,
      entitlement_credit_delta: null,
      next_invoice_amount: targetPrice.unit_amount,
    };
  }

  return {
    async getCatalog() {
      return catalog;
    },
    async getAccount() {
      if (pendingProjection && projectionPollsRemaining === 0) {
        account = pendingProjection;
        pendingProjection = null;
      } else if (pendingProjection) {
        projectionPollsRemaining -= 1;
      }
      return structuredClone(account);
    },
    async createCheckout(input) {
      const target = plan(input.plan_key);
      pendingProjection = {
        ...account,
        plan_key: target.key,
        plan_interval: input.interval,
        subscription_status: "active",
        current_period_end: futureIso(input.interval === "year" ? 365 : 30),
        credits: {
          balance: Number(target.entitlements[0]?.value ?? 0),
          grant_amount: Number(target.entitlements[0]?.value ?? 0),
          next_grant_at: futureIso(30),
        },
        entitlements: target.entitlements,
        entitlements_enforceable: true,
        pending_change: null,
        pending_cancellation: null,
      };
      projectionPollsRemaining = 1;
      const successUrl = new URL(input.success_url);
      successUrl.searchParams.set("expected_plan", target.key);
      successUrl.searchParams.set("expected_interval", input.interval);
      return {
        url: successUrl.toString(),
      };
    },
    async createPortal(returnUrl) {
      return { url: `${returnUrl}?portal=demo` };
    },
    async previewPlanChange(input) {
      const result = preview(input);
      previews.set(result.preview_id, result);
      return result;
    },
    async confirmPlanChange({ preview_id }) {
      const result = previews.get(preview_id);
      if (!result) throw new Error("Demo preview expired. Request a new preview.");
      const target = plan(result.target_plan_key);
      if (result.timing === "immediate") {
        pendingProjection = {
          ...account,
          plan_key: target.key,
          plan_interval: result.target_interval,
          subscription_status: "active",
          current_period_end: futureIso(result.target_interval === "year" ? 365 : 30),
          entitlements: target.entitlements,
          entitlements_enforceable: true,
          credits: {
            ...account.credits,
            grant_amount: Number(target.entitlements[0]?.value ?? 0),
          },
          pending_change: null,
        };
        projectionPollsRemaining = 1;
      } else {
        account = {
          ...account,
          pending_change: {
            target_plan_key: target.key,
            target_interval: result.target_interval,
            timing: result.timing,
            effective_at: result.effective_at,
            transition_policy: result.transition_policy,
          },
        };
      }
      return {
        status: "confirmed",
        timing: result.timing,
        transition_policy: result.transition_policy,
        target_plan_key: result.target_plan_key,
        target_interval: result.target_interval,
        account: structuredClone(account),
      };
    },
  };
}

export function demoCatalog(): CatalogResponse {
  return catalog;
}

export function demoAccount(
  planKey = "starter",
  interval: BillingInterval = "month",
): AccountResponse {
  const selected = plans.find((plan) => plan.key === planKey) ?? plans[0];
  return {
    account_id: "00000000-0000-0000-0000-000000000001",
    transition_policy: catalog.transition_policy,
    plan_key: selected.key,
    plan_interval: interval,
    subscription_status: "active",
    current_period_end: futureIso(21),
    credits: {
      balance: Number(selected.entitlements[0]?.value ?? 0),
      grant_amount: Number(selected.entitlements[0]?.value ?? 0),
      next_grant_at: futureIso(21),
    },
    entitlements: selected.entitlements,
    entitlements_enforceable: true,
    pending_change: null,
    pending_cancellation: null,
  };
}
