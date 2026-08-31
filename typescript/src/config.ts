import { defaultPlanCatalogPath } from "./resources.js";
import type { TransitionPolicy } from "./types.js";
import { isPrintable, requiredVisibleString } from "./validation.js";

const VERSION = /^\d{4}-\d{2}-\d{2}\.[a-z][a-z0-9_]*$/u;
const SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const LOOKUP_PREFIX = /^[a-z][a-z0-9-]{0,31}$/u;
const LOG_LEVELS = new Set(["CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"]);
const APP_ENVIRONMENTS = new Set(["production", "development", "test"]);

export type LogLevel = "CRITICAL" | "ERROR" | "WARNING" | "INFO" | "DEBUG";
export type AppEnvironment = "production" | "development" | "test";

export class ConfigurationError extends Error {}

export interface DatabaseSettings {
  readonly databaseUrl: string;
  readonly databasePoolMin: number;
  readonly databasePoolMax: number;
  readonly databasePoolIdleTimeoutMs: number;
  readonly databaseConnectTimeoutMs: number;
}

export interface Settings extends DatabaseSettings {
  readonly stripeSecretKey: string;
  readonly stripeWebhookSecret: string;
  readonly stripeApiVersion: string;
  readonly stripeWebhookApiVersion: string;
  readonly stripePortalConfigurationId: string | null;
  readonly productLine: string;
  readonly lookupPrefix: string;
  readonly planCatalogPath: string;
  readonly checkoutSuccessUrl: string;
  readonly checkoutCancelUrl: string;
  readonly portalReturnUrl: string;
  readonly frontendOrigins: string;
  readonly logLevel: LogLevel;
  readonly appEnv: AppEnvironment;
  readonly demoBearerToken: string | null;
  readonly demoBearerSubject: string;
  readonly demoBearerEmail: string | null;
  readonly billingTransitionPolicy: TransitionPolicy;
}

export const DEFAULT_PLAN_CATALOG_PATH = defaultPlanCatalogPath();

function requireEnvironment(
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined) {
    throw new ConfigurationError(`${name} is required`);
  }
  try {
    return requiredVisibleString(
      value,
      name,
      name === "DATABASE_URL" ? 2048 : 512,
    );
  } catch {
    throw new ConfigurationError(`${name} must be a bounded visible string`);
  }
}

function optionalVisible(
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  name: string,
  maximum: number,
): string | null {
  const value = environment[name];
  if (value === undefined || value === "") {
    return null;
  }
  try {
    return requiredVisibleString(value, name, maximum);
  } catch {
    throw new ConfigurationError(`${name} must be a bounded visible string`);
  }
}

export function publicHttpUrlIsStructurallySafe(
  value: unknown,
): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.host.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
}

export function checkoutSuccessBaseUrlIsSafe(value: string): boolean {
  if (!publicHttpUrlIsStructurallySafe(value)) {
    return false;
  }
  const parsed = new URL(value);
  return parsed.search.length === 0 && parsed.hash.length === 0;
}

function validatedDatabaseUrl(value: string): string {
  if (!value.startsWith("postgresql://") && !value.startsWith("postgres://")) {
    throw new ConfigurationError("DATABASE_URL must use PostgreSQL");
  }
  return value;
}

