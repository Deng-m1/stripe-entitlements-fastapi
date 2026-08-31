export const SITE_NAME = "Stripe Entitlements for FastAPI & TypeScript";
export const SITE_DESCRIPTION =
  "Open-source Stripe billing and entitlements with native FastAPI and TypeScript/Next.js backends over PostgreSQL, including subscriptions, exact fractional credits, one-time credit packs, and race-safe webhooks.";
export const REPOSITORY_URL =
  "https://github.com/ToseaAI/stripe-entitlements";

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

export function parsePublicSiteUrl(
  raw: string | undefined,
  environment = process.env.NODE_ENV,
): URL | null {
  const value = raw?.trim();
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("NEXT_PUBLIC_SITE_URL must be an absolute URL.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL must be an origin without credentials, path, query, or fragment.",
    );
  }
  const localDevelopment =
    environment !== "production" &&
    url.protocol === "http:" &&
    isLoopback(url.hostname);
  if (url.protocol !== "https:" && !localDevelopment) {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL must use HTTPS; loopback HTTP is development-only.",
    );
  }
  return url;
}

export function shouldAllowIndexing(
  flag: string | undefined,
  siteUrl: URL | null,
  environment = process.env.NODE_ENV,
): boolean {
  return flag === "true" && environment === "production" && siteUrl?.protocol === "https:";
}

export function absoluteSiteUrl(siteUrl: URL | null, path: string): string | undefined {
  return siteUrl ? new URL(path, siteUrl).toString() : undefined;
}

export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export const publicSiteUrl = parsePublicSiteUrl(
  process.env.NEXT_PUBLIC_SITE_URL,
);
export const allowIndexing = shouldAllowIndexing(
  process.env.NEXT_PUBLIC_ALLOW_INDEXING,
  publicSiteUrl,
);
