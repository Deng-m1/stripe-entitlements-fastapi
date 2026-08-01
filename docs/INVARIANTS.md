# Billing invariants

## 1. Money-to-entitlement attribution

Every subscription grant is attributed to immutable paid Invoice lines. A full-period
grant has exactly one non-proration target line. A prorated-delta grant has exactly one
negative source and one positive target proration line bound to a durable intent.
Plan, interval, and service period never come from a later mutable Subscription read.
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
first, a later paid event sees the flag and either blocks a fully closed Invoice or
grants then applies the cumulative partial-refund ratio in the same transaction.
Delta allocations distinguish source funding from upgrade funding; an old-epoch
clawback cannot mutate the current pool. When a current-epoch partial clawback exceeds
the spendable balance, `billing_clawback_debts` retains the missing units. A same-epoch
usage refund or delta grant is credited in the ledger and then immediately consumed by
that debt, so spending cannot make refunded funding reappear later.
Terminal funding closure has its own business guard: `stripe_invoice_state.closure_applied`
is committed with the blocked refund-before-paid grant, delta leaf reversion, lineage
revocation, or annual closure. A later refund/dispute Event with a different Event ID
cannot apply that terminal effect again, advance another epoch, or recreate debt.

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

## 9. Plan identity is explicit

Plan direction comes from the catalog's stable key and unique positive rank, never from
price amount. Price is billing data. Changing a price must not silently change whether a
transition is considered an upgrade or downgrade.

## 10. Settlement policy is explicit and persisted

`full_period_reset` starts a new full-price period with no proration.
`prorated_delta` permits only a same-interval monthly higher-tier upgrade and preserves
the period. Every one of the 36 plan/interval cells is defined for both policies. The
selected policy is copied to the intent and cannot be reinterpreted after configuration
changes.

Every annual-origin change remains period-end under both policies. An otherwise-
immediate preview that drifts from its policy-specific Invoice facts is also deferred.

## 11. Plan-change intent precedes entitlement

A Subscription price change is authorized only by a durable `billing_plan_changes` row
bound to account, target, source entitlement snapshot, and idempotency key. Mutable
Subscription state alone never grants a new plan. Confirm success, browser return, SCA
completion, and `customer.subscription.updated` are not grant events; the matching paid
invoice completes the intent.

Only one pending plan change may exist per account. For a delta upgrade, the intent also
snapshots the immutable source funding Invoice, fixed entitlement difference, and
proration timestamp. Confirm atomically changes `previewed` to `applying` before any
Stripe mutation and records `remote_started_at` before the call. An unknown result less
than 23 hours old is retried only with the same derived Stripe idempotency key. At or
beyond 23 hours, automatic mutation stops until an operator proves the exact Invoice or
Schedule outcome; a new logical intent is not opened speculatively.

An unconfirmed `previewed` row never authorizes a paid update. Only `applying`, `applied`,
`requires_action`, or the matching period-end `scheduled` state can authorize webhook
completion.

When Stripe returns a latest Invoice for an immediate mutation, its ID is bound to the
intent with compare-and-set semantics. The coordinator finish and a faster paid webhook
may race to establish the same binding; a conflicting ID fails closed. If the webhook
has already failed the intent, confirm returns conflict rather than reporting a
synchronous success. A subsequent `invoice.paid` or `invoice.payment_failed` may
complete or move that intent only when the exact Invoice ID matches. An unbound or older
failure creates an incident but cannot mark the new intent `requires_action` or freeze
the source entitlement. Exact coordinator binding resolves only the matching unbound-
failure incident. A matching paid Invoice resolves its bound/unbound payment-failure
incidents in the same transaction as entitlement completion; incidents for another
Invoice or account remain open.

## 12. Optional upgrade failure preserves paid entitlement

`pending_if_incomplete` may leave the old Subscription item active and a new Invoice open.
In that state the old, still-funded entitlement remains enforceable. The plan change is
`requires_action` and may expose a hosted recovery URL, but the target plan is not active.

## 13. Authentication and webhook contracts fail closed

Production billing APIs reject all requests until the host supplies an
`AuthAccountAdapter` that returns a verified stable subject. Browser account identifiers
are not trusted.

The outbound Stripe request version and webhook Event snapshot version are independent.
An Event whose `livemode` or `api_version` differs from the configured webhook contract
is stored as an ignored event with a durable `webhook_contract_mismatch` incident.

## 14. Delta cash and entitlement dimensions stay separate

Cash proration is used only to prove that Stripe settled the authorized source-to-target
change for one remaining monthly period. Credits added are always
`target.monthly_credits - source.monthly_credits`. Discounts, tax, customer balance,
credit notes, missing line pages, and inconsistent proration fractions fail closed.
The complete preview source credit, target charge, net due, currency, and service period
are durable facts; the paid Invoice must match them exactly. Full-period preview and paid
paths symmetrically reject balance, credit-note, tax, discount, pagination, quantity, and
amount drift.

A partial upgrade refund claws back only the proportional delta. Closing the latest
leaf delta advances `grant_epoch` and reverts to its funded source plan, so a late
product refund cannot recreate withdrawn upgrade credits. Closing a source or intermediate funding
Invoice revokes dependent enforcement. Allocation, ledger, account, Invoice state, and
intent changes commit in one PostgreSQL transaction.

## 15. Invoice ownership is checked before clawback mutation

Refund/dispute processing follows account → Invoice → grant/allocation lock order. An
Invoice state, grant slot, or delta allocation bound to another account creates an
incident before refund facts or balances are changed. Customer lookup alone is never
sufficient authority to debit credits.
