# Operations

## Schema initialization and migrations

Initialize a fresh PostgreSQL database before deploying matching API/worker code:

```bash
uv run stripe-entitlements migrate
```

This command initializes or evolves the application's schema on PostgreSQL 17 or 18. It
does not upgrade the PostgreSQL server between major versions. A brand-new PostgreSQL 18
database follows the same 001 + 002 application-schema path as a brand-new PostgreSQL 17
database.

This command loads only `DATABASE_URL` and optional `DATABASE_POOL_*` bounds. Run it as a least-privilege schema-init Job
without Stripe API or webhook credentials; the API and workers still require their full
runtime configuration.

Fresh databases using the current 0.4.0 candidate apply `001_v3_baseline.sql` and then
`002_stripe_request_snapshots.sql`. The baseline creates the complete fourteen-table
correctness model, all constraints, coordination indexes, the immutable Invoice-owner
trigger, and causal incident defaults in one transaction. Migration 002 atomically adds
versioned Stripe request snapshots to `checkout_claims`, `credit_pack_orders`, and
`billing_plan_changes`; it performs no guessed backfill.

The baseline is intentionally fresh-install-only. Version 0.3 does not support an in-place
upgrade from databases initialized by v0.2.x tags. Drop and recreate old development,
demo, and staging databases after preserving any test evidence you still need. Both
lineages fail closed when mixed; do not bypass the guard by editing `schema_migrations`.

The migration runner serializes changes with a PostgreSQL advisory lock and rejects a
changed checksum for any bundled migration already applied. A database may contain later
migration rows so a previous backward-compatible replica can remain healthy during future
rolling deploys. Starting from the released 0.3 baseline, add migrations rather than
editing it. Do not send authenticated billing traffic to a process until every migration
bundled with that version has been applied.

For the 0.3 → 0.4 cutover, `NULL` snapshot versions deliberately identify legacy rows,
`0` identifies a new reservation before any remote mutation, and `1` identifies a strict
frozen request. A v0.4 same-key retry reuses the v1 Price, URLs, Customer/create mode,
product line, request API version, parameters, and Stripe idempotency key. It never fills a
legacy row from the current catalog or deployment settings.

Although 002 is additive at the SQL level, do not run v0.3 and v0.4 Checkout/credit-pack/
plan-change writers concurrently. Quiesce those mutation endpoints, apply 002, deploy all
v0.4 writers, and only then reopen them; webhook projection may continue after the normal
backup and health checks. A rollback to v0.3 is safe only before v0.4 accepts remote
mutations, or after writes are stopped and every in-flight v1/remote-started row has been
reconciled or retired. Prefer rolling forward when a remote result is unknown.

## Scheduled jobs

Run annual grants hourly and reconciliation every five minutes. The reconciliation
command covers recurring Invoice state and persisted credit-pack
Session/PaymentIntent/Charge state. Both commands are safe to invoke from multiple
schedulers against one PostgreSQL primary.

```bash
uv run stripe-entitlements grant-due
uv run stripe-entitlements reconcile
```

The scheduler is not embedded in the API process. Kubernetes CronJobs, systemd timers,
Vercel Cron, Railway Cron, or another managed scheduler are valid. If a schedule is
missed, the next annual run jumps to the current reset slot rather than replaying all
missed monthly grants.
Reconciliation repairs paid/canceled projection after webhook loss. It rotates through
every eligible account in bounded batches during one invocation; old
`requires_action` rows cannot permanently occupy the first page.

The Vercel Services option exposes `GET /api/cron/annual-grants` and
`GET /api/cron/reconcile`. Both require Vercel's `Authorization: Bearer $CRON_SECRET`
contract, use bounded serverless pages, return identity-free counts, and return 503 when
the invocation should be retried. Missing `CRON_SECRET` disables them fail-closed. See
[the Vercel deployment guide](VERCEL.md); migration and catalog bootstrap must still run
as explicit predeploy/operator jobs.

Alert on scheduler lag; “multi-worker safe” does not mean “scheduler optional.”

## Incidents and fail-closed states

Alert whenever this query returns rows:

```sql
select kind, count(*)
from billing_incidents
where resolved_at is null
group by kind
order by count(*) desc;
```

Important categories include unknown account/Invoice shapes, unauthorized paid plan
changes, invalid delta lines, closed funding lineages, mode/version mismatch, and
reconciliation failures. Inspect `detail` and the
correlated Stripe Event only in a restricted environment. After a verified repair or
replay, set `resolved_at=now()`. Never delete unresolved rows to silence an alert.

`unbound_plan_change_payment_failed` is resolved automatically only when the coordinator
later binds that exact Invoice to the same account intent. `plan_change_payment_failed`
and its unbound counterpart are resolved automatically when that exact Invoice becomes
paid and completes the intent. A different or delayed old Invoice never clears them;
investigate any row that remains after a successful browser projection.

## Plan-change operations

Monitor pending rows and expired leases:

```sql
select status, count(*), min(updated_at) as oldest
from billing_plan_changes
where status in (
  'reserved','previewed','applying','scheduled','applied','requires_action'
)
group by status
order by status;
```

- `requires_action` means the target entitlement is not active. Keep the old funded plan
  visible/enforceable and provide the stored hosted recovery URL through authenticated
  account state.
