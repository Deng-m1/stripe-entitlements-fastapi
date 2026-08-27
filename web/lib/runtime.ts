import {
  createDemoBearerAuth,
  createE2ERouteAuth,
  noAuthAdapter,
} from "@/lib/auth";
import { createHttpBillingApi } from "@/lib/http-api";
import { createMockBillingApi } from "@/lib/mock-api";
import type { BillingApi, Redirect } from "@/lib/types";

const configuredMode = process.env.NEXT_PUBLIC_BILLING_API_MODE;
export const billingApiMode =
  configuredMode === "mock" || configuredMode === "http"
    ? configuredMode
    : process.env.NODE_ENV === "production"
      ? "http"
      : "mock";

const demoToken = process.env.NEXT_PUBLIC_DEMO_BEARER_TOKEN;
const e2eRouteAuthSentinel =
  process.env.NEXT_PUBLIC_E2E_ROUTE_AUTH_SENTINEL;
export const usesDemoConfiguration =
  billingApiMode === "mock" ||
  Boolean(demoToken) ||
  Boolean(e2eRouteAuthSentinel);

export function isUnsafeProductionDemoConfiguration(
  environment: string | undefined,
  mode: "mock" | "http",
  token: string | undefined,
): boolean {
  return environment === "production" && (mode === "mock" || Boolean(token));
}

export const unsafeProductionDemoConfiguration =
  isUnsafeProductionDemoConfiguration(
    process.env.NODE_ENV,
    billingApiMode,
    demoToken,
  );

let runtimeApi: BillingApi | undefined;

export function getBillingApi(): BillingApi {
  if (unsafeProductionDemoConfiguration) {
    throw new Error(
      "Demo billing mode and browser-exposed demo authentication are disabled in production.",
    );
  }
  if (runtimeApi) return runtimeApi;
  runtimeApi =
    billingApiMode === "mock"
      ? createMockBillingApi()
      : createHttpBillingApi({
          baseUrl: process.env.NEXT_PUBLIC_BILLING_API_BASE_URL ?? "",
          auth: demoToken
            ? createDemoBearerAuth(demoToken)
            : e2eRouteAuthSentinel
              ? createE2ERouteAuth(e2eRouteAuthSentinel)
              : noAuthAdapter,
        });
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

export const browserInternalRedirect: Redirect = (url) => {
  window.location.assign(internalRedirectUrl(url, window.location.origin));
};

export const browserBillingRedirect: Redirect = (url) => {
  window.location.assign(billingRedirectUrl(url, window.location.origin));
};
