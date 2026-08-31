# Stripe Billing, Entitlements & Credit Packs for FastAPI and TypeScript

[![CI](https://github.com/Deng-m1/stripe-entitlements-fastapi/actions/workflows/ci.yml/badge.svg)](https://github.com/Deng-m1/stripe-entitlements-fastapi/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.12%2B-3776AB.svg)](pyproject.toml)
[![Node](https://img.shields.io/badge/node-22%2B-339933.svg)](typescript/package.json)

An open-source Stripe billing, SaaS entitlements, and credit-ledger starter with two
native backend choices: Python/FastAPI or TypeScript/Node/Next.js. Both use PostgreSQL
and the same reviewed accounting contract. It includes monthly/yearly subscriptions, exact fractional
credits, one-time credit packs, two selectable upgrade policies, Checkout, refunds,
disputes, SCA recovery, Test Clock renewals, and webhook-authoritative accounting under
duplicate, delayed, concurrent, and out-of-order Events.

> This is an independent community project, not an official Stripe product.
> It is a reference implementation, not a universal SaaS billing framework and
> not financial, tax, accounting, or legal advice.

> **Current distribution status:** `main` contains the `0.4.0` release candidate,
> but `v0.4.0` and `@tosea/stripe-entitlements@0.4.0` are not published yet. Use a
> reviewed source commit, pinned Git/path dependency, vendored copy, or locally built
> tarball until those release channels exist; do not rely on an older tag or package as
> equivalent code. This is a new
> pre-1.0 reference with no documented external production adopters; its automated and
> Stripe test-mode evidence is not evidence of third-party production use.

## Start here

Choose the path that matches the host application; the linked guides contain the actual
setup and verification steps:

| Goal                                    | Start with                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Add billing to a Python/FastAPI service | [Quick start](#quick-start), then [adoption](docs/ADOPTION.md#compose-the-fastapi-application) |
| Use native Next.js/TypeScript billing   | [TypeScript source, Git vendor, or tarball](typescript/README.md#requirements)                 |
| Share a UI-only link without Stripe/DB  | [Credential-free public simulation](docs/AI_BUILDERS.md#publish-a-ui-only-simulation)          |

No registry release is required for either backend. The
[pinned Git and minimum vendoring guide](docs/ADOPTION.md#consume-a-pinned-git-source-or-vendored-copy)
lists the exact Python/TypeScript source, SQL, catalog, build, and upgrade boundaries.
The TypeScript source path still uses npm or another compatible JavaScript package
manager to install its third-party dependencies and produce `dist/`; it only avoids
downloading this unpublished package from the public registry.

## Contents

- [Implemented scope](#what-is-completeand-what-is-not)
- [Choose Python or TypeScript](#choose-python-or-typescript)
- [Plan catalog and annual savings](#plan-catalog)
- [One-time credit packs](#one-time-credit-packs)
- [Two plan-change templates](#safe-stripe-plan-transitions-full-price-or-prorated-difference)
- [Correctness and distributed deployment](#correctness-model)
- [Optional Vercel deployment](#deploy-on-vercel-with-either-backend)
- [v0, Lovable, and public simulation](#use-with-v0-lovable-and-ai-app-builders)
- [Quick start](#quick-start)
- [Adopt in an existing application](#adopt-in-an-existing-application)
- [Demo recording](#demo-recording-and-promotional-video)
- [Test evidence](#verification-and-evidence-boundary)
- [SQL and production cutover](#sql-migrations-and-production-cutover)
- [Repository map](#repository-map)
- [Frequently asked questions](#frequently-asked-questions)

## Why this Stripe billing reference exists

Many Stripe examples stop after creating Checkout or verifying a webhook signature.
Real SaaS billing also has to survive duplicate and out-of-order Events, concurrent
workers, unknown remote outcomes, annual credit resets, failed upgrades, refunds, and
browser returns that arrive before entitlement projection. This repository makes those
state transitions explicit and backs them with PostgreSQL constraints and real Stripe
test-mode gates.

It is useful as a starting point for teams building a FastAPI Stripe integration,
TypeScript/Next.js billing backend, subscription credit system, or SaaS pricing UI that need a
reviewable reference rather than a copy-paste Checkout snippet.

## Choose Python or TypeScript

The repository contains two independent server implementations. TypeScript does not
forward requests to Python, and Python does not invoke Node:

| Runtime                | Best fit                                                                              | Entry points                                                              |
| ---------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Python 3.12+ / FastAPI | Existing Python API, sidecar, container, or Vercel Services split deployment          | `stripe_entitlements`, `create_app`, `install_billing`, Python CLI        |
| Node 22+ / TypeScript  | Next.js App Router, standalone Node billing service, or another Fetch-compatible host | `@tosea/stripe-entitlements`, Node CLI, Fetch handler, Next Route Handler |

They share the canonical [`plans.toml`](plans.toml), PostgreSQL
[`001_v3_baseline.sql`](migrations/001_v3_baseline.sql) plus append-only
[`002_stripe_request_snapshots.sql`](migrations/002_stripe_request_snapshots.sql),
fixed-point credit protocol, transition matrices, webhook contract, and documented invariants. Golden policy vectors
run in both languages, and mixed Python/TypeScript PostgreSQL tests prove that the same
idempotency key cannot double-charge or overspend an account.

A deployment normally chooses one backend runtime. Do not mix arbitrary package
versions as interchangeable replicas: every API/webhook/worker process must use a
compatible migration level, identical catalog, Stripe mode/version contracts, product
line, and transition policy. See the [TypeScript package guide](typescript/README.md).

## What is complete—and what is not

The repository implements two complete, deliberately bounded transition templates:

- `full_period_reset`: immediately start a full-price target period without proration;
- `prorated_delta`: preserve the current monthly period, pay the prorated difference,
  and add the catalog entitlement difference.

For the bundled three-plan, two-interval catalog, their complete 6 × 6 matrices are
selected with one environment setting and persisted per intent. Shared scope:

- one subscription item and one currency (USD);
- any non-empty set of stable plan keys, each available monthly and yearly; the bundled
  reference catalog ships Starter, Pro, and Ultra;
- zero or more card-funded one-time USD credit packs with independent expiry and
  source-aware refunds; the bundled reference catalog ships three;
- exact product credits down to `0.000001`, stored as integer atoms rather than floats;
- yearly invoices fund up to 12 monthly credit grants rather than granting all
  credits at purchase;
- Checkout creates the first paid subscription;
- authenticated catalog, account, Checkout, Portal, preview, and confirm APIs;
- standalone `create_app()` plus native `BillingKernel` / `install_billing` composition
  for an existing FastAPI root;
- an independent TypeScript `BillingKernel`, Fetch facade, standalone Node server/CLI,
  and Next.js App Router integration using the same schema and invariants;
- strict personal/team JWT authentication starters, including catalog-only team viewers;
- an in-process `EntitlementService` and optional owner-authorized internal workload API;
- server-controlled plan transitions with Stripe invoice previews and
  Subscription Schedules;
- a Next.js reference UI for pricing, account state, payment recovery, and
  webhook-backed success polling;
- a stable Vercel Services deployment for Next.js, FastAPI, and secured bounded Cron
  routes on one domain, without requiring Railway or a separately hosted API;
- PostgreSQL event/business idempotency, row locks, durable plan-change intent,
  cross-Invoice funding allocation, refund/dispute convergence, and fail-closed
  incidents;
- a runnable host-owned Job + billing outbox + dispatch outbox + fencing example;
- persistent credit-pack reconciliation from exact Session, PaymentIntent, and Charge
  identities after webhook loss.

It does **not** implement multi-currency, seats or quantities, trials, coupons,
tax calculation, metered billing, arbitrary mixed invoice items, revenue
recognition, accounting, or a hosted identity provider. The host application
must supply verified authentication and product enforcement. See
[Architecture](docs/ARCHITECTURE.md), [Invariants](docs/INVARIANTS.md),
[exact fractional credits](docs/CREDIT_PRECISION.md), and the
[adoption guide](docs/ADOPTION.md).

## Plan catalog

Prices come from [plans.toml](plans.toml). Tier identity and transition direction
use stable plan keys and explicit rank—never a price comparison.

After editing that canonical file, regenerate the public pricing snapshot with the
source runtime already used by the host; neither path requires installing the other
runtime:

```bash
# Python/FastAPI source workflow, from the repository root
uv run python scripts/sync_reference_catalog.py
uv run python scripts/sync_reference_catalog.py --check

# Native TypeScript/v0 source workflow
cd typescript
npm run sync:catalog
npm run sync:catalog -- --check
```

Both commands validate `plans.toml` and deterministically produce the same
`web/reference-catalog.json`; `--check` verifies drift without writing.

| Plan    | Monthly | Yearly total | Yearly equivalent | Annual saving | Monthly credits |
| ------- | ------: | -----------: | ----------------: | ------------: | --------------: |
| Starter |     $19 |         $137 |         $11.42/mo |           $91 |             300 |
| Pro     |     $49 |         $353 |         $29.42/mo |          $235 |           1,000 |
| Ultra   |    $149 |       $1,073 |         $89.42/mo |          $715 |           4,000 |

Yearly savings compare 12 monthly payments with the explicit yearly total. The catalog
accepts lower, equal, or higher yearly totals because pricing is a product decision. The
UI shows a saving only when both prices use the same currency and the yearly total is
actually lower; an equal or higher yearly price gets no saving claim.
This display calculation never controls tier direction or transition timing.
Credits on a yearly subscription still arrive in monthly slots.

The bundled annual totals are approximately 40% lower than twelve monthly payments.
That is an explicit annual-price design, not a Stripe Coupon or Promotion Code. Coupons,
trials, and time-limited campaigns remain outside this reference's implemented scope:
Checkout Session creation omits `allow_promotion_codes` unconditionally, so hosted
Checkout never shows a promotion-code field. The gates any future promotion-code
support must clear first are documented in
[Promotion codes and coupons](docs/PROMOTION_CODES.md).

| Entitlement             | Starter |    Pro |  Ultra |
| ----------------------- | ------: | -----: | -----: |
| PDF → PPT / image → PPT |     yes |    yes |    yes |
| Batch conversion        |      no |    yes |    yes |
| API access              |      no |    yes |    yes |
| Priority queue          |      no |     no |    yes |
| Maximum file size       |   30 MB | 100 MB | 250 MB |
| Maximum pages per job   |     100 |    500 |  2,000 |
| Concurrent jobs         |       1 |      5 |     20 |
| API keys                |       0 |      5 |     25 |

The API returns these as structured entitlements. Product code still has to
enforce them; displaying an entitlement is not enforcement.

These bundled tiers are cumulative, but the catalog parser does not impose that product
choice on adopters. A plan may have no feature flags or numeric limits, and a higher-rank
plan may trade one entitlement for another. Rank alone defines upgrade/downgrade
direction. Under `prorated_delta`, a higher-rank monthly change without a positive credit
difference is safely scheduled for period end instead of attempting delta settlement.

Catalog entitlement names do have two invariants. `monthly_credits` is reserved for the
entitlement synthesized from each plan's top-level `monthly_credits` value, so it cannot
also be declared under `features` or `limits`. All other feature and numeric-limit keys
share one catalog-wide namespace: a key used as a feature in any plan cannot be used as a
limit in another plan, or vice versa. This keeps one key's value type stable for every
plan and for downstream enforcement.

## One-time credit packs

The reference catalog also includes one-time packs. Packs add spendable product credits;
they never add plan features, raise limits, or alter subscription tier direction.

| Pack        | Price | Credits | Default expiry |
| ----------- | ----: | ------: | -------------: |
| Boost 100   |   $15 |     100 |       365 days |
| Boost 500   |   $59 |     500 |       365 days |
| Boost 2,000 |  $199 |   2,000 |       365 days |

Pack Checkout uses Stripe Hosted Checkout in `mode=payment` and explicitly restricts the
reference contract to cards; Dashboard automatic payment methods cannot silently add an
untested settlement rail. Only a signed, exact `payment_intent.succeeded` projection
creates a funding lot; the browser return and `checkout.session.completed` do not grant
credits. Product debits are allocated FEFO to their exact subscription or pack sources.
Partial cash refunds, disputes, expiry, product refunds, and debt collected from later
funding remain traceable and converge in either delivery order. See
[Credit packs and multi-source funding](docs/CREDIT_PACKS.md).
Host product code stays on the Checkout/router/`EntitlementService` facade; it does not
need to query or coordinate the four internal pack accounting tables.

## Safe Stripe plan transitions: full price or prorated difference

Abbreviations combine plan and interval: `SM` is Starter Monthly, `SY` is
Starter Yearly, and so on.

Set `BILLING_TRANSITION_POLICY=full_period_reset` or `prorated_delta` before starting
the API. Health, catalog, account, preview, and confirm responses expose the selected
mode; every intent stores it durably.

`full_period_reset` keeps the original matrix: monthly-origin higher tiers and
month-to-year targets are preview-eligible immediately; downgrades and all
annual-origin changes are period-end. Immediate apply uses
`billing_cycle_anchor=now` and `proration_behavior=none`, and the paid target Invoice
resets the monthly credit pool.

`prorated_delta` permits immediate settlement only for a higher monthly tier with a
positive credit difference while remaining monthly. For example, Starter Monthly → Pro
Monthly pays Stripe's net remaining-period difference and adds exactly
`1,000 - 300 = 700` credits while keeping the same period and unused balance. Month/year
conversions, downgrades, and every annual-origin change are period-end.

The delta webhook path loads all Invoice line pages, requires one negative source and
one positive target catalog proration at the same fraction, and stores their
cross-Invoice funding allocation. Tax, discounts, customer balance, credit notes,
unknown/missing lines, and inconsistent periods fail closed. Partial refunds claw back
the proportional delta; closing a leaf upgrade reverts to the still-funded source,
while closing a source/intermediate lineage revokes enforcement for repair.

Both full bundled-catalog 6 × 6 matrices, Invoice acceptance rules, refund semantics,
and failure behavior are in [Plan transition policies](docs/PLAN_TRANSITIONS.md).

## Correctness model

- **At-least-once delivery, effectively-once PostgreSQL effects.** The project
  does not claim impossible end-to-end exactly-once delivery.
- Stripe signature verification authenticates the exact request body before parsing.
  Stripe Event IDs guard duplicate deliveries; `(stripe_invoice_id, grant_slot)`
  independently guards the same business grant through another Event or worker.
  PostgreSQL retains only a minimal allowlist of operational Event identifiers/state,
  never recursive Stripe free text, the raw body, or a payload digest.
- Funding attribution uses exact Customer/Subscription identity, Checkout claim/session
  identity, and server-retrieved Price-to-Product catalog identity. Stripe metadata such
  as `product_line` remains useful for operations but is not a duplicate authorization
  gate once those stronger identities match.
- Account row locks serialize balance, grant, refund, cancellation, and
  plan-change projection.
- `(event.created, event_rank)` prevents older/weaker subscription projections
  from overwriting newer state.
- Refund/dispute facts persist even when they arrive before the paid grant.
- Pack orders, funding lots, debit allocations, and durable clawback debt preserve the
  exact source of one-time credits across expiry, product refunds, and cash refunds.
- Delta allocations preserve source/target Invoice lineage across refunds and disputes.
- If a current-epoch clawback is larger than the spendable balance,
  `billing_clawback_debts` retains the missing units and consumes later same-epoch
  usage refunds or delta grants before they become spendable.
- Checkout and plan-change operations use durable, caller-replayable request
  identities and Stripe idempotency keys.
- Credit-pack Checkout also snapshots its original Customer-or-create mode; a webhook
  or changed login email cannot alter a same-key replay after an unknown remote result.
- Confirm atomically moves a preview to `applying` and records `remote_started_at`
  before Stripe mutation. Unknown outcomes younger than 23 hours use only the same
  derived Stripe key; older ambiguity stops for operator proof.
- Paid and payment-failed plan-change Events must match the intent's compare-and-set
  settlement Invoice ID; Subscription identity alone cannot attach an older failure.
  A paid webhook may win the coordinator-finish race, but both paths can bind only the
  same Invoice and a POST response never grants access.
- A 2xx fail-closed decision creates durable state or a `billing_incidents` row.

PostgreSQL is the coordination and writable truth. Multiple API/worker processes
are safe against the same primary, but PostgreSQL remains a stateful dependency
and single point unless deployed with HA, backups, and tested restore. See
[Distributed deployment](docs/DISTRIBUTED.md).

## Deploy on Vercel with either backend

The checked-in [`vercel.json`](vercel.json) deploys `web/` and the existing Python
billing core as two Vercel Services behind one deployment URL. Browser `/api/*`, Stripe
`/webhooks/*`, and `/health` traffic goes to FastAPI; every other path goes to Next.js.
The frontend uses the explicit `same-origin` API sentinel, so it needs no Railway URL,
cross-origin allowlist, or second public deployment.

Vercel Cron invokes bounded hourly annual-grant and five-minute reconciliation routes.
Those routes require `CRON_SECRET`, return only aggregate counts, and rely on the same
PostgreSQL locks, uniqueness guards, and leases that make multiple workers safe. Schema
migration and Stripe catalog bootstrap remain explicit operator commands before deploy.

This option still requires managed PostgreSQL, a Stripe account/webhook endpoint, and
the product's real identity provider. Same-origin routing never weakens authentication:
the FastAPI entrypoint defaults to reject-all and can enable the strict personal
JWT/JWKS starter only through complete explicit configuration. Preview deployments must
use isolated test Stripe/database resources and remain `noindex`.

See [Deploy Next.js and FastAPI together on Vercel](docs/VERCEL.md) for the environment
matrix, authentication boundary, local `vercel dev -L` workflow, webhook setup, and
deployment verification checklist.

For a pure TypeScript deployment, [`vercel.typescript.json`](vercel.typescript.json)
uses one Next.js service. Native Route Handlers own `/api/*`, `/webhooks/stripe`, and
`/health`, and the same bounded Cron URLs call the TypeScript services. It does not need
a Python or Railway runtime, but it still requires managed PostgreSQL, Stripe, real
authentication, migrations, backups, and schedulers. See the
[TypeScript package guide](typescript/README.md#use-the-native-nextjs-backend).

## Use with v0, Lovable, and AI app builders

A Stripe test account is sufficient for a realistic, access-controlled staging site:
Checkout, Portal, test cards, SCA, signed webhooks, refunds, and Test Clocks all use
Stripe's real test-mode network without moving money. The repository also provides an
explicitly `noindex` public `simulation` mode for UI-only links that must not contact
Stripe or a database.

v0 can edit the visual Next.js layer in this source repository while retaining the
native TypeScript Route Handlers. Lovable can own a Vite visual layer, but real billing
must call a separately deployed Node/FastAPI service through a tested authentication
integration. The repository UI's Supabase transport is not an exported browser package;
the guide provides one dependency-free
[`vite-billing-client.ts`](examples/browser_adapters/vite-billing-client.ts) file to copy
into a Vite project. In every case, secret keys, webhook verification, PostgreSQL, and
entitlement projection remain server-side. See the complete
[AI app-builder and test-staging guide](docs/AI_BUILDERS.md).

## API surface and authentication

Authenticated billing routes:

| Method | Route                         | Purpose                                                        |
| ------ | ----------------------------- | -------------------------------------------------------------- |
| GET    | `/api/catalog`                | ordered prices and structured entitlements                     |
| GET    | `/api/account`                | webhook-projected plan, credits, enforcement and pending state |
| POST   | `/api/checkout`               | first paid subscription; requires `Idempotency-Key`            |
| POST   | `/api/credit-packs/checkout`  | one-time pack Checkout; requires `Idempotency-Key`             |
| POST   | `/api/billing/portal`         | safe Portal Session; requires `Idempotency-Key`                |
| POST   | `/api/billing/change/preview` | durable preview; requires `Idempotency-Key`                    |
| POST   | `/api/billing/change/confirm` | confirm the opaque `preview_id`                                |

For a native TypeScript host, `BillingFetchHandlerOptions.onError` can send the original
server exception to a structured logger or error tracker while the client response stays
sanitized. Keep that callback server-only; never echo its exception or write it into
browser-visible state.

`AuthAccountAdapter` is the integration boundary in both implementations. Production defaults to
`RejectAllAuthAdapter`; it does not trust a browser-supplied account ID.
`DemoBearerAuthAdapter` is enabled only when all of these are true:

- `APP_ENV=development`;
- a Stripe test-mode key is configured;
- an explicit demo token is configured.

Replace it with verified session/OIDC/JWT authentication before deployment. The
demo token is not production auth. The optional `auth` extra supplies a strict
asymmetric JWT/JWKS verifier plus personal and team adapters. The team adapter proves
live membership for the signed tenant selector; viewers may read only catalog routes,
while account/recovery state and every mutation require `billing_admin`. When billing
uses a route prefix, pass that same explicit prefix to
`TeamBillingAuthorizationPolicy`; it never guesses path ownership. See the
[adoption guide](docs/ADOPTION.md#connect-authentication-and-tenant-authorization) and
the runnable [auth starters](examples/auth_starters/README.md).

Server-to-server product enforcement is separate from browser billing. The optional
internal router exposes entitlement check and owner-bound credit charge/refund routes.
It defaults to reject-all workload authentication and reject-all owner authorization;
an operation scope alone never permits a service to select every tenant. Exact JSON
shapes for the public frontend are documented in [web/README.md](web/README.md); the
private service boundary is documented in the
[adoption guide](docs/ADOPTION.md#standalone-service-private-apis).

## Stripe API versions are two separate contracts

- `STRIPE_API_VERSION` controls outbound SDK requests. Current code targets
  `2026-06-24.dahlia`.
- Each webhook Event has its own snapshot `api_version`, determined by the
  Stripe webhook endpoint/account contract. `STRIPE_WEBHOOK_API_VERSION` must
  equal that actual Event value and is a required startup setting; it deliberately
  has no fallback to `STRIPE_API_VERSION`.

The request version does not rewrite webhook payloads. In the four exact-`f757fcc`
browser gates, isolated test endpoints pinned to Dahlia delivered signed
`2026-06-24.dahlia` payloads while independent Event API retrievals reported
`2025-12-15.clover`. A mismatch
is recorded as `webhook_contract_mismatch` and ignored fail-closed. This repository does
not infer request, Event API view, or endpoint payload versions from one another. See
[Testing](docs/TESTING.md),
[Stripe CLI](docs/STRIPE_CLI.md), and
[Webhook verification](docs/WEBHOOK_VERIFICATION.md).

## Quick start

Requirements for the complete source-repository gates: Python 3.12+, `uv`, Docker,
Node.js 22+, npm, Stripe CLI, and a
Stripe test-mode account.

Choose one backend runtime for application traffic. The following setup first shows the
Python/FastAPI commands; the native TypeScript alternative follows below. PostgreSQL,
Stripe catalog, Portal, webhook, identity, and scheduler requirements are the same.
Vercel is an optional deployment adapter, not a runtime dependency: either backend can
run on a VM, container platform, Kubernetes, or another PaaS that can reach PostgreSQL
and receive signed Stripe webhooks. Docker and Stripe CLI are used by the repository's
default local/test workflows; they are not required inside a deployed application.

The commands below run from a source checkout. For a repeatable deployment, replace
`main` with the exact reviewed commit. The source tree contains both runtimes, the
catalog, migrations, examples, tests, and reference UI:

```bash
git clone https://github.com/Deng-m1/stripe-entitlements-fastapi.git
cd stripe-entitlements-fastapi
git checkout main
```

`stripe-entitlements migrate` initializes this application's schema in a fresh
PostgreSQL database. It does **not** upgrade PostgreSQL 17 to PostgreSQL 18. A new Neon
PostgreSQL 18 database has no major-version upgrade step; it only needs the application
schema initialized. Existing v0.3 application databases have a separate 001 → 002
cutover procedure in [Operations](docs/OPERATIONS.md).

```bash
cp .env.example .env
chmod 600 .env
# Choose full_period_reset or prorated_delta in .env.
docker compose up -d postgres
uv sync --frozen
uv run --env-file .env stripe-entitlements migrate
```

### Environment requirements by process

The full `.env.example` enables the complete reference, but its entries are not all
baseline startup requirements:

| Process or feature                        | Required configuration                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema migration only                     | `DATABASE_URL`; pool bounds are optional                                                                                                             |
| API/webhook/worker runtime                | `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the actual `STRIPE_WEBHOOK_API_VERSION`                                            |
| Protected browser billing                 | A host-supplied `AuthAccountAdapter`, or the complete compatible JWT/JWKS starter configuration; otherwise protected routes intentionally return 401 |
| Customer Portal                           | `STRIPE_PORTAL_CONFIGURATION_ID`; the rest of the server can start without Portal                                                                    |
| Reference UI plan-change/SCA confirmation | Matching `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`; initial Hosted Checkout and Portal redirects do not need it                                           |
| Annual grants and reconciliation          | A scheduler; `CRON_SECRET` is required only by the bundled Vercel Cron routes                                                                        |
| Production redirects/CORS                 | Deployment-specific Checkout, Portal, and `FRONTEND_ORIGINS` HTTPS values; localhost defaults are development-only                                   |
| Public SEO indexing                       | Canonical `NEXT_PUBLIC_SITE_URL` plus explicit `NEXT_PUBLIC_ALLOW_INDEXING=true`; previews should omit/disable them                                  |

`STRIPE_API_VERSION`, catalog/product identifiers, transition policy, pool settings, and
local URLs have defaults. Review or override them for a real product, but they are not
additional parser-level secrets required merely to start the reference runtime.

`stripe-entitlements migrate` reads only database connection/pool settings; a schema-init Job does not need
the Stripe API key, webhook secret, or browser configuration. The full `.env` command
above is convenient for local setup, but production should inject a database-only secret
into the migration Job and keep Stripe credentials on the API/workers that use them.

Before bootstrap, replace `STRIPE_SECRET_KEY`, the local demo values, product line,
lookup prefix, catalog path and transition policy in `.env`. The Portal ID and webhook
secret remain placeholders only until the next steps produce their real test-mode values.
Keep that file ignored and private; never commit credentials. Hosted Checkout and Portal
do not need a publishable key; the reference UI's Stripe.js plan-change/SCA confirmation
does. When that flow is enabled, the backend secret, Stripe CLI login, and browser
publishable key must all belong to the same Stripe test account.

Bootstrap or verify the dedicated test catalog and safe Portal configuration:

```bash
uv run --env-file .env python scripts/bootstrap_stripe.py
uv run --env-file .env python scripts/bootstrap_stripe.py --verify-only
```

Copy the actual Portal configuration ID reported by bootstrap into the ignored `.env`;
do not leave a format-valid placeholder. `--verify-only` finds a safe configuration but
does not prove that `STRIPE_PORTAL_CONFIGURATION_ID` points to that exact ID.

Start signed forwarding in a separate terminal:

```bash
stripe login
stripe listen \
  --events checkout.session.completed,checkout.session.expired,invoice.paid,invoice.payment_failed,customer.subscription.updated,customer.subscription.deleted,charge.refunded,charge.dispute.created,payment_intent.succeeded \
  --forward-to http://127.0.0.1:8000/webhooks/stripe
```

Copy the temporary signing secret into the ignored `.env` before starting the API.
`STRIPE_WEBHOOK_API_VERSION` must come from the listener or endpoint's actual signed
payload; it must not be copied from `STRIPE_API_VERSION`. Follow
[the local discovery procedure](docs/ADOPTION.md#discover-a-local-stripe-cli-payload-version)
when that contract is not yet known: start once with a candidate only for the diagnostic
delivery, then update `.env` and restart before beginning Checkout.

Run the read-only core preflight after the signing secret and signed-payload version are
configured. Customer Portal is an optional capability in this profile:

```bash
uv run --env-file .env stripe-entitlements doctor
```

`doctor` does not call Stripe by default. It checks the local package, catalog,
configuration, PostgreSQL schema, and migration checksums without printing secrets or
DSNs. A missing Portal ID is `SKIP` in the default `core` profile; a placeholder is a
warning, and a malformed optional ID also does not block the core API. The Portal route
rejects any missing, placeholder, or malformed ID locally before Stripe I/O. After
bootstrap produces the real ID, require it explicitly:

```bash
uv run --env-file .env stripe-entitlements doctor --profile portal
uv run --env-file .env stripe-entitlements doctor --profile portal --stripe-network
```

Use `--json` for automation. `--stripe-network` remains an explicit opt-in and adds read-only Stripe
Account/catalog verification plus Portal retrieval when configured. This preflight does
not prove production authentication, scheduler execution, webhook endpoint metadata, or
signed-payload delivery.

Start or restart the API after the final webhook contract is known:

```bash
uv run --env-file .env \
  uvicorn stripe_entitlements.app:create_app --factory --port 8000
```

Native TypeScript/Node alternative. For contributors running this source checkout instead:

```bash
cd typescript
npm ci
npm run build
cp .env.example .env
chmod 600 .env
# Set BILLING_TRANSITION_POLICY to full_period_reset or prorated_delta.
set -a
. ./.env
set +a
npx --no-install stripe-entitlements migrate
npx --no-install stripe-entitlements doctor
npx --no-install stripe-entitlements serve
```

The explicit build is required in a source checkout because generated `dist/` CLI files
are not committed. A locally packed `.tgz` already contains them. The Node server
exposes the same public paths on port 8000. A pure Next.js backend can
instead use the checked-in Route Handlers and `vercel.typescript.json`; it never starts
FastAPI. Full package, auth, worker, and deployment instructions are in
[`typescript/README.md`](typescript/README.md).

If an existing Next.js application lives in another repository, use either a pinned
submodule/local `file:` dependency or a locally built `.tgz` instead of the nonexistent
npm registry version. The exact source and tarball commands are in the
[TypeScript guide](typescript/README.md#requirements).

For the reference frontend:

```bash
cd web
npm ci
cp .env.example .env.local
chmod 600 .env.local
npm run dev
```

The copied frontend configuration defaults to explicit mock data; it does not connect
to the backend. HTTP mode requires the settings in the
[adoption guide](docs/ADOPTION.md#connect-or-replace-the-nextjs-frontend) and a matching
auth adapter. The UI does not treat Checkout return, confirm success, or SCA completion
as entitlement proof; it polls `/api/account` until webhook state matches the target.
With the default URL allowlists, open the frontend as `http://localhost:3000`, not the
different `http://127.0.0.1:3000` Origin.

A canned
`stripe trigger invoice.paid` has no matching repository account, so a durable
unknown-account incident is expected; it is a transport/signature smoke, not an
entitlement lifecycle test.

## Adopt in an existing application

Choose the billable owner before writing an authentication adapter. Personal billing
usually maps an immutable host user ID to `external_ref`; team billing maps the verified
organization or tenant ID instead. Email and browser-supplied account IDs are never
ownership authority.

Both backend packages supply the auth protocol, account resolver, billing HTTP APIs and
atomic credit primitives. It now also supplies personal/team JWT starters,
`BillingKernel` / `BillingServices`, a native `APIRouter` installer, an
`EntitlementService`, and an optional internal workload router. The host still owns
issuer/session configuration, tenant membership data, workload-to-owner grants,
product-limit enforcement, and the durable workflow that coordinates a Job with a
credit charge or refund. `CreditService` and a host Job insert are not one transaction,
so production job admission needs an idempotent outbox/saga rather than a best-effort
sequence. A complete runnable implementation is in
[`examples/job_outbox/`](examples/job_outbox/README.md).

Use `create_app(..., auth_adapter=...)` for the standalone service. For an existing
FastAPI root, construct `BillingKernel`, then call
`install_billing(app, kernel, prefix="/stripe")` before startup. The installer composes
the existing lifespan, reuses a host-connected pool without taking ownership, includes
prefixed routes in host OpenAPI, scopes browser CORS/Origin handling to public billing
routes, and scopes response hardening to installed billing routes. It does not alter
unrelated host routes or global logging. See the
[adoption guide](docs/ADOPTION.md#compose-the-fastapi-application) for complete runnable
personal, team, composed-lifespan, and internal-router examples.

For Node or Next.js, use `createBillingRuntime({ auth })` with a host
`AuthAccountAdapter`, or configure the strict personal JWT/JWKS environment starter and
delegate Route Handlers to `environmentNextBillingRouteHandler`. Team deployments inject
`TeamJwtAuthAdapter` with a live membership repository. See the
[TypeScript adoption guide](typescript/README.md#connect-the-host-identity-system).

Bind one `Database` object to one kernel; a second binding fails fast so one lifecycle
cannot close another kernel's pool. Routers passed explicitly through `internal_routers`
receive no-store/nosniff hardening but never inherit the public browser CORS permission.

Product credits support six exact fractional digits without binary floating point. A
Python integer passed to `CreditService` retains its historical meaning of whole credits;
fractional requests use a decimal string or `Decimal`. HTTP responses expose canonical
decimal strings together with atom strings and `scale=1000000`, so JavaScript never uses
a lossy `number` as ledger truth.

See [Adopting the reference in an existing application](docs/ADOPTION.md) for deployment
choices, user/tenant mappings, production auth code, server-side entitlement checks,
credit integration, frontend auth, schedulers and host contract tests.

## Demo recording and promotional video

Record a deterministic public-site/pricing/account walkthrough without Stripe:

```bash
PROMO_STEP_PAUSE_MS=1400 scripts/run_promo_ui.sh
```

The real browser runner can also retain Playwright video while exercising a real
Stripe **test-mode** decline, Checkout 3DS, signed webhook projection, plan preview,
upgrade SCA, and final account state:

```bash
E2E_TRANSITION_POLICY=prorated_delta \
E2E_RECORD_VIDEO=1 \
E2E_DEMO_PAUSE_MS=1200 \
scripts/run_browser_e2e.sh
```

The default transport creates a temporary version-pinned Webhook Endpoint and remains
the release-evidence mode. `E2E_WEBHOOK_TRANSPORT=stripe_cli` is available for local
signed-forwarding diagnosis and recording when a Quick Tunnel is unavailable, but it
does not prove endpoint metadata or endpoint-specific version pinning.

Build and review the redacted public cut with FFmpeg and Tesseract:

```bash
scripts/build_promo_video.sh
scripts/review_promo_video.sh
```

The builder generates its own deterministic music, identifies the two Playwright page
videos from safe screenshots, locates the Checkout/3DS/account milestones, masks payment
fields, and writes the H.264/AAC output below ignored `web/test-results/promo-final/`.
Raw browser artifacts remain ignored and private. The review gate decodes every frame
before checking A/V alignment, black segments, codecs, loudness, forbidden OCR terms,
and all 15 intentional scene captions. See
[Demo recording and promotional video](docs/DEMO_VIDEO.md) for the evidence boundary,
privacy rules, and reproducible workflow.

## Verification and evidence boundary

Evidence is split by execution layer; collecting a test or retaining an older run does
not prove the current tree against Stripe's network.

The billing-core and Stripe-network parity gate is bound to clean commit
`f757fcce4aeb1194b3db04f87579e8f5ef169058`. Its tree is byte-identical to the
subsequent squash-merged `main` commit `89646e5`. GitHub Actions run
[`33283480383`](https://github.com/Deng-m1/stripe-entitlements-fastapi/actions/runs/33283480383)
passed Backend, TypeScript billing core, Container, and Web:

- Python passed Ruff, Mypy, the version check, dependency audit, and 1,257 network-free
  tests with 10 `real_stripe` cases deselected;
- native TypeScript passed format/lint/typecheck/build, both npm audits, and 816 tests
  across 50 files with 83.19% statements, 76.64% branches, 92.16% functions, and 83.25%
  lines;
- a clean Web archive/install passed lint, typecheck, production build, both npm audits,
  and 208 tests across 19 files;
- Python and TypeScript each passed all 10 real Stripe **test-mode** cases, including
  run-owned cleanup and zero residual inventory;
- Python and TypeScript each passed both transition policies through four production-
  build browser journeys using temporary signed Stripe test-mode endpoints. Every run
  ended at Pro/1,020, observed 11 account-related and zero unrelated Events, bound the
  five essential Events, and completed database/endpoint/object cleanup; and
- clean Wheel/sdist/npm artifacts, fresh and v0.3 → v0.4 migration paths, and the hardened
  UID/GID 10001 read-only-root Docker readiness/secret-scan gate passed.

The temporary endpoints delivered signed `2026-06-24.dahlia` payloads, while the
independently retrieved Event API view was `2025-12-15.clover`. These are test-mode
endpoint and API observations. No live-production webhook payload verification is
claimed. Earlier 0.2/0.3, CLI-forwarding, working-tree, and failed Quick Tunnel runs remain
historical regression evidence and are not substituted for the exact-head results above.
The later AI-builder/public-simulation frontend changes require their own network-free
Web gate and a rerun of the affected real-browser SCA path; they do not inherit this
commit's browser evidence merely because the billing backend is unchanged.

Default CI:

```bash
uv sync --frozen
uv run python scripts/check_release_versions.py
uv run ruff format --check .
uv run ruff check .
uv run mypy src
uv run pytest -m "not real_stripe"
uv audit

cd typescript
npm ci
npm audit --omit=dev
npm audit
npm run check

cd ../web
npm ci
npm audit --omit=dev
npm audit
npm run lint
npm run typecheck
npm test
npx playwright install --with-deps chromium
npm run test:e2e:simulation
npm run build
```

The backend default suite uses a disposable PostgreSQL 17 container and exercises
transactions, locks, constraints, duplicate/out-of-order events, refunds,
annual-worker concurrency, Checkout, plan-change leases, API responses, and
fail-closed paths. PostgreSQL 18 compatibility is checked separately with fresh schema
application, idempotent re-application, readiness, and focused transaction gates; see
[Testing](docs/TESTING.md). Both majors are supported, but the evidence levels are
reported separately rather than implying that every matrix runs twice.

The opt-in `real_stripe` suite rejects live keys. Its current ten-case inventory is
designed to verify:

- creation of isolated real test-mode Product/Price/Customer/Subscription
  objects;
- a real paid monthly invoice projected to 300 credits;
- a real $9.50 half refund converging to 150 credits;
- a real one-time pack PaymentIntent, exact metadata/Customer/Charge lineage, partial and
  full cash clawback, product refund interaction, and strict run-owned cleanup;
- outbound Dahlia requests for a real mid-cycle Starter Monthly → Pro Monthly
  change, charged as a new $49 full-price period with no old-invoice proration,
  then projected from its separately versioned paid Event to Pro/1,000 credits;
- a real Starter Monthly → Pro Monthly prorated-delta change whose two paid
  proration lines add 700 credits, link back to the source Invoice, and whose real
  full refund returns the local entitlement to Starter/300;
- outbound Dahlia requests for a real Starter Yearly → Pro Yearly change,
  deferred through a two-phase Subscription Schedule at the annual boundary;
- authentication-required and attachable customer-charge-failure plan changes,
  both projecting a real `invoice.payment_failed` while preserving the old paid
  entitlement behind a real `pending_update`;
- a Test Clock annual lifecycle covering slot 1, +32-day slot 2, one current-slot
  grant after a downtime jump, and a real next-year renewal invoice resetting the
  new funding lineage to slot 1 with active/non-revoked expiry checks at every phase;
- idempotent object creation plus cleanup that fails the test on any deletion or
  run-marked inventory error;
- direct Event polling and PostgreSQL projection for those networked API cases.

All ten cases passed against isolated Stripe test-mode inventory in both runtimes on
`f757fcc`: Python in 404.42 seconds and TypeScript in 276.03 seconds. Direct Event polling
in those suites is not signed endpoint delivery, and later runtime changes must rerun the
gate rather than inherit this result.

The Test Clock and plan-change cases do not prove signed endpoint delivery. The
separate opt-in browser runner creates a temporary test endpoint and exercises a
decline → 3DS → signed webhook → browser plan upgrade → second paid projection
lifecycle. Run it once per transition policy. Use
`scripts/run_test_clock_e2e.sh` for the isolated time-travel gate and
`scripts/run_browser_e2e.sh` for browser/transport evidence; a skipped or partially
completed run is not evidence.

The current browser verifier binds its final result to one account, two Checkout
Sessions, the initial and settlement Invoices, the pack PaymentIntent/Charge/lot, and
exactly five essential signed Events. It also requires no unresolved incident for those
identities, verifies one 700-credit delta allocation or no allocation according to
policy, completes the hosted Portal round trip, and proves the Job charge/replay/refund
equations. The earlier pre-pack Stripe CLI runs bound three essential Events and remain
subscription/upgrade history only. The exact-`f757fcc` four-quadrant endpoint runs bound
five essential Events and happened to observe 11 account-related Events per run.
Incidental totals are not an invariant, and no live-production payload is claimed.

Manual test-mode observations from 2026-07-31 additionally covered:

- a `PY → UM` preview producing negative $204, supporting the stronger
  all-annual-origin period-end rule;
- a declined immediate change retaining the old SKU and active Subscription
  while the latest Invoice remained open and exposed both hosted recovery and a
  confirmation secret.

These are manual observations, not automatically replayed CI guarantees. No
customer, Event, Invoice, or secret identifiers are committed. See
[Testing](docs/TESTING.md) for the exact boundary.

## SQL migrations and production cutover

`stripe-entitlements migrate` applies the complete ordered migration bundle. A fresh 0.4.0
database receives `001_v3_baseline.sql` followed by
`002_stripe_request_snapshots.sql`; an existing v0.3 database receives only the atomic
002 addition. The baseline creates all fourteen correctness tables, final constraints,
partial uniqueness guards, coordination indexes, immutable Invoice ownership, and causal
incident timestamps. Migration 002 adds versioned JSON request snapshots to subscription
Checkout claims, credit-pack orders, and plan-change intents without inventing facts for
existing rows.

Here, **migration means application-schema initialization/evolution**. It is unrelated
to a PostgreSQL 17 → 18 server upgrade. New PostgreSQL 17 and 18 databases both start by
applying 001 and 002. Only an existing database that already contains this project's
older schema needs the version-to-version cutover below.

The migration process loads only `DATABASE_URL` and optional `DATABASE_POOL_*` bounds. This permits a least-privilege schema
init Job with no Stripe key or webhook secret; normal API and worker processes still
require their complete runtime settings.

This is an intentional pre-1.0 lineage reset. Version 0.3 cannot upgrade a database
initialized by a public v0.2.x tag: recreate old development, demo, and staging databases.
The new filename makes mixed histories fail closed in both directions; do not edit
`schema_migrations` to bypass that protection. Once 0.3 is released, its baseline checksum
is immutable and future schema changes must be appended as `002_...sql` and later files.

Snapshot state is explicit: `NULL` is a pre-002 request that cannot be reconstructed,
`0` is a new reservation that has not started a Stripe mutation, and `1` is the validated,
frozen request used for every same-key retry. The frozen request includes the exact Price,
URL, Customer/create mode, product line, API version, mutation parameters, and Stripe
idempotency identity. Legacy or malformed requests fail closed instead of being rebuilt
from current configuration.

The 002 DDL is additive, but the coordinator protocol is not safe to mix with v0.3 remote
mutation writers: v0.3 does not understand frozen snapshots. Quiesce subscription
Checkout, credit-pack Checkout, and plan-change creation; apply 002; then replace all such
writers with v0.4 before reopening traffic. After v0.4 has accepted a request, do not roll
those writers back to v0.3 while any claim/order/intent is in flight. Stop writes and
reconcile or retire every remote outcome first; otherwise roll forward.

The runner serializes application, verifies every bundled checksum, and allows later rows
for future backward-compatible rolling deploys. Apply every migration required by the
target version before routing traffic to it. Back up all fourteen correctness tables
together and test point-in-time restore.

Production is a deliberate separate cutover:

1. provision HA PostgreSQL and apply migrations;
2. integrate real authentication; the fail-closed default is intentional;
3. bootstrap and verify live Products, Prices, and the Portal using
   `--allow-live`;
4. create a live webhook endpoint for only the supported event contract;
5. set `STRIPE_WEBHOOK_API_VERSION` from that endpoint's actual Event snapshot,
   independently of `STRIPE_API_VERSION`;
6. configure allowlisted Checkout/Portal URLs and frontend origins;
7. run backend/frontend CI, test-mode object-shape tests, backup/restore drill,
   webhook delivery smoke, and manual payment recovery;
8. deploy schedulers for annual grants and reconciliation, then alert on
   unresolved incidents and webhook 5xx responses.

Use the [release checklist](.github/RELEASE_CHECKLIST.md) and
[Operations](docs/OPERATIONS.md).

## Repository map

- `src/stripe_entitlements/`: standalone/composable FastAPI integration, billing and
  entitlement services, processor, gateway, workers, auth and plan-change coordinator;
- `typescript/`: independent Node/Next implementation and unpublished npm-package
  source, Fetch/Route Handler adapters, CLI, unit/PostgreSQL/cross-runtime/real-Stripe
  tests, and adoption guide;
- `examples/auth_starters/`: runnable personal/team JWT entrypoints and team membership
  schema;
- `examples/job_outbox/`: runnable Job, billing outbox, queue outbox, retry, and fencing
  workflow with a bounded network-free PostgreSQL demo;
- `migrations/`: ordered PostgreSQL schema;
- `plans.toml`: stable plan identity, prices and entitlements;
- `scripts/bootstrap_stripe.py`: catalog and safe Portal bootstrap/verification;
- `scripts/run_test_clock_e2e.sh`: guarded real annual renewal/time-travel gate;
- `scripts/run_browser_e2e.sh`: isolated real browser and signed-webhook gate;
- `tests/`: pure, PostgreSQL race/API and opt-in real test-mode suites;
- `web/`: Next.js reference UI and API adapter;
- `docs/`: adoption, invariant, architecture, testing, operations, SEO and release
  references;
- `.github/`: CI, contribution templates and publishing metadata.

## Frequently asked questions

### Is this an official Stripe product?

No. It is an independent community reference with a deliberately bounded billing
policy. Stripe remains the payment processor; PostgreSQL is the local entitlement and
credit projection.

### Does it support monthly and annual subscriptions?

Yes. In the bundled reference catalog, Starter, Pro, and Ultra each have monthly and
annual prices. Annual invoices fund up to 12 monthly credit slots, and the opt-in real
Stripe suite contains a Test Clock gate for cross-year renewal. That network gate must
actually run for release evidence. A host catalog may use another non-empty set of
stable plan keys.

### Are upgrades, downgrades, and failed payments covered?

Yes within either documented six-state policy. Choose a full-price new period or a
same-period monthly prorated-difference upgrade. Both use paid Invoice lines as the
authority; annual-origin changes and downgrades wait until period end.
Authentication-required and customer-charge-failure paths preserve the old paid
entitlement until a target Invoice is actually paid.

### How does the Stripe prorated upgrade calculate credits?

Cash and product entitlement stay separate. Stripe calculates the remaining-period
source credit and target charge. After the matching paid Invoice is verified, the
application adds `target.monthly_credits - source.monthly_credits`. A shorter remaining
period changes money due, not the fixed tier entitlement difference.

### Does it include coupons, trials, tax, or multi-currency billing?

No. Those features introduce additional invoice shapes and policy decisions. They are
listed as non-goals rather than advertised without implementation and race tests.
Discounted Invoices fail closed, and Checkout omits `allow_promotion_codes`
unconditionally. [Promotion codes and coupons](docs/PROMOTION_CODES.md) records the
gates that must ship before this answer changes.

### Can a product charge fractional credits?

Yes. One credit is exactly one million integer atoms, so values down to `0.000001` are
supported. Catalog fractions are quoted decimal strings, HTTP credit amounts are decimal
strings plus atom strings, and PostgreSQL stores only integer atoms. Python, PostgreSQL,
TOML and JavaScript floating-point values are deliberately rejected at authoritative
boundaries. See [Exact fractional product credits](docs/CREDIT_PRECISION.md).

### Does it support one-time credit packs?

Yes. The reference implements fixed-price, card-funded USD packs, Hosted Checkout, exact
funding lots, FEFO consumption, independent expiry, partial/full cash refunds, disputes,
product-operation refunds, cross-epoch debt, and missed-webhook reconciliation. Packs do
not grant subscription features or limits. Applications may add an active-subscription
purchase policy at their own admission boundary; additional payment methods require an
explicitly tested settlement/refund policy rather than a Dashboard-only toggle.

### Can multiple API and worker instances share it?

Yes, when they share one PostgreSQL primary and identical configuration. Correctness
uses database locks, constraints, leases, and idempotency rather than process memory.
PostgreSQL is still a stateful dependency that needs HA, backups, and tested restore.

### Does a full-stack SSR Next.js app still need a database?

Yes for real Stripe billing. A Next.js App Router deployment does not need a separate
FastAPI, Railway, or long-running Node service—the server-side Route Handlers are the
backend—but it still needs one writable PostgreSQL 17 or 18 primary. Stripe processes money;
PostgreSQL owns webhook idempotency, subscription and entitlement projection, credit
lots, plan-change intent, annual grants, reconciliation, and incidents. Use managed
PostgreSQL such as Neon, Supabase, or another serverless-compatible provider. Only the
explicit browser-local `simulation` demo can run without a database, and it is not a
real Stripe integration.

### Can I install it into an existing FastAPI application?

Yes. `BillingKernel` owns the validated dependency graph and `install_billing` adds a
native, optionally prefixed router while composing the host lifespan. Public billing
middleware remains route-scoped, and a host-connected `Database` pool stays host-owned.
Use `create_app` when billing is the standalone root instead.

For public-site metadata, canonical configuration, social previews, structured data,
and indexing checks, see the [SEO runbook](docs/SEO.md).

## Non-goals

- card-data handling outside Stripe Checkout/hosted invoice/Stripe.js;
- replacing Stripe Billing, an identity provider, accounting software, or a
  general usage-metering platform;
- guaranteeing arbitrary Dashboard configuration, webhook delivery latency, or
  correctness for invoice shapes outside the documented single-item contract;
- granting access from a browser redirect or mutable Subscription read.

## License

Apache-2.0. See [LICENSE](LICENSE).
