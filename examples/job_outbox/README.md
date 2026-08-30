# Job + billing outbox + dispatch outbox example

This is a host-owned saga for products that charge credits before running an asynchronous
Job. Apply `schema.sql` to the host database, construct `JobWorkflowStore` with the host's
`asyncpg.Pool`, and give `BillingOutboxWorker` an owner-authorized `EntitlementService`
or private billing client.

## Run the bounded PostgreSQL demo

The executable demo uses the real PostgreSQL tables, transactions, `SKIP LOCKED` claims,
idempotency keys, queue inbox, leases, and fencing tokens. It deliberately injects a
process-local `DemoBillingAdapter` so it needs no Stripe credential and makes zero network
calls. That adapter is not a production billing implementation; production code injects
`kernel.services.entitlements` or an owner-authorized internal billing client.

From a source checkout or 0.4 source distribution:

```bash
docker compose up -d postgres
uv run --env-file .env python -m examples.job_outbox.demo --apply-schema
```

`--apply-schema` creates the five host-owned example tables only when none exist and
refuses a partial installation. Re-running the command reuses the schema. Every run uses
new request, Job, attempt, debit, dispatch, lease, and execution identities; by default it
deletes only those run-owned rows in dependency order. Use `--keep-rows` only on a local
disposable database when you want to inspect them.

The JSON report proves this sequence without printing the database URL or credentials:

- exact fractional charges (`1.250001` and `0.750002`) use one-million-atom accounting;
- replaying the same submission returns the original Job;
- both charge outboxes make their Jobs ready and both dispatch outboxes publish;
- an incorrect execution token cannot complete or fail either Job;
- duplicate queue delivery is consumed once;
- one Job succeeds, while one terminal failure creates and completes the matching refund;
- the final demo balance reflects only the successful Job; and
- `cleanup.completed=true` confirms bounded row cleanup.

The repository PostgreSQL suite separately runs this workflow against the real
`EntitlementService`, including concurrent same-request submission, concurrent account
charges, unknown-response replay, and refund races:

```bash
uv run pytest -q tests/test_job_outbox_example.py
```

Do not interpret the demo adapter as Stripe or webhook evidence. Its purpose is to make
the host-owned saga observable without adding a second external system to the example.

The durable sequence is:

```text
submit transaction: Job(pending_credit) + Attempt + charge outbox
  -> leased billing worker calls charge outside the transaction
  -> fenced finalize makes Job ready + creates dispatch outbox
  -> leased dispatcher publishes outside the transaction (at least once)
  -> consumer deduplicates dispatch_id and leases execution
  -> success, or fenced terminal failure + refund outbox
  -> leased billing worker retries the original credit_key until refund converges
```

Credit amounts enter as canonical decimal strings and are stored both as exact text and
integer atoms. PostgreSQL verifies that the two forms agree; Python `float` is rejected.
The billing owner is always a verified stable `owner_external_ref`, never a browser
account UUID, Stripe Customer ID, or queue payload field.

Composite foreign keys make every redundant routing fact fail closed: a billing row's
owner, Job, attempt, and credit key must describe one chain; a dispatch's attempt must
belong to its Job; and a queue inbox attempt must belong to that exact dispatch. This
protects imports, repair scripts, and future writers as well as the reference insert path.

All billing and dispatch claims use `FOR UPDATE SKIP LOCKED`, a bounded lease, and a new
token on every claim. Every state-changing finalizer compares the processing state and
token. Execution completion/failure additionally compares the current execution token
and lease. A terminal failure clears that token before it inserts the refund outbox row
in the same host transaction.

Queue delivery is deliberately at least once. Publish may succeed immediately before a
dispatcher crash, so consumers must call `QueueConsumer.consume()` with the immutable
`DispatchMessage`; the database inbox makes the business transition idempotent.

The queue transport remains a trusted workload boundary and should authenticate its
producers and consumers. Even on that private transport, a message contains only a
dispatch UUID: the consumer reloads Job facts from PostgreSQL and accepts only an outbox
row already in `processing` or `done`. A fabricated pending or unknown ID cannot start
work.
