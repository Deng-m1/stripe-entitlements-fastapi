# Stripe Subscription Billing & Entitlements for FastAPI

[![CI](https://github.com/FromCSUZhou/stripe-entitlements-fastapi/actions/workflows/ci.yml/badge.svg)](https://github.com/FromCSUZhou/stripe-entitlements-fastapi/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.12%2B-3776AB.svg)](pyproject.toml)

An open-source Stripe subscription billing and entitlement template for FastAPI,
PostgreSQL, and Next.js. It implements two complete, selectable plan-change policies,
three monthly/yearly tiers, annual savings display, Checkout, refunds, disputes, SCA
recovery, Test Clock renewals, and webhook-authoritative credits under duplicate,
delayed, concurrent, and out-of-order Events.

> This is an independent community project, not an official Stripe product.
> It is a reference implementation, not a universal SaaS billing framework and
> not financial, tax, accounting, or legal advice.

## Contents

- [Implemented scope](#what-is-completeand-what-is-not)
- [Plan catalog and annual savings](#plan-catalog)
- [Two plan-change templates](#safe-stripe-plan-transitions-full-price-or-prorated-difference)
- [Correctness and distributed deployment](#correctness-model)
- [Quick start](#quick-start)
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
- yearly invoices fund up to 12 monthly credit grants rather than granting all
  credits at purchase;
- Checkout creates the first paid subscription;
- authenticated catalog, account, Checkout, Portal, preview, and confirm APIs;
- server-controlled plan transitions with Stripe invoice previews and
  Subscription Schedules;
- a Next.js reference UI for pricing, account state, payment recovery, and
  webhook-backed success polling;
- PostgreSQL event/business idempotency, row locks, durable plan-change intent,
  cross-Invoice funding allocation, refund/dispute convergence, and fail-closed
  incidents.

It does **not** implement multi-currency, seats or quantities, trials, coupons,
tax calculation, metered billing, arbitrary mixed invoice items, revenue
recognition, accounting, or a hosted identity provider. The host application
must supply verified authentication and product enforcement. See
[Architecture](docs/ARCHITECTURE.md) and [Invariants](docs/INVARIANTS.md).

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
trials, and time-limited campaigns remain outside this reference's implemented scope.

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
  PostgreSQL retains a redacted Event snapshot, not the raw body or a payload digest.
- Funding attribution uses exact Customer/Subscription identity, Checkout claim/session
  identity, and server-retrieved Price-to-Product catalog identity. Stripe metadata such
  as `product_line` remains useful for operations but is not a duplicate authorization
  gate once those stronger identities match.
- Account row locks serialize balance, grant, refund, cancellation, and
  plan-change projection.
- `(event.created, event_rank)` prevents older/weaker subscription projections
  from overwriting newer state.
- Refund/dispute facts persist even when they arrive before the paid grant.
- Delta allocations preserve source/target Invoice lineage across refunds and disputes.
- If a current-epoch clawback is larger than the spendable balance,
  `billing_clawback_debts` retains the missing units and consumes later same-epoch
  usage refunds or delta grants before they become spendable.
- Checkout and plan-change operations use durable, caller-replayable request
  identities and Stripe idempotency keys.
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
demo token is not production auth. Exact JSON shapes and frontend configuration
are documented in [web/README.md](web/README.md).

## Stripe API versions are two separate contracts

- `STRIPE_API_VERSION` controls outbound SDK requests. Current code targets
  `2026-06-24.dahlia`.
- Each webhook Event has its own snapshot `api_version`, determined by the
  Stripe webhook endpoint/account contract. `STRIPE_WEBHOOK_API_VERSION` must
  equal that actual Event value and is a required startup setting; it deliberately
  has no fallback to `STRIPE_API_VERSION`.

The request version does not rewrite webhook payloads. The 2026-08-18 `0.2.2` browser
reruns used Stripe CLI signed forwarding and observed `2025-12-15.clover`; those runs
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

```bash
cp .env.example .env
# Choose full_period_reset or prorated_delta in .env.
docker compose up -d postgres
uv sync --frozen
uv run stripe-entitlements migrate
uv run uvicorn stripe_entitlements.app:create_app --factory --port 8000
```

Bootstrap or verify the dedicated test catalog and safe Portal configuration:

```bash
STRIPE_SECRET_KEY=sk_test_... uv run python scripts/bootstrap_stripe.py
STRIPE_SECRET_KEY=sk_test_... uv run python scripts/bootstrap_stripe.py --verify-only
```

For the reference frontend:

```bash
cd web
npm ci
cp .env.example .env.local
npm run dev
```

Development can run with explicit mock data. HTTP mode requires the backend and a
matching auth adapter. The UI does not treat Checkout return, confirm success, or
SCA completion as entitlement proof; it polls `/api/account` until webhook state
matches the target.

Forward selected events in a separate terminal:

```bash
stripe login
stripe listen --events \\
checkout.session.completed,checkout.session.expired,invoice.paid,invoice.payment_failed,customer.subscription.updated,customer.subscription.deleted,charge.refunded,charge.dispute.created \\
--forward-to http://127.0.0.1:8000/webhooks/stripe
```

Copy the temporary signing secret into the ignored local `.env`. A canned
`stripe trigger invoice.paid` has no matching repository account, so a durable
unknown-account incident is expected; it is a transport/signature smoke, not an
entitlement lifecycle test.

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

Current `0.2.2` release-candidate evidence recorded on 2026-08-18:

- 702 local/backend tests passed against disposable PostgreSQL 17; the full collection
  contained 711 cases and 9 `real_stripe` cases were deselected;
- 102 frontend tests passed with lint, typecheck, production build, production-only npm
  audit, complete npm audit, and Python dependency audit all passing with zero known
  vulnerabilities;
- all 9 real Stripe cases executed and passed against test mode, including strict
  run-owned cleanup, paid/refund projection, both upgrade policies, the four-case failed-
  payment matrix, annual Schedule construction, and the complete Test Clock renewal
  lifecycle;
- `full_period_reset` and `prorated_delta` each passed the real-browser lifecycle through
  explicit Stripe CLI signed forwarding: decline, Checkout 3DS, Starter/300 projection,
  upgrade SCA, Pro/1,000 projection, seven related Events, zero unrelated Events, and
  exact three-essential-Event binding;
- the `0.2.2` Wheel installed in an independent virtual environment, loaded its packaged
  catalog and five migrations from an arbitrary working directory, and migrated a fresh
  PostgreSQL database; the Docker image ran as UID/GID 10001 with a read-only root,
  completed migration, and returned a healthy `0.2.2` API;
- the final 48.800-second public demo remains the separately reviewed `0.2.0` visual
  artifact: 1,464 decoded frames, no long black segment, zero forbidden-term OCR matches,
  15/15 semantic scene checks, and 1080p/30 fps H.264 with 48 kHz stereo AAC at -20.0
  LUFS. It is not relabeled as proof of the changed `0.2.2` code;
- no live-production webhook payload verification is claimed.

CLI signed forwarding proves the raw-signature/application/database path but does not
prove temporary Webhook Endpoint metadata or endpoint-specific version pinning. The
latest separate endpoint-mode evidence remains the 2026-08-02 dual-policy run: both
policies used isolated temporary Dahlia endpoints, reached Pro/1,000, bound the same
three essential Events, found zero unrelated Events, and completed strict cleanup while
the independent Event API view reported Clover.

Historical pre-hardening evidence from earlier on 2026-08-01 was 239 local/backend
tests, 7 real Stripe test-mode tests, 60 frontend tests, and 2 browser policy runs. It is
useful regression history only, not current-tree network evidence. Those historical
browser runs happened to observe five signed account-related Events per run; the current
gate instead requires exactly three identity-bound essential Events—the run's Checkout,
initial paid Invoice, and settlement paid Invoice—and validates every additional
account-matched Event without requiring an incidental total of five.

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

The opt-in `real_stripe` suite rejects live keys. Its current nine-case inventory is
designed to verify:

- creation of isolated real test-mode Product/Price/Customer/Subscription
  objects;
- a real paid monthly invoice projected to 300 credits;
- a real $9.50 half refund converging to 150 credits;
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

All nine assertions passed on the `0.2.2` release candidate on 2026-08-18. Future
releases must rerun them with an isolated test account rather than treating this result
as permanent proof.

The Test Clock and plan-change cases do not prove signed endpoint delivery. The
separate opt-in browser runner creates a temporary test endpoint and exercises a
decline → 3DS → signed webhook → browser plan upgrade → second paid projection
lifecycle. Run it once per transition policy. Use
`scripts/run_test_clock_e2e.sh` for the isolated time-travel gate and
`scripts/run_browser_e2e.sh` for browser/transport evidence; a skipped or partially
completed run is not evidence.

The current browser verifier binds its final result to one account, Checkout Session,
initial Invoice, settlement Invoice, and their three essential signed Events. It also
requires no unresolved incident for that identity and verifies one 700-credit delta
allocation or no allocation according to policy. The older five-Event observation is
not a fixed assertion. Both `0.2.2` policies passed on 2026-08-18 through Stripe CLI
signed forwarding; each run observed seven account-related Events, zero unrelated
Events, exactly three essential Events, and a Clover signed payload/Event API view. CLI
forwarding does not prove temporary endpoint metadata. The latest separate temporary-
endpoint evidence remains the 2026-08-02 dual-policy run with signed Dahlia payloads and
an independent Clover Event API view. The incidental count of seven is not an invariant,
and no live-production payload is claimed.

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

`stripe-entitlements migrate` applies sorted SQL files:

1. `001_schema.sql`: accounts, Event inbox, invoice facts, ledgers, Checkout
   claims, and incidents;
2. `002_plan_transitions.sql`: entitlement expiry/revocation columns, durable
   plan-change state, request identity, one-pending-change constraint, and
   immutable invoice/account attribution;
3. `003_transition_policies.sql`: persisted policy/preview/remote-call snapshots,
   unique settlement binding, cross-Invoice funding allocations, clawback debt,
   terminal-closure business idempotency, and reconciliation rotation state;
4. `004_event_audit_hardening.sql`: redacted Event audit snapshots, legacy payload
   scrubbing, and the transitional audit-shape contract;
5. `005_simplify_event_audit.sql`: stops new payload hashing, clears stored digests,
   removes hash-based constraints, and retains a nullable compatibility column for a
   safe rolling upgrade while keeping the redacted audit snapshot.

The runner serializes migration application, verifies the checksum of every bundled
migration already present in the database, and allows later migration rows so a backward-
compatible rolling deploy does not make the previous replica fail readiness. Apply every
migration required by the new version before routing traffic to it. Back up all ten
correctness tables together and test point-in-time restore.

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

- `src/stripe_entitlements/`: FastAPI, processor, gateway, workers, auth and
  plan-change coordinator;
- `migrations/`: ordered PostgreSQL schema;
- `plans.toml`: stable plan identity, prices and entitlements;
- `scripts/bootstrap_stripe.py`: catalog and safe Portal bootstrap/verification;
- `scripts/run_test_clock_e2e.sh`: guarded real annual renewal/time-travel gate;
- `scripts/run_browser_e2e.sh`: isolated real browser and signed-webhook gate;
- `tests/`: pure, PostgreSQL race/API and opt-in real test-mode suites;
- `web/`: Next.js reference UI and API adapter;
- `docs/`: invariant, architecture, testing, operations, SEO and release references;
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

### Can multiple API and worker instances share it?

Yes, when they share one PostgreSQL primary and identical configuration. Correctness
uses database locks, constraints, leases, and idempotency rather than process memory.
PostgreSQL is still a stateful dependency that needs HA, backups, and tested restore.

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
