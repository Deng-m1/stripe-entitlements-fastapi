import postgresGlobalSetup from "../support/postgres-global-setup.js";
import { optionalStripeTestSecret } from "./guard.js";

export default async function realStripeGlobalSetup(): Promise<
  () => Promise<void>
> {
  const key = optionalStripeTestSecret(process.env["STRIPE_SECRET_KEY"]);
  if (key === undefined) {
    return async () => undefined;
  }
  // The key was validated before Docker startup and before any Stripe client or
  // network-capable object is constructed.
  return postgresGlobalSetup();
}
