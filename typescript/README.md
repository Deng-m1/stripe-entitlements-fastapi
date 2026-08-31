# Stripe entitlements for TypeScript

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

`@tosea/stripe-entitlements` is the native TypeScript/Node implementation of this
repository's Stripe billing, SaaS entitlement, fractional-credit, and credit-pack
reference. It does not proxy or spawn the Python service. It uses the same reviewed
PostgreSQL schema, `plans.toml`, settlement policies, and billing invariants as the
FastAPI implementation.

> **Distribution status:** this `main` branch contains the `0.4.0` release candidate,
> but there is no `v0.4.0` tag or public npm package yet. Use the whole repository or a
> locally packed tarball as shown below. Do not run the registry install command until a
> real npm release exists.

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
[README](https://github.com/ToseaAI/stripe-entitlements/blob/main/README.md),
[invariants](https://github.com/ToseaAI/stripe-entitlements/blob/main/docs/INVARIANTS.md),
and
[architecture](https://github.com/ToseaAI/stripe-entitlements/blob/main/docs/ARCHITECTURE.md)
before extending the state machine.

## Requirements

- Node.js 22 or newer; the package is ESM-only;
- PostgreSQL 17 or 18 (the SQL uses PostgreSQL as the coordination layer);
- a Stripe test-mode account for development;
- a public signed webhook endpoint and a scheduler in deployed environments.

### Use the whole repository

This is the shortest path for v0, another AI builder, or a new Next.js product. Fork or
clone the repository, optionally pin an exact reviewed commit, and keep `web/` next to
`typescript/`. The checked-in web application already uses
`@tosea/stripe-entitlements: file:../typescript` and builds it before Next.js:

```bash
git clone https://github.com/ToseaAI/stripe-entitlements.git
cd stripe-entitlements
git checkout main
npm --prefix web ci
npm --prefix web run dev
```

That command starts the reference UI in local mock mode unless `web/.env.local`
explicitly selects the HTTP backend. It does not select a deployed billing runtime or
prove Stripe integration. For real native TypeScript billing in this whole-repository
layout, deploy explicitly with `-A vercel.typescript.json` (or copy that file to the
fork's root `vercel.json`). The checked-in default `vercel.json` selects the separate
FastAPI service instead.

When changing the root `plans.toml` in this source repository, regenerate the Next.js
pricing snapshot without Python:

```bash
cd typescript
npm run sync:catalog
npm run sync:catalog -- --check
```

The first command writes `web/reference-catalog.json`; the second is the no-write drift
gate. Neither command is part of the packaged tarball, which deliberately omits the
reference UI.

In a Next.js App Router/SSR application, Route Handlers are the backend, so you do
not need a separate FastAPI, Railway, or long-running Node service. Real Stripe
billing still requires one writable PostgreSQL 17 or 18 primary for webhook idempotency,
entitlement and credit state, plan-change intent, workers, reconciliation, and
incidents. Only the browser-local simulation can run without PostgreSQL, and it is
not a real Stripe integration.

### Use a pinned Git checkout or vendored source

No published `@tosea` package is required. Because this package lives in a monorepo
subdirectory, do not put the repository root Git URL directly in `dependencies`; npm
would not find this `package.json`. Pin the repository as a submodule/local checkout,
build its TypeScript package, and use a local file dependency:

```bash
git submodule add https://github.com/ToseaAI/stripe-entitlements.git vendor/stripe-entitlements
git -C vendor/stripe-entitlements checkout FULL_COMMIT_SHA
npm --prefix vendor/stripe-entitlements/typescript ci
npm --prefix vendor/stripe-entitlements/typescript run build
npm install --save-exact ./vendor/stripe-entitlements/typescript
git add .gitmodules vendor/stripe-entitlements package.json package-lock.json
```

```json
{
  "dependencies": {
    "@tosea/stripe-entitlements": "file:vendor/stripe-entitlements/typescript"
  }
}
```

The minimum manual vendor is the complete `typescript/src/` plus its `package.json`,
`package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `.env.example`, README and
licenses, together with root `migrations/001_v3_baseline.sql`,
`migrations/002_stripe_request_snapshots.sql`, and `plans.toml`. Preserve their upstream
layout: the TypeScript build copies `../migrations/` and `../plans.toml` into `dist/`.
The exact tree and upgrade procedure are in the
[source-vendoring guide](https://github.com/ToseaAI/stripe-entitlements/blob/main/docs/ADOPTION.md#consume-a-pinned-git-source-or-vendored-copy).

The host-root `npm install --save-exact` command records the local `file:` dependency in
both `package.json` and `package-lock.json`; without that lockfile update a later
`npm ci` will fail. Commit `.gitmodules` and the submodule gitlink after checking out the
reviewed SHA so CI/Vercel receives that exact revision rather than the branch tip that
was current when `git submodule add` ran.

CI must initialize the pinned checkout and rebuild it before the host application build.
This still uses a JavaScript package manager for the declared `stripe`, `pg`, `jose`,
`zod`, and TOML dependencies; it does not fetch `@tosea/stripe-entitlements` from the npm
registry.

For a Next.js host, make that requirement executable in the host `package.json` rather
than relying on an already-generated local `dist/` directory:

```json
{
  "scripts": {
    "billing:build": "npm --prefix vendor/stripe-entitlements/typescript ci && npm --prefix vendor/stripe-entitlements/typescript run build",
    "prebuild": "npm run billing:build",
    "build": "next build"
  }
}
```

If the host already has `prebuild`, append `npm run billing:build` to it. Vercel can keep
`npm run build` as its Build Command because npm runs `prebuild` automatically. Its source
checkout must contain the initialized public submodule or committed vendor tree before
the install step.

### Install a local tarball into a separate application

If the application lives in another repository, pack the reviewed source and install
the resulting file. This exercises the same package boundary intended for npm without
depending on the unpublished registry entry:

```bash
cd /path/to/stripe-entitlements/typescript
npm ci
mkdir -p /path/to/your-next-app/vendor
npm pack --pack-destination /path/to/your-next-app/vendor

cd /path/to/your-next-app
npm install --save-exact ./vendor/tosea-stripe-entitlements-0.4.0.tgz
npx --no-install stripe-entitlements --version
cp node_modules/@tosea/stripe-entitlements/.env.example .env.local
chmod 600 .env.local
```

The local tarball contains compiled JavaScript, declarations, the CLI, `plans.toml`,
migrations 001/002, the environment example, and licenses. It does not contain the
repository's reference UI, Vercel configuration, test suite, or operator scripts. Keep
the reviewed tarball at that relative `vendor/` path in deployment source (or use an
equivalent private registry); an absolute path on the development machine will not exist
in a remote build.

Next.js may use a project `.env.local` for Route Handlers, but the standalone
`stripe-entitlements` CLI does not load Next.js dotenv files. Before `migrate`,
`bootstrap`, or `doctor`, export the same private server configuration into the shell
as shown below (source `.env.local` instead if that is the file you chose). Never place
Stripe or database credentials in a `NEXT_PUBLIC_*` variable.

The root [environment requirements table](https://github.com/ToseaAI/stripe-entitlements/blob/main/README.md#environment-requirements-by-process)
separates baseline runtime values from Portal, browser Stripe.js, authentication, Cron,
and SEO settings. Copying the full example is convenient; it does not make every value
mandatory for every process.

For contributors working from this source checkout instead:

```bash
cd typescript
npm ci
npm run build
cp .env.example .env
chmod 600 .env
```

`npm run build` is required before the first source-checkout CLI invocation because
`dist/` is generated and intentionally absent from Git. A locally packed tarball already
contains `dist/`, so its consumer does not rebuild the package.

Set `BILLING_TRANSITION_POLICY` in that private environment file to exactly one of
`full_period_reset` or `prorated_delta` before migration and startup. This package is a
native Node backend: it can run with `stripe-entitlements serve` on any suitable VM,
container platform, or PaaS. Next.js and Vercel are optional adapters, and neither Python
nor a Vercel account is required for the standalone TypeScript path.

The repository's own Next.js application intentionally consumes `file:../typescript` so
CI tests the same working tree. A separate application may use either the pinned
submodule/local `file:` path above or the local tarball; the tarball most closely tests
the future registry package boundary. The release workflow is designed to publish those
tested bytes later; a workflow definition is not evidence that publication has happened.

### Browser and Vite consumer boundary

This package is a server runtime. Do not import it into a Vite/Lovable browser bundle:
Stripe secrets, raw webhook verification, `pg`, migrations, and entitlement projection
belong on Node or FastAPI. A Vite frontend calls the deployed billing HTTP API with the
current user's short-lived access token.

The copyable, dependency-free
[`vite-billing-client.ts`](https://github.com/ToseaAI/stripe-entitlements/blob/main/examples/browser_adapters/vite-billing-client.ts) example
contains no repository aliases and does not depend on the unpublished npm package. It is
only a browser transport; the server still verifies identity and remains the source of
truth. See the [AI-builder guide](https://github.com/ToseaAI/stripe-entitlements/blob/main/docs/AI_BUILDERS.md#lovable--supabase) for Supabase
wiring and the HttpOnly-cookie BFF boundary.

## Initialize PostgreSQL

Apply migrations as an explicit operator step:

```bash
# Source checkout uses ./.env. In a separate tarball consumer, change this to ./.env.local.
environment_file=./.env
set -a
. "$environment_file"
set +a
npx --no-install stripe-entitlements migrate
```

`migrate` reads only database connection/pool settings (`DATABASE_URL` and the optional
`DATABASE_POOL_*` bounds); production schema jobs should not receive Stripe secrets.
Application startup does not migrate by default. `BILLING_APPLY_MIGRATIONS=1`
is an explicit local-development opt-in, not a production rollout mechanism.

Use a dedicated PostgreSQL 17 or 18 database or a deliberately isolated database/search path.
The migrations create `schema_migrations`, fourteen correctness tables, functions, and
triggers in the connection's current `search_path`; this release has no
`BILLING_DB_SCHEMA` option. Do not point it casually at an application's existing
`public.schema_migrations`, read replica, HTTP database adapter, or browser database
client. Runtime traffic needs a normal server-side PostgreSQL wire URL to one writable
primary. Pool sizing and rollout guidance live in
[Operations](https://github.com/ToseaAI/stripe-entitlements/blob/main/docs/OPERATIONS.md)
and
[Distributed deployment](https://github.com/ToseaAI/stripe-entitlements/blob/main/docs/DISTRIBUTED.md).

The TypeScript build packages the canonical root migration bundle and catalog. The full
concurrency suites default to PostgreSQL 17. PostgreSQL 18 has a separate compatibility
gate for fresh schema application, idempotent re-application, readiness, and focused
transactions. `migrate` initializes/evolves this application's tables; it does not
upgrade the PostgreSQL server from major version 17 to 18. A brand-new PostgreSQL 18
database simply applies both migrations.

Only adopters with an existing v0.3 application schema need the 001 → 002 writer
cutover. Follow
[Operations](https://github.com/ToseaAI/stripe-entitlements/blob/main/docs/OPERATIONS.md)
for that case; it is not part of a
new project's database setup.

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
npx --no-install stripe-entitlements bootstrap
npx --no-install stripe-entitlements bootstrap --verify-only
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
npx --no-install stripe-entitlements bootstrap \
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
npx --no-install stripe-entitlements bootstrap \
  --allow-live \
  --confirm-live-product-line mysaas-billing

npx --no-install stripe-entitlements bootstrap \
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
npx --no-install stripe-entitlements doctor --profile portal
npx --no-install stripe-entitlements serve
```

Only a source checkout needs `npm run build` first. A local tarball installation runs
the packaged CLI directly.

The listener defaults to `0.0.0.0:8000`. Set `BILLING_HOST`, `BILLING_PORT`, and
`BILLING_PUBLIC_ORIGIN` when a trusted proxy or non-default port is used. Operational
commands are intentionally bounded:

```bash
npx --no-install stripe-entitlements doctor                 # core; Portal is optional
npx --no-install stripe-entitlements doctor --profile portal
npx --no-install stripe-entitlements doctor --profile portal --stripe-network
npx --no-install stripe-entitlements doctor --json
npx --no-install stripe-entitlements doctor --stripe-network
npx --no-install stripe-entitlements --version
npx --no-install stripe-entitlements cron annual-grants
npx --no-install stripe-entitlements cron reconcile
```

`doctor` makes no Stripe request unless `--stripe-network` is present. The default
`core` profile reports a missing Portal configuration as skipped and a placeholder as a
warning; a malformed optional ID also leaves the core API available. The Portal route
rejects missing, placeholder, or malformed IDs locally before Stripe I/O. The `portal`
profile makes that capability strict; network retrieval still requires the
separate opt-in. Doctor does not prove host authentication, scheduler execution, webhook
endpoint metadata, or signed delivery. Cron commands process bounded work and may safely
overlap because PostgreSQL, not process memory, owns coordination.

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
[`/api/[...billing]`](https://github.com/ToseaAI/stripe-entitlements/blob/main/tests/npm-next-consumer/app/api/%5B...billing%5D/route.ts),
[`/webhooks/stripe`](https://github.com/ToseaAI/stripe-entitlements/blob/main/tests/npm-next-consumer/app/webhooks/stripe/route.ts),
and
[`/health`](https://github.com/ToseaAI/stripe-entitlements/blob/main/tests/npm-next-consumer/app/health/route.ts).

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
[`vercel.typescript.json`](https://github.com/ToseaAI/stripe-entitlements/blob/main/vercel.typescript.json)
deploys this as one Next.js service and schedules the two secured Cron routes; it is not
part of the npm tarball. It assumes the source repository's `web/` + `typescript/`
monorepo layout; do not copy it unchanged into a standalone root-level Next.js project.
For that project, let Vercel detect Next.js and add only the Cron entries shown in the
[Vercel guide](https://github.com/ToseaAI/stripe-entitlements/blob/main/docs/VERCEL.md#native-typescript-topology). Managed PostgreSQL remains
required; Vercel state or in-memory locks are not a substitute.

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

The verified, bounded string `sub` becomes a stable owner reference. UUID and opaque
provider subjects are both preserved exactly; optional `nbf` is enforced when present.
Email is never ownership authority. For another session provider, inject an
`AuthAccountAdapter`:

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

For teams, use `TeamJwtAuthAdapter` with a live host-owned membership repository. User
and tenant IDs are bounded opaque strings, so UUID, `user_...`, and `org_...` identifiers
work without normalization. A signed tenant selector alone is not authorization;
billing administrators and read-only viewers have different capabilities. Set
`tenantClaim: "org_id"` in the adapter options when that is the provider's signed claim
name. The host must also define identity merge,
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

`BillingFetchHandlerOptions.onError` is an optional server-only hook for a structured
logger or error tracker. It receives the original exception while the HTTP response
remains sanitized; never echo that exception or write it into browser-visible state.

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
for a higher-tier monthly-to-monthly upgrade with a positive credit difference, charges
Stripe's verified remaining-period difference, and adds only the catalog credit
difference. Downgrades and annual-origin
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
[testing guide](https://github.com/ToseaAI/stripe-entitlements/blob/main/docs/TESTING.md)
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
[TESTING](https://github.com/ToseaAI/stripe-entitlements/blob/main/docs/TESTING.md)
and
[BROWSER_E2E](https://github.com/ToseaAI/stripe-entitlements/blob/main/docs/BROWSER_E2E.md).
