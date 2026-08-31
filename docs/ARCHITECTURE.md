# Architecture

```text
Host identity provider
  │ verified stable subject through AuthAccountAdapter / JWT starters
  ▼
Choose one native server runtime
  ├─ Python / FastAPI
  │    ├─ standalone create_app()
  │    └─ host app + install_billing(BillingKernel, prefix)
  └─ TypeScript / Node
       ├─ standalone Node CLI/server or Fetch handler
       └─ Next.js App Router Route Handlers
       │
       ▼
Billing API ───────────────────────► Stripe request API
  │ catalog/account                  Checkout / Portal / invoice preview
  │ Checkout + Idempotency-Key       pending_if_incomplete / Schedule
  │ preview + confirm / selected settlement policy
  ▼
PostgreSQL primary
  ├─ billing_accounts
  ├─ checkout_claims
  └─ billing_plan_changes

Stripe
  │ signed, at-least-once webhook Event snapshots
  ▼
Python or TypeScript raw-body endpoint
  │ verify signature before JSON trust
  │ prefetch Price / Charge references (no DB transaction open)
  ▼
Transactional event processor
  ├─ stripe_webhook_events       Event inbox
  ├─ billing_accounts            locked entitlement projection
  ├─ stripe_invoice_state        cumulative refund/dispute facts
  ├─ credit_ledger/debits        balance audit and usage epochs
  ├─ credit_pack_orders/lots     one-time cash and expiring funding snapshots
  ├─ credit_debit_allocations    exact subscription/pack debit provenance
  ├─ credit_pack_clawback_debts  spent pack funding withdrawn by cash events
  ├─ billing_plan_changes        durable intent/completion state
  ├─ billing_funding_allocations source → delta Invoice lineage
  ├─ billing_clawback_debts      uncollected current-epoch clawbacks
  └─ billing_incidents           durable fail-closed queue

Annual worker ── remote Subscription snapshot ──► same account/invoice locks
Reconciler    ── Stripe truth after webhook loss ─► same invoice grant guard
Pack reconciler ── exact Session → PaymentIntent → Charge ─► fenced Event projector
                  (network outside transactions; token checked before inbox claim)

Next.js reference UI
  └─ never grants access; polls GET /api/account for webhook projection

Authenticated product workload
  │ WorkloadIdentityAdapter + operation scope + WorkloadOwnerAuthorizer
  ▼
optional internal router/handler ──► EntitlementService ──► credit/account rows
```

Both checked-in Vercel topologies preserve this boundary. `vercel.json` splits Next.js
and FastAPI into two Services behind one domain. `vercel.typescript.json` uses one
Next.js service whose Node Route Handlers own `/api/*`, `/webhooks/stripe`, and
`/health`. In either case Cron reaches secured, bounded annual and reconciliation
wrappers; it does not create a second in-memory coordinator. See the
[Vercel guide](VERCEL.md) and [TypeScript guide](../typescript/README.md).

The separate `vercel.simulation.json` is intentionally outside that billing topology. It
deploys only the reference UI, has no Cron or backend rewrite, returns 404 from compiled
billing routes, stores versioned sample state in browser `sessionStorage`, and carries no
billing credential. It demonstrates interaction design only and inherits none of the
PostgreSQL/Stripe correctness guarantees above.

## Scope boundary

Each backend supports one recurring subscription item, USD, a configured non-empty set
of stable plan keys, monthly/yearly intervals, exact fixed-point monthly credit grants,
optional credit packs, and two explicit transition policies. The bundled reference
catalog has three plans and three packs; those counts are examples, not parser
invariants. The prorated template is bounded to same-interval monthly tier upgrades. It
is not an arbitrary Invoice reducer. Unknown/ambiguous Invoice shapes fail closed.

Product credits use a fixed protocol of one million integer atoms per displayed credit.
Binary floating point never enters the catalog, API, PostgreSQL ledger, refund math or
browser business state. Stripe currency remains a separate minor-unit integer dimension;
see [Exact fractional product credits](CREDIT_PRECISION.md).

