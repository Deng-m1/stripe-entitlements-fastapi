import { z } from "zod";

import { JSON_SAFE_INTEGER_MAX } from "./bounds.js";
import { readBoundedRequestBody } from "./bounded-body.js";
import { CREDIT_SCALE } from "./credit-amount.js";
import {
  CreditsUnavailableError,
  InsufficientCreditsError,
  type CreditResult,
} from "./credits.js";
import {
  BillingOwnerNotFoundError,
  CreditIdempotencyConflictError,
  CreditOperationNotFoundError,
  InvalidCreditRequestError,
  InvalidOwnerReferenceError,
  validateOwnerExternalRef,
  type EntitlementService,
} from "./entitlements.js";
import {
  RejectAllWorkloadIdentityAdapter,
  RejectAllWorkloadOwnerAuthorizer,
  WorkloadAuthenticationError,
  WorkloadAuthorizationError,
  WorkloadPrincipal,
  type WorkloadIdentityAdapter,
  type WorkloadOwnerAuthorizer,
} from "./internal-auth.js";
import type { JsonValue } from "./types.js";

export const ENTITLEMENTS_CHECK_SCOPE = "entitlements:check";
export const CREDITS_CHARGE_SCOPE = "credits:charge";
export const CREDITS_REFUND_SCOPE = "credits:refund";

const MAX_INTERNAL_BODY_BYTES = 64 * 1024;
const ENTITLEMENT_KEY = /^[a-z][a-z0-9_]{0,63}$/u;

const ownerReference = z.string().min(1).max(512);
const entitlementKey = z.string().min(1).max(64).regex(ENTITLEMENT_KEY);
const limitValue = z.number().int().min(0).max(JSON_SAFE_INTEGER_MAX);
const entitlementCheckRequest = z
  .object({
    owner_external_ref: ownerReference,
    required_features: z.array(entitlementKey).max(64).default([]),
    required_limits: z.record(entitlementKey, limitValue).default({}),
  })
  .strict();
const creditChargeRequest = z
  .object({
    owner_external_ref: ownerReference,
    amount: z.string().min(1).max(32),
  })
  .strict();
const creditRefundRequest = z
  .object({ owner_external_ref: ownerReference })
  .strict();

export type InternalEntitlementServiceProvider = () => EntitlementService;

export interface InternalBillingHandlerOptions {
  readonly serviceProvider: InternalEntitlementServiceProvider;
  readonly authAdapter?: WorkloadIdentityAdapter;
  readonly ownerAuthorizer?: WorkloadOwnerAuthorizer;
  readonly prefix?: string;
}

type InternalRoute = "check" | "charge" | "refund";

function normalizedPrefix(value: string | undefined): string {
  const prefix = value ?? "/internal/v1";
  if (
    !prefix.startsWith("/") ||
    prefix.endsWith("/") ||
    prefix.includes("//") ||
    prefix.includes("?") ||
    prefix.includes("#")
  ) {
    throw new TypeError(
      "internal API prefix must be an absolute path without a trailing slash",
    );
  }
  return prefix;
}

function noStoreResponse(status: number, body: JsonValue): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function detail(status: number, message: string): Response {
  return noStoreResponse(status, { detail: message });
}

async function strictJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  let declaredLength: number | undefined;
  if (declared !== null) {
    if (!/^\d+$/u.test(declared)) {
      throw new RangeError("internal request Content-Length is invalid");
    }
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length > MAX_INTERNAL_BODY_BYTES) {
      throw new RangeError("internal request body is too large");
    }
    declaredLength = length;
  }
  const body = await readBoundedRequestBody(request, MAX_INTERNAL_BODY_BYTES);
  if (body.byteLength === 0 || body.byteLength > MAX_INTERNAL_BODY_BYTES) {
    throw new RangeError("internal request body is empty or too large");
  }
  if (declaredLength !== undefined && declaredLength !== body.byteLength) {
    throw new RangeError("internal request Content-Length does not match body");
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    ) as unknown;
  } catch {
    throw new TypeError("internal request body is not valid UTF-8 JSON");
  }
}

function creditResponse(result: CreditResult): JsonValue {
  return {
    outcome: result.outcome,
    balance: result.balance.toString(),
    balance_atoms: result.balanceAtoms.toString(),
    requested: result.requested.toString(),
    requested_atoms: result.requestedAtoms.toString(),
    restored: result.restored.toString(),
    restored_atoms: result.restoredAtoms.toString(),
    scale: Number(CREDIT_SCALE),
  };
}

function checkResponse(
  decision: Awaited<ReturnType<EntitlementService["check"]>>,
): JsonValue {
  return {
    allowed: decision.allowed,
    reason: decision.reason,
    entitlements_enforceable: decision.entitlementsEnforceable,
    plan_key: decision.planKey,
    plan_interval: decision.planInterval,
    subscription_status: decision.subscriptionStatus,
    credits: {
      balance: decision.creditBalance.toString(),
      balance_atoms: decision.creditBalance.atoms.toString(),
      scale: Number(CREDIT_SCALE),
      spendable: decision.creditsSpendable,
      expires_at: decision.creditExpiresAt,
    },
    features: { ...decision.features },
    limits: Object.fromEntries(
      Object.entries(decision.limits).map(([key, value]) => [
        key,
        {
          requested: value.requested,
          maximum: value.maximum,
          allowed: value.allowed,
        },
      ]),
    ),
  };
}

async function authenticatedPrincipal(
  adapter: WorkloadIdentityAdapter,
  request: Request,
): Promise<WorkloadPrincipal | Response> {
  try {
    const principal = await adapter.authenticate(request);
    return principal instanceof WorkloadPrincipal
      ? principal
      : detail(401, "workload authentication failed");
  } catch (error) {
    if (error instanceof WorkloadAuthenticationError) {
      return detail(401, "workload authentication failed");
    }
    return detail(500, "internal billing request failed");
  }
}

