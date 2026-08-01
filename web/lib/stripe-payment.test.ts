import { afterEach, describe, expect, it, vi } from "vitest";

const stripeMocks = vi.hoisted(() => ({
  loadStripe: vi.fn(),
}));

vi.mock("@stripe/stripe-js", () => ({
  loadStripe: stripeMocks.loadStripe,
}));

import { confirmRequiredStripePayment } from "@/lib/stripe-payment";

describe("Stripe payment authentication", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    stripeMocks.loadStripe.mockReset();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("never reflects a client secret from a provider error", async () => {
    const clientSecret = "pi_sensitive_secret_value";
    vi.stubEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "pk_test_safe");
    stripeMocks.loadStripe.mockResolvedValue({
      confirmCardPayment: vi.fn(async () => ({
        error: { message: `Provider echoed ${clientSecret}` },
      })),
    });

    let displayedError = "";
    try {
      await confirmRequiredStripePayment({
        status: "action_required",
        timing: "immediate",
        transition_policy: "full_period_reset",
        target_plan_key: "pro",
        target_interval: "year",
        payment_client_secret: clientSecret,
        payment_confirmation_method: "confirm_card_payment",
      });
    } catch (caught) {
      displayedError = caught instanceof Error ? caught.message : String(caught);
    }

    expect(displayedError).toContain("No plan change was assumed");
    expect(displayedError).not.toContain(clientSecret);
    expect(document.body.textContent).not.toContain(clientSecret);
    expect(JSON.stringify(window.localStorage)).not.toContain(clientSecret);
    expect(JSON.stringify(window.sessionStorage)).not.toContain(clientSecret);
  });
});