The frontend is a reference consumer, not the system of record. Product services must
enforce `entitlements_enforceable`, structured limits, and credit operations server-side.

## Authentication boundary

`AuthAccountAdapter` translates the host application's verified session/JWT/OIDC identity
into a stable `external_ref`. The default production adapter rejects every billing API
request. The demo Bearer adapter requires development mode, a test Stripe key, and an
explicit token; it is not a deployable authentication scheme.

Accounts are looked up or created from the verified subject. No route accepts an account
ID from the browser.

The optional authentication extra supplies a strict asymmetric JWT/JWKS verifier and
two reference adapters. `PersonalJwtAuthAdapter` maps a verified, bounded stable `sub`
string to one user owner; UUID and opaque identity-provider subjects are both supported.
`TeamJwtAuthAdapter` treats the signed bounded tenant ID only as a selector, performs a
live host membership lookup, permits viewers to read only catalog routes, and reserves
account/recovery data and mutations for billing administrators. The configured billing
prefix is explicit in `TeamBillingAuthorizationPolicy`; it is never inferred from an
arbitrary request path.

## FastAPI integration and service boundary

`BillingKernel` validates settings and owns the database, Stripe gateway, catalog,
authentication adapter, and one lifespan-scoped `BillingServices` graph. The services
contain the Event processor, Checkout and plan-change coordinators, and
`EntitlementService`, credit-pack Checkout coordinator, and credit-pack reconciler.
Access through `kernel.services` fails outside the active
lifespan, preventing use against an uninitialized or already closed pool.

`create_app()` builds the standalone reference application and preserves its historical
app-wide CORS, logging, state aliases, and route behavior. `create_billing_router()`
builds a native `APIRouter`. `install_billing()` is the host integration contract: it
includes that router in host OpenAPI, scopes browser CORS/Origin handling to public
billing routes and response hardening to installed billing routes, and leaves unrelated
host routes and global logging unchanged.

Installation wraps the existing host lifespan rather than replacing it. The host enters
first, billing enters second, and shutdown reverses that order. An injected pool already
connected by the host remains host-owned; otherwise the kernel opens and closes its own
pool. One `Database` object binds to one kernel, preventing one lifecycle owner from
closing a pool used by another. Duplicate installation, a second kernel for the same
`Database`, and concurrent activation of one kernel fail explicitly.

The optional internal router calls the same `EntitlementService` through a lazy provider
after lifespan startup. Workload authentication and an operation scope are necessary but
not sufficient: `WorkloadOwnerAuthorizer` must also bind that principal and operation to
the exact `owner_external_ref`. Both adapters default to reject-all. This prevents a
global service scope from becoming cross-tenant credit authority.
Routers passed explicitly through `internal_routers` receive no-store/nosniff hardening
for success, validation, and not-found responses, but never inherit the browser
CORS/Origin allowance applied to the public billing router. The hook is not a generic
public-extension mechanism.

The host must register Starlette `CORSMiddleware` before `install_billing` and leave the
billing middleware outermost. With internal routers installed, lifespan startup rejects
the inverse order rather than silently letting an outer CORS layer re-add browser headers.
An arbitrary ASGI wrapper or reverse proxy outside FastAPI is not introspectable; keeping
internal paths outside browser CORS remains an explicit host deployment contract.

The service facade does not make a product Job and a credit operation one transaction.
Job state, queue dispatch, outbox/saga repair, concurrency limits, API-key limits, and
workload audit remain host-owned responsibilities.

## TypeScript integration and service boundary

The TypeScript `BillingKernel` owns the same conceptual graph with native `pg`, Stripe
SDK, and TypeScript services. `createBillingRuntime()` starts one kernel and exposes a
standard Fetch handler; the standalone Node server adapts Node HTTP streams without
changing the raw webhook bytes. The Node CLI supplies explicit migration, doctor,
server, annual-grant, and reconciliation entrypoints.

