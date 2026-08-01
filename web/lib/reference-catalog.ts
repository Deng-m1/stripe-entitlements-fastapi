import type {
  CatalogPlan,
  CatalogResponse,
  Entitlement,
} from "@/lib/types";
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

interface ReferencePlanSource {
  key: string;
  name: string;
  description: string;
  currency: string;
  rank: number;
  monthly_credits: number;
  month_usd: number;
  year_usd: number;
  features: string[];
  limits: Record<string, number>;
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

export const referenceCatalog: CatalogResponse = { plans: referencePlans };

export function referenceEntitlements(planKey: string): Entitlement[] {
  return referencePlans.find((plan) => plan.key === planKey)?.entitlements ?? [];
}
