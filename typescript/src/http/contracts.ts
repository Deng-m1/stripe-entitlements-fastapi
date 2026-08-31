import type { AuthAccountAdapter, AuthenticatedIdentity } from "../auth.js";
import type { JsonValue } from "../types.js";

export type BillingCronJob = "annual-grants" | "reconcile";

export type BillingHttpOperation =
  | "catalog"
  | "account"
  | "checkout"
  | "creditPackCheckout"
  | "portal"
  | "previewPlanChange"
  | "confirmPlanChange";

export type BillingHttpErrorPhase =
  | "health"
  | "stripe_webhook"
  | "scheduled_worker"
  | "authentication"
  | "billing_operation";

/**
 * Server-only diagnostic context. The HTTP response remains sanitized; adopters can
 * send the original exception to their own structured logger or error tracker.
 */
export interface BillingHttpErrorContext {
  readonly phase: BillingHttpErrorPhase;
  readonly request: Request;
  readonly error: unknown;
  readonly operation?: BillingHttpOperation;
  readonly cronJob?: BillingCronJob;
}

export type BillingHttpErrorReporter = (
  context: BillingHttpErrorContext,
) => void | Promise<void>;

export interface BillingHttpResult {
  readonly status: number;
  readonly body: JsonValue;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface BillingRequestContext {
  readonly request: Request;
  readonly identity: AuthenticatedIdentity;
}

export interface StripeWebhookContext {
  readonly request: Request;
  /** Exact bytes received from the HTTP request, before JSON parsing. */
  readonly rawBody: Uint8Array;
  readonly stripeSignature: string;
}

/**
 * Framework-neutral HTTP facade over the billing core.
 *
 * Implementations own all billing behavior. The HTTP package only supplies routing,
 * authentication, raw-body preservation, browser-origin policy, and response
 * hardening; it deliberately contains no entitlement or ledger fallback behavior.
 */
export interface BillingHttpServices {
  health(request: Request): Promise<BillingHttpResult>;
  catalog(context: BillingRequestContext): Promise<BillingHttpResult>;
  account(context: BillingRequestContext): Promise<BillingHttpResult>;
  checkout(context: BillingRequestContext): Promise<BillingHttpResult>;
  creditPackCheckout(
    context: BillingRequestContext,
  ): Promise<BillingHttpResult>;
  portal(context: BillingRequestContext): Promise<BillingHttpResult>;
  previewPlanChange(context: BillingRequestContext): Promise<BillingHttpResult>;
  confirmPlanChange(context: BillingRequestContext): Promise<BillingHttpResult>;
  stripeWebhook(context: StripeWebhookContext): Promise<BillingHttpResult>;
  runCron(job: BillingCronJob, request: Request): Promise<BillingHttpResult>;
}

export type BillingCsrfMode = "origin-if-present" | "same-origin-session";

export interface BillingFetchHandlerOptions {
  readonly services: BillingHttpServices;
  readonly auth: AuthAccountAdapter;
  readonly allowedOrigins: readonly string[];
  /**
   * Cookie-backed same-origin sessions must use `same-origin-session`, which rejects
   * mutation requests without an Origin header. Bearer integrations retain the
   * existing origin-if-present contract.
   */
  readonly csrfMode?: BillingCsrfMode;
  readonly cronSecret?: string;
  /** Called only on the server. Reporter failures never replace the billing response. */
  readonly onError?: BillingHttpErrorReporter;
}

export type BillingFetchHandler = (request: Request) => Promise<Response>;