`@tosea/stripe-entitlements/next` adapts the Fetch handler to App Router. Its
environment-backed handler lazily shares one connected runtime across warm Node
invocations, retries a failed initialization later, and returns sanitized 503 responses.
Route modules must export `runtime = "nodejs"`, `dynamic = "force-dynamic"`, and a
bounded duration. Edge runtime and request-local in-memory coordination are unsupported.

Construction performs no network request. Startup owns only a database connection it
opened, and production migrations remain an explicit operator action. One `Database`
object binds to one kernel so a lifecycle owner cannot close another kernel's pool. An
injected gateway must match the complete outbound contract in settings before a database
connection opens: Stripe test/live mode, request API version, product line, Checkout
success/cancel URLs, Portal return URL, and Portal configuration identity. This prevents
a successful payment from being projected under another product line or freezing an old
redirect into a durable request snapshot. Public CORS/origin, raw webhook,
scheduler-secret, authentication, and sanitized-error rules are enforced by the shared
Fetch facade rather than reimplemented in each framework adapter.

The TypeScript `EntitlementService` and internal Fetch handler preserve the same
workload-identity plus owner-authorization boundary as Python. They likewise do not make
host Job state, queue dispatch, or a credit operation one distributed transaction.

## Why external Stripe reads happen first

Network calls while holding row locks amplify latency and deadlock probability. The
gateway materializes paginated Invoice lines and resolves Price lookup keys,
InvoicePayment references, Subscription snapshots, and plan-change previews outside
transactions. A short transaction snapshots or revalidates identity, funding lineage,
and entitlement state before and after remote work.

Checkout uses a durable client request key, claim token, and immutable
pre-existing-Customer-or-create snapshot; first-Customer replay omits email rather than
retaining mutable login PII. Plan changes use durable
intent, expiring leases, and derived Stripe idempotency keys. A crash after an unknown
remote outcome is retried with the same identity instead of creating a second logical
operation. Confirmation changes `previewed` to `applying` before remote work and stores
`remote_started_at` before the Stripe call. Automatic same-key replay stops at 23 hours,
leaving a safety margin before Stripe's idempotency retention boundary; older ambiguity
requires exact operator proof instead of a new intent.

The immediate Stripe result's latest Invoice ID is compare-and-set into
`settlement_invoice_id`. Paid and payment-failed processing must match that exact ID;
Subscription identity alone is insufficient because an older failed Invoice can arrive
after a newer plan-change intent. The coordinator and a faster paid webhook may race to
establish the same binding; both accept only the same ID. Webhook completion remains
authoritative, and confirm reports conflict if the webhook has already failed the
intent.

## Why PostgreSQL is the coordination layer

An Event ID primary key serializes duplicate deliveries. Account row locks serialize
balance, grants, refunds, deletion and plan projection. Partial unique indexes encode the
invoice-slot grant and one-pending-plan-change invariants independently of application
branches. No correctness decision relies on process memory or an expiring Redis lock.

The implementation uses PostgreSQL `READ COMMITTED` plus explicit locks and constraints.
Paths that touch account and invoice state lock account first, then invoice.

## Data model and schema migrations

`001_v3_baseline.sql` directly creates the complete 0.3 table model and remains immutable:

- `billing_accounts`: locally enforced plan, status, credit, expiry and annual state;
- `stripe_webhook_events`: committed Event inbox with a minimal allowlisted audit snapshot;
- `stripe_invoice_state`: immutable Invoice ownership and monotonic refund/dispute facts;
- `credit_ledger` and `credit_debits`: business-idempotent funding and product usage;
- `credit_pack_orders`: durable one-time Checkout request snapshot (including nullable
  pre-existing Customer), PaymentIntent, and cash state;
- `credit_funding_lots`: independently expiring one-time product-credit funding;
- `credit_debit_allocations`: exact subscription/pack provenance for each product debit;
- `credit_pack_clawback_debts`: spent pack funding still owed after a cash clawback;
- `checkout_claims`: Checkout single-flight and replay identity;
- `billing_plan_changes`: policy, preview, lease, settlement and recovery state;
- `billing_funding_allocations`: source-to-delta funding lineage;
- `billing_clawback_debts`: uncollected current-epoch clawbacks; and
- `billing_incidents`: deduplicated fail-closed operational work with causal timestamps.

