export {
  asNextRouteHandler,
  createNextBillingRouteHandler,
} from "./route-handler.js";
export type { NextBillingRouteHandler } from "./route-handler.js";
export {
  closeEnvironmentNextBillingRuntime,
  environmentNextBillingRouteHandler,
} from "./environment.js";

// Convenience values for non-Next adapters and contract tests. Next.js applications
// must write these as literal exports in each Route Handler so static analysis sees them.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
