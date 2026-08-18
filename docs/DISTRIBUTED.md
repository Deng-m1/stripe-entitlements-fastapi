# Single-instance and distributed deployment

## What is multi-instance safe

Any number of webhook API processes may receive duplicates concurrently when they share
one PostgreSQL primary. Any number of annual workers or reconcilers may scan the same
accounts. Correctness comes from primary keys, partial unique indexes, conditional
updates, leases and row locks; process-local memory is not part of the proof.

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

## Remaining single points and external dependencies

- PostgreSQL is the only writable truth and coordination point. Use managed HA,
  point-in-time recovery, connection pooling and regularly tested restore.
- Stripe is an external dependency. Unknown remote outcomes require same-key retry;
  webhook processing returns 500 on transient internal failures so Stripe retries.
- The host identity provider and `AuthAccountAdapter` are availability/security
  dependencies for billing APIs.
- DNS, load balancers and API regions can delay requests/webhooks. Delayed Events are
  safe, but product state can be stale until retry or reconciliation.
- Annual grants require a scheduler. Multiple schedulers are safe; no scheduler means
  delayed slots, not duplicate slots.
- PostgreSQL and Stripe are not one atomic transaction. Durable intent, idempotency and
  reconciliation reduce the failure surface but do not create distributed ACID.

## Isolation and lock order

The implementation uses PostgreSQL `READ COMMITTED` plus explicit row locks and unique
constraints. Serializable isolation is not required. All processor paths that touch both
account and invoice state lock account first, then invoice. Plan-change reservation locks
the account before inspecting pending intents.

PostgreSQL can still report a deadlock under unrelated application locks. Let the
transaction fail and retry the same Event or request identity; do not catch a deadlock and
commit a partial effect.

## Rolling deployment and migration safety

Apply all four migrations through `004_event_audit_hardening.sql` before sending traffic
to code that uses authenticated billing APIs. Avoid running a new process against an old
schema. During a rolling deploy:

1. back up all ten correctness tables;
2. apply forward-compatible migrations once;
3. deploy API/worker replicas with identical catalog and runtime policy settings;
4. verify health, catalog and one authenticated account;
5. start/re-enable schedulers;
6. run reconciliation and inspect unresolved incidents.

Each binary verifies the checksum of every migration it bundles, but tolerates later rows
already present in `schema_migrations`. This allows a backward-compatible old replica to
remain ready while the new schema rolls out or while a rollback drains newer replicas.
Never remove, rename, or reinterpret an applied migration; add a new one and keep runtime
changes backward-compatible until old replicas are gone.

## Horizontal scaling checklist

- All replicas use compatible migrations and the same `plans.toml`, transition policy,
  request API version, webhook Event snapshot version, and product-line prefix.
- Do not cache Portal configuration safety indefinitely; runtime Portal creation verifies
  that plan changes remain disabled and cancellation remains period-end.
- Keep worker clocks synchronized; PostgreSQL timestamps remain authoritative.
- Configure statement and lock timeouts, but let failures roll back and retry.
- Alert on unresolved incidents, stale plan-change leases, webhook 5xx and scheduler lag.
- Run reconciliation after outages longer than Stripe's retry window.
- Alert before any `applying` row reaches the 23-hour automatic-replay boundary.
- Test point-in-time restore; a backup that omits inbox, ledger, invoice or plan-change
  state can reopen duplicate or unauthorized effects.