The four pack-specific responsibilities are deliberately separate: an order coordinates
remote payment/idempotency and cash state, a lot owns remaining/expiring funding, an
allocation records which source one product debit consumed, and pack debt retains a cash
clawback after those credits were spent. Combining any pair loses either remote-operation
identity, independent expiry, source-safe Job refunds, or post-spend liability. This
normalization is internal to the billing boundary; host entities integrate through the
router, `EntitlementService`, and reconciler rather than those tables.

Every credit quantity in these tables is an integer atom count. Column names retain the
domain wording (`credits_balance`, `delta`, `entitlement_delta`) while schema comments
record the atom semantics. Cash amount columns remain Stripe currency minor units.

The baseline also declares the immutable Invoice-owner trigger, all partial uniqueness
guards, reconciliation/annual indexes, explicit foreign-key delete actions, and
`clock_timestamp()` incident observation default. It intentionally omits the deprecated
`payload_sha256` rolling-compatibility column; signatures authenticate delivery, Event IDs
identify deliveries, and database constraints provide business-effect idempotency.

Together these fourteen correctness tables are one backup/restore unit. Restoring account
balances without their inbox, Invoice, allocation, debt, or intent identity can reopen a
business effect.

Pack provenance is database-enforced rather than merely checked by service code.
Account-scoped composite foreign keys bind every lot to its order, every allocation to
its debit and optional lot, and every pack debt or synthetic collection debit to its
order. Deferred transaction-end constraints verify debit allocation totals and the
order/lot cash, expiry, outstanding-allocation, and released-debt conservation equations.

The 0.3 baseline is a one-time pre-release lineage reset and has no in-place upgrade path
from the public v0.2.x tags. Recreate development, demo, and staging databases made by a
v0.2.x checkout. The filename is a generation sentinel: new code rejects old history and
old code rejects the new history before applying SQL. Starting with 0.3, never edit the
baseline after release; append `002_...sql` and later migrations, preserving checksums and
backward compatibility whenever rolling deployment is promised.

Version 0.4.0 appends `002_stripe_request_snapshots.sql`. It adds nullable
`request_snapshot_version` and `stripe_request_snapshot` pairs to `checkout_claims`,
`credit_pack_orders`, and `billing_plan_changes`. `NULL` preserves the honest legacy
state, `0` means reserved but not remotely started, and `1` requires a JSON object that
the runtime validates against the owning row before use. The request is frozen by a
compare-and-set transaction before Stripe mutation; all Stripe I/O remains outside the
transaction. Retries execute the frozen request and API version, not a later catalog,
URL, Customer observation, or product-line configuration.

The SQL change tolerates an older binary reading the database, but v0.3 remote-mutation
coordinators do not understand v1 snapshots. Therefore 0.3 → 0.4 uses a coordinated
writer cutover, and 0.4 → 0.3 is prohibited while any v0.4 claim/order/intent is in flight.

## Supported webhook Event contract

- `checkout.session.completed`
- `checkout.session.expired`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `charge.refunded`
- `charge.dispute.created`
- `payment_intent.succeeded`

Unlisted types are acknowledged and recorded as ignored. Configure production endpoints
to send only this set.

## Two independent Stripe version contracts

`STRIPE_API_VERSION` is attached to outbound SDK requests. Webhook Event payloads retain
the endpoint's snapshot `api_version`; `STRIPE_WEBHOOK_API_VERSION` validates that value.
Pinning one does not pin the other.

In the 2026-08-18 `0.2.2` Stripe CLI forwarding evidence, the signed payload/Event API
view used `2025-12-15.clover` while outbound request code targeted
`2026-06-24.dahlia`. In the separate 2026-08-02 endpoint evidence, isolated endpoints
pinned to Dahlia delivered signed Dahlia payloads while Event API retrieval remained
Clover. A version/livemode mismatch creates a durable incident and does not mutate
entitlement state.
