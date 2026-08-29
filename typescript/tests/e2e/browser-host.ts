import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { createServer, type Server } from "node:https";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AuthenticationError,
  type AuthenticatedIdentity,
} from "../../src/auth.js";
import {
  IdentityProviderUnavailable,
  JwtVerificationConfig,
  JwtVerifier,
  PersonalJwtAuthAdapter,
} from "../../src/auth-starters.js";
import { loadSettings, type Settings } from "../../src/config.js";
import {
  createBillingRuntime,
  type BillingRuntime,
} from "../../src/deployment.js";
import {
  CREDITS_CHARGE_SCOPE,
  CREDITS_REFUND_SCOPE,
  ENTITLEMENTS_CHECK_SCOPE,
  createInternalBillingFetchHandler,
} from "../../src/internal-api.js";
import {
  WorkloadAuthenticationError,
  WorkloadAuthorizationError,
  WorkloadPrincipal,
  type WorkloadIdentityAdapter,
  type WorkloadOwnerAuthorizer,
} from "../../src/internal-auth.js";
import { validateOwnerExternalRef } from "../../src/owner-reference.js";
import { StripeGateway } from "../../src/stripe-gateway.js";
import { isPlainRecord, isPrintable } from "../../src/validation.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PORTAL_SESSION = /^bps_[A-Za-z0-9_]+$/u;
const BROWSER_E2E_REQUEST_HEADERS = new Set(["authorization", "content-type"]);

interface PortalCreationEvidence {
  readonly customerId: string;
  readonly configurationId: string;
  readonly returnUrl: string;
}

export interface BrowserE2eHostConfiguration {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly tlsKeyFile: string;
  readonly tlsCertificateFile: string;
  readonly jwksFile: string;
  readonly issuer: string;
  readonly personalAudience: string;
  readonly workloadAudience: string;
  readonly workloadSubject: string;
  readonly workloadToken: string;
  readonly expectedOwner: string;
  readonly successJobKey: string;
  readonly failureJobKey: string;
}

export interface RunningBrowserE2eHost {
  readonly runtime: BillingRuntime;
  readonly server: Server;
  readonly configuration: BrowserE2eHostConfiguration;
  close(): Promise<void>;
}

function requiredEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  maximum = 8192,
): string {
  const value = environment[name];
  if (
    value === undefined ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > maximum ||
    !isPrintable(value)
  ) {
    throw new TypeError(`${name} is required for the browser E2E host`);
  }
  return value;
}

function configuredPort(raw: string): number {
  if (!/^[1-9][0-9]{0,4}$/u.test(raw)) {
    throw new TypeError("E2E_BACKEND_PORT must be an integer from 1 to 65535");
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new TypeError("E2E_BACKEND_PORT must be an integer from 1 to 65535");
  }
  return port;
}

function loopbackHost(raw: string): string {
  if (raw !== "127.0.0.1" && raw !== "localhost" && raw !== "::1") {
    throw new TypeError("E2E_BACKEND_HOST must be a loopback host");
  }
  return raw;
}

