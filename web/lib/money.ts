import type { BillingInterval, CatalogPlan, Price } from "@/lib/types";

export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount / 100);
}

export function priceFor(plan: CatalogPlan, interval: BillingInterval): Price {
  return plan.prices[interval];
}

export function annualEquivalentMonthly(plan: CatalogPlan): number {
  return plan.prices.year.unit_amount / 12;
}

export function annualSavings(plan: CatalogPlan): number | null {
  const month = plan.prices.month;
  const year = plan.prices.year;
  if (month.currency.toUpperCase() !== year.currency.toUpperCase()) return null;
  const savings = month.unit_amount * 12 - year.unit_amount;
  return savings > 0 ? savings : null;
}

export function formatDate(value: string | null): string {
  if (!value) return "Not scheduled";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
