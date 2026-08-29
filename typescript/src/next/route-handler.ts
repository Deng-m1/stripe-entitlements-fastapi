import type {
  BillingFetchHandler,
  BillingFetchHandlerOptions,
} from "../http/contracts.js";
import { createBillingFetchHandler } from "../http/handler.js";

export type NextBillingRouteHandler = (request: Request) => Promise<Response>;

/**
 * Adapt the framework-neutral handler to the standard Next.js Route Handler
 * signature without introducing a runtime dependency on Next itself.
 */
export function asNextRouteHandler(
  handler: BillingFetchHandler,
): NextBillingRouteHandler {
  return (request: Request): Promise<Response> => handler(request);
}

export function createNextBillingRouteHandler(
  options: BillingFetchHandlerOptions,
): NextBillingRouteHandler {
  return asNextRouteHandler(createBillingFetchHandler(options));
}
