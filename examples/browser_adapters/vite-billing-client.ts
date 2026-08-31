/**
 * Copy this dependency-free transport into a Vite/Lovable browser application.
 * Identity verification and entitlement enforcement still belong to the billing server.
 */

export type BillingPath =
  | "/api/catalog"
  | "/api/account"
  | "/api/checkout"
  | "/api/credit-packs/checkout"
  | "/api/billing/portal"
  | "/api/billing/change/preview"
  | "/api/billing/change/confirm";

export interface BillingRequest {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}

export function createBillingFetch(options: {
  readonly baseUrl: string;
  readonly getAccessToken: () => Promise<string | null>;
}) {
  const baseUrl = new URL(options.baseUrl);
  const loopback =
    baseUrl.hostname === "localhost" ||
    baseUrl.hostname === "127.0.0.1" ||
    baseUrl.hostname === "[::1]";
  if (
    baseUrl.protocol !== "https:" &&
    !(baseUrl.protocol === "http:" && loopback)
  ) {
    throw new Error("Billing API must use HTTPS outside local development.");
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error(
      "Billing API URL must not contain credentials, query, or fragment.",
    );
  }
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/u, "")}/`;

  return async function billingFetch<T>(
    path: BillingPath,
    request: BillingRequest = {},
  ): Promise<T> {
    const token = await options.getAccessToken();
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      token !== token.trim() ||
      /\s/u.test(token)
    ) {
      throw new Error("Sign in before opening billing.");
    }

    const response = await fetch(new URL(path.slice(1), baseUrl), {
      method: request.method ?? "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(request.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...(request.idempotencyKey === undefined
          ? {}
          : { "Idempotency-Key": request.idempotencyKey }),
      },
      ...(request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
    });

    if (!response.ok) {
      throw new Error(`Billing request failed (${response.status}).`);
    }
    return (await response.json()) as T;
  };
}
