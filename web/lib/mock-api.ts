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
  CREDIT_SCALE,
  addCreditDecimals,
  creditAmountFromDecimal,
  creditAmountFromEntitlement,
} from "@/lib/credit-amount";
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

function planCreditAmount(plan: CatalogPlan) {
  const entitlement = plan.entitlements.find(
    (item) => item.key === "monthly_credits",
  );
  if (!entitlement) throw new Error(`Plan ${plan.key} has no monthly credit grant.`);
  return creditAmountFromEntitlement(entitlement);
}

export function createMockBillingApi(
  initial?: Partial<AccountResponse>,
): BillingApi {
  const initialBalance = creditAmountFromDecimal("214");
  const starterGrant = creditAmountFromDecimal("300");
  let account: AccountResponse = {
    account_id: "00000000-0000-0000-0000-000000000001",
    transition_policy: catalog.transition_policy,
    plan_key: "starter",
    plan_interval: "month",
    subscription_status: "active",
    current_period_end: futureIso(21),
    credits: {
      balance: initialBalance.decimal,
      balance_atoms: initialBalance.atoms,
      subscription_balance: initialBalance.decimal,
      subscription_balance_atoms: initialBalance.atoms,
      purchased_balance: "0",
      purchased_balance_atoms: "0",
      grant_amount: starterGrant.decimal,
      grant_amount_atoms: starterGrant.atoms,
      scale: CREDIT_SCALE,
      next_grant_at: futureIso(21),
      credit_packs: [],
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
      entitlement_credit_delta_atoms: null,
      credit_scale: CREDIT_SCALE,
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
      const targetCredits = planCreditAmount(target);
      const total = addCreditDecimals(
        targetCredits.decimal,
        account.credits.purchased_balance,
      );
      pendingProjection = {
        ...account,
        plan_key: target.key,
        plan_interval: input.interval,
        subscription_status: "active",
        current_period_end: futureIso(input.interval === "year" ? 365 : 30),
        credits: {
          ...account.credits,
          balance: total.decimal,
          balance_atoms: total.atoms,
          subscription_balance: targetCredits.decimal,
          subscription_balance_atoms: targetCredits.atoms,
          grant_amount: targetCredits.decimal,
          grant_amount_atoms: targetCredits.atoms,
          scale: targetCredits.scale,
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
    async createCreditPackCheckout(input) {
      const pack = catalog.credit_packs.find((item) => item.key === input.pack_key);
      if (!pack) throw new Error(`Unknown demo credit pack: ${input.pack_key}`);
      const purchased = addCreditDecimals(
        account.credits.purchased_balance,
        pack.credits,
      );
      const total = addCreditDecimals(
        account.credits.subscription_balance,
        purchased.decimal,
      );
      pendingProjection = {
        ...account,
        credits: {
          ...account.credits,
          balance: total.decimal,
          balance_atoms: total.atoms,
          purchased_balance: purchased.decimal,
          purchased_balance_atoms: purchased.atoms,
          credit_packs: [
            ...account.credits.credit_packs,
            {
              lot_id: `demo-lot-${pack.key}`,
              pack_key: pack.key,
              checkout_session_id: `cs_test_demo_${pack.key}`,
              remaining: pack.credits,
              remaining_atoms: pack.credits_atoms,
              expires_at: futureIso(pack.expires_days),
            },
          ],
        },
      };
      projectionPollsRemaining = 1;
      const successUrl = new URL(input.success_url);
      successUrl.searchParams.set("expected_credit_pack", pack.key);
      successUrl.searchParams.set(
        "checkout_session_id",
        `cs_test_demo_${pack.key}`,
      );
      return {
        session_id: `cs_test_demo_${pack.key}`,
        url: successUrl.toString(),
      };
    },
    async createPortal(returnUrl) {
      return {
        session_id: "bps_demo_reference",
        url: `${returnUrl}?portal=demo`,
      };
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
      const targetCredits = planCreditAmount(target);
      if (result.timing === "immediate") {
        const total = addCreditDecimals(
          targetCredits.decimal,
          account.credits.purchased_balance,
        );
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
            balance: total.decimal,
            balance_atoms: total.atoms,
            subscription_balance: targetCredits.decimal,
            subscription_balance_atoms: targetCredits.atoms,
            grant_amount: targetCredits.decimal,
            grant_amount_atoms: targetCredits.atoms,
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
  const selectedCredits = planCreditAmount(selected);
  return {
    account_id: "00000000-0000-0000-0000-000000000001",
    transition_policy: catalog.transition_policy,
    plan_key: selected.key,
    plan_interval: interval,
    subscription_status: "active",
    current_period_end: futureIso(21),
    credits: {
      balance: selectedCredits.decimal,
      balance_atoms: selectedCredits.atoms,
      subscription_balance: selectedCredits.decimal,
      subscription_balance_atoms: selectedCredits.atoms,
      purchased_balance: "0",
      purchased_balance_atoms: "0",
      grant_amount: selectedCredits.decimal,
      grant_amount_atoms: selectedCredits.atoms,
      scale: selectedCredits.scale,
      next_grant_at: futureIso(21),
      credit_packs: [],
    },
    entitlements: selected.entitlements,
    entitlements_enforceable: true,
    pending_change: null,
    pending_cancellation: null,
  };
}
