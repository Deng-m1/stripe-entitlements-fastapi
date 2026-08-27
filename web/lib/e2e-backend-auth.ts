import { E2E_ROUTE_AUTH_SENTINEL } from "@/lib/auth";

const maximumBearerBytes = 8_192;

export function optionalE2EBearerToken(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (
    !/^[\x21-\x7E]+$/u.test(raw) ||
    new TextEncoder().encode(raw).length > maximumBearerBytes
  ) {
    throw new Error(
      "E2E_DEMO_BEARER_TOKEN must contain at most 8192 visible ASCII bytes.",
    );
  }
  return raw;
}

export function isExactBackendApiRequest(
  requestUrl: string,
  backendOrigin: string,
): boolean {
  try {
    const request = new URL(requestUrl);
    const backend = new URL(backendOrigin);
    return (
      request.origin === backend.origin &&
      (request.pathname === "/api" || request.pathname.startsWith("/api/"))
    );
  } catch {
    return false;
  }
}

export function withE2EBackendAuthorization(
  headers: Record<string, string>,
  token: string,
): Record<string, string> {
  const authorization = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() === "authorization",
  );
  if (
    authorization.length !== 1 ||
    authorization[0][1] !== `Bearer ${E2E_ROUTE_AUTH_SENTINEL}`
  ) {
    throw new Error(
      "Refusing to inject the E2E token without the exact route-auth sentinel.",
    );
  }
  return {
    ...Object.fromEntries(
      Object.entries(headers).filter(
        ([name]) => name.toLowerCase() !== "authorization",
      ),
    ),
    authorization: `Bearer ${token}`,
  };
}
