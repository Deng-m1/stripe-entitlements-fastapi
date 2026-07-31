# Single-instance and distributed deployment

## What is multi-instance safe

Any number of webhook API processes may receive duplicates concurrently when they share
one PostgreSQL primary. Any number of annual workers may scan the same due accounts.
Correctness comes from primary keys, partial unique indexes, conditional updates, and row
locks; process-local memory is not part of the proof.

Checkout Session creation uses a durable single-flight claim. A process crash after the
Stripe call but before session attachment leaves an expiring claim. The same claim token
is also the Stripe idempotency key, allowing an operator or reconciler to recover without
creating a second logical Session.

## Remaining single points and dependencies

- PostgreSQL is the only writable truth and coordination point. Use managed HA,
  point-in-time recovery, connection pooling, and regularly tested restores.
- Stripe is an external dependency. Webhook processing returns 500 on transient internal
  failures so Stripe retries.
- DNS/load balancer/API region availability can delay delivery; delayed events are safe,
  but product state may be stale until retry or reconciliation.
- Annual grants need at least one scheduler invocation. Multiple schedulers are safe; no
  scheduler means delayed grants, not duplicate grants.

## Isolation level and locks

The implementation uses PostgreSQL `READ COMMITTED` plus explicit row locks and unique
constraints. Serializable isolation is not required. All paths that touch both account
and invoice state lock account first, then invoice, to reduce deadlock cycles. PostgreSQL
may still report a deadlock under unrelated application locks; allow the transaction to
fail so the webhook is retried.

## Horizontal scaling checklist

- All replicas use the same migration version and Stripe API version.
- Do not cache Portal configuration safety indefinitely in a process.
- Keep worker clocks synchronized; PostgreSQL timestamps remain authoritative.
- Configure statement and lock timeouts, but let timeout failures return 500.
- Alert on unresolved incidents and webhook 5xx rates.
- Run reconciliation after outages longer than Stripe's retry window.
