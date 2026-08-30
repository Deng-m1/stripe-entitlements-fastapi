# Single-instance and distributed deployment

## What is multi-instance safe

Any number of webhook API processes may receive duplicates concurrently when they share
one PostgreSQL primary. Any number of annual workers or reconcilers may scan the same
accounts. Correctness comes from primary keys, partial unique indexes, conditional
updates, leases and row locks; process-local memory is not part of the proof.

That model is implemented independently by Python/FastAPI and TypeScript/Node/Next.js.
A normal fleet selects one runtime and keeps its package version, migration level,
catalog, Stripe mode/version contracts, product line, and transition policy identical.
The shared schema and cross-runtime credit contention tests support controlled
interoperability; they are not permission to mix arbitrary releases as replicas.

That statement also covers stateless Vercel Python Functions and native Next.js Node
Route Handlers. Overlapping Cron requests process bounded pages and can be interrupted
or repeated; no invocation owns durable progress in memory. The same PostgreSQL primary,
migration level, catalog, Stripe mode, and transition policy remain mandatory across
every warm instance. Function cold starts and provider retries do not weaken the
database guards. Configure managed PostgreSQL connection limits/pooling for serverless
concurrency; exhausting connections is an availability failure even when correctness
remains intact.

Checkout Session creation uses a durable single-flight claim. The browser supplies a
stable `Idempotency-Key` for one user intent; the database binds it to an unguessable
claim token. Stripe receives a derived stable idempotency key. A retry with the same
intent can recover a previously created Session URL, while a different unexpired request
is rejected.

Plan-change preview stores one durable intent per account/request key. Confirm uses the
opaque preview ID. An expiring database lease serializes remote preview/apply/schedule
work. Confirm first persists `applying` and `remote_started_at`; an unknown outcome less
than 23 hours old is replayed with the same derived Stripe key, while older ambiguity
blocks for exact Invoice/Schedule proof. A
partial unique index permits only one pending plan change per account. The intent stores
its transition policy; delta intents additionally bind the source funding Invoice,
credit difference, and fixed proration timestamp. The latest Invoice returned by an
immediate mutation is compare-and-set into the intent; paid/failed Events must match it
exactly rather than relying on Subscription identity.

Delta paid/refund/dispute paths use the same account-first lock order and a unique
settlement Invoice in `billing_funding_allocations`. Multiple webhook replicas and
reconcilers can race on one Invoice without duplicating its delta.
Outstanding current-epoch clawback units are stored in `billing_clawback_debts` and
atomically consume later usage refunds or delta grants.
`stripe_invoice_state.closure_applied` independently prevents distinct refund/dispute
Event IDs from reapplying one terminal funding closure.

The same guarantees apply when routes are installed into a host FastAPI application,
adapted through the TypeScript Fetch/Node/Next facade, or called through the optional
internal workload boundary. `BillingKernel` and its service graph are process-local
wiring; all committed entitlement and credit coordination still uses the shared
PostgreSQL primary. Install/start one kernel once per host application. Duplicate or
concurrent activation fails rather than opening an ambiguous second service graph.

One `Database` object may bind to only one `BillingKernel`. A second binding fails at
construction so an earlier lifecycle owner cannot close a pool still used by another
kernel. Separate process/app owners may use separate `Database` objects with the same
DSN; PostgreSQL, not those objects, remains their shared coordination layer.

`install_billing` composes an existing host lifespan with billing startup. The host
enters first, so a host-connected injected `Database` pool remains host-owned; billing
shuts down before the host closes that pool. This is resource ownership, not distributed
coordination: replicas must never share an in-memory kernel or pool across processes.

## Remaining single points and external dependencies

- PostgreSQL is the only writable truth and coordination point. Use managed HA,
  point-in-time recovery, connection pooling and regularly tested restore.
- Stripe is an external dependency. Unknown remote outcomes require same-key retry;
  webhook processing returns 500 on transient internal failures so Stripe retries.
- The host identity provider and `AuthAccountAdapter` are availability/security
  dependencies for billing APIs.
- JWT starter deployments depend on their configured HTTPS JWKS provider and the host's
  revocation/session policy. Team deployments additionally depend on a live membership
  lookup for every protected request.
- Internal-router deployments depend on both workload credential verification and the
  host-owned workload-to-owner authorization store. A valid operation scope alone is
  deliberately insufficient authority for another tenant.