- An expired preview must be recreated with a new user intent.
- An expired operation lease can resume with the same durable request/Stripe key.
- `applying` with `remote_started_at` less than 23 hours old must be retried only through
  the same preview ID. Do not create a second intent.
- `applying` at least 23 hours old is intentionally blocked. Retrieve the exact Stripe
  request/Invoice or Schedule in a restricted environment and prove customer,
  Subscription, source/target Price, amount, service period, metadata, and two-phase
  Schedule policy before repair. If proof is incomplete, keep it blocked and escalate;
  never clear the row merely to retry billing.
- A Schedule is not entitlement completion; matching webhook facts remain authoritative.
- `upgrade_funding_closed_reverted` means the latest delta was refunded/disputed and the
  local projection returned to its still-funded source plan. Reconcile the remote
  Subscription deliberately; do not hide the incident.
- `funding_lineage_closed` revokes enforcement because a source/intermediate Invoice for
  a current delta chain closed. Repair or refund the chain before clearing revocation.

Do not copy recovery URLs or confirmation secrets into tickets, analytics or logs.

## Replay and reconciliation

Stripe Event ID replay returns duplicate after committed success. To repair webhook loss,
subscription reconciliation retrieves Stripe truth and uses a synthetic
`reconcile:<invoice_id>` identity. The invoice/slot unique index remains the final
duplicate-grant guard. Credit-pack reconciliation leases one order, retrieves only its
persisted Session and exact PaymentIntent/Charge outside a transaction, then projects a
fenced synthetic Event through the normal inbox. An order without a durable `cs_` is
recovered only by the original Checkout caller replaying its same idempotency key.

Do not edit stored Event payloads or delete inbox rows to force replay. A plan change
without durable intent must remain fail-closed even if the Dashboard shows the target
Price. Do not clear `stripe_invoice_state.closure_applied` to replay a refund or
dispute: it is the business-idempotency guard that prevents a different Event ID from
reapplying terminal revocation, leaf reversion, annual closure, or debt creation.

Before enabling `prorated_delta` on an upgraded database, this query must return zero:

```sql
select id from billing_accounts
where subscription_status='active'
  and (entitlement_period_end is null or entitlement_period_end <= now());
```

Reconcile/backfill those accounts from paid Invoice truth first. Do not invent a period
boundary from the mutable Subscription alone.

## Portal verification

The dedicated Portal configuration must be:

- active and in the same test/live mode as the application;
- tagged with the configured product line;
- `subscription_update.enabled=false`;
- cancellation enabled only with `mode=at_period_end`.

The runtime check intentionally ignores benign Portal features such as invoice-history,
payment-method, or customer-profile presentation; those do not bypass the entitlement
state machine. The bootstrap script creates the recommended complete configuration, and
runtime Portal Session creation retrieves it again to enforce only the mutation-critical
policy. All price changes use the server preview/confirm API.

## API version operations

Track separately:

- `STRIPE_API_VERSION` for outbound SDK requests;
- required `STRIPE_WEBHOOK_API_VERSION` for the signed endpoint payload's top-level
  Event `api_version`; there is intentionally no outbound-request-version default.

The current request code targets `2026-06-24.dahlia`. Both 0.3 candidate Stripe CLI
browser gates on 2026-08-28 observed signed Clover payloads and a Clover Event API view. The
separate 2026-08-02 temporary endpoints were pinned to Dahlia and delivered real signed
Dahlia payloads while Event API retrieval remained Clover. Neither CLI forwarding nor an
Event API view substitutes for inspecting a deployed endpoint contract and its signed
delivery. A mismatch creates a durable incident and does not apply entitlements.

Record request, signed endpoint payload, and Event API retrieval views separately in
every release and alert on `webhook_contract_mismatch`.

## Backup and restore

Back up all fourteen correctness tables together:

1. `billing_accounts`;
2. `stripe_webhook_events`;
3. `stripe_invoice_state`;
4. `credit_ledger`;
5. `credit_debits`;
6. `credit_pack_orders`;
7. `credit_funding_lots`;
8. `credit_debit_allocations`;
9. `credit_pack_clawback_debts`;
10. `checkout_claims`;
11. `billing_plan_changes`;
12. `billing_funding_allocations`;
13. `billing_clawback_debts`;
14. `billing_incidents`.

A restore that omits inbox, invoice, ledger, debit, Checkout or plan-change identity can
reopen duplicate/unauthorized effects. Perform point-in-time recovery drills, verify the
complete migration history for the deployed 0.3-or-later version, then run reconciliation
and inspect incidents before reopening traffic.

## Production monitoring

At minimum monitor:

- database health, pool saturation, locks/deadlocks and backup freshness;
- webhook 2xx/4xx/5xx and delivery age;
- unresolved incidents by kind;
- annual scheduler/reconciliation lag;
- stale Checkout claims, plan-change leases, and `applying` age;
- outstanding `billing_clawback_debts` by age and units;
- outstanding `credit_pack_clawback_debts`, stale pack reconciliation leases, and
  `last_reconcile_error` by age/code;
- `requires_action` age and hosted-invoice recovery completion;
- account projection lag after Checkout/confirm returns;
- Stripe/API latency and rate limits.

The frontend success page timing out is an operational signal, not permission to grant
the target plan locally.
