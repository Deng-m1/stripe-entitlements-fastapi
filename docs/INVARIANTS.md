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
identity, guards attach/release. Before remote mutation, the claim freezes a versioned
request containing the exact Price, URLs, Customer/create mode, product line, request API
version, parameters, and derived Stripe idempotency key. Same-key recovery replays that
request and omits an email prefill for first-Customer creation instead of retaining
mutable login PII. A pre-002 `NULL`, reserved-but-unfrozen `0`, malformed version, or
row/snapshot mismatch cannot be reconstructed from current configuration. Expiration or
completion of an older Session cannot delete or bind a newer claim. A Subscription update
that first binds through a claim consumes that authority in the same transaction, and
terminal deletion removes any claim that existed before it. A late paid Event cannot
reuse pre-deletion Checkout authority.

## 6. Annual monthly grants

An annual invoice funds up to 12 monthly slots. Slot 1 is issued by `invoice.paid`;
subsequent slots use the same funding invoice and unique `(invoice, slot)` key. After
downtime, the worker grants only the current slot rather than replaying every missed
monthly reset. Refunds monotonically reduce future allowed slots.

## 7. Retryability and durable failure

The inbox claim is in the same transaction as side effects. Any exception rolls back the
claim. A 500 asks Stripe to retry. A 2xx fail-closed decision must have a durable incident
or persistent invoice flag so it can be inspected and replayed.

An inbox duplicate proves only that a delivery committed, not that its projection did.
Synthetic reconciliation retries inspect the committed outcome, preserve ignored reasons
for CAS recovery, and resolve only incidents observed strictly before that reconciliation
attempt. Incident observations use PostgreSQL's statement wall clock rather than the
transaction-start clock; an observation at the exact cutoff or written later by a
long-running transaction remains unresolved for the next attempt.

A Subscription reconciliation CAS retry never reuses the mutable Stripe object from the
losing attempt. It first snapshots the newly committed local projection cursor, then
retrieves and validates Stripe state again, and permits one fresh projection. A second
cursor loss stops fail-closed with a durable incident so an older remote read cannot
overwrite newer status, cancellation, or period facts committed by a webhook.

If another reconciler advances the Subscription projection cursor between a paid-Invoice
snapshot and its account lock, the losing attempt performs a bounded retry against a
fresh snapshot and a new synthetic Event ID. A successful retry may resolve only the
`stale_paid_event` whose account, Invoice, and failed synthetic Event ID it superseded;
it does not widen the causal cutoff for any other incident.

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
Stripe mutation and records `remote_started_at` before the call. Preview freezes the
complete Price evidence, Subscription/item/period context, product line, request API
version, policy parameters, Schedule phases, and derived idempotency key. Confirm and
unknown-result recovery execute only that validated snapshot; legacy unfrozen intents
fail closed and cannot be filled from a later catalog. An unknown result less
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

For one bound settlement Invoice, a committed paid grant dominates a later
`invoice.payment_failed` snapshot. Both delivery orders converge to a completed intent
without an order-dependent unresolved failure incident.

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
sufficient authority to debit credits. First ownership is established by an atomic,
ownership-conditional Invoice upsert; a conflicting concurrent caller cannot merge amount,
refund, full-closure, or dispute facts into the winner's row.

## 16. Discounts remain fail-closed until promo attribution gates pass

Nothing in this section weakens invariants 1, 4, or 14. Today any Coupon, Promotion
Code, or discount participation on an Invoice, including zero-valued shapes, fails
closed with no entitlement effect: the paid path rolls back for retry or records a
durable incident, and both transition policies symmetrically reject discount drift in
preview and paid settlement. The annual saving is explicit yearly pricing in
`plans.toml`, not a discount object. Checkout Session creation must never send
`allow_promotion_codes` (including via a default-off feature flag) while this section
stands, because a redeemed code would charge the customer without granting
entitlement.

A future change may accept a discount-bearing Invoice only when all of these gates hold
(see [Promotion codes and coupons](PROMOTION_CODES.md)):

1. Durable discount facts (Coupon, Promotion Code, discount total, amount paid)
   commit in the same PostgreSQL transaction as the grant they fund.
2. Catalog credits never scale with discounts: a discounted paid Invoice grants exactly
   the full catalog quantity or nothing.
3. Refund and dispute ratios are computed from the discounted amount actually paid,
   preserving invariant-4 convergence.
4. Both transition policies keep symmetric preview and paid rejection of discount
   drift; discounts never enter `prorated_delta` or `full_period_reset` settlement math.
5. The promo test matrix in [Promotion codes and coupons](PROMOTION_CODES.md) and the
   promo UI test gates in [TEST_GATES_PROMO_UI.md](plans/TEST_GATES_PROMO_UI.md) pass,
   including Session-parameter omission regression.