- DNS, load balancers and API regions can delay requests/webhooks. Delayed Events are
  safe, but product state can be stale until retry or reconciliation.
- Annual grants require a scheduler. Multiple schedulers are safe; no scheduler means
  delayed slots, not duplicate slots.
- Vercel Services is an optional API/UI/scheduler host, not durable storage. Vercel Cron
  cadence and duration depend on the selected platform plan; another scheduler may call
  the same secured endpoints or run the one-shot CLI commands.
- PostgreSQL and Stripe are not one atomic transaction. Durable intent, idempotency and
  reconciliation reduce the failure surface but do not create distributed ACID.
- A host Job database/queue and billing are also not one atomic transaction. The host
  must provide an idempotent outbox/saga, leases, fencing, and repair; the service facade
  does not turn that workflow into distributed ACID.

## Isolation and lock order

The implementation uses PostgreSQL `READ COMMITTED` plus explicit row locks and unique
constraints. Serializable isolation is not required. All processor paths that touch both
account and invoice state lock account first, then invoice. Plan-change reservation locks
the account before inspecting pending intents.

Pack funding and Checkout claim expiry use a `clock_timestamp()` cutoff sampled after
the account lock. PostgreSQL `now()` is fixed at transaction start, so using it after a
lock wait could otherwise spend or restore already-expired funding, retain a stale busy
claim, or shorten a newly created claim's TTL.

PostgreSQL can still report a deadlock under unrelated application locks. Let the
transaction fail and retry the same Event or request identity; do not catch a deadlock and
commit a partial effect.

## Schema deployment and migration safety

Version 0.3 starts from the fresh-install-only `001_v3_baseline.sql`. It intentionally
does not upgrade a database initialized by a v0.2.x tag. Before the first 0.3 deployment,
recreate every development, demo, or staging database that used the old lineage; never
point a v0.2.x process at a 0.3 database or a 0.3 process at a v0.2.x database.

Version 0.4.0 appends `002_stripe_request_snapshots.sql`; a fresh database applies both
files and an existing 0.3 database applies only 002. Apply every bundled migration before
sending traffic to code that uses authenticated billing APIs. For the first deployment
and every later schema change:

1. back up all fourteen correctness tables;
2. apply every migration bundled with the target version once;
3. deploy API/worker replicas with identical catalog and runtime policy settings;
4. verify health, catalog and one authenticated account;
5. start/re-enable schedulers;
6. run reconciliation and inspect unresolved incidents.

Each binary verifies the checksum of every migration it bundles and tolerates later rows
already present in `schema_migrations`. The 0.3 lineage-reset guard is deliberately not a
rolling-upgrade bridge from v0.2.x. After the 0.3 baseline is established, never remove,
rename, or reinterpret an applied migration; append a new migration and keep runtime
changes backward-compatible until old replicas are gone.

Migration 002 is schema-additive but changes the remote-mutation recovery protocol. Do
not mix v0.3 and v0.4 subscription Checkout, credit-pack Checkout, or plan-change writers:
quiesce those routes, apply 002, replace the writer fleet, and reopen traffic. Once v0.4
has frozen or started a request, an older coordinator can no longer replay it safely from
mutable configuration. Roll forward, or stop writes and reconcile/retire every in-flight
request before any v0.3 rollback.

## Horizontal scaling checklist

- All replicas use compatible migrations and the same `plans.toml`, transition policy,
  request API version, webhook Event snapshot version, and product-line prefix.
- All API replicas use the same billable-owner encoding, JWT issuer/audience contract,
  explicit billing prefix, team capability policy, and workload-to-owner authorization
  rules.
- Do not cache Portal configuration safety indefinitely; runtime Portal creation verifies
  that plan changes remain disabled and cancellation remains period-end.
- Keep worker clocks synchronized; PostgreSQL timestamps remain authoritative.
- Configure statement and lock timeouts, but let failures roll back and retry.
- Alert on unresolved incidents, stale plan-change leases, webhook 5xx and scheduler lag.
- Run reconciliation after outages longer than Stripe's retry window.
- Alert before any `applying` row reaches the 23-hour automatic-replay boundary.
- Test point-in-time restore; a backup that omits inbox, ledger, invoice or plan-change
  state can reopen duplicate or unauthorized effects.
