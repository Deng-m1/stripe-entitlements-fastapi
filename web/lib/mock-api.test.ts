import { describe, expect, it } from "vitest";
import {
  createMockBillingApi,
  demoAccount,
} from "@/lib/mock-api";
import type { BillingInterval } from "@/lib/types";

const variants = [
  ["starter", "month"],
  ["starter", "year"],
  ["pro", "month"],
  ["pro", "year"],
  ["ultra", "month"],
  ["ultra", "year"],
] as const;

const rank = { starter: 1, pro: 2, ultra: 3 } as const;

describe("mock billing contract", () => {
  it("implements the exhaustive safe 6×6 transition matrix", async () => {
    for (const [currentPlan, currentInterval] of variants) {
      for (const [targetPlan, targetInterval] of variants) {
        const api = createMockBillingApi(
          demoAccount(currentPlan, currentInterval as BillingInterval),
        );
        if (currentPlan === targetPlan && currentInterval === targetInterval) {
          await expect(
            api.previewPlanChange({
              plan_key: targetPlan,
              interval: targetInterval,
            }),
          ).rejects.toThrow("unchanged");
          continue;
        }

        const result = await api.previewPlanChange({
          plan_key: targetPlan,
          interval: targetInterval,
        });
        const expected =
          currentInterval === "year"
            ? "period_end"
            : rank[targetPlan] > rank[currentPlan] ||
                (currentPlan === targetPlan &&
                  currentInterval === "month" &&
                  targetInterval === "year")
              ? "immediate"
              : "period_end";
        expect(result.timing, `${currentPlan}/${currentInterval} -> ${targetPlan}/${targetInterval}`).toBe(
          expected,
        );
      }
    }
  });

  it("does not project Checkout entitlements before account polling", async () => {
    const api = createMockBillingApi(demoAccount("starter", "month"));
    await api.createCheckout({
      plan_key: "pro",
      interval: "year",
      success_url: "http://localhost:3000/billing/success",
      cancel_url: "http://localhost:3000/pricing",
    });

    expect((await api.getAccount()).plan_key).toBe("starter");
    expect((await api.getAccount()).plan_key).toBe("pro");
  });

  it("does not project an immediate change from the confirm response", async () => {
    const api = createMockBillingApi(demoAccount("starter", "month"));
    const change = await api.previewPlanChange({
      plan_key: "pro",
      interval: "year",
    });
    const confirmed = await api.confirmPlanChange({ preview_id: change.preview_id });

    expect(confirmed.account?.plan_key).toBe("starter");
    expect((await api.getAccount()).plan_key).toBe("starter");
    expect((await api.getAccount()).plan_key).toBe("pro");
  });
});