Until every gate is met, the fail-closed behavior above is the invariant.

## 17. Product credits use one exact fixed-point protocol

Every authoritative product-credit quantity is stored and calculated as an integer
number of atoms. One displayed credit is exactly `1,000,000` atoms and the scale is a
compiled protocol constant, not a per-process environment setting. Stripe currency
minor units remain a separate integer dimension and are never scaled as product
credits.

Catalog and incoming amount boundaries accept canonical decimal strings with at most six
fractional digits. Python `float`, PostgreSQL floating-point values, JSON fractional
numbers, scientific notation, silent rounding, and a value destined for one persisted
atom column outside the PostgreSQL `bigint` range are rejected. An account total may
aggregate several independently bounded funding rows and therefore exceed one `bigint`;
that read/result aggregate uses Python arbitrary-precision integers and decimal/atom
strings end to end. JavaScript `number` is never its source of truth.

Idempotency binds the normalized atom value. Equivalent spellings such as `0.1` and
`0.100000` represent the same amount; values that differ by one atom are different
requests. Account locking still prevents concurrent overspend, and every committed
ledger row satisfies exact integer addition without permitting a negative balance.

Refund and dispute ratios continue to use integer multiplication followed by an explicit
ceiling in atom space. This preserves cumulative, delivery-order-independent clawback
behavior while limiting rounding to at most one atom. Product-operation refunds remain
bound to their recorded grant epoch. Any addition written back to one `bigint` column
that would overflow fails and rolls back the complete business effect; summing separate
funding rows for an exact read-only account total is not such a write.

## 18. Credit packs preserve immutable cash and funding provenance

A pack order snapshots its account, client and Stripe request identities, pack key,
lookup key, credit atoms, currency amount, currency, expiry policy, nullable pre-existing
Customer request, URLs, product line, request API version, Checkout parameters, and
derived Stripe idempotency key before Checkout is created. Same-key recovery replays only
that strict versioned request; first-Customer creation deliberately omits an email prefill
instead of rereading mutable authentication state. A legacy, unfrozen, malformed, or
row-inconsistent snapshot cannot start a Stripe mutation. Checkout Session, PaymentIntent, Charge, and
Dispute facts must match that full snapshot, exact customer lineage, authorized amount,
amount received, latest Charge, and object state. Only a compatible
`payment_intent.succeeded` grants funding; a browser return or Checkout completion never
does. An expired Session or an unknown Checkout outcome beyond the bounded same-key
recovery window cannot be reopened with the old intent. One paid order has at most one
funding lot. The first compatible committed payment fact freezes `paid_at` and the lot's
`expires_at = paid_at + expires_days`; a later business duplicate, refund, dispute, or
reconciliation replay cannot move that financial window. The lot's `created_at` is only
the local projection audit time. If a missed successful payment is first projected after
that immutable financial expiry, its lot is created already expired; those atoms are
never exposed or used to collect a later clawback debt.

Pack lots and subscription funding are consumed first-expiring-first-out. Every product
debit records exact source allocations, and a product refund can return atoms only to
those sources while their funding window remains valid. Pack lots never grant plan
features, limits, subscription status, or a new subscription epoch.

Cash refunds are cumulative facts. They withdraw the ceiling of the cumulative cash
ratio from unspent and expired atoms first; already-consumed funding becomes durable
pack debt. Cash-refund-before-product-refund, product-refund-before-cash-refund, debt
collection before or after renewal, duplicate Events, and concurrent delivery converge
to the same net funding. Releasing collected debt reverses its exact recorded source and
cannot cross an account, pack order, lot, or subscription grant epoch.

`credit_pack_clawback_debts.collected_credits` always equals the outstanding,
not-yet-reversed allocations of its synthetic debt-collection debits. Every such debit
has exactly one funding-source allocation and a direct account-scoped foreign key to an
existing debt, so a counter update cannot erase liability and a collection cannot exist
before its debt and funding lot.

The account row is locked before every pack order, lot, allocation, or debt mutation.
Account-scoped composite foreign keys prevent cross-tenant provenance even if application
code is wrong. Deferred database equations require each debit to equal its allocations,
each order's refunded atoms to equal cash-clawed atoms plus debt target, and each lot's
original atoms to equal its remaining, expired, cash-clawed, debt-released, and still-
allocated atoms.

Reconciliation leases one exact order, performs every Stripe retrieval outside a
database transaction, and rechecks the lease token inside the EventProcessor transaction
before claiming the synthetic Event inbox identity. A stale worker therefore cannot
project a fact or clear a replacement worker's lease.

PostgreSQL `now()` is transaction-start time and is never used as the pack-expiry cutoff
after a row-lock wait. Charge, product refund, and Checkout reservation paths sample
`clock_timestamp()` only after acquiring the account lock and reuse that wall-clock
cutoff for the transaction's expiry decisions.