/** Validate all process-only host values before opening PostgreSQL or Stripe clients. */
export function browserE2eHostConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BrowserE2eHostConfiguration {
  const secretKey = requiredEnvironment(environment, "STRIPE_SECRET_KEY", 512);
  if (!secretKey.startsWith("sk_test_")) {
    throw new TypeError(
      "the browser E2E TypeScript host requires a Stripe test key",
    );
  }
  const host = loopbackHost(
    requiredEnvironment(environment, "E2E_BACKEND_HOST", 255),
  );
  const port = configuredPort(
    requiredEnvironment(environment, "E2E_BACKEND_PORT", 5),
  );
  const bracketed = host.includes(":") ? `[${host}]` : host;
  const origin = `https://${bracketed}:${String(port)}`;
  const issuer = requiredEnvironment(environment, "E2E_JWT_ISSUER", 2048);
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch (error) {
    throw new TypeError("E2E_JWT_ISSUER must be the browser host issuer URL", {
      cause: error,
    });
  }
  if (
    issuerUrl.origin !== origin ||
    issuerUrl.pathname !== "/e2e/issuer" ||
    issuerUrl.search.length > 0 ||
    issuerUrl.hash.length > 0
  ) {
    throw new TypeError("E2E_JWT_ISSUER must be the browser host issuer URL");
  }
  const workloadSubject = requiredEnvironment(
    environment,
    "E2E_WORKLOAD_SUBJECT",
    512,
  );
  if (!UUID.test(workloadSubject)) {
    throw new TypeError("E2E_WORKLOAD_SUBJECT must be a UUID");
  }
  const expectedOwner = requiredEnvironment(
    environment,
    "E2E_EXPECTED_OWNER_EXTERNAL_REF",
    512,
  );
  validateOwnerExternalRef(expectedOwner);
  return Object.freeze({
    host,
    port,
    origin,
    tlsKeyFile: requiredEnvironment(environment, "E2E_TLS_KEY_FILE", 4096),
    tlsCertificateFile: requiredEnvironment(
      environment,
      "E2E_TLS_CERT_FILE",
      4096,
    ),
    jwksFile: requiredEnvironment(environment, "E2E_PERSONAL_JWKS_FILE", 4096),
    issuer,
    personalAudience: requiredEnvironment(
      environment,
      "E2E_PERSONAL_JWT_AUDIENCE",
      512,
    ),
    workloadAudience: requiredEnvironment(
      environment,
      "E2E_WORKLOAD_JWT_AUDIENCE",
      512,
    ),
    workloadSubject,
    workloadToken: requiredEnvironment(environment, "E2E_WORKLOAD_JWT", 16_384),
    expectedOwner,
    successJobKey: requiredEnvironment(environment, "E2E_JOB_SUCCESS_KEY", 200),
    failureJobKey: requiredEnvironment(environment, "E2E_JOB_FAILURE_KEY", 200),
  });
}

class RecordingStripeGateway extends StripeGateway {
  public readonly portalEvidence = new Map<string, PortalCreationEvidence>();

  readonly #configurationId: string;
  readonly #returnUrl: string;

  public constructor(settings: Settings) {
    const configurationId = settings.stripePortalConfigurationId;
    if (configurationId === null) {
      throw new TypeError(
        "STRIPE_PORTAL_CONFIGURATION_ID is required for browser E2E",
      );
    }
    super(settings.stripeSecretKey, settings.stripeWebhookSecret, {
      productLine: settings.productLine,
      apiVersion: settings.stripeApiVersion,
      portalConfigurationId: configurationId,
      checkoutSuccessUrl: settings.checkoutSuccessUrl,
      checkoutCancelUrl: settings.checkoutCancelUrl,
      portalReturnUrl: settings.portalReturnUrl,
    });
    this.#configurationId = configurationId;
    this.#returnUrl = settings.portalReturnUrl;
  }

  public override async createPortalSession(input: {
    readonly customerId: string;
    readonly idempotencyKey: string;
  }): Promise<readonly [sessionId: string, sessionUrl: string]> {
    const result = await super.createPortalSession(input);
    this.portalEvidence.set(result[0], {
      customerId: input.customerId,
      configurationId: this.#configurationId,
      returnUrl: this.#returnUrl,
    });
    return result;
  }
}

class SignedWorkloadAdapter implements WorkloadIdentityAdapter {
  readonly #verifier: JwtVerifier;
  readonly #issuer: string;

  public constructor(verifier: JwtVerifier, issuer: string) {
    this.#verifier = verifier;
    this.#issuer = issuer;
  }

  public async authenticate(request: Request): Promise<WorkloadPrincipal> {
    try {
      const verified = await this.#verifier.verifyRequest(request);
      return new WorkloadPrincipal({
        issuer: this.#issuer,
        subject: verified.userId,
        scopes: new Set([
          ENTITLEMENTS_CHECK_SCOPE,
          CREDITS_CHARGE_SCOPE,
          CREDITS_REFUND_SCOPE,
        ]),
      });
    } catch (error) {
      if (
        error instanceof AuthenticationError ||
        error instanceof IdentityProviderUnavailable
      ) {
        throw new WorkloadAuthenticationError(
          "signed workload credential rejected",
          { cause: error },
        );
      }
      throw error;
    }
  }
}

