import {
  createDemoBearerAuth,
  createE2ERouteAuth,
  noAuthAdapter,
} from "@/lib/auth";
import {
  createHttpBillingApi,
  SAME_ORIGIN_BILLING_API,
} from "@/lib/http-api";
import {
  createMockBillingApi,
  createPublicSimulationBillingApi,
  resetPublicSimulationStorage,
  type MockBillingStorage,
} from "@/lib/mock-api";
import type { BillingApi, Redirect } from "@/lib/types";

const configuredMode = process.env.NEXT_PUBLIC_BILLING_API_MODE;
export const billingApiMode =
  configuredMode === "mock" ||
  configuredMode === "simulation" ||
  configuredMode === "http"
    ? configuredMode
    : process.env.NODE_ENV === "production"
      ? "http"
      : "mock";

const demoToken = process.env.NEXT_PUBLIC_DEMO_BEARER_TOKEN;
const simulationAcknowledgement =
  process.env.NEXT_PUBLIC_SIMULATION_ACKNOWLEDGEMENT;
const e2eRouteAuthSentinel =
  process.env.NEXT_PUBLIC_E2E_ROUTE_AUTH_SENTINEL;
export const publicSimulationMode = billingApiMode === "simulation";
export const usesDemoConfiguration =
  billingApiMode === "mock" ||
  publicSimulationMode ||
  Boolean(demoToken) ||
  Boolean(e2eRouteAuthSentinel);

export function isUnsafeProductionDemoConfiguration(
  environment: string | undefined,
  mode: "mock" | "simulation" | "http",
  token: string | undefined,
  allowIndexing?: string,
  acknowledgement?: string,
): boolean {
  if (environment !== "production") return false;
  if (mode === "mock" || Boolean(token)) return true;
  if (mode !== "simulation") return false;
  return acknowledgement !== "1" || allowIndexing !== "false";
}

export const unsafeProductionDemoConfiguration =
  isUnsafeProductionDemoConfiguration(
    process.env.NODE_ENV,
    billingApiMode,
    demoToken,
    process.env.NEXT_PUBLIC_ALLOW_INDEXING,
    simulationAcknowledgement,
  );

export function configuredBillingApiBaseUrl(
  value: string | undefined,
): string {
  return value ?? SAME_ORIGIN_BILLING_API;
}

let runtimeApi: BillingApi | undefined;

const SIMULATION_STORAGE_PROBE =
  "stripe-entitlements:public-simulation:storage-probe";
const SIMULATION_STORAGE_ERROR =
  "Public simulation requires available browser sessionStorage. Enable session storage or open the demo in a standard browser tab; no billing request was sent.";

export function isUsableSimulationStorage(
  storage: MockBillingStorage,
): boolean {
  let previous: string | null = null;
  let wroteProbe = false;
  let usable = false;
  try {
    previous = storage.getItem(SIMULATION_STORAGE_PROBE);
    storage.setItem(SIMULATION_STORAGE_PROBE, "1");
    wroteProbe = true;
    usable = storage.getItem(SIMULATION_STORAGE_PROBE) === "1";
  } catch {
    usable = false;
  } finally {
    if (wroteProbe) {
      try {
        if (previous === null) storage.removeItem(SIMULATION_STORAGE_PROBE);
        else storage.setItem(SIMULATION_STORAGE_PROBE, previous);
      } catch {
        usable = false;
      }
    }
  }
  return usable;
}

function browserSimulationStorage(): MockBillingStorage | null | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const storage = window.sessionStorage;
    return isUsableSimulationStorage(storage) ? storage : null;
  } catch {
    return null;
  }
}

function unavailablePublicSimulationApi(): BillingApi {
  async function unavailable<T>(): Promise<T> {
    throw new Error(SIMULATION_STORAGE_ERROR);
  }
  return {
    getCatalog: unavailable,
    getAccount: unavailable,
    createCheckout: unavailable,
    createCreditPackCheckout: unavailable,
    createPortal: unavailable,
    previewPlanChange: unavailable,
    confirmPlanChange: unavailable,
  };
}

export function resetPublicSimulation(): void {
  if (!publicSimulationMode) return;
  const storage = browserSimulationStorage();
  if (storage) resetPublicSimulationStorage(storage);
  runtimeApi = undefined;
}

