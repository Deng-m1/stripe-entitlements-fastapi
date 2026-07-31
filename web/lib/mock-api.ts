import type {
  AccountResponse,
  BillingApi,
  BillingInterval,
  CatalogPlan,
  CatalogResponse,
  ChangePreview,
  ChangePreviewRequest,
  Entitlement,
} from "@/lib/types";

const featureLabels: Record<string, string> = {
  pdf_to_ppt: "PDF to PowerPoint",
  image_to_ppt: "Image to PowerPoint",
  batch_conversion: "Batch conversion",
  api_access: "API access",
  priority_queue: "Priority queue",
};

const limitLabels: Record<string, { label: string; unit?: string }> = {
  max_file_mb: { label: "Maximum file size", unit: "MB" },
  max_pages_per_job: { label: "Maximum pages per job", unit: "pages" },
  concurrent_jobs: { label: "Concurrent jobs", unit: "jobs" },
  api_keys: { label: "API keys", unit: "keys" },
};

function planEntitlements(
  monthlyCredits: number,
  features: string[],
  limits: Record<string, number>,
): Entitlement[] {
  return [
    {
      key: "monthly_credits",
      label: "Credits per monthly grant",
      value: monthlyCredits,
      unit: "credits",
    },
    ...features.map((key) => ({
      key,
      label: featureLabels[key] ?? key,
      value: true,
    })),
    ...Object.entries(limits).map(([key, value]) => ({
      key,
      label: limitLabels[key]?.label ?? key,
      value,
      unit: limitLabels[key]?.unit,
    })),
  ];
}

const plans: CatalogPlan[] = [
  {
    key: "starter",
    name: "Starter",
    description: "For individuals with a steady monthly workload.",
    display_order: 10,
    prices: {
      month: { currency: "USD", unit_amount: 1900, interval: "month" },
      year: { currency: "USD", unit_amount: 13700, interval: "year" },
    },
    entitlements: planEntitlements(
      300,
      ["pdf_to_ppt", "image_to_ppt"],
      {
        max_file_mb: 30,
        max_pages_per_job: 100,
        concurrent_jobs: 1,
        api_keys: 0,
      },
    ),
  },
  {
    key: "pro",
    name: "Pro",
    description: "For growing teams that need a larger credit grant.",
    display_order: 20,
    prices: {
      month: { currency: "USD", unit_amount: 4900, interval: "month" },
      year: { currency: "USD", unit_amount: 35300, interval: "year" },
    },
    entitlements: planEntitlements(
      1000,
      ["pdf_to_ppt", "image_to_ppt", "batch_conversion", "api_access"],
      {
        max_file_mb: 100,
        max_pages_per_job: 500,
        concurrent_jobs: 5,
        api_keys: 5,
      },
    ),
  },
  {
    key: "ultra",
    name: "Ultra",
    description: "For high-volume product and operations workloads.",
    display_order: 30,
    prices: {
      month: { currency: "USD", unit_amount: 14900, interval: "month" },
      year: { currency: "USD", unit_amount: 107300, interval: "year" },
    },
    entitlements: planEntitlements(
      4000,
      [
        "pdf_to_ppt",
        "image_to_ppt",
        "batch_conversion",
        "api_access",
        "priority_queue",
      ],
      {
        max_file_mb: 250,
        max_pages_per_job: 2000,
        concurrent_jobs: 20,
        api_keys: 25,
      },
    ),
  },
];

const catalog: CatalogResponse = { plans };

function futureIso(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function entitlementsFor(planKey: string) {
  return plans.find((plan) => plan.key === planKey)?.entitlements ?? [];
}

export function createMockBillingApi(
  initial?: Partial<AccountResponse>,
): BillingApi {
  let account: AccountResponse = {
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
      effective_at:
        timing === "immediate"
          ? new Date().toISOString()
          : account.current_period_end ?? futureIso(30),
      currency: targetPrice.currency,
      amount_due_now: timing === "immediate" ? targetPrice.unit_amount : 0,
      credit_applied: creditApplied,
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
          },
        };
      }
      return {
        status: "confirmed",
        timing: result.timing,
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