function boundedEnvironmentInteger(
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new ConfigurationError(`${name} must be a base-10 integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(
      `${name} must be between ${String(minimum)} and ${String(maximum)}`,
    );
  }
  return value;
}

function validatedVersion(value: string, field: string): string {
  if (!VERSION.test(value)) {
    throw new ConfigurationError(`${field} must use YYYY-MM-DD.release format`);
  }
  return value;
}

function validatedRedirect(
  value: string,
  field: string,
  success = false,
): string {
  if (!publicHttpUrlIsStructurallySafe(value)) {
    throw new ConfigurationError(`${field} must be an origin-safe HTTP(S) URL`);
  }
  if (success && !checkoutSuccessBaseUrlIsSafe(value)) {
    throw new ConfigurationError(
      `${field} must not include a query or fragment`,
    );
  }
  return value;
}

function boundedConfiguration(
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: string,
): string {
  const value = environment[name] ?? fallback;
  if (
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > 8192 ||
    !isPrintable(value)
  ) {
    throw new ConfigurationError(`${name} must be a bounded visible string`);
  }
  return value;
}

export function loadDatabaseSettings(
  environment:
    | NodeJS.ProcessEnv
    | Readonly<Record<string, string | undefined>> = process.env,
): DatabaseSettings {
  const databasePoolMin = boundedEnvironmentInteger(
    environment,
    "DATABASE_POOL_MIN",
    1,
    0,
    100,
  );
  const databasePoolMax = boundedEnvironmentInteger(
    environment,
    "DATABASE_POOL_MAX",
    20,
    1,
    100,
  );
  if (databasePoolMin > databasePoolMax) {
    throw new ConfigurationError(
      "DATABASE_POOL_MIN must not exceed DATABASE_POOL_MAX",
    );
  }
  return Object.freeze({
    databaseUrl: validatedDatabaseUrl(
      requireEnvironment(environment, "DATABASE_URL"),
    ),
    databasePoolMin,
    databasePoolMax,
    databasePoolIdleTimeoutMs: boundedEnvironmentInteger(
      environment,
      "DATABASE_POOL_IDLE_TIMEOUT_MS",
      10_000,
      1_000,
      600_000,
    ),
    databaseConnectTimeoutMs: boundedEnvironmentInteger(
      environment,
      "DATABASE_CONNECT_TIMEOUT_MS",
      10_000,
      1_000,
      120_000,
    ),
  });
}

export function loadSettings(
  environment:
    | NodeJS.ProcessEnv
    | Readonly<Record<string, string | undefined>> = process.env,
): Settings {
  const database = loadDatabaseSettings(environment);
  const stripeSecretKey = requireEnvironment(environment, "STRIPE_SECRET_KEY");
  if (
    !stripeSecretKey.startsWith("sk_test_") &&
    !stripeSecretKey.startsWith("sk_live_")
  ) {
    throw new ConfigurationError(
      "STRIPE_SECRET_KEY must be an sk_test_ or sk_live_ key",
    );
  }
  const stripeWebhookSecret = requireEnvironment(
    environment,
    "STRIPE_WEBHOOK_SECRET",
  );
  if (!stripeWebhookSecret.startsWith("whsec_")) {
    throw new ConfigurationError(
      "STRIPE_WEBHOOK_SECRET must start with whsec_",
    );
  }
  const portalConfigurationId = optionalVisible(
    environment,
    "STRIPE_PORTAL_CONFIGURATION_ID",
    255,
  );
  const productLine = boundedConfiguration(
    environment,
    "PRODUCT_LINE",
    "example-entitlements",
  );
  if (!SLUG.test(productLine)) {
    throw new ConfigurationError("PRODUCT_LINE must be a lowercase slug");
  }
  const lookupPrefix = boundedConfiguration(
    environment,
    "LOOKUP_PREFIX",
    "ent",
  );
  if (!LOOKUP_PREFIX.test(lookupPrefix)) {
    throw new ConfigurationError(
      "LOOKUP_PREFIX must be a lowercase slug without underscores",
    );
  }
  const transitionPolicy =
    environment["BILLING_TRANSITION_POLICY"] ?? "full_period_reset";
  if (
    transitionPolicy !== "full_period_reset" &&
    transitionPolicy !== "prorated_delta"
  ) {
    throw new ConfigurationError("BILLING_TRANSITION_POLICY is invalid");
  }
  const logLevel = environment["LOG_LEVEL"] ?? "INFO";
  if (!LOG_LEVELS.has(logLevel)) {
    throw new ConfigurationError("LOG_LEVEL is invalid");
  }
  const appEnv = environment["APP_ENV"] ?? "production";
  if (!APP_ENVIRONMENTS.has(appEnv)) {
    throw new ConfigurationError("APP_ENV is invalid");
  }
  const demoBearerToken = optionalVisible(
    environment,
    "DEMO_BEARER_TOKEN",
    512,
  );
  if (demoBearerToken !== null && !/^[\x20-\x7e]+$/u.test(demoBearerToken)) {
    throw new ConfigurationError(
      "DEMO_BEARER_TOKEN must use visible ASCII characters",
    );
  }
  const demoBearerSubject = boundedConfiguration(
    environment,
    "DEMO_BEARER_SUBJECT",
    "demo-user",
  );
  const demoBearerEmail = optionalVisible(
    environment,
    "DEMO_BEARER_EMAIL",
    320,
  );
  if (
    demoBearerEmail !== null &&
    (demoBearerEmail.split("@").length !== 2 || /\s/u.test(demoBearerEmail))
  ) {
    throw new ConfigurationError(
      "DEMO_BEARER_EMAIL must contain one @ and no whitespace",
    );
  }
  const checkoutSuccessUrl = boundedConfiguration(
    environment,
    "CHECKOUT_SUCCESS_URL",
    "http://localhost:3000/billing/success",
  );
  const checkoutCancelUrl = boundedConfiguration(
    environment,
    "CHECKOUT_CANCEL_URL",
    "http://localhost:3000/pricing",
  );
  const portalReturnUrl = boundedConfiguration(
    environment,
    "PORTAL_RETURN_URL",
    "http://localhost:3000/account",
  );
  return Object.freeze({
    databaseUrl: database.databaseUrl,
    databasePoolMin: database.databasePoolMin,
    databasePoolMax: database.databasePoolMax,
    databasePoolIdleTimeoutMs: database.databasePoolIdleTimeoutMs,
    databaseConnectTimeoutMs: database.databaseConnectTimeoutMs,
    stripeSecretKey,
    stripeWebhookSecret,
    stripeApiVersion: validatedVersion(
      environment["STRIPE_API_VERSION"] ?? "2026-06-24.dahlia",
      "STRIPE_API_VERSION",
    ),
    stripeWebhookApiVersion: validatedVersion(
      requireEnvironment(environment, "STRIPE_WEBHOOK_API_VERSION"),
      "STRIPE_WEBHOOK_API_VERSION",
    ),
    stripePortalConfigurationId: portalConfigurationId,
    productLine,
    lookupPrefix,
    planCatalogPath: boundedConfiguration(
      environment,
      "PLAN_CATALOG_PATH",
      DEFAULT_PLAN_CATALOG_PATH,
    ),
    checkoutSuccessUrl: validatedRedirect(
      checkoutSuccessUrl,
      "CHECKOUT_SUCCESS_URL",
      true,
    ),
    checkoutCancelUrl: validatedRedirect(
      checkoutCancelUrl,
      "CHECKOUT_CANCEL_URL",
    ),
    portalReturnUrl: validatedRedirect(portalReturnUrl, "PORTAL_RETURN_URL"),
    frontendOrigins: boundedConfiguration(
      environment,
      "FRONTEND_ORIGINS",
      "http://localhost:3000",
    ),
    logLevel: logLevel as LogLevel,
    appEnv: appEnv as AppEnvironment,
    demoBearerToken,
    demoBearerSubject,
    demoBearerEmail,
    billingTransitionPolicy: transitionPolicy,
  });
}

export function stripeTestMode(
  settings: Pick<Settings, "stripeSecretKey">,
): boolean {
  return settings.stripeSecretKey.startsWith("sk_test_");
}
