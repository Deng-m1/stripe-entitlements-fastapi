import type {
  AccountResponse,
  BillingApi,
  CatalogResponse,
  ChangeConfirmRequest,
  ChangeConfirmResponse,
  ChangePreview,
  ChangePreviewRequest,
  CheckoutRequest,
  IdempotentRequestOptions,
  RedirectResponse,
} from "@/lib/types";
import type { AuthAdapter } from "@/lib/auth";
import {
  CREDIT_SCALE,
  parseExactCreditAmount,
} from "@/lib/credit-amount";
import { createIdempotencyKey } from "@/lib/idempotency";

export class BillingApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BillingApiError";
  }
}

interface HttpApiOptions {
  baseUrl: string;
  auth: AuthAdapter;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const defaultTimeoutMs = 30_000;
const maximumTimeoutMs = 120_000;
const maximumAccessTokenBytes = 8_192;

function validAccessToken(value: string): boolean {
  return (
    /^[\x21-\x7E]+$/u.test(value) &&
    new TextEncoder().encode(value).length <= maximumAccessTokenBytes
  );
}

function idempotencyKey(value: string | undefined): string {
  const key = value ?? createIdempotencyKey();
  if (!/^[\x21-\x7E]{1,200}$/u.test(key)) {
    throw new BillingApiError(
      "Idempotency key must contain 1 to 200 visible ASCII characters.",
    );
  }
  return key;
}

function responseErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    for (const field of ["detail", "error", "message"] as const) {
      const value = (body as Record<string, unknown>)[field];
      if (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 500 &&
        !/[\u0000-\u001F\u007F]/u.test(value)
      ) {
        return value;
      }
    }
  }
  return `Request failed (${status})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidCreditContract(): never {
  throw new BillingApiError(
    "Billing API returned an invalid exact-credit contract.",
    502,
  );
}

function validateCreditEntitlements(
  value: unknown,
  requireMonthlyCredits: boolean,
): void {
  if (!Array.isArray(value)) invalidCreditContract();
  const monthlyCredits = value.filter(
    (item) => isRecord(item) && item.key === "monthly_credits",
  );
  if (monthlyCredits.length > 1 || (requireMonthlyCredits && monthlyCredits.length !== 1)) {
    invalidCreditContract();
  }
  if (monthlyCredits.length === 1) {
    const entitlement = monthlyCredits[0];
    parseExactCreditAmount(
      entitlement.value,
      entitlement.value_atoms,
      entitlement.scale,
    );
  }
}

function decodeAccountResponse(body: unknown): AccountResponse {
  try {
    if (!isRecord(body) || !isRecord(body.credits)) invalidCreditContract();
    parseExactCreditAmount(
      body.credits.balance,
      body.credits.balance_atoms,
      body.credits.scale,
    );
    parseExactCreditAmount(
      body.credits.grant_amount,
      body.credits.grant_amount_atoms,
      body.credits.scale,
    );
    validateCreditEntitlements(body.entitlements, false);
    return body as unknown as AccountResponse;
  } catch (error) {
    if (error instanceof BillingApiError) throw error;
    return invalidCreditContract();
  }
}

function decodeCatalogResponse(body: unknown): CatalogResponse {
  try {
    if (!isRecord(body) || !Array.isArray(body.plans)) invalidCreditContract();
    for (const plan of body.plans) {
      if (!isRecord(plan)) invalidCreditContract();
      validateCreditEntitlements(plan.entitlements, true);
    }
    return body as unknown as CatalogResponse;
  } catch (error) {
    if (error instanceof BillingApiError) throw error;
    return invalidCreditContract();
  }
}

function decodeChangePreview(body: unknown): ChangePreview {
  try {
    if (!isRecord(body) || body.credit_scale !== CREDIT_SCALE) {
      invalidCreditContract();
    }
    const decimal = body.entitlement_credit_delta;
    const atoms = body.entitlement_credit_delta_atoms;
    if (decimal === null || atoms === null) {
      if (decimal !== null || atoms !== null) invalidCreditContract();
    } else {
      parseExactCreditAmount(decimal, atoms, body.credit_scale);
    }
    return body as unknown as ChangePreview;
  } catch (error) {
    if (error instanceof BillingApiError) throw error;
    return invalidCreditContract();
  }
}

function decodeChangeConfirm(body: unknown): ChangeConfirmResponse {
  if (!isRecord(body)) invalidCreditContract();
  if (body.account !== undefined) decodeAccountResponse(body.account);
  return body as unknown as ChangeConfirmResponse;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

export function normalizeBillingApiBaseUrl(
  baseUrl: string,
  environment = process.env.NODE_ENV,
): string {
  if (!baseUrl) return "";

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new BillingApiError(
      "Billing API base URL must be an absolute HTTP(S) URL.",
    );
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new BillingApiError(
      "Billing API base URL must not contain credentials, a query, or a fragment.",
    );
  }
  const secure = parsed.protocol === "https:";
  const localDevelopment =
    parsed.protocol === "http:" &&
    environment !== "production" &&
    isLoopbackHostname(parsed.hostname);
  if (!secure && !localDevelopment) {
    throw new BillingApiError(
      "Billing API base URL must use HTTPS (loopback HTTP is allowed outside production).",
    );
  }

  return parsed.toString().replace(/\/+$/, "");
}

export function createHttpBillingApi({
  baseUrl,
  auth,
  fetchImpl = fetch,
  timeoutMs = defaultTimeoutMs,
}: HttpApiOptions): BillingApi {
  const normalizedBase = normalizeBillingApiBaseUrl(baseUrl);
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > maximumTimeoutMs
  ) {
    throw new BillingApiError(
      `Billing API timeout must be an integer between 1 and ${maximumTimeoutMs} milliseconds.`,
    );
  }

  async function request<T>(
    path: string,
    init?: RequestInit,
    decode?: (body: unknown) => T,
  ): Promise<T> {
    if (!normalizedBase) {
      throw new BillingApiError(
        "Billing API is not configured. Set NEXT_PUBLIC_BILLING_API_BASE_URL.",
      );
    }
    const token = await auth.getAccessToken();
    if (!token) {
      throw new BillingApiError(
        "No authentication adapter is configured. Demo Bearer auth is local-only; connect the host application's real session provider.",
        401,
      );
    }
    if (!validAccessToken(token)) {
      throw new BillingApiError(
        "The authentication adapter returned an invalid access token.",
        401,
      );
    }
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${normalizedBase}${path}`, {
        ...init,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...init?.headers,
        },
      });
    } catch {
      if (controller.signal.aborted) {
        throw new BillingApiError("Billing API request timed out.", 504);
      }
      throw new BillingApiError("Billing API is temporarily unavailable.", 503);
    } finally {
      globalThis.clearTimeout(timeout);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new BillingApiError(
        responseErrorMessage(body, response.status),
        response.status,
      );
    }
    if (body === null) {
      throw new BillingApiError("Billing API returned an empty response.", response.status);
    }
    return decode ? decode(body) : (body as T);
  }

  return {
    getCatalog: () =>
      request<CatalogResponse>("/api/catalog", undefined, decodeCatalogResponse),
    getAccount: () =>
      request<AccountResponse>("/api/account", undefined, decodeAccountResponse),
    createCheckout: (
      input: CheckoutRequest,
      options?: IdempotentRequestOptions,
    ) =>
      request<RedirectResponse>("/api/checkout", {
        method: "POST",
        body: JSON.stringify(input),
        headers: {
          "Idempotency-Key": idempotencyKey(options?.idempotencyKey),
        },
      }),
    createPortal: (
      returnUrl: string,
      options?: IdempotentRequestOptions,
    ) =>
      request<RedirectResponse>("/api/billing/portal", {
        method: "POST",
        body: JSON.stringify({ return_url: returnUrl }),
        headers: {
          "Idempotency-Key": idempotencyKey(options?.idempotencyKey),
        },
      }),
    previewPlanChange: (
      input: ChangePreviewRequest,
      options?: IdempotentRequestOptions,
    ) =>
      request<ChangePreview>(
        "/api/billing/change/preview",
        {
          method: "POST",
          body: JSON.stringify(input),
          headers: {
            "Idempotency-Key": idempotencyKey(options?.idempotencyKey),
          },
        },
        decodeChangePreview,
      ),
    confirmPlanChange: (input: ChangeConfirmRequest) =>
      request<ChangeConfirmResponse>(
        "/api/billing/change/confirm",
        {
          method: "POST",
          body: JSON.stringify(input),
        },
        decodeChangeConfirm,
      ),
  };
}
