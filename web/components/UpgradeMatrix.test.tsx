import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UpgradeMatrix } from "@/components/UpgradeMatrix";

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
});
