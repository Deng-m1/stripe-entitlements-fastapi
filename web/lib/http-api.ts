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
}: HttpApiOptions): BillingApi {
  const normalizedBase = normalizeBillingApiBaseUrl(baseUrl);

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
    const response = await fetchImpl(`${normalizedBase}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    const body = (await response.json().catch(() => null)) as
      | { detail?: string; error?: string; message?: string }
      | T
      | null;
    if (!response.ok) {
      const error = body as { detail?: string; error?: string; message?: string } | null;
      throw new BillingApiError(
        error?.detail ?? error?.error ?? error?.message ?? `Request failed (${response.status})`,
        response.status,
      );
    }
    if (body === null) {
      throw new BillingApiError("Billing API returned an empty response.", response.status);
    }
    return body as T;
  }

  return {
    getCatalog: () => request<CatalogResponse>("/api/catalog"),
    getAccount: () => request<AccountResponse>("/api/account"),
    createCheckout: (
      input: CheckoutRequest,
      options?: IdempotentRequestOptions,
    ) =>
      request<RedirectResponse>("/api/checkout", {
        method: "POST",
        body: JSON.stringify(input),
        headers: {
          "Idempotency-Key":
            options?.idempotencyKey ?? createIdempotencyKey(),
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
          "Idempotency-Key":
            options?.idempotencyKey ?? createIdempotencyKey(),
        },
      }),
    previewPlanChange: (
      input: ChangePreviewRequest,
      options?: IdempotentRequestOptions,
    ) =>
      request<ChangePreview>("/api/billing/change/preview", {
        method: "POST",
        body: JSON.stringify(input),
        headers: {
          "Idempotency-Key":
            options?.idempotencyKey ?? createIdempotencyKey(),
        },
      }),
    confirmPlanChange: (input: ChangeConfirmRequest) =>
      request<ChangeConfirmResponse>("/api/billing/change/confirm", {
        method: "POST",
        body: JSON.stringify(input),
      }),
  };
}
