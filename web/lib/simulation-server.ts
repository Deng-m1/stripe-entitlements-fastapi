type BillingRouteHandler = (request: Request) => Promise<Response>;
type BillingRouteHandlerLoader = () => Promise<BillingRouteHandler>;

let productionHandler: Promise<BillingRouteHandler> | undefined;

async function loadProductionHandler(): Promise<BillingRouteHandler> {
  productionHandler ??= import("@tosea/stripe-entitlements/next").then(
    ({ environmentNextBillingRouteHandler }) =>
      environmentNextBillingRouteHandler,
  );
  return productionHandler;
}

function simulationDisabled(): Response {
  return new Response(JSON.stringify({ detail: "not found" }), {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function createSimulationSafeBillingRouteHandler(
  mode: string | undefined,
  loadHandler: BillingRouteHandlerLoader = loadProductionHandler,
): BillingRouteHandler {
  if (mode === "simulation") {
    return async () => simulationDisabled();
  }
  return async (request) => (await loadHandler())(request);
}

/** Public simulation never initializes or calls the packaged billing backend. */
export const simulationSafeBillingRouteHandler =
  createSimulationSafeBillingRouteHandler(
    process.env.NEXT_PUBLIC_BILLING_API_MODE,
  );
