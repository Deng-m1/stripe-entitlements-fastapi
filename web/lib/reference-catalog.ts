import type {
  CatalogCreditPack,
  CatalogPlan,
  CatalogResponse,
  Entitlement,
} from "@/lib/types";
import { creditAmountFromDecimal } from "@/lib/credit-amount";
import referenceCatalogSource from "@/reference-catalog.json";

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
  monthlyCredits: string,
  features: string[],
  limits: Record<string, number>,
): Entitlement[] {
  const creditAmount = creditAmountFromDecimal(monthlyCredits);
  return [
    {
      key: "monthly_credits",
      label: "Credits per monthly grant",
      value: creditAmount.decimal,
      value_atoms: creditAmount.atoms,
      scale: creditAmount.scale,
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

interface ReferencePlanSource {
  key: string;
  name: string;
  description: string;
  currency: string;
  rank: number;
  monthly_credits: string;
  month_usd: number;
  year_usd: number;
  features: string[];
  limits: Record<string, number>;
}

interface ReferenceCreditPackSource {
  key: string;
  name: string;
  description: string;
  currency: string;
  rank: number;
  credits: string;
  price_usd: number;
  expires_days: number;
}

/** Public build-time catalog used by the landing and initial pricing HTML. */
export const referencePlans: CatalogPlan[] = (
  referenceCatalogSource.plans as ReferencePlanSource[]
).map((plan) => ({
  key: plan.key,
  name: plan.name,
  description: plan.description,
  display_order: plan.rank,
  prices: {
    month: {
      currency: plan.currency,
      unit_amount: plan.month_usd * 100,
      interval: "month",
    },
    year: {
      currency: plan.currency,
      unit_amount: plan.year_usd * 100,
      interval: "year",
    },
  },
  entitlements: planEntitlements(
    plan.monthly_credits,
    plan.features,
    plan.limits,
  ),
}));

export const referenceCreditPacks: CatalogCreditPack[] = (
  referenceCatalogSource.credit_packs as ReferenceCreditPackSource[]
).map((pack) => {
  const credits = creditAmountFromDecimal(pack.credits);
  return {
    key: pack.key,
    name: pack.name,
    description: pack.description,
    display_order: pack.rank,
    credits: credits.decimal,
    credits_atoms: credits.atoms,
    credit_scale: credits.scale,
    price: {
      currency: pack.currency,
      unit_amount: pack.price_usd * 100,
    },
    expires_days: pack.expires_days,
  };
});

export const referenceCatalog: CatalogResponse = {
  transition_policy: "full_period_reset",
  plans: referencePlans,
  credit_packs: referenceCreditPacks,
};

export function referenceEntitlements(planKey: string): Entitlement[] {
  return referencePlans.find((plan) => plan.key === planKey)?.entitlements ?? [];
}
