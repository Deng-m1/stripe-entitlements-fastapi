import { AuthenticationError } from "../auth.js";
import type { AuthenticatedIdentity } from "../auth.js";
import {
  IdentityProviderUnavailable,
  TeamAuthorizationError,
} from "../auth-starters.js";
import { validateOwnerExternalRef } from "../owner-reference.js";
import type { JsonValue } from "../types.js";
import type {
  BillingFetchHandler,
  BillingFetchHandlerOptions,
  BillingHttpResult,
  BillingHttpOperation,
  BillingRequestContext,
} from "./contracts.js";
import {
  cronAuthorizationMatches,
  mutationOriginDecision,
  normalizeAllowedOrigins,
  validateCronSecret,
} from "./security.js";
import { readStripeWebhook } from "./webhook-body.js";

interface RouteDefinition {
  readonly kind: "health" | "authenticated" | "webhook" | "cron";
  readonly operation?: BillingHttpOperation;
  readonly job?: "annual-grants" | "reconcile";
}

const ROUTES: ReadonlyMap<string, RouteDefinition> = new Map([
  ["GET /health", { kind: "health" }],
  ["GET /api/catalog", { kind: "authenticated", operation: "catalog" }],
  ["GET /api/account", { kind: "authenticated", operation: "account" }],
  ["POST /api/checkout", { kind: "authenticated", operation: "checkout" }],
  [
    "POST /api/credit-packs/checkout",
    { kind: "authenticated", operation: "creditPackCheckout" },
  ],
  ["POST /api/billing/portal", { kind: "authenticated", operation: "portal" }],
  [
    "POST /api/billing/change/preview",
    { kind: "authenticated", operation: "previewPlanChange" },
  ],
  [
    "POST /api/billing/change/confirm",
    { kind: "authenticated", operation: "confirmPlanChange" },
  ],
  ["POST /webhooks/stripe", { kind: "webhook" }],
  ["GET /api/cron/annual-grants", { kind: "cron", job: "annual-grants" }],
  ["GET /api/cron/reconcile", { kind: "cron", job: "reconcile" }],
]);

const METHODS_BY_PATH: ReadonlyMap<string, readonly string[]> = (() => {
  const result = new Map<string, string[]>();
  for (const key of ROUTES.keys()) {
    const separator = key.indexOf(" ");
    const method = key.slice(0, separator);
    const path = key.slice(separator + 1);
    const methods = result.get(path) ?? [];
    methods.push(method);
    result.set(path, methods);
  }
  return result;
})();

const CORS_REQUEST_HEADERS = new Set([
  "authorization",
  "content-type",
  "idempotency-key",
  "x-stripe-mode-requirement",
]);

function jsonBody(value: JsonValue): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function hardenedResponse(
  status: number,
  body: JsonValue,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  const serialized = jsonBody(body);
  if (serialized === undefined) {
    return hardenedResponse(500, {
      error: "billing service returned an invalid JSON response",
    });
  }
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(serialized, { status, headers });
}

function serviceResponse(result: BillingHttpResult): Response {
  if (
    !Number.isInteger(result.status) ||
    result.status < 100 ||
    result.status > 599
  ) {
    return hardenedResponse(500, {
      error: "billing service returned an invalid status",
    });
  }
  return hardenedResponse(result.status, result.body, result.headers);
}

function errorResponse(
  status: number,
  message: string,
  field: "detail" | "error",
): Response {
  return hardenedResponse(status, { [field]: message });
}

function validatedIdentity(
  identity: AuthenticatedIdentity,
): AuthenticatedIdentity {
  validateOwnerExternalRef(identity.externalRef);
  if (
    identity.email !== undefined &&
    (identity.email.length === 0 ||
      identity.email !== identity.email.trim() ||
      Buffer.byteLength(identity.email, "utf8") > 320 ||
      identity.email.split("@").length !== 2 ||
      /\s/u.test(identity.email) ||
      Array.from(identity.email).some((character) => /\p{C}/u.test(character)))
  ) {
    throw new TypeError("authenticated identity has an invalid email");
  }
  return identity;
}

