import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProductBento } from "@/components/ProductBento";

describe("ProductBento", () => {
  it("renders the four product-surface cards", () => {
    render(<ProductBento />);
    for (const title of [
      "Webhook inbox",
      "Entitlement projection",
      "Upgrade preview",
      "Test gates",
    ]) {
      expect(
        screen.getByRole("heading", { level: 3, name: title }),
      ).toBeInTheDocument();
    }
  });

  it("keeps the artifacts idempotency-honest and catalog-true", () => {
    render(<ProductBento />);
    // The duplicate delivery is absorbed as a no-op, never double-applied.
    expect(screen.getByText("invoice.paid · redelivery")).toBeInTheDocument();
    expect(screen.getByText("already claimed")).toBeInTheDocument();
    expect(screen.getByText("no-op")).toBeInTheDocument();
    // The upgrade preview prices the catalog delta (Pro 1,000 → Ultra 4,000).
    expect(screen.getByText("prorated_delta")).toBeInTheDocument();
    expect(
      screen.getByText("+3,000 monthly credits · period preserved"),
    ).toBeInTheDocument();
    // The projection reads catalog entitlements, not invented ones.
    expect(screen.getByText("monthly_credits")).toBeInTheDocument();
    expect(screen.getByText("granted by invoice.paid · grant epoch 7")).toBeInTheDocument();
  });

  it("composes each card's artifact behind a depth stack", () => {
    const { container } = render(<ProductBento />);
    expect(container.querySelectorAll(".bento-card")).toHaveLength(4);
    expect(container.querySelectorAll(".bento-ghost")).toHaveLength(4);
    expect(container.querySelectorAll(".bento-glow")).toHaveLength(4);
    // Two distinct parallax rates: atmosphere leads, grid lags (§3.2).
    expect(
      container.querySelector(".bento-atmosphere")?.getAttribute("data-depth"),
    ).toBe("-12");
    expect(
      container.querySelector(".bento-grid")?.getAttribute("data-depth"),
    ).toBe("16");
  });
});
