export {
  asNextRouteHandler,
  createNextBillingRouteHandler,
} from "./route-handler.js";
export type { NextBillingRouteHandler } from "./route-handler.js";
export {
  closeEnvironmentNextBillingRuntime,
  environmentNextBillingRouteHandler,
} from "./environment.js";

// Re-export these exact literals from each application Route Handler module. They
// keep Stripe/pg on the Node runtime, disable route caching, and bound Vercel work.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