function withCors(
  response: Response,
  request: Request,
  origins: ReadonlySet<string>,
): Response {
  const origin = request.headers.get("origin");
  if (origin === null || !origins.has(origin)) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  const vary = headers.get("Vary");
  if (vary === null) {
    headers.set("Vary", "Origin");
  } else if (
    !vary.split(",").some((value) => value.trim().toLowerCase() === "origin")
  ) {
    headers.set("Vary", `${vary}, Origin`);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isPublicApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/") && !pathname.startsWith("/api/cron/");
}

function preflightResponse(
  request: Request,
  pathname: string,
  origins: ReadonlySet<string>,
): Response | undefined {
  if (
    request.method.toUpperCase() !== "OPTIONS" ||
    !isPublicApiPath(pathname)
  ) {
    return undefined;
  }
  const methods = METHODS_BY_PATH.get(pathname);
  if (methods === undefined) {
    return errorResponse(404, "not found", "detail");
  }
  const origin = request.headers.get("origin");
  if (origin === null || !origins.has(origin)) {
    return errorResponse(403, "request origin is not allowed", "error");
  }
  const requestedMethod = request.headers
    .get("access-control-request-method")
    ?.toUpperCase();
  if (requestedMethod === undefined || !methods.includes(requestedMethod)) {
    return errorResponse(400, "CORS method is not allowed", "error");
  }
  const requestedHeaders = (
    request.headers.get("access-control-request-headers") ?? ""
  )
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  if (requestedHeaders.some((value) => !CORS_REQUEST_HEADERS.has(value))) {
    return errorResponse(400, "CORS header is not allowed", "error");
  }
  const headers = new Headers({
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": [...CORS_REQUEST_HEADERS].join(", "),
    "Access-Control-Allow-Methods": methods.join(", "),
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(null, { status: 204, headers });
}

async function invokeAuthenticated(
  operation: BillingHttpOperation,
  context: BillingRequestContext,
  services: BillingFetchHandlerOptions["services"],
): Promise<BillingHttpResult> {
  switch (operation) {
    case "catalog":
      return services.catalog(context);
    case "account":
      return services.account(context);
    case "checkout":
      return services.checkout(context);
    case "creditPackCheckout":
      return services.creditPackCheckout(context);
    case "portal":
      return services.portal(context);
    case "previewPlanChange":
      return services.previewPlanChange(context);
    case "confirmPlanChange":
      return services.confirmPlanChange(context);
  }
}

async function reportError(
  options: BillingFetchHandlerOptions,
  context: Parameters<NonNullable<BillingFetchHandlerOptions["onError"]>>[0],
): Promise<void> {
  try {
    await options.onError?.(context);
  } catch {
    // Diagnostics must never replace the original sanitized HTTP behavior.
  }
}

export function createBillingFetchHandler(
  options: BillingFetchHandlerOptions,
): BillingFetchHandler {
  const origins = normalizeAllowedOrigins(options.allowedOrigins);
  const csrfMode = options.csrfMode ?? "origin-if-present";
  const cronSecret = validateCronSecret(options.cronSecret);

  return async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(400, "invalid request URL", "detail");
    }
    const preflight = preflightResponse(request, url.pathname, origins);
    if (preflight !== undefined) {
      return preflight;
    }
    const method = request.method.toUpperCase();
    const route = ROUTES.get(`${method} ${url.pathname}`);
    if (route === undefined) {
      const allowed = METHODS_BY_PATH.get(url.pathname);
      if (allowed !== undefined) {
        const response = errorResponse(405, "method not allowed", "detail");
        response.headers.set("Allow", allowed.join(", "));
        return response;
      }
      return errorResponse(404, "not found", "detail");
    }

    if (route.kind === "health") {
      try {
        return serviceResponse(await options.services.health(request));
      } catch (error) {
        await reportError(options, { phase: "health", request, error });
        return errorResponse(503, "billing service is unavailable", "detail");
      }
    }

    if (route.kind === "webhook") {
      const payload = await readStripeWebhook(request);
      if (!payload.ok) {
        return errorResponse(payload.status, payload.message, "error");
      }
      try {
        return serviceResponse(
          await options.services.stripeWebhook({
            request,
            rawBody: payload.rawBody,
            stripeSignature: payload.stripeSignature,
          }),
        );
      } catch (error) {
        await reportError(options, {
          phase: "stripe_webhook",
          request,
          error,
        });
        return errorResponse(
          500,
          "processing failed; Stripe should retry",
          "error",
        );
      }
    }

    if (route.kind === "cron") {
      if (cronSecret === undefined) {
        return errorResponse(
          503,
          "scheduled workers are not configured",
          "detail",
        );
      }
      if (
        !cronAuthorizationMatches(
          request.headers.get("authorization"),
          cronSecret,
        )
      ) {
        return errorResponse(401, "invalid scheduler authorization", "detail");
      }
      const job = route.job;
      if (job === undefined) {
        return errorResponse(
          500,
          "scheduled route is not configured",
          "detail",
        );
      }
      try {
        return serviceResponse(await options.services.runCron(job, request));
      } catch (error) {
        await reportError(options, {
          phase: "scheduled_worker",
          request,
          error,
          cronJob: job,
        });
        return errorResponse(
          503,
          "scheduled worker failed and should be retried",
          "detail",
        );
      }
    }

    const originDecision = mutationOriginDecision(request, origins, csrfMode);
    if (!originDecision.allowed) {
      return errorResponse(403, "request origin is not allowed", "error");
    }
    let identity: AuthenticatedIdentity;
    try {
      identity = validatedIdentity(await options.auth.authenticate(request));
    } catch (error) {
      if (error instanceof TeamAuthorizationError) {
        return withCors(
          errorResponse(403, "billing operation is not permitted", "detail"),
          request,
          origins,
        );
      }
      if (error instanceof IdentityProviderUnavailable) {
        await reportError(options, {
          phase: "authentication",
          request,
          error,
        });
        return withCors(
          hardenedResponse(
            503,
            { detail: "identity provider temporarily unavailable" },
            { "Retry-After": String(error.retryAfterSeconds) },
          ),
          request,
          origins,
        );
      }
      if (error instanceof AuthenticationError) {
        return withCors(
          errorResponse(401, "authentication failed", "detail"),
          request,
          origins,
        );
      }
      await reportError(options, {
        phase: "authentication",
        request,
        error,
      });
      return withCors(
        errorResponse(401, "authentication failed", "detail"),
        request,
        origins,
      );
    }
    const operation = route.operation;
    if (operation === undefined) {
      return errorResponse(500, "billing route is not configured", "detail");
    }
    try {
      const response = serviceResponse(
        await invokeAuthenticated(
          operation,
          { request, identity },
          options.services,
        ),
      );
      return withCors(response, request, origins);
    } catch (error) {
      await reportError(options, {
        phase: "billing_operation",
        request,
        error,
        operation,
      });
      return withCors(
        errorResponse(500, "billing request failed", "detail"),
        request,
        origins,
      );
    }
  };
}
