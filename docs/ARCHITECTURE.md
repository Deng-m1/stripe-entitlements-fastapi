# Architecture

```text
Stripe
  │ signed, at-least-once webhooks
  ▼
FastAPI raw-body endpoint
  │ verify signature
  │ prefetch Price / Charge references (no DB transaction open)
  ▼
Transactional event processor
  ├─ stripe_webhook_events       event inbox
  ├─ billing_accounts            locked entitlement projection
  ├─ stripe_invoice_state        cumulative refund/dispute facts
  ├─ credit_ledger               append-only balance audit
  └─ billing_incidents           durable fail-closed queue

Annual worker ── remote Subscription snapshot ──► same account/invoice locks
Checkout API  ── checkout_claims ── Stripe call ── identity-checked attach
```

## Why external Stripe reads happen first

Network calls while holding row locks amplify latency and deadlock probability. The
gateway resolves Price lookup keys and dispute Charge references before the processor
opens a transaction. The transaction then revalidates local identity and state under
locks. Annual workers follow the same snapshot-then-revalidate pattern.

## Why PostgreSQL is the coordination layer

An event ID primary key serializes duplicate deliveries. Account row locks serialize
balance changes, charges, refunds, deletion, and annual resets. Partial unique indexes
encode business invariants independently of application branches. This remains correct
with multiple API processes and workers without requiring a Redis lock that can expire
while work is still running.

## Data model

- `billing_accounts`: the locally enforced entitlement projection.
- `stripe_webhook_events`: committed event inbox and outcome audit.
- `stripe_invoice_state`: monotonic cumulative refund/dispute facts.
- `credit_ledger`: append-only changes with `balance_after` and invoice attribution.
- `checkout_claims`: expiring single-flight claims with an unguessable identity token.
- `billing_incidents`: deduplicated unresolved operational work.

The SQL source of truth is `migrations/001_schema.sql`.

## Supported event contract

- `checkout.session.completed`
- `checkout.session.expired`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `charge.refunded`
- `charge.dispute.created`

Unlisted event types are acknowledged and recorded with an ignored outcome. Configure
the production endpoint to send only the contract above.
