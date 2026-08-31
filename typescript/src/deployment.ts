import { RejectAllAuthAdapter, type AuthAccountAdapter } from "./auth.js";
import {
  JwtVerificationConfig,
  JwtVerifier,
  PersonalJwtAuthAdapter,
} from "./auth-starters.js";
import { DefaultBillingHttpServices } from "./billing-http-services.js";
import { createBillingFetchHandler } from "./http/handler.js";
import type {
  BillingCsrfMode,
  BillingFetchHandler,
  BillingHttpErrorReporter,
} from "./http/contracts.js";
import { BillingKernel, type BillingKernelOptions } from "./kernel.js";

export interface BillingRuntime {
  readonly kernel: BillingKernel;
  readonly services: DefaultBillingHttpServices;
  readonly handler: BillingFetchHandler;
  close(): Promise<void>;
}

export interface BillingRuntimeOptions extends BillingKernelOptions {
  readonly cronSecret?: string;
  readonly csrfMode?: BillingCsrfMode;
  readonly applyMigrations?: boolean;
  readonly onError?: BillingHttpErrorReporter;
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = environment[name];
  return value === "" ? undefined : value;
}

/** Build the strict personal-user starter; team auth remains an explicit host injection. */
export function authAdapterFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AuthAccountAdapter | undefined {
  const mode = environmentValue(environment, "BILLING_AUTH_MODE");
  const jwtFields = [
    "BILLING_JWT_ISSUER",
    "BILLING_JWT_AUDIENCE",
    "BILLING_JWKS_URL",
  ] as const;
  if (mode === undefined) {
    if (
      jwtFields.some(
        (field) => environmentValue(environment, field) !== undefined,
      )
    ) {
      throw new TypeError(
        "BILLING_AUTH_MODE must be personal_jwt when JWT settings are configured",
      );
    }
    return undefined;
  }
  if (mode === "reject_all") {
    if (
      jwtFields.some(
        (field) => environmentValue(environment, field) !== undefined,
      )
    ) {
      throw new TypeError(
        "BILLING_AUTH_MODE must be personal_jwt when JWT settings are configured",
      );
    }
    return new RejectAllAuthAdapter();
  }
  if (mode !== "personal_jwt") {
    throw new TypeError("BILLING_AUTH_MODE must be reject_all or personal_jwt");
  }
  const missing = jwtFields.filter(
    (field) => environmentValue(environment, field) === undefined,
  );
  if (missing.length > 0) {
    throw new TypeError(
      `personal_jwt authentication requires ${missing.join(", ")}`,
    );
  }
  const algorithms = (
    environmentValue(environment, "BILLING_JWT_ALGORITHMS") ?? "RS256"
  )
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const config = new JwtVerificationConfig({
    issuer: environment["BILLING_JWT_ISSUER"] as string,
    audience: environment["BILLING_JWT_AUDIENCE"] as string,
    jwksUrl: environment["BILLING_JWKS_URL"] as string,
    algorithms,
  });
  return new PersonalJwtAuthAdapter(new JwtVerifier(config));
}

function optionalMigrationOptIn(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  const value = environmentValue(environment, "BILLING_APPLY_MIGRATIONS");
  if (value === undefined) {
    return false;
  }
  if (value !== "1") {
    throw new TypeError(
      "BILLING_APPLY_MIGRATIONS must be exactly 1 when enabled",
    );
  }
  return true;
}

function csrfModeFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): BillingCsrfMode | undefined {
  const value = environmentValue(environment, "BILLING_CSRF_MODE");
  if (value === undefined) {
    return undefined;
  }
  if (value !== "origin-if-present" && value !== "same-origin-session") {
    throw new TypeError(
      "BILLING_CSRF_MODE must be origin-if-present or same-origin-session",
    );
  }
  return value;
}

export async function createBillingRuntime(
  options: BillingRuntimeOptions = {},
): Promise<BillingRuntime> {
  const kernel = await BillingKernel.create(options);
  await kernel.start({ applyMigrations: options.applyMigrations === true });
  try {
    const services = new DefaultBillingHttpServices(kernel);
    const handler = createBillingFetchHandler({
      services,
      auth: kernel.auth,
      allowedOrigins: kernel.origins,
      ...(options.cronSecret === undefined
        ? {}
        : { cronSecret: options.cronSecret }),
      ...(options.csrfMode === undefined ? {} : { csrfMode: options.csrfMode }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    });
    let closed = false;
    return {
      kernel,
      services,
      handler,
      async close(): Promise<void> {
        if (!closed) {
          closed = true;
          await kernel.stop();
        }
      },
    };
  } catch (error) {
    await kernel.stop().catch(() => undefined);
    throw error;
  }
}

export async function createBillingRuntimeFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<BillingRuntime> {
  const auth = authAdapterFromEnvironment(environment);
  const cronSecret = environmentValue(environment, "CRON_SECRET");
  const csrfMode = csrfModeFromEnvironment(environment);
  return createBillingRuntime({
    environment,
    ...(auth === undefined ? {} : { auth }),
    ...(cronSecret === undefined ? {} : { cronSecret }),
    ...(csrfMode === undefined ? {} : { csrfMode }),
    applyMigrations: optionalMigrationOptIn(environment),
  });
}
