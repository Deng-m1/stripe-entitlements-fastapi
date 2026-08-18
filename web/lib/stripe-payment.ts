import { loadStripe } from "@stripe/stripe-js";
import type { ChangeConfirmResponse } from "@/lib/types";

export async function confirmRequiredStripePayment(
  result: ChangeConfirmResponse,
): Promise<void> {
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new Error(
      "Additional payment authentication is required, but NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not configured. No billing change was assumed.",
    );
  }
  if (!/^pk_(?:test|live)_[A-Za-z0-9]+$/.test(publishableKey)) {
    throw new Error(
      "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is invalid. No billing change was assumed.",
    );
  }
  if (!result.payment_client_secret) {
    throw new Error(
      "The billing API returned payment_required without a payment_client_secret.",
    );
  }
  const method = result.payment_confirmation_method;
  if (method !== "confirm_payment" && method !== "confirm_card_payment") {
    throw new Error(
      "The billing API returned an unsupported payment confirmation method. No billing change was assumed.",
    );
  }

  const stripe = await loadStripe(publishableKey);
  if (!stripe) {
    throw new Error("Stripe.js could not be initialized.");
  }

  let confirmation;
  try {
    confirmation =
      method === "confirm_payment"
        ? await stripe.confirmPayment({
            clientSecret: result.payment_client_secret,
            confirmParams: {
              return_url: successUrl(result),
            },
            redirect: "if_required",
          })
        : await stripe.confirmCardPayment(result.payment_client_secret);
  } catch {
    throw new Error(
      "Stripe could not authenticate the payment. No plan change was assumed.",
    );
  }

  if (confirmation.error) {
    // Provider messages are not reflected verbatim: request details, including
    // client secrets, must never enter the DOM, logs, URLs, or browser storage.
    throw new Error(
      "Stripe could not authenticate the payment. No plan change was assumed.",
    );
  }
  const status = confirmation.paymentIntent?.status;
  if (
    status !== "succeeded" &&
    status !== "processing" &&
    status !== "requires_capture"
  ) {
    throw new Error(
      "Stripe did not return a completed payment authentication state. No billing change was assumed.",
    );
  }
}

export function successUrl(result: ChangeConfirmResponse): string {
  const url = new URL("/billing/success", window.location.origin);
  url.searchParams.set("expected_plan", result.target_plan_key);
  url.searchParams.set("expected_interval", result.target_interval);
  return url.toString();
}
