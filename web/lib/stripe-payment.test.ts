import { afterEach, describe, expect, it, vi } from "vitest";

const stripeMocks = vi.hoisted(() => ({
  loadStripe: vi.fn(),
}));

vi.mock("@stripe/stripe-js", () => ({
  loadStripe: stripeMocks.loadStripe,
}));

import { confirmRequiredStripePayment } from "@/lib/stripe-payment";

function confirmationResult(values: Record<string, unknown> = {}) {
  return {
    status: "action_required" as const,
    timing: "immediate" as const,
    transition_policy: "full_period_reset" as const,
    target_plan_key: "pro",
    target_interval: "year" as const,
    payment_client_secret: "pi_safe_secret_value",
    payment_confirmation_method: "confirm_payment" as const,
    ...values,
  };
}


describe("Stripe payment authentication", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    stripeMocks.loadStripe.mockReset();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("accepts only completed PaymentIntent states and keeps webhook projection authoritative", async () => {
    vi.stubEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "pk_test_safe");
    const confirmPayment = vi.fn(async () => ({
      paymentIntent: { status: "processing" },
    }));
    stripeMocks.loadStripe.mockResolvedValue({ confirmPayment });

    await expect(
      confirmRequiredStripePayment(confirmationResult()),
    ).resolves.toBeUndefined();
    expect(confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        clientSecret: "pi_safe_secret_value",
        redirect: "if_required",
      }),
    );
  });

  it.each([undefined, "", "pk_secret_wrong", "sk_test_not_publishable"])(
    "rejects a missing or malformed publishable key: %s",
    async (publishableKey) => {
      if (publishableKey === undefined) {
        vi.stubEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "");
      } else {
        vi.stubEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", publishableKey);
      }
      await expect(
        confirmRequiredStripePayment(confirmationResult()),
      ).rejects.toThrow(/No billing change was assumed/);
      expect(stripeMocks.loadStripe).not.toHaveBeenCalled();
    },
  );

  it("rejects an unknown confirmation method instead of falling back", async () => {
    vi.stubEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "pk_test_safe");
    await expect(
      confirmRequiredStripePayment(
        confirmationResult({ payment_confirmation_method: "future_method" }) as never,
      ),
    ).rejects.toThrow(/unsupported payment confirmation method/);
    expect(stripeMocks.loadStripe).not.toHaveBeenCalled();
  });

  it.each([undefined, "requires_action", "requires_payment_method", "canceled"])(
    "rejects a non-completed PaymentIntent status: %s",
    async (status) => {
      vi.stubEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "pk_test_safe");
      stripeMocks.loadStripe.mockResolvedValue({
        confirmPayment: vi.fn(async () => ({
          paymentIntent: status ? { status } : undefined,
        })),
      });
      await expect(
        confirmRequiredStripePayment(confirmationResult()),
      ).rejects.toThrow(/did not return a completed/);
    },
  );

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
