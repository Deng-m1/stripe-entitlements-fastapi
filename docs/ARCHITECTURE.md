# Architecture

```text
Host identity provider
  │ verified stable subject through AuthAccountAdapter
  ▼
FastAPI billing API ───────────────► Stripe request API
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
FastAPI raw-body endpoint
  │ verify signature before JSON trust
  │ prefetch Price / Charge references (no DB transaction open)
  ▼
Transactional event processor
  ├─ stripe_webhook_events       Event inbox
  ├─ billing_accounts            locked entitlement projection
  ├─ stripe_invoice_state        cumulative refund/dispute facts
  ├─ credit_ledger/debits        balance audit and usage epochs
  ├─ billing_plan_changes        durable intent/completion state
  ├─ billing_funding_allocations source → delta Invoice lineage
  ├─ billing_clawback_debts      uncollected current-epoch clawbacks
  └─ billing_incidents           durable fail-closed queue

Annual worker ── remote Subscription snapshot ──► same account/invoice locks
Reconciler    ── Stripe truth after webhook loss ─► same invoice grant guard

Next.js reference UI
  └─ never grants access; polls GET /api/account for webhook projection
```

## Scope boundary

The backend supports one recurring subscription item, USD, fixed plan keys,
monthly/yearly intervals, exact fixed-point monthly credit grants, and two explicit transition
policies. The prorated template is bounded to same-interval monthly tier upgrades. It is
not an arbitrary Invoice reducer. Unknown/ambiguous Invoice shapes fail closed.

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

## Why external Stripe reads happen first

Network calls while holding row locks amplify latency and deadlock probability. The
gateway materializes paginated Invoice lines and resolves Price lookup keys,
InvoicePayment references, Subscription snapshots, and plan-change previews outside
transactions. A short transaction snapshots or revalidates identity, funding lineage,
and entitlement state before and after remote work.

Checkout uses a durable client request key and claim token. Plan changes use durable
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

## Data model and schema baseline

`001_v3_baseline.sql` directly creates the complete 0.3 schema for fresh installations:

- `billing_accounts`: locally enforced plan, status, credit, expiry and annual state;
- `stripe_webhook_events`: committed Event inbox with a redacted audit snapshot;
- `stripe_invoice_state`: immutable Invoice ownership and monotonic refund/dispute facts;
- `credit_ledger` and `credit_debits`: business-idempotent funding and product usage;
- `checkout_claims`: Checkout single-flight and replay identity;
- `billing_plan_changes`: policy, preview, lease, settlement and recovery state;
- `billing_funding_allocations`: source-to-delta funding lineage;
- `billing_clawback_debts`: uncollected current-epoch clawbacks; and
- `billing_incidents`: deduplicated fail-closed operational work with causal timestamps.

Every credit quantity in these tables is an integer atom count. Column names retain the
domain wording (`credits_balance`, `delta`, `entitlement_delta`) while schema comments
record the atom semantics. Cash amount columns remain Stripe currency minor units.

The baseline also declares the immutable Invoice-owner trigger, all partial uniqueness
guards, reconciliation/annual indexes, explicit foreign-key delete actions, and
`clock_timestamp()` incident observation default. It intentionally omits the deprecated
`payload_sha256` rolling-compatibility column; signatures authenticate delivery, Event IDs
identify deliveries, and database constraints provide business-effect idempotency.

Together these ten correctness tables are one backup/restore unit. Restoring account
balances without their inbox, Invoice, allocation, debt, or intent identity can reopen a
business effect.

The 0.3 baseline is a one-time pre-release lineage reset and has no in-place upgrade path
from the public v0.2.x tags. Recreate development, demo, and staging databases made by a
v0.2.x checkout. The filename is a generation sentinel: new code rejects old history and
old code rejects the new history before applying SQL. Starting with 0.3, never edit the
baseline after release; append `002_...sql` and later migrations, preserving checksums and
backward compatibility whenever rolling deployment is promised.

## Supported webhook Event contract

- `checkout.session.completed`
- `checkout.session.expired`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `charge.refunded`
- `charge.dispute.created`

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
