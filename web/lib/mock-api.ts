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
  parseExactCreditAmount,
} from "@/lib/credit-amount";
import {
  referenceCatalog,
  referenceEntitlements,
  referencePlans,
} from "@/lib/reference-catalog";

const plans = referencePlans;
const catalog = referenceCatalog;
const PUBLIC_SIMULATION_STORAGE_KEY =
  "stripe-entitlements:public-simulation:v1";
const MAX_STORED_SIMULATION_BYTES = 262_144;

export interface MockBillingStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

interface StoredSimulationState {
  readonly version: 1;
  readonly account: AccountResponse;
  readonly pending_projection: AccountResponse | null;
  readonly projection_polls_remaining: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SIMULATION_PLAN_KEYS = new Set([
  "free",
  ...plans.map((plan) => plan.key),
]);
const SIMULATION_PACK_KEYS = new Set(
  catalog.credit_packs.map((pack) => pack.key),
);
const CANONICAL_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function isBoundedString(value: unknown, maximum = 256): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

function isCanonicalUtcInstant(value: unknown): value is string {
  if (!isBoundedString(value, 64) || !CANONICAL_UTC_INSTANT.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function storedCreditAmount(decimal: unknown, atoms: unknown) {
  if (!isBoundedString(decimal, 64) || !isBoundedString(atoms, 64)) {
    return null;
  }
  try {
    return parseExactCreditAmount(decimal, atoms, CREDIT_SCALE);
  } catch {
    return null;
  }
}

function simulationStripeToken(key: string): string {
  return key.replaceAll("-", "_");
}

function isStoredCredits(value: unknown, planKey: string): boolean {
  if (!isRecord(value) || value.scale !== CREDIT_SCALE) return false;

  const balance = storedCreditAmount(value.balance, value.balance_atoms);
  const subscription = storedCreditAmount(
    value.subscription_balance,
    value.subscription_balance_atoms,
  );
  const purchased = storedCreditAmount(
    value.purchased_balance,
    value.purchased_balance_atoms,
  );
  const grant = storedCreditAmount(
    value.grant_amount,
    value.grant_amount_atoms,
  );
  if (!balance || !subscription || !purchased || !grant) return false;

  const selectedPlan = plans.find((plan) => plan.key === planKey);
  const expectedGrant =
    planKey === "free"
      ? creditAmountFromDecimal("0")
      : selectedPlan
        ? planCreditAmount(selectedPlan)
        : null;
  if (
    !expectedGrant ||
    subscription.atoms !== expectedGrant.atoms ||
    grant.atoms !== expectedGrant.atoms ||
    BigInt(balance.atoms) !==
      BigInt(subscription.atoms) + BigInt(purchased.atoms)
  ) {
    return false;
  }

  if (
    (planKey === "free" && value.next_grant_at !== null) ||
    (planKey !== "free" && !isCanonicalUtcInstant(value.next_grant_at))
  ) {
    return false;
  }
  if (!Array.isArray(value.credit_packs) || value.credit_packs.length > 20) {
    return false;
  }

  const lotIds = new Set<string>();
  const checkoutSessionIds = new Set<string>();
  let purchasedAtoms = 0n;
  for (const [index, lot] of value.credit_packs.entries()) {
    if (!isRecord(lot) || !isBoundedString(lot.pack_key, 64)) return false;
    const pack = catalog.credit_packs.find((item) => item.key === lot.pack_key);
    if (!pack || !SIMULATION_PACK_KEYS.has(pack.key)) return false;

    const sequence = String(index + 1);
    const expectedLotId = `simulation-lot-${pack.key}-${sequence}`;
    const expectedCheckoutSessionId = `cs_simulation_${simulationStripeToken(
      pack.key,
    )}_${sequence}`;
    const remaining = storedCreditAmount(lot.remaining, lot.remaining_atoms);
    if (
      lot.lot_id !== expectedLotId ||
      lot.checkout_session_id !== expectedCheckoutSessionId ||
      !remaining ||
      remaining.atoms !== pack.credits_atoms ||
      !isCanonicalUtcInstant(lot.expires_at) ||
      lotIds.has(expectedLotId) ||
      checkoutSessionIds.has(expectedCheckoutSessionId)
    ) {
      return false;
    }
    lotIds.add(expectedLotId);
    checkoutSessionIds.add(expectedCheckoutSessionId);
    purchasedAtoms += BigInt(remaining.atoms);
  }
  return purchasedAtoms === BigInt(purchased.atoms);
}

function isStoredPendingChange(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isBoundedString(value.target_plan_key, 64) &&
    value.target_plan_key !== "free" &&
    SIMULATION_PLAN_KEYS.has(value.target_plan_key) &&
    (value.target_interval === "month" || value.target_interval === "year") &&
    (value.timing === "immediate" || value.timing === "period_end") &&
    isCanonicalUtcInstant(value.effective_at) &&
    value.transition_policy === catalog.transition_policy &&
    (value.status === undefined ||
      [
        "previewed",
        "applying",
        "scheduled",
        "applied",
        "requires_action",
        "completed",
        "failed",
      ].includes(String(value.status))) &&
    (value.payment_url === undefined || value.payment_url === null)
  );
}

function isStoredAccount(value: unknown): value is AccountResponse {
  if (!isRecord(value)) return false;
  const planKey = value.plan_key;
  const interval = value.plan_interval;
  const status = value.subscription_status;
  if (!isBoundedString(planKey, 64) || !SIMULATION_PLAN_KEYS.has(planKey)) {
    return false;
  }
  const expectedEntitlements = referenceEntitlements(planKey);
  const free = planKey === "free";
  return (
    value.account_id === "00000000-0000-0000-0000-000000000002" &&
    value.transition_policy === catalog.transition_policy &&
    (interval === null || interval === "month" || interval === "year") &&
    (status === "none" || status === "active") &&
    ((free && interval === null && status === "none") ||
      (!free && interval !== null && status === "active")) &&
    ((free && value.current_period_end === null) ||
      (!free && isCanonicalUtcInstant(value.current_period_end))) &&
    isStoredCredits(value.credits, planKey) &&
    Array.isArray(value.entitlements) &&
    value.entitlements.length <= 50 &&
    JSON.stringify(value.entitlements) ===
      JSON.stringify(expectedEntitlements) &&
    typeof value.entitlements_enforceable === "boolean" &&
    value.entitlements_enforceable === (planKey !== "free") &&
    (value.pending_change === null ||
      isStoredPendingChange(value.pending_change)) &&
    value.pending_cancellation === null
  );
}

function isStoredSimulationState(
  value: unknown,
): value is StoredSimulationState {
  if (!isRecord(value) || value.version !== 1) return false;
  const account = value.account;
  const pending = value.pending_projection;
  const polls = value.projection_polls_remaining;
  return (
    isStoredAccount(account) &&
    (pending === null || isStoredAccount(pending)) &&
    Number.isSafeInteger(polls) &&
    Number(polls) >= 0 &&
    Number(polls) <= 1 &&
    ((pending === null && polls === 0) || pending !== null)
  );
}

function restoreSimulationState(
  storage: MockBillingStorage | undefined,
): StoredSimulationState | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PUBLIC_SIMULATION_STORAGE_KEY);
    if (raw === null) return null;
    if (
      new TextEncoder().encode(raw).byteLength > MAX_STORED_SIMULATION_BYTES
    ) {
      storage.removeItem(PUBLIC_SIMULATION_STORAGE_KEY);
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredSimulationState(parsed)) {
      storage.removeItem(PUBLIC_SIMULATION_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    try {
      storage.removeItem(PUBLIC_SIMULATION_STORAGE_KEY);
    } catch {
      // The runtime's storage preflight will expose an unavailable simulation.
    }
    return null;
  }
}

export function resetPublicSimulationStorage(
  storage: MockBillingStorage,
): void {
  try {
    storage.removeItem(PUBLIC_SIMULATION_STORAGE_KEY);
  } catch {
    // The next runtime storage preflight will expose an unavailable simulation.
  }
}

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
  if (!entitlement)
    throw new Error(`Plan ${plan.key} has no monthly credit grant.`);
  return creditAmountFromEntitlement(entitlement);
}

