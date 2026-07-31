# Operations

## Migrations

Apply sorted migrations before deploying matching API/worker code:

```bash
uv run stripe-entitlements migrate
```

- `001_schema.sql` creates the original account, inbox, invoice, ledger, Checkout and
  incident model.
- `002_plan_transitions.sql` adds entitlement windows/revocation, replayable Checkout
  requests, `billing_plan_changes` and immutable invoice/account attribution.

Do not send authenticated billing traffic to a new process while its database is still on
the old schema.

## Scheduled jobs

Run annual grants hourly and reconciliation daily. Both commands are safe to invoke from
multiple schedulers against one PostgreSQL primary.

```bash
uv run stripe-entitlements grant-due
uv run stripe-entitlements reconcile
```

The scheduler is not embedded in the API process. Kubernetes CronJobs, Railway Cron,
systemd timers or a managed scheduler are valid. If a schedule is missed, the next annual
run jumps to the current reset slot rather than replaying all missed monthly grants.
Reconciliation repairs paid/canceled projection after webhook loss.

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

Important categories include unknown account/invoice shapes, unauthorized paid plan
changes, mode/version mismatch and reconciliation failures. Inspect `detail` and the
correlated Stripe Event only in a restricted environment. After a verified repair or
replay, set `resolved_at=now()`. Never delete unresolved rows to silence an alert.

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
- A Schedule is not entitlement completion; matching webhook facts remain authoritative.

Do not copy recovery URLs or confirmation secrets into tickets, analytics or logs.

## Replay and reconciliation

Stripe Event ID replay returns duplicate after committed success. To repair webhook loss,
reconciliation retrieves Stripe truth and uses a synthetic `reconcile:<invoice_id>`
identity. The invoice/slot unique index remains the final duplicate-grant guard.

Do not edit stored Event payloads or delete inbox rows to force replay. A plan change
without durable intent must remain fail-closed even if the Dashboard shows the target
Price.

## Portal verification

The dedicated Portal configuration must be:

- active and in the same test/live mode as the application;
- `subscription_update.enabled=false`;
- cancellation enabled only with `mode=at_period_end`.

The bootstrap script creates/verifies this policy, and runtime Portal Session creation
retrieves it again so Dashboard drift fails closed. All price changes use the server
preview/confirm API; Portal is for payment methods, invoice history, customer email and
period-end cancellation.

## API version operations

Track separately:

- `STRIPE_API_VERSION` for outbound SDK requests;
- `STRIPE_WEBHOOK_API_VERSION` for top-level Event `api_version`.

The current request code targets `2026-06-24.dahlia`. The currently observed test Events
used `2025-12-15.clover`. Do not copy the request value into the webhook setting without
inspecting the endpoint's real Event snapshot. A mismatch creates a durable incident and
does not apply entitlements.

Record both values in every release and alert on `webhook_contract_mismatch`.

## Backup and restore

Back up all eight correctness tables together:

1. `billing_accounts`;
2. `stripe_webhook_events`;
3. `stripe_invoice_state`;
4. `credit_ledger`;
5. `credit_debits`;
6. `checkout_claims`;
7. `billing_plan_changes`;
8. `billing_incidents`.

A restore that omits inbox, invoice, ledger, debit, Checkout or plan-change identity can
reopen duplicate/unauthorized effects. Perform point-in-time recovery drills, verify the
two migration versions, then run reconciliation and inspect incidents before reopening
traffic.

## Production monitoring

At minimum monitor:

- database health, pool saturation, locks/deadlocks and backup freshness;
- webhook 2xx/4xx/5xx and delivery age;
- unresolved incidents by kind;
- annual scheduler/reconciliation lag;
- stale Checkout claims and plan-change leases;
- `requires_action` age and hosted-invoice recovery completion;
- account projection lag after Checkout/confirm returns;
- Stripe/API latency and rate limits.

The frontend success page timing out is an operational signal, not permission to grant
the target plan locally.
