# Stripe Entitlements for FastAPI

[![CI](https://github.com/FromCSUZhou/stripe-entitlements-fastapi/actions/workflows/ci.yml/badge.svg)](https://github.com/FromCSUZhou/stripe-entitlements-fastapi/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.12%2B-3776AB.svg)](pyproject.toml)

A PostgreSQL-backed FastAPI and Next.js reference for Stripe subscriptions,
credit entitlements, annual monthly grants, Checkout, refunds, disputes, and
server-controlled plan changes under duplicate, delayed, concurrent, and
out-of-order events.

> This is an independent community project, not an official Stripe product.
> It is a reference implementation, not a universal SaaS billing framework and
> not financial, tax, accounting, or legal advice.

## What is complete—and what is not

The repository implements one deliberately bounded product policy:

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
  refund/dispute convergence, and fail-closed incidents.

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

## Safe plan transitions

Abbreviations combine plan and interval: `SM` is Starter Monthly, `SY` is
Starter Yearly, and so on.

| From / To | SM | SY | PM | PY | UM | UY |
| --- | --- | --- | --- | --- | --- | --- |
| **SM** | noop | immediate | immediate | immediate | immediate | immediate |
| **SY** | period end | noop | period end | period end | period end | period end |
| **PM** | period end | period end | noop | immediate | immediate | immediate |
| **PY** | period end | period end | period end | noop | period end | period end |
| **UM** | period end | period end | period end | period end | noop | immediate |
| **UY** | period end | period end | period end | period end | period end | noop |

Every non-noop change from an annual plan is period-end, including a nominal tier
upgrade such as `SY → PY` or `PY → UY`. The paid annual invoice owns a 12-slot
funding lineage. Replacing it early can use a negative proration from that old
invoice to fund the new one; a later refund or dispute would then require a
cross-invoice funding ledger that this bounded reference intentionally does not
claim to implement.

“Immediate” means eligible for immediate settlement, not guaranteed activation.
The server first previews the invoice. It remains immediate only when quantity,
currency and amount exactly match the catalog, the full target charge is funded
without any nonzero proration, and no customer-balance credit participates.
Otherwise it fails closed to period-end. After confirm, new entitlements appear
only when a paid invoice webhook completes the durable intent. See
[Plan transition policy](docs/PLAN_TRANSITIONS.md).

## Correctness model

- **At-least-once delivery, effectively-once PostgreSQL effects.** The project
  does not claim impossible end-to-end exactly-once delivery.
- Stripe Event IDs guard duplicate deliveries; `(stripe_invoice_id, grant_slot)`
  independently guards the same business grant through another Event or worker.
- Account row locks serialize balance, grant, refund, cancellation, and
  plan-change projection.
- `(event.created, event_rank)` prevents older/weaker subscription projections
  from overwriting newer state.
- Refund/dispute facts persist even when they arrive before the paid grant.
- Checkout and plan-change operations use durable, caller-replayable request
  identities and Stripe idempotency keys.
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
  equal that actual Event value.

The request version does not rewrite webhook payloads. On the currently observed
test account, real Events reported `2025-12-15.clover`; that is the observed
webhook snapshot, while outbound requests used Dahlia. A mismatch is recorded as
`webhook_contract_mismatch` and ignored fail-closed. This repository does not
claim that real `2026-06-24.dahlia` webhook Events were verified. See
[Testing](docs/TESTING.md) and [Stripe CLI](docs/STRIPE_CLI.md).

## Quick start

Requirements: Python 3.12+, `uv`, Docker, Node.js 22+, npm, Stripe CLI, and a
Stripe test-mode account.

```bash
cp .env.example .env
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

## Verification and evidence boundary

Latest verified 2026-07-31 baseline:

- 163 local/backend tests passed;
- 4 opt-in real Stripe test-mode tests passed;
- 47 frontend tests passed, followed by a successful production build;
- frontend production-dependency audit reported zero vulnerabilities.

Default CI:

```bash
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

The opt-in `real_stripe` suite rejects live keys. It currently proves:

- creation of isolated real test-mode Product/Price/Customer/Subscription
  objects;
- a real paid monthly invoice projected to 300 credits;
- a real $9.50 half refund converging to 150 credits;
- outbound Dahlia requests for a real mid-cycle Starter Monthly → Pro Monthly
  change, charged as a new $49 full-price period with no old-invoice proration,
  then projected from its separately versioned paid Event to Pro/1,000 credits;
- outbound Dahlia requests for a real Starter Yearly → Pro Yearly change,
  deferred through a two-phase Subscription Schedule at the annual boundary;
- object cleanup scoped to that run;
- a Test Clock can be created, advanced one hour, return to `ready`, and deleted.

The Test Clock test itself does **not** prove renewal, annual grant,
cancellation, or decline lifecycles. The two plan-change cases above are direct
test-mode API/Event tests, not Test Clock or webhook-delivery tests.

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
   immutable invoice/account attribution.

Apply every migration before routing traffic to the new application version.
Back up all eight correctness tables together and test point-in-time restore.

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
- `tests/`: pure, PostgreSQL race/API and opt-in real test-mode suites;
- `web/`: Next.js reference UI and API adapter;
- `docs/`: invariant, architecture, testing, operations and release references;
- `.github/`: CI, contribution templates and publishing metadata.

## Non-goals

- card-data handling outside Stripe Checkout/hosted invoice/Stripe.js;
- replacing Stripe Billing, an identity provider, accounting software, or a
  general usage-metering platform;
- guaranteeing arbitrary Dashboard configuration, webhook delivery latency, or
  correctness for invoice shapes outside the documented single-item contract;
- granting access from a browser redirect or mutable Subscription read.

## License

Apache-2.0. See [LICENSE](LICENSE).