class BoundWorkloadOwnerAuthorizer implements WorkloadOwnerAuthorizer {
  readonly #workloadSubject: string;
  readonly #ownerExternalRef: string;

  public constructor(workloadSubject: string, ownerExternalRef: string) {
    this.#workloadSubject = workloadSubject;
    this.#ownerExternalRef = ownerExternalRef;
  }

  public authorize(
    principal: WorkloadPrincipal,
    ownerExternalRef: string,
    requiredScope: string,
  ): Promise<void> {
    if (
      principal.subject !== this.#workloadSubject ||
      ownerExternalRef !== this.#ownerExternalRef ||
      !principal.scopes.has(requiredScope)
    ) {
      return Promise.reject(
        new WorkloadAuthorizationError(
          "workload is not bound to this billing owner",
        ),
      );
    }
    return Promise.resolve();
  }
}

function jsonResponse(status: number, body: unknown): Response {
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

type BrowserE2eRouteHandler = (request: Request) => Promise<Response>;

function browserE2eCorsResponse(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
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

function browserE2ePreflight(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
): Response {
  const origin = request.headers.get("origin");
  if (origin === null || !allowedOrigins.has(origin)) {
    return jsonResponse(403, { detail: "request origin is not allowed" });
  }
  if (
    request.headers.get("access-control-request-method")?.toUpperCase() !==
    "POST"
  ) {
    return jsonResponse(400, { detail: "CORS method is not allowed" });
  }
  const requestedHeaders = (
    request.headers.get("access-control-request-headers") ?? ""
  )
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  if (
    requestedHeaders.length !== BROWSER_E2E_REQUEST_HEADERS.size ||
    new Set(requestedHeaders).size !== requestedHeaders.length ||
    requestedHeaders.some((value) => !BROWSER_E2E_REQUEST_HEADERS.has(value))
  ) {
    return jsonResponse(400, { detail: "CORS headers are not allowed" });
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Origin": origin,
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Route the two browser-only host operations through an exact, credential-free CORS boundary. */
export function createBrowserE2eApiHandler(input: {
  readonly allowedOrigins: readonly string[];
  readonly portal: BrowserE2eRouteHandler;
  readonly jobs: BrowserE2eRouteHandler;
}): (request: Request) => Promise<Response | undefined> {
  if (input.allowedOrigins.length === 0 || input.allowedOrigins.includes("*")) {
    throw new TypeError("browser E2E API requires explicit frontend origins");
  }
  const allowedOrigins = new Set(input.allowedOrigins);
  return async (request): Promise<Response | undefined> => {
    const pathname = new URL(request.url).pathname;
    const route =
      pathname === "/api/e2e/portal-evidence"
        ? input.portal
        : pathname === "/api/e2e/jobs"
          ? input.jobs
          : undefined;
    if (route === undefined) {
      return undefined;
    }
    if (request.method.toUpperCase() === "OPTIONS") {
      return browserE2ePreflight(request, allowedOrigins);
    }
    const origin = request.headers.get("origin");
    if (origin !== null && !allowedOrigins.has(origin)) {
      return jsonResponse(403, { detail: "request origin is not allowed" });
    }
    const response = await route(request);
    return origin === null
      ? response
      : browserE2eCorsResponse(response, origin);
  };
}

async function strictObject(
  request: Request,
  fields: readonly string[],
): Promise<Record<string, unknown> | undefined> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    return undefined;
  }
  if (!isPlainRecord(parsed)) {
    return undefined;
  }
  const observed = Object.keys(parsed).sort();
  const expected = [...fields].sort();
  return observed.length === expected.length &&
    observed.every((field, index) => field === expected[index])
    ? parsed
    : undefined;
}

async function personalIdentity(
  adapter: PersonalJwtAuthAdapter,
  expectedOwner: string,
  request: Request,
): Promise<AuthenticatedIdentity | Response> {
  try {
    const identity = await adapter.authenticate(request);
    return identity.externalRef === expectedOwner
      ? identity
      : jsonResponse(403, {
          detail: "personal identity is outside this E2E run",
        });
  } catch {
    return jsonResponse(401, { detail: "personal authentication failed" });
  }
}

function portalEvidenceHandler(input: {
  readonly runtime: BillingRuntime;
  readonly gateway: RecordingStripeGateway;
  readonly personalAuth: PersonalJwtAuthAdapter;
  readonly configuration: BrowserE2eHostConfiguration;
  readonly settings: Settings;
  readonly jwksFetches: () => number;
}): (request: Request) => Promise<Response> {
  return async (request): Promise<Response> => {
    if (request.method !== "POST") {
      return jsonResponse(405, { detail: "method not allowed" });
    }
    const identity = await personalIdentity(
      input.personalAuth,
      input.configuration.expectedOwner,
      request,
    );
    if (identity instanceof Response) {
      return identity;
    }
    const body = await strictObject(request, ["session_id"]);
    const sessionId = body?.["session_id"];
    if (
      typeof sessionId !== "string" ||
      sessionId.length > 255 ||
      !PORTAL_SESSION.test(sessionId)
    ) {
      return jsonResponse(422, { detail: "invalid request body" });
    }
    const account =
      await input.runtime.kernel.database.existingAccountForExternalRef(
        identity.externalRef,
      );
    const evidence = input.gateway.portalEvidence.get(sessionId);
    if (account === null || evidence === undefined) {
      return jsonResponse(404, {
        detail: "Portal Session evidence was not found",
      });
    }
    if (
      evidence.customerId !== account.stripe_customer_id ||
      evidence.configurationId !== input.settings.stripePortalConfigurationId ||
      evidence.returnUrl !== input.settings.portalReturnUrl ||
      input.jwksFetches() <= 0
    ) {
      return jsonResponse(409, {
        detail: "Portal Session evidence is not owner-bound",
      });
    }
    return jsonResponse(200, {
      verified: true,
      session_id: sessionId,
      personal_jwks_verified: true,
    });
  };
}

function jobHandler(input: {
  readonly personalAuth: PersonalJwtAuthAdapter;
  readonly internalHandler: (request: Request) => Promise<Response>;
  readonly configuration: BrowserE2eHostConfiguration;
}): (request: Request) => Promise<Response> {
  const internalPost = async (
    path: string,
    body: Readonly<Record<string, unknown>>,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown> | undefined> => {
    const headers = new Headers({
      Authorization: `Bearer ${input.configuration.workloadToken}`,
      "Content-Type": "application/json",
    });
    if (idempotencyKey !== undefined) {
      headers.set("Idempotency-Key", idempotencyKey);
    }
    const response = await input.internalHandler(
      new Request(`https://internal.e2e.invalid${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
    if (response.status !== 200) {
      return undefined;
    }
    const parsed: unknown = await response.json();
    return isPlainRecord(parsed) ? parsed : undefined;
  };

  return async (request): Promise<Response> => {
    if (request.method !== "POST") {
      return jsonResponse(405, { detail: "method not allowed" });
    }
    const identity = await personalIdentity(
      input.personalAuth,
      input.configuration.expectedOwner,
      request,
    );
    if (identity instanceof Response) {
      return identity;
    }
    const body = await strictObject(request, [
      "operation_key",
      "amount",
      "scenario",
    ]);
    const operationKey = body?.["operation_key"];
    const amount = body?.["amount"];
    const scenario = body?.["scenario"];
    const expected =
      operationKey === input.configuration.successJobKey
        ? ["80", "success"]
        : operationKey === input.configuration.failureJobKey
          ? ["20", "terminal_failure"]
          : undefined;
    if (
      typeof operationKey !== "string" ||
      operationKey.length === 0 ||
      Buffer.byteLength(operationKey, "utf8") > 200 ||
      !isPrintable(operationKey) ||
      typeof amount !== "string" ||
      (scenario !== "success" && scenario !== "terminal_failure") ||
      expected?.[0] !== amount ||
      expected[1] !== scenario
    ) {
      return jsonResponse(400, {
        detail: "product Job request is outside this E2E run",
      });
    }
    const owner = { owner_external_ref: identity.externalRef };
    const entitlement = await internalPost("/internal/v1/entitlements/check", {
      ...owner,
      required_features: ["pdf_to_ppt"],
      required_limits: { max_file_mb: 30 },
    });
    if (entitlement?.["allowed"] !== true) {
      return jsonResponse(409, { detail: "product Job is not entitled" });
    }
    const charge = await internalPost(
      "/internal/v1/credits/charge",
      { ...owner, amount },
      operationKey,
    );
    if (charge === undefined) {
      return jsonResponse(502, {
        detail: "the private entitlement operation failed",
      });
    }
    if (scenario === "success") {
      return jsonResponse(200, {
        job_status: "succeeded",
        entitlement,
        charge,
        refund: null,
      });
    }
    const refund = await internalPost(
      "/internal/v1/credits/refund",
      owner,
      operationKey,
    );
    if (refund === undefined) {
      return jsonResponse(502, {
        detail: "the private entitlement operation failed",
      });
    }
    return jsonResponse(200, {
      job_status: "failed_refunded",
      entitlement,
      charge,
      refund,
    });
  };
}

function requestHeaders(source: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(source)) {
    if (raw === undefined) {
      continue;
    }
    if (Array.isArray(raw)) {
      for (const value of raw) {
        headers.append(name, value);
      }
    } else {
      headers.set(name, raw);
    }
  }
  return headers;
}

async function incomingBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    size += chunk.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      throw new RangeError("browser E2E request body is too large");
    }
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

type StreamingRequestInit = RequestInit & { duplex?: "half" };

async function fetchRequest(
  incoming: IncomingMessage,
  origin: string,
): Promise<Request> {
  const target = incoming.url ?? "/";
  if (!target.startsWith("/") || target.startsWith("//")) {
    throw new TypeError("invalid request target");
  }
  const method = (incoming.method ?? "GET").toUpperCase();
  const init: StreamingRequestInit = {
    method,
    headers: requestHeaders(incoming.headers),
  };
  if (method !== "GET" && method !== "HEAD") {
    const body = await incomingBody(incoming);
    const copied = new ArrayBuffer(body.byteLength);
    new Uint8Array(copied).set(body);
    init.body = copied;
    init.duplex = "half";
  }
  return new Request(new URL(target, `${origin}/`), init);
}

async function writeResponse(
  response: Response,
  destination: ServerResponse,
): Promise<void> {
  destination.statusCode = response.status;
  for (const [name, value] of response.headers.entries()) {
    if (name.toLowerCase() !== "set-cookie") {
      destination.setHeader(name, value);
    }
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    destination.setHeader("set-cookie", cookies);
  }
  destination.end(Buffer.from(await response.arrayBuffer()));
}

async function jwksDocument(path: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the isolated runner owns this validated private path.
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new TypeError("E2E_PERSONAL_JWKS_FILE is not valid UTF-8 JSON", {
      cause: error,
    });
  }
  if (
    !isPlainRecord(parsed) ||
    !Array.isArray(parsed["keys"]) ||
    parsed["keys"].length !== 1
  ) {
    throw new TypeError(
      "E2E_PERSONAL_JWKS_FILE must contain exactly one signing key",
    );
  }
  return parsed;
}

function verifier(issuer: string, audience: string): JwtVerifier {
  return new JwtVerifier(
    new JwtVerificationConfig({
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
    }),
  );
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error === undefined) {
        resolvePromise();
      } else {
        rejectPromise(error);
      }
    });
  });
}

/** Start the isolated HTTPS host over the real TypeScript billing service graph. */
export async function startBrowserE2eHost(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RunningBrowserE2eHost> {
  const configuration = browserE2eHostConfiguration(environment);
  const [key, certificate, jwks] = await Promise.all([
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the isolated runner owns this validated private path.
    readFile(configuration.tlsKeyFile),
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the isolated runner owns this validated private path.
    readFile(configuration.tlsCertificateFile),
    jwksDocument(configuration.jwksFile),
  ]);
  const settings = loadSettings(environment);
  const personalAuth = new PersonalJwtAuthAdapter(
    verifier(configuration.issuer, configuration.personalAudience),
  );
  const workloadAuth = new SignedWorkloadAdapter(
    verifier(configuration.issuer, configuration.workloadAudience),
    configuration.issuer,
  );
  const gateway = new RecordingStripeGateway(settings);
  const runtime = await createBillingRuntime({
    settings,
    gateway,
    auth: personalAuth,
  });
  const internalHandler = createInternalBillingFetchHandler({
    serviceProvider: () => runtime.kernel.requireServices().entitlements,
    authAdapter: workloadAuth,
    ownerAuthorizer: new BoundWorkloadOwnerAuthorizer(
      configuration.workloadSubject,
      configuration.expectedOwner,
    ),
  });
  let jwksFetchCount = 0;
  const portal = portalEvidenceHandler({
    runtime,
    gateway,
    personalAuth,
    configuration,
    settings,
    jwksFetches: () => jwksFetchCount,
  });
  const jobs = jobHandler({
    personalAuth,
    internalHandler,
    configuration,
  });
  const browserApi = createBrowserE2eApiHandler({
    allowedOrigins: runtime.kernel.origins,
    portal,
    jobs,
  });
  const dispatch = async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/e2e/issuer/.well-known/jwks.json") {
      if (request.method !== "GET") {
        return jsonResponse(405, { detail: "method not allowed" });
      }
      jwksFetchCount += 1;
      return jsonResponse(200, jwks);
    }
    const browserResponse = await browserApi(request);
    if (browserResponse !== undefined) {
      return browserResponse;
    }
    if (pathname.startsWith("/internal/v1/")) {
      return internalHandler(request);
    }
    return runtime.handler(request);
  };
  const server = createServer(
    { key, cert: certificate },
    (incoming, outgoing) => {
      const handle = async (): Promise<void> => {
        try {
          await writeResponse(
            await dispatch(await fetchRequest(incoming, configuration.origin)),
            outgoing,
          );
        } catch {
          await writeResponse(
            jsonResponse(500, { detail: "browser E2E host failed" }),
            outgoing,
          );
        }
      };
      void handle().catch(() => outgoing.destroy());
    },
  );
  try {
    server.listen(configuration.port, configuration.host);
    await Promise.race([
      once(server, "listening"),
      once(server, "error").then(([error]) => {
        throw error instanceof Error
          ? error
          : new Error("browser E2E HTTPS listener failed", { cause: error });
      }),
    ]);
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    await runtime.close().catch(() => undefined);
    throw error;
  }
  let closed = false;
  return {
    runtime,
    server,
    configuration,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      let serverError: unknown;
      try {
        await closeServer(server);
      } catch (error) {
        serverError = error;
      }
      await runtime.close();
      if (serverError !== undefined) {
        throw serverError instanceof Error
          ? serverError
          : new Error("browser E2E HTTPS server failed to close", {
              cause: serverError,
            });
      }
    },
  };
}

async function runFromCommandLine(): Promise<void> {
  const host = await startBrowserE2eHost();
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      backend_implementation: "typescript",
      host: host.configuration.host,
      port: host.configuration.port,
    })}\n`,
  );
  const shutdown = (): void => {
    void host.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  void runFromCommandLine().catch((error: unknown) => {
    const kind =
      error instanceof Error ? error.constructor.name : "UnknownError";
    process.stderr.write(`${JSON.stringify({ ok: false, error: kind })}\n`);
    process.exitCode = 1;
  });
}