export function getBillingApi(): BillingApi {
  if (unsafeProductionDemoConfiguration) {
    throw new Error(
      "The public billing configuration is unsafe for production. Use HTTP mode, or an explicitly acknowledged credential-free noindex simulation.",
    );
  }
  if (runtimeApi) return runtimeApi;
  if (publicSimulationMode) {
    const storage = browserSimulationStorage();
    runtimeApi =
      storage === null
        ? unavailablePublicSimulationApi()
        : createPublicSimulationBillingApi(storage);
  } else {
    runtimeApi =
      billingApiMode === "mock"
        ? createMockBillingApi()
        : createHttpBillingApi({
          baseUrl: configuredBillingApiBaseUrl(
            process.env.NEXT_PUBLIC_BILLING_API_BASE_URL,
          ),
          auth: demoToken
            ? createDemoBearerAuth(demoToken)
            : e2eRouteAuthSentinel
              ? createE2ERouteAuth(e2eRouteAuthSentinel)
              : noAuthAdapter,
        });
  }
  return runtimeApi;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

function parseRedirect(
  url: string,
  origin: string,
  environment: string | undefined,
): { destination: URL; applicationOrigin: URL } {
  let destination: URL;
  let applicationOrigin: URL;
  try {
    applicationOrigin = new URL(origin);
    destination = new URL(url, applicationOrigin);
  } catch {
    throw new Error("Billing redirect URL is invalid.");
  }
  if (destination.username || destination.password) {
    throw new Error("Billing redirect URL must not contain credentials.");
  }
  const secure = destination.protocol === "https:";
  const localDevelopment =
    destination.protocol === "http:" &&
    environment !== "production" &&
    isLoopbackHostname(destination.hostname);
  if (!secure && !localDevelopment) {
    throw new Error(
      "Billing redirects require HTTPS (loopback HTTP is allowed outside production).",
    );
  }
  return { destination, applicationOrigin };
}

export function internalRedirectUrl(
  url: string,
  origin: string,
  environment = process.env.NODE_ENV,
): string {
  const { destination, applicationOrigin } = parseRedirect(
    url,
    origin,
    environment,
  );
  if (destination.origin !== applicationOrigin.origin) {
    throw new Error("Internal billing redirects must stay on the application origin.");
  }
  return destination.toString();
}

export function billingRedirectUrl(
  url: string,
  origin: string,
  environment = process.env.NODE_ENV,
): string {
  const { destination, applicationOrigin } = parseRedirect(
    url,
    origin,
    environment,
  );
  const stripeHost =
    destination.hostname === "stripe.com" ||
    destination.hostname.endsWith(".stripe.com");
  if (destination.origin !== applicationOrigin.origin && !stripeHost) {
    throw new Error(
      "Billing redirects may only use this application or an HTTPS Stripe host.",
    );
  }
  if (stripeHost && destination.protocol !== "https:") {
    throw new Error("Stripe billing redirects require HTTPS.");
  }
  return destination.toString();
}

export function publicSimulationRedirectUrl(
  url: string,
  origin: string,
): string {
  let destination: URL;
  let applicationOrigin: URL;
  try {
    applicationOrigin = new URL(origin);
    destination = new URL(url, applicationOrigin);
  } catch {
    throw new Error("Public simulation redirect URL is invalid.");
  }
  if (
    destination.username ||
    destination.password ||
    destination.origin !== applicationOrigin.origin
  ) {
    throw new Error("Public simulation redirects must stay on this application origin.");
  }
  const secure = destination.protocol === "https:";
  const loopback =
    destination.protocol === "http:" &&
    isLoopbackHostname(destination.hostname);
  if (!secure && !loopback) {
    throw new Error(
      "Public simulation redirects require HTTPS (loopback HTTP is allowed for local tests).",
    );
  }
  return destination.toString();
}

export const browserInternalRedirect: Redirect = (url) => {
  window.location.assign(
    publicSimulationMode
      ? publicSimulationRedirectUrl(url, window.location.origin)
      : internalRedirectUrl(url, window.location.origin),
  );
};

export const browserBillingRedirect: Redirect = (url) => {
  window.location.assign(
    publicSimulationMode
      ? publicSimulationRedirectUrl(url, window.location.origin)
      : billingRedirectUrl(url, window.location.origin),
  );
};
