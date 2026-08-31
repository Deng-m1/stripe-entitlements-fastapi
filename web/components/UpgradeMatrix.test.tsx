import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UpgradeMatrix } from "@/components/UpgradeMatrix";
import { creditAmountFromDecimal } from "@/lib/credit-amount";
import { referencePlans } from "@/lib/reference-catalog";
import type { CatalogPlan } from "@/lib/types";

function plansWithTargetCredits(credits: string): CatalogPlan[] {
  const starter = referencePlans.find((plan) => plan.key === "starter");
  const pro = referencePlans.find((plan) => plan.key === "pro");
  if (!starter || !pro) throw new Error("reference plans are incomplete");
  const amount = creditAmountFromDecimal(credits);
  return [
    starter,
    {
      ...pro,
      entitlements: pro.entitlements.map((entitlement) =>
        entitlement.key === "monthly_credits"
          ? {
              ...entitlement,
              value: amount.decimal,
              value_atoms: amount.atoms,
              scale: amount.scale,
            }
          : entitlement,
      ),
    },
  ];
}

describe("UpgradeMatrix", () => {
  it("defines all 36 transitions under the prorated-delta policy", () => {
    const { container } = render(<UpgradeMatrix />);
    const table = screen.getByRole("table", {
      name: /Outcome of every plan change under the prorated_delta template/i,
    });

    expect(within(table).getAllByRole("row")).toHaveLength(7);
    expect(container.querySelectorAll("tbody td")).toHaveLength(36);
    expect(container.querySelectorAll("tbody .matrix-dot.noop")).toHaveLength(6);
    expect(container.querySelectorAll("tbody .matrix-dot.immediate")).toHaveLength(3);
    expect(container.querySelectorAll("tbody .matrix-dot.period-end")).toHaveLength(27);
  });

  it("keeps the highlighted Starter-to-Pro settlement tied to catalog credits", () => {
    const { container } = render(<UpgradeMatrix />);
    const highlighted = container.querySelector("td.matrix-highlight");

    expect(highlighted).not.toBeNull();
    expect(highlighted).toHaveTextContent(
      "prorated_delta · paid two-line Invoice · +700 credits · period preserved",
    );
    expect(
      screen.getByText(/prorated_delta settles it immediately/i),
    ).toHaveTextContent("+700 credits");
  });

  it.each(["300", "100"])(
    "schedules a %s-credit higher-rank target without claiming a delta",
    (credits) => {
      const { container } = render(
        <UpgradeMatrix plans={plansWithTargetCredits(credits)} />,
      );
      const highlighted = container.querySelector("td.matrix-highlight");

      expect(highlighted).not.toBeNull();
      expect(highlighted?.querySelector(".matrix-dot.period-end")).not.toBeNull();
      expect(highlighted).toHaveTextContent(
        "non-positive credit difference · scheduled at period end",
      );
      expect(highlighted).not.toHaveTextContent("+-");
      expect(
        screen.getByText(/prorated_delta schedules it at period end/i),
      ).toHaveTextContent("requires a positive credit difference");
    },
  );
});
