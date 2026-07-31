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
  if (!result.payment_client_secret) {
    throw new Error(
      "The billing API returned payment_required without a payment_client_secret.",
    );
  }

  const stripe = await loadStripe(publishableKey);
  if (!stripe) {
    throw new Error("Stripe.js could not be initialized.");
  }

  const method = result.payment_confirmation_method ?? "confirm_card_payment";
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
}

export function successUrl(result: ChangeConfirmResponse): string {
  const url = new URL("/billing/success", window.location.origin);
  url.searchParams.set("expected_plan", result.target_plan_key);
  url.searchParams.set("expected_interval", result.target_interval);
  return url.toString();
}
