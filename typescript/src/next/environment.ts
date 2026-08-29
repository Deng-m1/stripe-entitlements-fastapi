import {
  createBillingRuntimeFromEnvironment,
  type BillingRuntime,
} from "../deployment.js";
import type { NextBillingRouteHandler } from "./route-handler.js";

let sharedRuntime: Promise<BillingRuntime> | undefined;

function unavailable(): Response {
  return new Response(
    JSON.stringify({ detail: "billing service is unavailable" }),
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        Pragma: "no-cache",
        "Retry-After": "5",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function runtimeFromEnvironment(): Promise<BillingRuntime> {
  sharedRuntime ??= createBillingRuntimeFromEnvironment(process.env).catch(
    (error: unknown) => {
      sharedRuntime = undefined;
      throw error;
    },
  );
  return sharedRuntime;
}

/**
 * Lazily share one connected kernel across warm Next.js Node invocations.
 * Initialization failures are sanitized and retried by a later request.
 */
export const environmentNextBillingRouteHandler: NextBillingRouteHandler =
  async (request): Promise<Response> => {
    try {
      return await (await runtimeFromEnvironment()).handler(request);
    } catch {
      return unavailable();
    }
  };

/** Close the warm singleton for tests and controlled process shutdown. */
export async function closeEnvironmentNextBillingRuntime(): Promise<void> {
  const pending = sharedRuntime;
  sharedRuntime = undefined;
  if (pending !== undefined) {
    await (await pending).close();
  }
}
