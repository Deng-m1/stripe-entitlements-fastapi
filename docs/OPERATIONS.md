# Operations

## Scheduled jobs

Run annual grants hourly and reconciliation daily. Both commands are safe to invoke from
multiple schedulers against one PostgreSQL primary.

```bash
uv run stripe-entitlements grant-due
uv run stripe-entitlements reconcile
```

The scheduler is not embedded in the API process. Kubernetes CronJobs, Railway Cron,
systemd timers, or a managed scheduler are all valid. If a schedule is missed, the next
annual run jumps to the current reset slot and reconciliation repairs paid/canceled state.

## Incidents

Alert whenever this query returns rows:

```sql
select kind, count(*)
from billing_incidents
where resolved_at is null
group by kind
order by count(*) desc;
```

Inspect `detail` and the correlated Stripe Event in a restricted operations environment.
After a verified repair or replay, set `resolved_at=now()`. Never delete unresolved rows
to silence an alert.

## Replay

Stripe Event ID replay is expected to return `duplicate` after a committed success. To
repair a lost entitlement, reconciliation retrieves the latest paid Invoice and uses a
synthetic `reconcile:<invoice_id>` event. The invoice/slot unique index remains the final
duplicate-grant guard.

## Portal verification limitation

Some current Stripe API versions accept the Portal `products` allowlist when creating a
Configuration but omit that list from retrieve responses. The bootstrap script verifies
all Products and Prices independently and strictly verifies the returned anchor,
proration, and scheduling policy. Its output explicitly says
`portal_products=omitted-by-stripe-api` when the allowlist cannot be read back. Re-run the
idempotent bootstrap during releases and test an actual Portal plan change; do not pretend
an omitted response field was verified.

## Backup and restore

Back up the six correctness tables together: `billing_accounts`,
`stripe_webhook_events`, `stripe_invoice_state`, `credit_ledger`, `credit_debits`,
`checkout_claims`, and `billing_incidents`. A restore that omits the inbox or ledger can
reopen duplicate side effects. Perform point-in-time recovery drills and run
reconciliation after recovery.