export function createMockBillingApi(
  initial?: Partial<AccountResponse>,
  storage?: MockBillingStorage,
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
  const restored = restoreSimulationState(storage);
  if (restored) {
    account = structuredClone(restored.account);
    pendingProjection = structuredClone(restored.pending_projection);
    projectionPollsRemaining = restored.projection_polls_remaining;
  }

  function persist(): void {
    if (!storage) return;
    const state: StoredSimulationState = {
      version: 1,
      account,
      pending_projection: pendingProjection,
      projection_polls_remaining: projectionPollsRemaining,
    };
    storage.setItem(PUBLIC_SIMULATION_STORAGE_KEY, JSON.stringify(state));
  }

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
          : (account.current_period_end ?? futureIso(30)),
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
        persist();
      } else if (pendingProjection) {
        projectionPollsRemaining -= 1;
        persist();
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
      persist();
      const successUrl = new URL(input.success_url);
      successUrl.searchParams.set("expected_plan", target.key);
      successUrl.searchParams.set("expected_interval", input.interval);
      return {
        url: successUrl.toString(),
      };
    },
    async createCreditPackCheckout(input) {
      const pack = catalog.credit_packs.find(
        (item) => item.key === input.pack_key,
      );
      if (!pack) throw new Error(`Unknown demo credit pack: ${input.pack_key}`);
      if (account.credits.credit_packs.length >= 20) {
        throw new Error(
          "Public simulation supports at most 20 active credit-pack lots.",
        );
      }
      const sequence = account.credits.credit_packs.length + 1;
      const checkoutSessionId = `cs_simulation_${simulationStripeToken(
        pack.key,
      )}_${sequence}`;
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
              lot_id: `simulation-lot-${pack.key}-${sequence}`,
              pack_key: pack.key,
              checkout_session_id: checkoutSessionId,
              remaining: pack.credits,
              remaining_atoms: pack.credits_atoms,
              expires_at: futureIso(pack.expires_days),
            },
          ],
        },
      };
      projectionPollsRemaining = 1;
      persist();
      const successUrl = new URL(input.success_url);
      successUrl.searchParams.set("expected_credit_pack", pack.key);
      successUrl.searchParams.set("checkout_session_id", checkoutSessionId);
      return {
        session_id: checkoutSessionId,
        url: successUrl.toString(),
      };
    },
    async createPortal(returnUrl) {
      return {
        session_id: "sim_portal_reference",
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
      if (!result)
        throw new Error("Demo preview expired. Request a new preview.");
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
          current_period_end: futureIso(
            result.target_interval === "year" ? 365 : 30,
          ),
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
        persist();
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
        persist();
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

export function createPublicSimulationBillingApi(
  storage?: MockBillingStorage,
): BillingApi {
  return createMockBillingApi(demoFreeAccount(), storage);
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

export function demoFreeAccount(): AccountResponse {
  const zero = creditAmountFromDecimal("0");
  return {
    account_id: "00000000-0000-0000-0000-000000000002",
    transition_policy: catalog.transition_policy,
    plan_key: "free",
    plan_interval: null,
    subscription_status: "none",
    current_period_end: null,
    credits: {
      balance: zero.decimal,
      balance_atoms: zero.atoms,
      subscription_balance: zero.decimal,
      subscription_balance_atoms: zero.atoms,
      purchased_balance: zero.decimal,
      purchased_balance_atoms: zero.atoms,
      grant_amount: zero.decimal,
      grant_amount_atoms: zero.atoms,
      scale: zero.scale,
      next_grant_at: null,
      credit_packs: [],
    },
    entitlements: [],
    entitlements_enforceable: false,
    pending_change: null,
    pending_cancellation: null,
  };
}
