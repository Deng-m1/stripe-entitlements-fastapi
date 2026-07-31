# Billing invariants

## 1. Money-to-entitlement attribution

Every subscription grant is attributed to an immutable paid invoice line. Plan,
interval, and service period come from that line, not from a later mutable Subscription
read. The reference supports exactly one non-proration subscription item per invoice.
Unknown or ambiguous shapes fail closed into `billing_incidents`.

## 2. Two independent idempotency layers

The event inbox prevents the same Stripe Event ID from committing twice. The partial
unique index on `(stripe_invoice_id, grant_slot)` prevents a second caller, a new Event
ID, a reconciliation run, or an annual worker from issuing the same business grant.

“Exactly once” is intentionally not claimed. Stripe is at-least-once, networks can fail,
and a database commit can happen before a client sees the response. The guarantee is
effectively-once PostgreSQL effects under the documented schema.

## 3. Ordered state projection

Stripe does not guarantee webhook order. Subscription projections compare
`(event.created, event_rank)` with the last applied tuple. In same-second ties:

1. `customer.subscription.deleted`
2. `invoice.paid`
3. `customer.subscription.updated`
4. `invoice.payment_failed`

This prevents a weaker payment failure from refreezing an account after a successful
payment, and prevents a paid event from reviving a same-second terminal deletion.

## 4. Refund-order convergence

Refund and dispute state is stored before looking for a grant. If the clawback arrives
first, a later paid event sees the flag and either blocks a fully closed invoice or
grants then applies the cumulative partial-refund ratio in the same transaction.

For the current active pool, these permutations converge to the same credit balance:

- paid, then partial refund;
- partial refund, then paid;
- paid, then full refund/dispute;
- full refund/dispute, then paid.

## 5. Checkout single-flight

One account has at most one unexpired Checkout claim. Claim identity, not only account
identity, guards attach/release. Expiration or completion of an older Session cannot
delete or bind a newer claim.

## 6. Annual monthly grants

An annual invoice funds up to 12 monthly slots. Slot 1 is issued by `invoice.paid`;
subsequent slots use the same funding invoice and unique `(invoice, slot)` key. After
downtime, the worker grants only the current slot rather than replaying every missed
monthly reset. Refunds monotonically reduce future allowed slots.

## 7. Retryability and durable failure

The inbox claim is in the same transaction as side effects. Any exception rolls back the
claim. A 500 asks Stripe to retry. A 2xx fail-closed decision must have a durable incident
or persistent invoice flag so it can be inspected and replayed.

## 8. Product-operation refunds cannot cross grant epochs

Each usage debit snapshots the account's `grant_epoch`. A product job may refund its
debit only while the account remains in that epoch. A renewal reset, subscription end,
or full clawback advances the epoch, so a late product refund cannot recreate credits
that belonged to a closed entitlement window.
