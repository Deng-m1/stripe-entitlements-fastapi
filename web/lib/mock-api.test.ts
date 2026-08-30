import { describe, expect, it } from "vitest";
import {
  createMockBillingApi,
  createPublicSimulationBillingApi,
  demoAccount,
  resetPublicSimulationStorage,
  type MockBillingStorage,
} from "@/lib/mock-api";
import type { AccountResponse, BillingInterval } from "@/lib/types";

const variants = [
  ["starter", "month"],
  ["starter", "year"],
  ["pro", "month"],
  ["pro", "year"],
  ["ultra", "month"],
  ["ultra", "year"],
] as const;

const rank = { starter: 1, pro: 2, ultra: 3 } as const;

function memoryStorage(): MockBillingStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

interface MutableStoredSimulationState {
  version: number;
  account: AccountResponse;
  pending_projection: AccountResponse | null;
  projection_polls_remaining: number;
}

describe("mock billing contract", () => {
  it("uses the exact decimal/atoms contract for account and catalog credits", async () => {
    const account = demoAccount("pro", "month");
    expect(account.credits).toMatchObject({
      balance: "1000",
      balance_atoms: "1000000000",
      grant_amount: "1000",
      grant_amount_atoms: "1000000000",
      scale: 1_000_000,
    });

    const monthlyCredits = (await createMockBillingApi().getCatalog()).plans
      .find((plan) => plan.key === "pro")
      ?.entitlements.find(
        (entitlement) => entitlement.key === "monthly_credits",
      );
    expect(monthlyCredits).toMatchObject({
      value: "1000",
      value_atoms: "1000000000",
      scale: 1_000_000,
    });
  });

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
        expect(
          result.timing,
          `${currentPlan}/${currentInterval} -> ${targetPlan}/${targetInterval}`,
        ).toBe(expected);
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
    const confirmed = await api.confirmPlanChange({
      preview_id: change.preview_id,
    });

    expect(confirmed.account?.plan_key).toBe("starter");
    expect((await api.getAccount()).plan_key).toBe("starter");
    expect((await api.getAccount()).plan_key).toBe("pro");
  });

  it("persists subscription, upgrade, and credit-pack projection across navigation", async () => {
    const storage = memoryStorage();
    let api = createPublicSimulationBillingApi(storage);
    expect((await api.getAccount()).plan_key).toBe("free");

    await api.createCheckout({
      plan_key: "starter",
      interval: "month",
      success_url: "https://demo.example/billing/success",
      cancel_url: "https://demo.example/pricing",
    });
    api = createPublicSimulationBillingApi(storage);
    expect((await api.getAccount()).plan_key).toBe("free");
    expect((await api.getAccount()).plan_key).toBe("starter");

    const preview = await api.previewPlanChange({
      plan_key: "pro",
      interval: "month",
    });
    await api.confirmPlanChange({ preview_id: preview.preview_id });
    api = createPublicSimulationBillingApi(storage);
    expect((await api.getAccount()).plan_key).toBe("starter");
    expect((await api.getAccount()).plan_key).toBe("pro");

    const pack = (await api.getCatalog()).credit_packs[0];
    await api.createCreditPackCheckout({
      pack_key: pack.key,
      success_url: "https://demo.example/billing/success",
      cancel_url: "https://demo.example/pricing",
    });
    api = createPublicSimulationBillingApi(storage);
    expect((await api.getAccount()).credits.credit_packs).toHaveLength(0);
    const projected = await api.getAccount();
    expect(projected.credits.credit_packs).toEqual([
      expect.objectContaining({
        pack_key: pack.key,
        checkout_session_id: `cs_simulation_${pack.key.replaceAll("-", "_")}_1`,
      }),
    ]);

    api = createPublicSimulationBillingApi(storage);
    expect((await api.getAccount()).plan_key).toBe("pro");
    expect((await api.getAccount()).credits.credit_packs).toHaveLength(1);
  });

  it("isolates browser sessions and resets or repairs stored simulation state", async () => {
    const first = memoryStorage();
    const second = memoryStorage();
    const firstApi = createPublicSimulationBillingApi(first);
    await firstApi.createCheckout({
      plan_key: "starter",
      interval: "month",
      success_url: "https://demo.example/billing/success",
      cancel_url: "https://demo.example/pricing",
    });
    await firstApi.getAccount();
    await firstApi.getAccount();
    expect(
      (await createPublicSimulationBillingApi(first).getAccount()).plan_key,
    ).toBe("starter");
    expect(
      (await createPublicSimulationBillingApi(second).getAccount()).plan_key,
    ).toBe("free");

    resetPublicSimulationStorage(first);
    expect(
      (await createPublicSimulationBillingApi(first).getAccount()).plan_key,
    ).toBe("free");

    let removed = false;
    const corrupt: MockBillingStorage = {
      getItem: () => "{not-json",
      removeItem: () => {
        removed = true;
      },
      setItem: () => undefined,
    };
    expect(
      (await createPublicSimulationBillingApi(corrupt).getAccount()).plan_key,
    ).toBe("free");
    expect(removed).toBe(true);
  });

  it("fails a cross-page mutation when durable browser state cannot be saved", async () => {
    const denied: MockBillingStorage = {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new Error("storage denied");
      },
    };
    const api = createPublicSimulationBillingApi(denied);

    await expect(
      api.createCheckout({
        plan_key: "starter",
        interval: "month",
        success_url: "https://demo.example/billing/success",
        cancel_url: "https://demo.example/pricing",
      }),
    ).rejects.toThrow("storage denied");
  });

  it("resets syntactically valid but semantically tampered browser state", async () => {
    let persisted: string | null = null;
    let removed = false;
    const storage: MockBillingStorage = {
      getItem: () => persisted,
      removeItem: () => {
        removed = true;
        persisted = null;
      },
      setItem: (_key, value) => {
        persisted = value;
      },
    };
    const api = createPublicSimulationBillingApi(storage);
    await api.createCheckout({
      plan_key: "starter",
      interval: "month",
      success_url: "https://demo.example/billing/success",
      cancel_url: "https://demo.example/pricing",
    });
    await api.getAccount();
    await api.getAccount();
    await api.createCreditPackCheckout({
      pack_key: "boost-100",
      success_url: "https://demo.example/billing/success",
      cancel_url: "https://demo.example/pricing",
    });
    await api.getAccount();
    await api.getAccount();
    if (persisted === null) {
      throw new Error("expected persisted public-simulation state");
    }
    const baseline = JSON.parse(persisted) as MutableStoredSimulationState;

    const tamperCases: ReadonlyArray<
      readonly [string, (state: MutableStoredSimulationState) => void]
    > = [
      [
        "decimal and atoms disagree",
        (state) => {
          state.account.credits.balance_atoms = "1";
        },
      ],
      [
        "balance no longer equals its funding sources",
        (state) => {
          state.account.credits.balance = "999";
          state.account.credits.balance_atoms = "999000000";
        },
      ],
      [
        "grant differs from the canonical plan",
        (state) => {
          state.account.credits.grant_amount = "301";
          state.account.credits.grant_amount_atoms = "301000000";
        },
      ],
      [
        "period timestamp is not a valid canonical instant",
        (state) => {
          state.account.current_period_end = "2026-02-30T00:00:00.000Z";
        },
      ],
      [
        "pack amount differs from the catalog",
        (state) => {
          const lot = state.account.credits.credit_packs[0];
          if (!lot) throw new Error("expected baseline credit-pack lot");
          lot.remaining = "99";
          lot.remaining_atoms = "99000000";
        },
      ],
      [
        "pack identities are duplicated",
        (state) => {
          const lot = state.account.credits.credit_packs[0];
          if (!lot) throw new Error("expected baseline credit-pack lot");
          state.account.credits.credit_packs.push(structuredClone(lot));
          state.account.credits.purchased_balance = "200";
          state.account.credits.purchased_balance_atoms = "200000000";
          state.account.credits.balance = "500";
          state.account.credits.balance_atoms = "500000000";
        },
      ],
      [
        "entitlements differ from the canonical plan",
        (state) => {
          state.account.entitlements = [];
        },
      ],
    ];

    for (const [label, tamper] of tamperCases) {
      const candidate = structuredClone(baseline);
      tamper(candidate);
      persisted = JSON.stringify(candidate);
      removed = false;

      const repaired =
        await createPublicSimulationBillingApi(storage).getAccount();

      expect(repaired.plan_key, label).toBe("free");
      expect(repaired.credits.balance, label).toBe("0");
      expect(removed, label).toBe(true);
    }
  });
});