async function authorizeOwner(
  principal: WorkloadPrincipal,
  ownerExternalRef: string,
  scope: string,
  authorizer: WorkloadOwnerAuthorizer,
): Promise<Response | undefined> {
  if (!principal.scopes.has(scope)) {
    return detail(403, "workload is not authorized");
  }
  try {
    validateOwnerExternalRef(ownerExternalRef);
  } catch (error) {
    if (error instanceof InvalidOwnerReferenceError) {
      return detail(400, "invalid owner reference");
    }
    return detail(400, "invalid owner reference");
  }
  try {
    await authorizer.authorize(principal, ownerExternalRef, scope);
  } catch (error) {
    if (error instanceof WorkloadAuthorizationError) {
      return detail(403, "workload is not authorized");
    }
    return detail(500, "internal billing request failed");
  }
  return undefined;
}

function routeFor(pathname: string, prefix: string): InternalRoute | undefined {
  if (pathname === `${prefix}/entitlements/check`) {
    return "check";
  }
  if (pathname === `${prefix}/credits/charge`) {
    return "charge";
  }
  if (pathname === `${prefix}/credits/refund`) {
    return "refund";
  }
  return undefined;
}

/** Framework-neutral, service-identity-protected entitlement and credit API. */
export function createInternalBillingFetchHandler(
  options: InternalBillingHandlerOptions,
): (request: Request) => Promise<Response> {
  const prefix = normalizedPrefix(options.prefix);
  const auth = options.authAdapter ?? new RejectAllWorkloadIdentityAdapter();
  const authorizer =
    options.ownerAuthorizer ?? new RejectAllWorkloadOwnerAuthorizer();

  return async (request: Request): Promise<Response> => {
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return detail(400, "invalid request URL");
    }
    const route = routeFor(pathname, prefix);
    if (route === undefined) {
      return detail(404, "not found");
    }
    if (request.method.toUpperCase() !== "POST") {
      const response = detail(405, "method not allowed");
      response.headers.set("Allow", "POST");
      return response;
    }
    const principal = await authenticatedPrincipal(auth, request);
    if (principal instanceof Response) {
      return principal;
    }
    let rawBody: unknown;
    try {
      rawBody = await strictJson(request);
    } catch {
      return detail(422, "invalid request body");
    }

    if (route === "check") {
      const parsed = entitlementCheckRequest.safeParse(rawBody);
      if (!parsed.success) {
        return detail(422, "invalid request body");
      }
      const denied = await authorizeOwner(
        principal,
        parsed.data.owner_external_ref,
        ENTITLEMENTS_CHECK_SCOPE,
        authorizer,
      );
      if (denied !== undefined) {
        return denied;
      }
      try {
        const decision = await options
          .serviceProvider()
          .check(parsed.data.owner_external_ref, {
            requiredFeatures: parsed.data.required_features,
            requiredLimits: parsed.data.required_limits,
          });
        return noStoreResponse(200, checkResponse(decision));
      } catch (error) {
        if (
          error instanceof InvalidOwnerReferenceError ||
          error instanceof TypeError ||
          error instanceof RangeError
        ) {
          return detail(400, "invalid entitlement check request");
        }
        return detail(500, "internal billing request failed");
      }
    }

    const idempotencyKey = request.headers.get("idempotency-key");
    if (idempotencyKey === null) {
      return detail(422, "Idempotency-Key header is required");
    }
    if (route === "charge") {
      const parsed = creditChargeRequest.safeParse(rawBody);
      if (!parsed.success) {
        return detail(422, "invalid request body");
      }
      const denied = await authorizeOwner(
        principal,
        parsed.data.owner_external_ref,
        CREDITS_CHARGE_SCOPE,
        authorizer,
      );
      if (denied !== undefined) {
        return denied;
      }
      try {
        const result = await options
          .serviceProvider()
          .charge(
            parsed.data.owner_external_ref,
            parsed.data.amount,
            idempotencyKey,
          );
        return noStoreResponse(200, creditResponse(result));
      } catch (error) {
        if (
          error instanceof InvalidOwnerReferenceError ||
          error instanceof InvalidCreditRequestError
        ) {
          return detail(400, "invalid credit charge request");
        }
        if (error instanceof BillingOwnerNotFoundError) {
          return detail(404, "billing owner not found");
        }
        if (error instanceof CreditIdempotencyConflictError) {
          return detail(409, "credit idempotency conflict");
        }
        if (error instanceof CreditsUnavailableError) {
          return detail(409, "credits are unavailable");
        }
        if (error instanceof InsufficientCreditsError) {
          return detail(409, "insufficient credits");
        }
        return detail(500, "internal billing request failed");
      }
    }

    const parsed = creditRefundRequest.safeParse(rawBody);
    if (!parsed.success) {
      return detail(422, "invalid request body");
    }
    const denied = await authorizeOwner(
      principal,
      parsed.data.owner_external_ref,
      CREDITS_REFUND_SCOPE,
      authorizer,
    );
    if (denied !== undefined) {
      return denied;
    }
    try {
      const result = await options
        .serviceProvider()
        .refund(parsed.data.owner_external_ref, idempotencyKey);
      return noStoreResponse(200, creditResponse(result));
    } catch (error) {
      if (
        error instanceof InvalidOwnerReferenceError ||
        error instanceof InvalidCreditRequestError
      ) {
        return detail(400, "invalid credit refund request");
      }
      if (error instanceof CreditOperationNotFoundError) {
        return detail(404, "credit operation not found");
      }
      return detail(500, "internal billing request failed");
    }
  };
}
