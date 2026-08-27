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
monthly/yearly intervals, fixed monthly credit grants, and two explicit transition
policies. The prorated template is bounded to same-interval monthly tier upgrades. It is
not an arbitrary Invoice reducer. Unknown/ambiguous Invoice shapes fail closed.

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

## Data model and migrations

`001_schema.sql` creates:

- `billing_accounts`: locally enforced plan, status, credit and annual state;
- `stripe_webhook_events`: committed Event inbox and outcome audit;
- `stripe_invoice_state`: monotonic refund/dispute facts;
- `credit_ledger`: append-only grants, charges, clawbacks and balances;
- `credit_debits`: idempotent product usage with grant-epoch snapshot;
- `checkout_claims`: Checkout single-flight identity;
- `billing_incidents`: deduplicated unresolved operational work.

`002_plan_transitions.sql` adds:

- entitlement/cancellation expiry and revocation fields to accounts;
- replayable Checkout client request identity and stored Session URL;
- `billing_plan_changes` with preview snapshots, leases, estimates, Schedule/recovery
  state and one-pending-change constraint;
- an immutable `stripe_invoice_state.account_id` trigger.

`003_transition_policies.sql` adds:

- persisted `full_period_reset` / `prorated_delta` policy, exact preview Invoice facts,
  `applying`, and `remote_started_at` state to `billing_plan_changes`;
- `stripe_invoice_state.closure_applied`, an independent business guard for terminal
  refund/dispute effects delivered under different Event IDs;
- a unique settlement-Invoice binding;
- `billing_funding_allocations`, which records source/target lines, cash proration,
  entitlement delta, grant epoch, and cumulative refund/dispute status;
- `billing_clawback_debts`, which prevents spent current-epoch funding from reappearing
  after a refund or dispute; and
- reconciliation rotation state/indexes so bounded runs do not starve later accounts.

`004_event_audit_hardening.sql` introduces redacted audit snapshots that remove secrets,
PII, hosted URLs, and internal prefetch fields, and scrubs pre-hardening full payloads.
`005_simplify_event_audit.sql` then stops new digest writes, clears stored values, and
removes the hash-based constraints. The nullable column remains for one rolling-upgrade
compatibility window so an older replica can drain safely. Stripe signatures authenticate
delivery, Event IDs provide delivery idempotency, and business uniqueness constraints
provide effect idempotency; the active audit contract uses only the redacted snapshot.

`006_invoice_ownership_and_incident_causality.sql` aligns the Invoice-owner foreign key
with audit retention: an account referenced by `stripe_invoice_state` cannot be deleted
independently. It also indexes unresolved incidents by account, kind, and observation time
and changes `last_seen_at` to a statement-wall-clock default. Reconciliation resolves only
facts that strictly predate its database attempt token, including when an incident writer's
transaction began earlier but wrote or committed after the attempt began.

Together the migrations define ten correctness tables. Backup and restore them as one
unit; restoring account balances without their inbox, Invoice, allocation, debt, or
intent identity can reopen a business effect.

Apply every migration bundled with the deployed version in filename order. Known
migration checksums are immutable, while a database may contain later rows during a
backward-compatible rolling deployment or rollback.

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
