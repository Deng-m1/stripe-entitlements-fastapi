# Stripe entitlements for TypeScript

[![npm](https://img.shields.io/npm/v/%40tosea%2Fstripe-entitlements.svg?label=npm)](https://www.npmjs.com/package/@tosea/stripe-entitlements)
[![license](https://img.shields.io/npm/l/%40tosea%2Fstripe-entitlements.svg)](https://github.com/Deng-m1/stripe-entitlements-fastapi/blob/v0.4.0/LICENSE)

`@tosea/stripe-entitlements` is the native TypeScript/Node implementation of this
repository's Stripe billing, SaaS entitlement, fractional-credit, and credit-pack
reference. It does not proxy or spawn the Python service. It uses the same reviewed
PostgreSQL schema, `plans.toml`, settlement policies, and billing invariants as the
FastAPI implementation.

Choose one runtime for a normal deployment:

- use the Python package for a FastAPI application;
- use this package for a Node service or a Next.js App Router application.

Both runtimes can read the same schema and the test suite proves cross-runtime credit
idempotency and overspend safety. A production fleet should nevertheless standardize on
one runtime per API/webhook/worker deployment and keep its package version, catalog,
Stripe mode, API versions, and transition policy identical across replicas.

## Implemented boundary

The TypeScript implementation includes:

- Stripe-hosted subscription and one-time credit-pack Checkout;
- Portal sessions and server-controlled plan-change preview/confirm;
- both `full_period_reset` and `prorated_delta` transition templates;
- monthly and yearly subscriptions, with yearly funding released in monthly slots;
- SCA/payment-failure recovery without replacing the paid source entitlement;
- signed raw-body webhook processing, ordered subscription projection, and durable
  fail-closed incidents;
- exact fixed-point credits (one credit is `1_000_000` atoms), usage refunds, pack
  expiry, cash refunds, disputes, debt, and source allocation;
- PostgreSQL event/business idempotency, locks, constraints, annual grants, and
  subscription/pack reconciliation;
- personal JWT/JWKS and team-membership authentication starters;
- `EntitlementService` plus an owner-authorized internal check/charge/refund handler;
- a Fetch-style HTTP facade, standalone Node server/CLI, Next.js Route Handler adapter,
  and a read-only-by-default `doctor` command.

The deliberately unsupported scope is the same as the Python implementation: no
multi-currency, seats/quantities, trials, tax engine, metered billing, mixed arbitrary
Invoice items, or enabled promotion codes. See the root
[README](https://github.com/Deng-m1/stripe-entitlements-fastapi/blob/v0.4.0/README.md),
[invariants](https://github.com/Deng-m1/stripe-entitlements-fastapi/blob/v0.4.0/docs/INVARIANTS.md),
and
[architecture](https://github.com/Deng-m1/stripe-entitlements-fastapi/blob/v0.4.0/docs/ARCHITECTURE.md)
before extending the state machine.

## Requirements

- Node.js 22 or newer; the package is ESM-only;
- PostgreSQL 17 (the SQL uses PostgreSQL as the coordination layer);
- a Stripe test-mode account for development;
- a public signed webhook endpoint and a scheduler in deployed environments.

For a new Node or Next.js project, install the exact reviewed release:

```bash
npm install --save-exact @tosea/stripe-entitlements@0.4.0
npx stripe-entitlements --version
cp node_modules/@tosea/stripe-entitlements/.env.example .env
chmod 600 .env
```

In a Next.js App Router/SSR application, Route Handlers are the backend, so you do
not need a separate FastAPI, Railway, or long-running Node service. Real Stripe
billing still requires one writable PostgreSQL 17 primary for webhook idempotency,
entitlement and credit state, plan-change intent, workers, reconciliation, and
incidents. Only the browser-local simulation can run without PostgreSQL, and it is
not a real Stripe integration.

The installed package already contains compiled JavaScript, declarations, the CLI,
`plans.toml`, migrations 001/002, the environment example, and licenses. It does not
contain the repository's reference UI, Vercel configuration, test suite, or operator
scripts. Copy application files from the matching
[v0.4.0 source tag](https://github.com/Deng-m1/stripe-entitlements-fastapi/tree/v0.4.0)
only when you need those examples; do not mix another branch or version with the npm
runtime.

Next.js may use a project `.env.local` for Route Handlers, but the standalone
`stripe-entitlements` CLI does not load Next.js dotenv files. Before `migrate`,
`bootstrap`, or `doctor`, export the same private server configuration into the shell
as shown below (source `.env.local` instead if that is the file you chose). Never place
Stripe or database credentials in a `NEXT_PUBLIC_*` variable.

For contributors working from this source checkout instead:

```bash
cd typescript
npm ci
npm run build
cp .env.example .env
chmod 600 .env
```

`npm run build` is required before the first source-checkout CLI invocation because
`dist/` is generated and intentionally absent from Git. A clean-installed release
tarball already contains `dist/`, so downstream applications do not rebuild the package.

Set `BILLING_TRANSITION_POLICY` in that private environment file to exactly one of
`full_period_reset` or `prorated_delta` before migration and startup. This package is a
native Node backend: it can run with `stripe-entitlements serve` on any suitable VM,
container platform, or PaaS. Next.js and Vercel are optional adapters, and neither Python
nor a Vercel account is required for the standalone TypeScript path.

The repository's own Next.js application intentionally consumes `file:../typescript` so
CI tests the same working tree. Downstream applications should use the pinned registry
command above. The tag release workflow tests that tarball locally, builds it in a fresh
Next.js App Router consumer, publishes the exact bytes to npm, verifies registry
integrity, and then installs the registry version in another clean project.

## Initialize PostgreSQL

Apply migrations as an explicit operator step:

```bash
set -a
. ./.env
set +a
npx stripe-entitlements migrate
```

`migrate` reads only database connection/pool settings (`DATABASE_URL` and the optional
`DATABASE_POOL_*` bounds); production schema jobs should not receive Stripe secrets.
Application startup does not migrate by default. `BILLING_APPLY_MIGRATIONS=1`
is an explicit local-development opt-in, not a production rollout mechanism.

Use a dedicated PostgreSQL 17 database or a deliberately isolated database/search path.
The migrations create `schema_migrations`, fourteen correctness tables, functions, and
triggers in the connection's current `search_path`; this release has no
`BILLING_DB_SCHEMA` option. Do not point it casually at an application's existing
`public.schema_migrations`, read replica, HTTP database adapter, or browser database
client. Runtime traffic needs a normal server-side PostgreSQL wire URL to one writable
primary. In serverless deployments, budget each warm instance's pool separately; start
with `DATABASE_POOL_MIN=0` and a small `DATABASE_POOL_MAX`, then cap platform concurrency
against the database-wide connection budget.

The TypeScript build packages the canonical root migration bundle and catalog. CI verifies
001 and 002 byte-for-byte after `npm pack` and installation in a clean project, then uses
that clean-installed package's CLI against a disposable empty PostgreSQL 17 database. The
gate checks exact migration versions and SHA-256 history, an idempotent second apply, all
correctness tables, the 002 snapshot columns, and the installed package's `schemaReady()`
result. Fresh v0.4.0 databases apply both migrations; an existing v0.3 database applies 002
only.

Do not mix v0.3 and v0.4 Checkout, credit-pack, or plan-change writers during that
upgrade. Quiesce those routes, migrate, replace the writer fleet, and reopen traffic.
Once v0.4 has frozen or started a request, roll forward unless all in-flight remote
outcomes have first been reconciled or retired; v0.3 cannot honor its request snapshot.

Every process owns its own PostgreSQL pool. For serverless or horizontally scaled
deployments, set `DATABASE_POOL_MAX` from the database-wide connection budget divided
by the maximum warm-instance count; `DATABASE_POOL_MIN=0` avoids retaining an idle
floor. `DATABASE_POOL_IDLE_TIMEOUT_MS` and `DATABASE_CONNECT_TIMEOUT_MS` are strictly
bounded as well. Defaults are `1`, `20`, `10000`, and `10000`; do not multiply the
default 20 by an unbounded function concurrency setting.

## Bootstrap Stripe without Python

The Node CLI can create or verify the recurring plan catalog, one-time credit packs,
and the dedicated safe Customer Portal configuration. It does not invoke Python and it
does not connect to PostgreSQL:

```bash
set -a
. ./.env
set +a
npx stripe-entitlements bootstrap
npx stripe-entitlements bootstrap --verify-only
```

The JSON result contains only non-secret inventory counts, mode, API version, object
IDs, and mutation summaries. Copy its `portalConfigurationId` into
`STRIPE_PORTAL_CONFIGURATION_ID` before starting the application. The Portal policy
disables subscription price changes and allows cancellation only at period end; all
plan changes must continue through the authenticated preview/confirm API.

Bootstrap uses the package's canonical `plans.toml`, `LOOKUP_PREFIX`, and
`PRODUCT_LINE` by default. A downstream application can select explicit operator
inputs without changing runtime configuration:

```bash
npx stripe-entitlements bootstrap \
  --catalog /absolute/path/to/plans.toml \
  --lookup-prefix mysaas \
  --product-line mysaas-billing
```

Every mutation has a deterministic Stripe idempotency key derived from the mode,
product line, logical operation, desired contract, and observed remote state. All list
operations follow every Stripe page. The command repairs catalog drift only when the
existing Price is proven to belong to the expected Product; it refuses a lookup-key
collision with another Product. Duplicate owned Products or Portal configurations also
fail closed for operator review.

Test mode is the default safety boundary. Any Stripe network access with an `sk_live_`
key—including `--verify-only`—requires two explicit CLI acknowledgements in addition to
the live key itself:

```bash
npx stripe-entitlements bootstrap \
  --allow-live \
  --confirm-live-product-line mysaas-billing

npx stripe-entitlements bootstrap \
  --verify-only \
  --allow-live \
  --confirm-live-product-line mysaas-billing
```

The confirmation value must exactly equal the effective `PRODUCT_LINE`. Missing,
placeholder, malformed, or insufficiently confirmed live keys are rejected before the
Stripe SDK client is constructed, so no network request can occur on those paths.

## Run as a standalone Node service

After bootstrap has produced a Portal configuration ID and the environment has a
webhook secret plus the actual signed-payload API version:

```bash
npx stripe-entitlements doctor
npx stripe-entitlements serve
```

Only a source checkout needs `npm run build` first. A registry installation runs the
packaged CLI directly.

The listener defaults to `0.0.0.0:8000`. Set `BILLING_HOST`, `BILLING_PORT`, and
`BILLING_PUBLIC_ORIGIN` when a trusted proxy or non-default port is used. Operational
commands are intentionally bounded:

```bash
npx stripe-entitlements doctor --json
npx stripe-entitlements doctor --stripe-network
npx stripe-entitlements --version
npx stripe-entitlements cron annual-grants
npx stripe-entitlements cron reconcile
```

`doctor` makes no Stripe request unless `--stripe-network` is present. Cron commands
process bounded work and may safely overlap because PostgreSQL, not process memory, owns
coordination.

## Use the native Next.js backend

The root `web/` application demonstrates a pure TypeScript deployment. These Route
Handlers all delegate to one lazily shared Node-runtime billing kernel:

```typescript
// app/api/[...billing]/route.ts
import { environmentNextBillingRouteHandler as handle } from "@tosea/stripe-entitlements/next";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
```

Add equivalent explicit handlers for `/webhooks/stripe` and `/health`; a catch-all under
`/api` cannot receive either path. The matching source-tag examples are
[`/api/[...billing]`](https://github.com/Deng-m1/stripe-entitlements-fastapi/blob/v0.4.0/tests/npm-next-consumer/app/api/%5B...billing%5D/route.ts),
[`/webhooks/stripe`](https://github.com/Deng-m1/stripe-entitlements-fastapi/blob/v0.4.0/tests/npm-next-consumer/app/webhooks/stripe/route.ts),
and
[`/health`](https://github.com/Deng-m1/stripe-entitlements-fastapi/blob/v0.4.0/tests/npm-next-consumer/app/health/route.ts).

The catalog and migrations are runtime files, not JavaScript imports. Include them in
Next.js/Vercel output-file tracing:

```javascript
// next.config.mjs
const nextConfig = {
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/@tosea/stripe-entitlements/dist/plans.toml",
      "./node_modules/@tosea/stripe-entitlements/dist/migrations/**/*.sql",
    ],
  },
};

export default nextConfig;
```

The clean-consumer release gate reads every Route Handler's `.nft.json` and fails unless
all three traces contain the catalog and every packaged migration. If
`PLAN_CATALOG_PATH` selects a host-owned catalog instead of the bundled file, add that
exact deployed path to `outputFileTracingIncludes` too and verify it in the built route
trace; an absolute path that exists only on the developer machine is invalid.

Use the Node runtime, never Edge, because Stripe, `pg`, raw webhook bodies, and database
transactions are server-only. The source repository's
[`vercel.typescript.json`](https://github.com/Deng-m1/stripe-entitlements-fastapi/blob/v0.4.0/vercel.typescript.json)
deploys this as one Next.js service and schedules the two secured Cron routes; it is not
part of the npm tarball. Managed PostgreSQL remains required; Vercel state or in-memory
locks are not a substitute.

Import the package only from server modules. Do not import it from a Client Component,
Next Middleware, an Edge route, or code evaluated during static rendering. Browser code
calls the same-origin HTTP routes instead. Keep `runtime`, `dynamic`, and `maxDuration`
as literal exports in each Route Handler because Next.js statically analyzes those
values. The release gate installs the tarball into a clean Next.js 16.3.2 App Router
consumer and runs a production build of all three handlers.

## Connect the host identity system

The production default rejects every protected API request. For a personal-user SaaS,
the environment starter verifies an asymmetric JWT/JWKS contract:

```dotenv
BILLING_AUTH_MODE=personal_jwt
BILLING_JWT_ISSUER=https://identity.example.com/
BILLING_JWT_AUDIENCE=billing-api
BILLING_JWKS_URL=https://identity.example.com/.well-known/jwks.json
BILLING_JWT_ALGORITHMS=RS256
```

The verified UUID `sub` becomes a stable owner reference. Email is never ownership
authority. For another session provider, inject an `AuthAccountAdapter`:

```typescript
import {
  createBillingRuntime,
  type AuthAccountAdapter,
} from "@tosea/stripe-entitlements";

const auth: AuthAccountAdapter = {
  async authenticate(request) {
    const session = await verifyYourServerSession(request);
    return { externalRef: `v1:user:${session.immutableUserId}` };
  },
};

let sharedRuntime: ReturnType<typeof createBillingRuntime> | undefined;

function getBillingRuntime() {
  sharedRuntime ??= createBillingRuntime({
    auth,
    // Required when verifyYourServerSession reads an HttpOnly browser cookie.
    csrfMode: "same-origin-session",
  }).catch((error: unknown) => {
    sharedRuntime = undefined;
    throw error;
  });
  return sharedRuntime;
}

export async function handleBillingRequest(request: Request) {
  try {
    return await (await getBillingRuntime()).handler(request);
  } catch {
    return Response.json(
      { detail: "billing service is unavailable" },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": "5",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
}
```

Place that singleton in a server-only module and import `handleBillingRequest` from all
three Route Handlers. Do not call `createBillingRuntime` once per request: every warm
bundle owns a PostgreSQL pool, and initialization failures must be retryable. The
packaged `environmentNextBillingRouteHandler` already implements this singleton for the
strict environment-driven personal-JWT/reject-all modes; use the host-owned wrapper when
Auth.js, Clerk, Supabase, or another cookie/session provider supplies identity.

For teams, use `TeamJwtAuthAdapter` with a live host-owned membership repository. A
signed tenant selector alone is not authorization; billing administrators and read-only
viewers have different capabilities. The host must also define identity merge,
deletion, tenant transfer, and plan-grandfathering policy.

## Public and product-service APIs

The Fetch facade serves the same public contract as FastAPI:

| Method | Path                          | Purpose                                      |
| ------ | ----------------------------- | -------------------------------------------- |
| `GET`  | `/api/catalog`                | prices, policy, and structured entitlements  |
| `GET`  | `/api/account`                | webhook-projected account and enforceability |
| `POST` | `/api/checkout`               | first subscription Checkout                  |
| `POST` | `/api/credit-packs/checkout`  | one-time pack Checkout                       |
| `POST` | `/api/billing/portal`         | constrained Portal Session                   |
| `POST` | `/api/billing/change/preview` | durable plan-change preview                  |
| `POST` | `/api/billing/change/confirm` | apply an opaque preview intent               |
| `POST` | `/webhooks/stripe`            | exact raw-body signed webhook                |
| `GET`  | `/api/cron/annual-grants`     | bounded annual-slot worker                   |
| `GET`  | `/api/cron/reconcile`         | bounded recovery worker                      |

Mutating browser routes require the documented origin/CSRF policy and idempotency keys.
The browser never selects a billing account ID.

Product code can call `runtime.kernel.requireServices().entitlements` in the same
process. A separately deployed product service can instead mount
`createInternalBillingFetchHandler`, but it must supply both workload authentication and
an exact workload-to-owner authorizer. Service scope alone must never grant cross-tenant
credit authority. Job creation/queue dispatch and a credit charge are not one database
transaction; use a host-owned outbox/saga and fencing workflow.

A browser Checkout request must carry the authenticated host session or Bearer token,
an allowed `Origin`, JSON content, and one idempotency key created for that user intent.
Persist and reuse the same key across network retries; rotate it only when the user starts
a genuinely new Checkout intent. The response is a Stripe-hosted URL; redirect to it,
then treat the return page only as a signal to poll the webhook-projected account:

```typescript
const response = await fetch("/api/checkout", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "Content-Type": "application/json",
    "Idempotency-Key": loadOrCreateStableCheckoutIntentKey(),
  },
  body: JSON.stringify({
    plan_key: "starter",
    interval: "month",
    success_url: `${location.origin}/billing/success`,
    cancel_url: `${location.origin}/pricing`,
  }),
});
const { url } = (await response.json()) as { url: string };
location.assign(url);
```

For a cross-origin Bearer integration, also send `Authorization`; never expose a shared
service credential. After Stripe returns, poll `GET /api/account` until the signed
webhook projection changes `entitlements_enforceable`; the Checkout redirect itself is
not proof of payment or access.

## Select a plan-change template

Set exactly one value consistently across every API and worker replica:

```dotenv
BILLING_TRANSITION_POLICY=full_period_reset
# or
BILLING_TRANSITION_POLICY=prorated_delta
```

`full_period_reset` starts an eligible immediate upgrade as a new full-price period and
resets the credit pool after the paid Invoice. `prorated_delta` keeps the current period
for a higher-tier monthly-to-monthly upgrade, charges Stripe's verified remaining-period
difference, and adds only the catalog credit difference. Downgrades and annual-origin
changes are period-end. The selected policy is persisted on each intent; price amount
never determines tier direction.

## Repository verification

The following commands are for a clone of the source repository; they are not scripts
shipped inside the npm dependency. The network-free gate includes type-aware lint, type
checking, unit vectors, real PostgreSQL migrations/constraints/transactions/races,
cross-Python/TypeScript credit contention, and a production build:

```bash
npm audit --omit=dev
npm audit
npm run check
```

The source repository's opt-in real Stripe suite refuses a missing, malformed, or live
key before any network request. It creates only run-marked test objects and fails if
strict cleanup or the final zero-inventory check fails:

```bash
npm run test:real-stripe
```

See the matching
[testing guide](https://github.com/Deng-m1/stripe-entitlements-fastapi/blob/v0.4.0/docs/TESTING.md)
for the database container and browser E2E runners, which are not bundled in the npm
tarball.

The repository-level Playwright lifecycle can run the same hosted Checkout, decline,
3DS, signed webhook, plan upgrade, credit pack, Portal, and product Job journey against
either backend and either transition policy:

```bash
E2E_BACKEND_IMPLEMENTATION=typescript \
E2E_TRANSITION_POLICY=full_period_reset \
../scripts/run_browser_e2e.sh

E2E_BACKEND_IMPLEMENTATION=typescript \
E2E_TRANSITION_POLICY=prorated_delta \
../scripts/run_browser_e2e.sh
```

Use test credentials from a private ignored environment file. Passing mocked tests does
not prove Stripe network behavior; Event polling does not prove signed delivery; and a
test endpoint does not prove a live production webhook contract. The exact evidence
boundaries are documented in
[TESTING](https://github.com/Deng-m1/stripe-entitlements-fastapi/blob/v0.4.0/docs/TESTING.md)
and
[BROWSER_E2E](https://github.com/Deng-m1/stripe-entitlements-fastapi/blob/v0.4.0/docs/BROWSER_E2E.md).
