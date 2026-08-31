import { describe, expect, it } from "vitest";
import {
  annualEquivalentMonthly,
  annualSavings,
  annualSavingsPercent,
  formatMoney,
} from "@/lib/money";
import { demoCatalog } from "@/lib/mock-api";
import type { CatalogPlan } from "@/lib/types";

describe("annual pricing display math", () => {
  it.each([
    ["starter", "$137.00", "$11.42", "$91.00", 40],
    ["pro", "$353.00", "$29.42", "$235.00", 40],
    ["ultra", "$1,073.00", "$89.42", "$715.00", 40],
  ])(
    "uses the explicit annual price for %s",
    (planKey, annualTotal, monthlyEquivalent, savings, savingsPercent) => {
      const plan = demoCatalog().plans.find((item) => item.key === planKey);
      expect(plan).toBeDefined();
      if (!plan) return;

      expect(formatMoney(plan.prices.year.unit_amount, "USD")).toBe(annualTotal);
      expect(formatMoney(annualEquivalentMonthly(plan), "USD")).toBe(
        monthlyEquivalent,
      );
      expect(formatMoney(annualSavings(plan) ?? 0, "USD")).toBe(savings);
      expect(annualSavingsPercent(plan)).toBe(savingsPercent);
    },
  );

  it("does not claim savings across currencies or for a non-discounted year", () => {
    const base = demoCatalog().plans[0];
    const mismatched: CatalogPlan = {
      ...base,
      prices: {
        ...base.prices,
        year: { ...base.prices.year, currency: "EUR" },
      },
    };
    const noDiscount: CatalogPlan = {
      ...base,
      prices: {
        ...base.prices,
        year: { ...base.prices.year, unit_amount: base.prices.month.unit_amount * 12 },
      },
    };
    const annualPremium: CatalogPlan = {
      ...base,
      prices: {
        ...base.prices,
        year: {
          ...base.prices.year,
          unit_amount: base.prices.month.unit_amount * 12 + 1,
        },
      },
    };

    expect(annualSavings(mismatched)).toBeNull();
    expect(annualSavings(noDiscount)).toBeNull();
    expect(annualSavings(annualPremium)).toBeNull();
    expect(annualSavingsPercent(mismatched)).toBeNull();
    expect(annualSavingsPercent(noDiscount)).toBeNull();
    expect(annualSavingsPercent(annualPremium)).toBeNull();
  });
});
