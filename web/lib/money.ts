import type { BillingInterval, CatalogPlan, Price } from "@/lib/types";

export function formatMoney(
  amount: number,
  currency: string,
  locale = "en-US",
): string {
  return new Intl.NumberFormat(locale, {
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

/**
 * Percentage saved by paying the explicit annual catalog price instead of
 * twelve monthly invoices. This is display math over catalog amounts only;
 * it never represents a Stripe Coupon or promotion code.
 */
export function annualSavingsPercent(plan: CatalogPlan): number | null {
  const savings = annualSavings(plan);
  if (savings === null) return null;
  const monthlyTotal = plan.prices.month.unit_amount * 12;
  if (monthlyTotal <= 0) return null;
  return Math.round((savings / monthlyTotal) * 100);
}

export function formatDate(value: string | null, locale = "en-US"): string {
  if (!value) return locale.toLowerCase().startsWith("zh") ? "未安排" : "Not scheduled";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
