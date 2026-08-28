# Stripe Billing, Entitlements & Credit Packs for FastAPI

[![CI](https://github.com/Deng-m1/stripe-entitlements-fastapi/actions/workflows/ci.yml/badge.svg)](https://github.com/Deng-m1/stripe-entitlements-fastapi/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.12%2B-3776AB.svg)](pyproject.toml)

An open-source Stripe billing, SaaS entitlements, and credit-ledger starter for FastAPI,
PostgreSQL, and Next.js. It includes monthly/yearly subscriptions, exact fractional
credits, one-time credit packs, two selectable upgrade policies, Checkout, refunds,
disputes, SCA recovery, Test Clock renewals, and webhook-authoritative accounting under
duplicate, delayed, concurrent, and out-of-order Events.

> This is an independent community project, not an official Stripe product.
> It is a reference implementation, not a universal SaaS billing framework and
> not financial, tax, accounting, or legal advice.

## Contents

- [Implemented scope](#what-is-completeand-what-is-not)
- [Plan catalog and annual savings](#plan-catalog)
- [One-time credit packs](#one-time-credit-packs)
- [Two plan-change templates](#safe-stripe-plan-transitions-full-price-or-prorated-difference)
- [Correctness and distributed deployment](#correctness-model)
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
subscription credit system, SaaS pricing backend, or Next.js billing UI that need a
reviewable reference rather than a copy-paste Checkout snippet.

## What is complete—and what is not

The repository implements two complete, deliberately bounded transition templates:

- `full_period_reset`: immediately start a full-price target period without proration;
- `prorated_delta`: preserve the current monthly period, pay the prorated difference,
  and add the catalog entitlement difference.

Their complete 6 × 6 matrices are selected with one environment setting and persisted
per intent. Shared scope:

- one subscription item and one currency (USD);
- three fixed plans, each available monthly or yearly;
- three card-funded one-time USD credit packs with independent expiry and source-aware
  refunds;
- exact product credits down to `0.000001`, stored as integer atoms rather than floats;
- yearly invoices fund up to 12 monthly credit grants rather than granting all
  credits at purchase;
- Checkout creates the first paid subscription;
- authenticated catalog, account, Checkout, Portal, preview, and confirm APIs;
- standalone `create_app()` plus native `BillingKernel` / `install_billing` composition
  for an existing FastAPI root;
- strict personal/team JWT authentication starters, including catalog-only team viewers;
- an in-process `EntitlementService` and optional owner-authorized internal workload API;
- server-controlled plan transitions with Stripe invoice previews and
  Subscription Schedules;
- a Next.js reference UI for pricing, account state, payment recovery, and
  webhook-backed success polling;
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

| Plan | Monthly | Yearly total | Yearly equivalent | Annual saving | Monthly credits |
| --- | ---: | ---: | ---: | ---: | ---: |
| Starter | $19 | $137 | $11.42/mo | $91 | 300 |
| Pro | $49 | $353 | $29.42/mo | $235 | 1,000 |
| Ultra | $149 | $1,073 | $89.42/mo | $715 | 4,000 |

Yearly savings compare 12 monthly payments with the explicit yearly total. The
UI shows a saving only when both prices use the same currency and the yearly
total is actually lower; an equal or higher yearly price gets no saving claim.
This display calculation never controls tier direction or transition timing.
Credits on a yearly subscription still arrive in monthly slots.

The bundled annual totals are approximately 40% lower than twelve monthly payments.
That is an explicit annual-price design, not a Stripe Coupon or Promotion Code. Coupons,
trials, and time-limited campaigns remain outside this reference's implemented scope:
Checkout Session creation omits `allow_promotion_codes` unconditionally, so hosted
Checkout never shows a promotion-code field. The gates any future promotion-code
support must clear first are documented in
[Promotion codes and coupons](docs/PROMOTION_CODES.md).

| Entitlement | Starter | Pro | Ultra |
| --- | ---: | ---: | ---: |
| PDF → PPT / image → PPT | yes | yes | yes |
| Batch conversion | no | yes | yes |
| API access | no | yes | yes |
| Priority queue | no | no | yes |
| Maximum file size | 30 MB | 100 MB | 250 MB |
| Maximum pages per job | 100 | 500 | 2,000 |
| Concurrent jobs | 1 | 5 | 20 |
| API keys | 0 | 5 | 25 |

The API returns these as structured entitlements. Product code still has to
enforce them; displaying an entitlement is not enforcement.

## One-time credit packs

The reference catalog also includes one-time packs. Packs add spendable product credits;
they never add plan features, raise limits, or alter subscription tier direction.

| Pack | Price | Credits | Default expiry |
| --- | ---: | ---: | ---: |
| Boost 100 | $15 | 100 | 365 days |
| Boost 500 | $59 | 500 | 365 days |
| Boost 2,000 | $199 | 2,000 | 365 days |

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

`prorated_delta` permits immediate settlement only for a higher monthly tier while
remaining monthly. For example, Starter Monthly → Pro Monthly pays Stripe's net
remaining-period difference and adds exactly `1,000 - 300 = 700` credits while keeping
the same period and unused balance. Month/year conversions, downgrades, and every
annual-origin change are period-end.

The delta webhook path loads all Invoice line pages, requires one negative source and
one positive target catalog proration at the same fraction, and stores their
cross-Invoice funding allocation. Tax, discounts, customer balance, credit notes,
unknown/missing lines, and inconsistent periods fail closed. Partial refunds claw back
the proportional delta; closing a leaf upgrade reverts to the still-funded source,
while closing a source/intermediate lineage revokes enforcement for repair.

Both full 6 × 6 matrices, Invoice acceptance rules, refund semantics, and failure
behavior are in [Plan transition policies](docs/PLAN_TRANSITIONS.md).

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

## API surface and authentication

Authenticated billing routes:

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/catalog` | ordered prices and structured entitlements |
| GET | `/api/account` | webhook-projected plan, credits, enforcement and pending state |
| POST | `/api/checkout` | first paid subscription; requires `Idempotency-Key` |
| POST | `/api/credit-packs/checkout` | one-time pack Checkout; requires `Idempotency-Key` |
| POST | `/api/billing/portal` | safe Portal Session; requires `Idempotency-Key` |
| POST | `/api/billing/change/preview` | durable preview; requires `Idempotency-Key` |
| POST | `/api/billing/change/confirm` | confirm the opaque `preview_id` |

`AuthAccountAdapter` is the integration boundary. Production defaults to
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
shapes and frontend configuration are documented in [web/README.md](web/README.md).

## Stripe API versions are two separate contracts

- `STRIPE_API_VERSION` controls outbound SDK requests. Current code targets
  `2026-06-24.dahlia`.
- Each webhook Event has its own snapshot `api_version`, determined by the
  Stripe webhook endpoint/account contract. `STRIPE_WEBHOOK_API_VERSION` must
  equal that actual Event value and is a required startup setting; it deliberately
  has no fallback to `STRIPE_API_VERSION`.

The request version does not rewrite webhook payloads. The 2026-08-28 0.3 candidate
browser reruns used Stripe CLI signed forwarding and observed `2025-12-15.clover`; those runs
prove raw-signature processing but not endpoint metadata. In the separate 2026-08-02
endpoint gates, Event API retrievals reported Clover while isolated endpoints pinned to
Dahlia delivered signed `2026-06-24.dahlia` payloads for the same lifecycle. A mismatch
is recorded as `webhook_contract_mismatch` and ignored fail-closed. This repository does
not infer request, Event API view, or endpoint payload versions from one another. See
[Testing](docs/TESTING.md),
[Stripe CLI](docs/STRIPE_CLI.md), and
[Webhook verification](docs/WEBHOOK_VERIFICATION.md).

## Quick start

Requirements: Python 3.12+, `uv`, Docker, Node.js 22+, npm, Stripe CLI, and a
Stripe test-mode account.

The commands below assume an exact release-tag source checkout or the matching source
distribution. The Wheel is intentionally the backend runtime boundary: it contains the
Python package, catalog, and migrations, while the source distribution also contains the
environment templates, operator scripts, Docker/Compose files, examples, tests, and
Next.js reference UI.

The version-tag workflow attaches the Wheel, source distribution, checksums, and immutable
container digest to the matching GitHub Release. It also publishes
`ghcr.io/deng-m1/stripe-entitlements-fastapi` with exact-version, minor-version, commit,
and `latest` tags. Moving minor-version and `latest` tags only advance within their
respective release channels; publishing an older patch does not roll them back. GitHub
Release assets are not a claim that the package was published to PyPI; use the exact
reviewed artifact or release tag documented for your deployment.

The published container is currently native `linux/amd64`, not a multi-architecture
manifest. ARM64 users should install the Wheel/source distribution or build and verify
the pinned Dockerfile on their own platform.

Version 0.3 requires a fresh database. If the PostgreSQL volume was initialized by a
v0.2.x checkout, preserve any evidence you need and recreate that development volume;
there is intentionally no in-place upgrade across the pre-release baseline reset.
The `migrate` command is still required on a new installation because it initializes the
fourteen-table schema; it does not imply that an unreleased product needs a historical
data migration or v0.2 compatibility path.

```bash
cp .env.example .env
chmod 600 .env
# Choose full_period_reset or prorated_delta in .env.
docker compose up -d postgres
uv sync --frozen
uv run --env-file .env stripe-entitlements migrate
```

`stripe-entitlements migrate` reads only `DATABASE_URL`; a schema-init Job does not need
the Stripe API key, webhook secret, or browser configuration. The full `.env` command
above is convenient for local setup, but production should inject a database-only secret
into the migration Job and keep Stripe credentials on the API/workers that use them.

Before bootstrap, replace `STRIPE_SECRET_KEY`, the local demo values, product line,
lookup prefix, catalog path and transition policy in `.env`. The Portal ID and webhook
secret remain placeholders only until the next steps produce their real test-mode values.
Keep that file ignored and private; never commit credentials. The backend secret, later
Stripe CLI login and browser publishable key must all belong to the same Stripe test
account.

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

After the real Portal ID, signing secret, and signed-payload version are configured, run
the read-only preflight:

```bash
uv run --env-file .env stripe-entitlements doctor
```

`doctor` does not call Stripe by default. It checks the local package, catalog,
configuration, PostgreSQL schema, and migration checksums without printing secrets or
DSNs. Use `doctor --json` for automation. The explicit `doctor --stripe-network` mode
adds read-only Stripe Account, catalog, and Portal retrieval, but it still does not claim
webhook endpoint or signed-payload evidence.

Start or restart the API after the final webhook contract is known:

```bash
uv run --env-file .env \
  uvicorn stripe_entitlements.app:create_app --factory --port 8000
```

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

The repository supplies the auth protocol, account resolver, billing HTTP APIs and
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

The current 0.3 working-tree candidate passed 1,187 network-free backend tests against
disposable PostgreSQL 17, 189 frontend tests, and all 10 opt-in Stripe test-mode cases.
Those results are not yet bound to a final commit, container, signed browser transport,
or production release; all applicable gates must be rebound to the release commit.

The artifact and network evidence below belongs to the earlier 2026-08-28 0.3
baseline candidate based on `main@4df7f73`; it has not been rebound to the current
phase-1 tree and must be rerun before release:

- an independently installed candidate Wheel loaded its packaged catalog and complete
  schema baseline from an arbitrary working directory and migrated a fresh PostgreSQL 17
  database; the candidate Docker image applied the same baseline over an internal-only
  network, then ran as UID/GID 10001 with a read-only root while a host-side `/health`
  request returned `ok=true` and `database=true`;
- that candidate passed all 9 real Stripe cases against test mode, including strict
  run-owned cleanup, paid/refund projection, both upgrade policies, the four-case failed-
  payment matrix, annual Schedule construction, and the complete Test Clock renewal
  lifecycle;
- before the credit-pack browser lane was added, `full_period_reset` and
  `prorated_delta` each passed the subscription/upgrade production-build lifecycle
  through explicit Stripe CLI signed forwarding: decline, Checkout 3DS, Starter/300
  projection, upgrade SCA, Pro/1,000 projection, seven related Events, zero unrelated
  Events, exact three-essential-Event binding, and strict cleanup;
- the final 48.800-second public demo remains the separately reviewed `0.2.0` visual
  artifact: 1,464 decoded frames, no long black segment, zero forbidden-term OCR matches,
  15/15 semantic scene checks, and 1080p/30 fps H.264 with 48 kHz stereo AAC at -20.0
  LUFS. It is not relabeled as proof of the changed `0.2.2` code;
- no live-production webhook payload verification is claimed.

Two later 2026-08-28 temporary-endpoint working-tree runs completed the expanded
subscription + credit-pack + Portal + product-Job browser lifecycle for both policies.
Each bound the current five essential Events, found zero unrelated Events, observed 11
account-related Events, and ended at Pro/1,020 after strict run-owned cleanup. Those
artifacts predate the final hardening changes and do not embed a final Git commit, so they
are regression evidence—not release-commit proof—and must be rerun after the final commit.

CLI signed forwarding proves the raw-signature/application/database path but does not
prove temporary Webhook Endpoint metadata or endpoint-specific version pinning. The
2026-08-02 subscription-only dual-policy endpoint runs remain historical Dahlia/Clover
version evidence. An earlier 2026-08-28 retry stopped before account creation because its
Quick Tunnel hostname remained DNS `NXDOMAIN`; a later pair of expanded endpoint runs did
complete as described above. None is substituted for a final-commit rerun.

Historical pre-hardening evidence from earlier on 2026-08-01 was 239 local/backend
tests, 7 real Stripe test-mode tests, 60 frontend tests, and 2 browser policy runs. It is
useful regression history only, not current-tree network evidence. The current expanded
gate requires exactly five identity-bound essential Events: subscription Checkout,
initial and settlement paid Invoices, credit-pack Checkout, and the pack's authoritative
`payment_intent.succeeded`. It validates every additional account-matched Event without
fixing the incidental total Event count.

Default CI:

```bash
uv run ruff format --check .
uv run ruff check .
uv run mypy src
uv run pytest -m "not real_stripe"

cd web
npm ci
npm audit --omit=dev
npm run lint
npm run typecheck
npm test
npm run build
```

The backend default suite uses a disposable PostgreSQL 17 container and exercises
transactions, locks, constraints, duplicate/out-of-order events, refunds,
annual-worker concurrency, Checkout, plan-change leases, API responses, and
fail-closed paths.

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

The nine pre-pack assertions passed on the earlier 0.3 baseline candidate on 2026-08-28.
The added credit-pack case and every changed assertion still require a run on the final
release commit with an isolated test account; the older result is not permanent proof.

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
subscription/upgrade history only. The later expanded endpoint artifacts bound five,
but still predate the final commit. Incidental totals such as seven or 11 are not an
invariant, and no live-production payload is claimed.

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

`stripe-entitlements migrate` applies the complete `001_v3_baseline.sql` to a fresh
PostgreSQL database. It directly creates all fourteen correctness tables, final constraints,
partial uniqueness guards, coordination indexes, immutable Invoice ownership, and causal
incident timestamps. There are no historical backfills, FK rebuilds, or deprecated audit-
digest compatibility columns in a fresh installation.

The migration process loads only `DATABASE_URL`. This permits a least-privilege schema
init Job with no Stripe key or webhook secret; normal API and worker processes still
require their complete runtime settings.

This is an intentional pre-1.0 lineage reset. Version 0.3 cannot upgrade a database
initialized by a public v0.2.x tag: recreate old development, demo, and staging databases.
The new filename makes mixed histories fail closed in both directions; do not edit
`schema_migrations` to bypass that protection. Once 0.3 is released, its baseline checksum
is immutable and future schema changes must be appended as `002_...sql` and later files.

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

Yes. Starter, Pro, and Ultra each have monthly and annual prices. Annual invoices fund
up to 12 monthly credit slots, and the opt-in real Stripe suite contains a Test Clock
gate for cross-year renewal. That network gate must actually run for release evidence.

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
