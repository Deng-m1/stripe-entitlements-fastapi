# Stripe entitlements for TypeScript

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
[README](../README.md), [invariants](../docs/INVARIANTS.md), and
[architecture](../docs/ARCHITECTURE.md) before extending the state machine.

## Requirements

- Node.js 22 or newer;
- PostgreSQL 17 (the SQL uses PostgreSQL as the coordination layer);
- a Stripe test-mode account for development;
- a public signed webhook endpoint and a scheduler in deployed environments.

From this source checkout:

```bash
cd typescript
npm ci
cp .env.example .env
chmod 600 .env
```

Set `BILLING_TRANSITION_POLICY` in that private environment file to exactly one of
`full_period_reset` or `prorated_delta` before migration and startup. This package is a
native Node backend: it can run with `stripe-entitlements serve` on any suitable VM,
container platform, or PaaS. Next.js and Vercel are optional adapters, and neither Python
nor a Vercel account is required for the standalone TypeScript path.

The repository's Next.js application consumes the package with
`file:../typescript`. Once an npm release is published, downstream applications can use
the matching pinned package version instead. Do not assume an older npm package or Git
tag contains this working tree.

The current release workflow builds, clean-installs, verifies, and attaches the `.tgz` to
the GitHub Release; it intentionally does not run `npm publish`. Configure npm trusted
publishing and add a registry-vacancy/provenance gate before claiming a registry release.

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
npm run build
npx stripe-entitlements doctor
npx stripe-entitlements serve
```

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
`/api` cannot receive either path. The checked-in files are:

- `web/app/api/[...billing]/route.ts`;
- `web/app/webhooks/stripe/route.ts`;
- `web/app/health/route.ts`.

Use the Node runtime, never Edge, because Stripe, `pg`, raw webhook bodies, and database
transactions are server-only. The included `vercel.typescript.json` deploys this as one
Next.js service and schedules the two secured Cron routes. Managed PostgreSQL remains
required; Vercel state or in-memory locks are not a substitute.

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

const runtime = await createBillingRuntime({ auth });
```

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

## Verification

The network-free gate includes type-aware lint, type checking, unit vectors, real
PostgreSQL migrations/constraints/transactions/races, cross-Python/TypeScript credit
contention, and a production build:

```bash
npm audit --omit=dev
npm audit
npm run check
```

The opt-in real Stripe suite refuses a missing, malformed, or live key before any
network request. It creates only run-marked test objects and fails if strict cleanup or
the final zero-inventory check fails:

```bash
npm run test:real-stripe
```

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
boundaries are documented in [TESTING](../docs/TESTING.md) and
[BROWSER_E2E](../docs/BROWSER_E2E.md).
