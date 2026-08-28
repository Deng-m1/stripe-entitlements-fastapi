# Credit packs and multi-source funding

Credit packs are stored-value funding, not a larger subscription grant. They persist
across subscription grant epochs, can expire independently, and can be refunded or
disputed after some or all of their credits have been consumed. Those facts require
source-aware accounting rather than a direct `credits_balance += amount` update.

This document defines the bounded 0.3 reference policy and the database invariants that
make duplicate and out-of-order Stripe delivery safe. Product credits use the exact
fixed-point protocol in [Exact fractional product credits](CREDIT_PRECISION.md); Stripe
cash amounts remain integer currency minor units.

## Reference policy

- Hosted Checkout uses `mode=payment`, `payment_method_types=["card"]`, and a catalog
  Price with `quantity=1`. The reference is deliberately card-only; enabling Dashboard
  automatic payment methods requires separate acceptance tests and settlement/refund
  policy for every additional payment rail.
- The reference catalog supports USD packs with a fixed credit amount and price.
- Pack Checkout does not accept Coupons, Promotion Codes, tax, customer-balance funding,
  non-card or Dashboard-injected automatic payment methods, arbitrary quantities,
  automatic top-up, or a browser-supplied Price ID.
- A signed, contract-compatible `payment_intent.succeeded` Event is the grant authority.
  Browser return and `checkout.session.completed` never grant credits.
- Each pack lot expires after its catalog-defined lifetime; the reference default is
  365 days from the successful payment time.
- Consumption is first-expiring-first-out across usable subscription funding and pack
  lots. A product refund returns credits only to the exact sources consumed by that
  debit and only while each source remains returnable.
- Subscription renewal, downgrade, cancellation, or grant-epoch advancement never
  deletes an unexpired pack lot. A pack does not grant plan features or higher limits.
- A cumulative partial cash refund withdraws
  `ceil(original_pack_atoms * cumulative_refunded_cash / amount_paid)` atoms. A full
  refund or dispute closes the complete pack funding.
- If withdrawn pack credits were already consumed, the missing amount becomes durable
  cross-epoch debt. Later positive credit funding is collected against that debt before
  it becomes spendable.

Applications that want packs to require an active subscription must enforce that as a
purchase and product-admission policy. It must not be implemented by deleting pack
funding when a subscription Event arrives.

The first compatible payment fact that commits locally freezes the order's `paid_at`.
Normal signed delivery uses the Stripe Event success time; missed-webhook reconciliation
uses the remotely verified Charge time. That first fact alone derives `expires_at`, so a
business duplicate, refund, dispute, or later reconciliation cannot extend the funding
window. `credit_funding_lots.created_at` records local projection time and is not used for
financial expiry.

## Why four additional tables are justified

These are independent business identities, not duplicate copies of the ledger:

| Entity | Unique responsibility | Why the existing ledger is insufficient |
| --- | --- | --- |
| `credit_pack_orders` | Durable Checkout/payment intent, catalog snapshot, cash state, and request idempotency | A ledger row cannot coordinate an unknown remote Checkout outcome or cumulative cash refunds. |
| `credit_funding_lots` | Remaining atoms, expiry, closure, and immutable funding source | An aggregate balance cannot distinguish expiring or refunded sources. |
| `credit_debit_allocations` | Exact debit-to-lot provenance | Without allocation, a Job refund can recreate the wrong funding or bypass an expired/closed lot. |
| `credit_pack_clawback_debts` | Spent funding that a later refund/dispute must still recover | A current balance cannot represent a liability after the purchased credits have already been spent, and subscription `grant_epoch` debt is intentionally not persistent. |

Job, queue, and dispatch outbox tables remain host-owned and are not added to the billing
baseline. See the runnable Job/outbox/fencing example and the adoption guide.

These four tables are an internal accounting boundary, not four new host integration
APIs. Ordinary product code uses the authenticated credit-pack Checkout route,
`EntitlementService`/the owner-authorized internal router, and the reconciliation command;
it does not read or mutate order, lot, allocation, or debt rows. Operators include all
four in one backup/restore and monitor their documented incidents, but the facade hides
their transaction and lock choreography from business entities and Job payloads.

## Transaction and lock order

All pack mutations use PostgreSQL `READ COMMITTED` plus explicit constraints and row
locks. Every write path first locks `billing_accounts`; that row is the per-account
serialization boundary. After it is held, each operation uses its own deterministic
downstream order:

```text
billing_accounts (always first)
  Stripe cash projection -> credit_pack_orders -> credit_funding_lots -> pack debt
  product charge         -> funding lots (expires_at, id) -> debit -> allocations
  product refund         -> debit -> allocations -> source lot/order -> pack debt
                           -> synthetic collection debit/allocation
```

No downstream row is shared across accounts, and the account lock prevents two paths
for one account from interleaving their downstream lock orders. A read-only snapshot may
resolve an account ID before the lock; it grants no mutation authority and ownership is
checked again inside the locked transaction.

The Stripe Event inbox claim and every resulting order, lot, balance, allocation, debt,
ledger, and incident mutation commit in one transaction. Stripe object retrieval and
Checkout creation happen outside database transactions.

There are two deliberately separate recovery paths:

- If an order is still `reserved` and has no persisted `cs_` identity, only the
  original `CreditPackCoordinator` call may recover it. The host repeats the same
  client key and complete Checkout parameters, which repeats the derived
  `credit-pack:<order_id>` Stripe idempotency key. The background reconciler records
  `checkout_replay_required` in `last_reconcile_error`; it does not scan global
  Sessions, trust metadata search results, or create a second Session.
- Once `stripe_checkout_session_id` is durable, the pack reconciler leases the order
  and retrieves that exact Session, then its exact PaymentIntent and Charge. The
  network calls hold no database transaction. Remote-verified synthetic facts pass
  through the normal Event inbox/projector, and the lease token is rechecked and
  locked in the same transaction as each effect. This recovers missed
  `payment_intent.succeeded`, Checkout completion/expiry, cumulative refunds, and
  disputes across multiple replicas.

The order also snapshots the nullable pre-existing Stripe Customer used by that first
remote request. A webhook can bind a newly created Customer before the API process stores
the Session ID, and the host user's email can change between retries; neither later fact
is allowed to alter the replayed Stripe parameters. In first-Customer mode the reference
therefore uses `customer_creation=always` without an email prefill. Checkout still
collects the email, while the billing database avoids retaining email PII solely for
idempotency recovery. If the webhook stored the same Session ID first, the recovering API
call fills the missing Session URL without downgrading its completed status.

Product charging locks the account first, lazily closes expired lots, then locks usable
lots in `(expires_at, id)` order. This gives concurrent workers one deterministic
allocation order. A uniqueness guard on the debit key prevents the same Job attempt from
allocating twice.

Lazy closure moves `remaining_credits` into `expired_credits`; it never silently drops
the value. A product refund after closure also records the would-have-been source return
as expired without exposing it as usable balance. A later cash refund first reclassifies
still-unspent or expired atoms into `cash_clawed_back_credits` and creates debt only for
the residual that remains consumed. Therefore an expired lot cannot create phantom
future debt merely because cash and product refunds arrived in the opposite order.

## Event and business idempotency

The Event inbox prevents one Stripe Event ID from committing twice. Separate database
guards prevent the same business effect through another Event ID:

- one order per `(account_id, client_idempotency_key)`;
- one order per Stripe Checkout Session and PaymentIntent;
- one funding lot per paid pack order;
- monotonic cumulative `amount_refunded` and `refunded_atoms` per order;
- one allocation per `(debit_id, funding_lot_id)`; and
- one cumulative debt row per pack order.

A `payment_intent.succeeded` payload must match the reserved order's account/customer,
currency, exact amount, catalog snapshot, livemode, and metadata identity. An unknown or
ambiguous shape fails closed into a durable incident. Metadata alone is never ownership
authority.

`charge.refunded` and `charge.dispute.created` identify the successful PaymentIntent and
order before any balance mutation. Refund facts are stored monotonically before looking
for the lot, so refund-before-grant and grant-before-refund converge. A terminal closure
has its own database guard so a refund and dispute with different Event IDs cannot close
the same funding twice.

## Product refunds

A debit may consume more than one source. Each allocation records its exact atom amount.
Refunding the Job locks the original debit and allocations:

- a current subscription allocation is returned only while its grant epoch is still
  current;
- an unexpired active pack allocation is returned to its original lot even if the
  subscription epoch changed;
- an expired, fully refunded, or disputed lot is not recreated; and
- cash-clawback debt for that source pack is settled before lot headroom is restored:
  uncollected debt is released first, collected debt is unwound to each synthetic
  debit's exact subscription epoch or pack lot, and only the residual is returned to
  the source pack's net post-cash-refund headroom; and
- the debit becomes terminal only once, so concurrent refunds converge.

`credit_debits.amount` persists the requested refund quantity and
`credit_debits.restored_credits` persists what was actually returned to valid funding
sources. `CreditResult` and the internal HTTP API expose canonical decimal and atom
strings for both. A replay reads those persisted values, so an expired source or a
cash-first ordering is never represented as a false full restoration. Synthetic
`credit_pack_debt_collection` debits are internal accounting identities and are rejected
by the public product-refund path.

## Required test matrix

The network-free PostgreSQL suite must cover:

1. successful grant, duplicate Event, and different Event/same PaymentIntent;
2. concurrent `payment_intent.succeeded` processing with one lot and one grant;
3. Checkout creation unknown outcome and same-key recovery;
4. wrong owner/customer, Price, currency, amount, livemode, version, metadata, or event
   shape failing closed without a credit mutation;
5. FEFO consumption across subscription and multiple pack expiries;
6. concurrent charges that cannot overspend or allocate one lot twice;
7. subscription renewal/cancellation preserving pack lots;
8. Job refund to original sources, including a cross-epoch pack allocation and an
   expired/closed source;
9. partial refund before/after grant and every duplicate/out-of-order permutation;
10. full refund and dispute before/after grant;
11. refund after spend creating debt, debt surviving epoch changes, and later grants
    collecting it before spendable balance appears;
12. cash-refund-versus-Job-refund and renewal-collection-versus-Job-refund real
    PostgreSQL races, including uncollected, partially collected, and fully collected
    debt returned to the exact source without crossing account, order, or grant epoch;
13. rollback after inbox claim followed by successful retry; and
14. fixed-point boundary, one-atom rounding, and PostgreSQL `bigint` overflow rejection
    with whole-transaction rollback after a debt unwind has begun;
15. Session → PaymentIntent → Charge reconciliation with every network call outside a
    database transaction, including payment-plus-refund recovery in one pass; and
16. `SKIP LOCKED` multi-replica claims, lease takeover, token fencing inside
    EventProcessor, and a stale worker that cannot project or clear its replacement's
    lease.

The opt-in real Stripe suite must additionally create a run-scoped Product, one-time
Price, Checkout/PaymentIntent and refund in test mode, process the real object shapes,
and prove strict cleanup. The browser gate must enter a real hosted `cs_test_` Checkout,
wait for signed webhook projection, spend credits through a product Job, and exercise
failure recovery. Test Clock does not advance arbitrary PaymentIntent time or PostgreSQL
time; pack expiry therefore uses an injected/database clock in deterministic tests and a
separate bounded integration check.

Passing mocked, direct Stripe API, Stripe CLI forwarding, temporary endpoint, and live
production verification are separate evidence layers as described in
[Testing strategy](TESTING.md).

## Distributed scope

The design is safe across multiple API, webhook, outbox, and product worker replicas
sharing one PostgreSQL primary. PostgreSQL remains the coordination point and Stripe
remains an external dependency; this is not distributed ACID. The order identity,
same-key remote retry, Event inbox, row locks, unique constraints, allocation provenance,
and durable debt make every local effect convergent under at-least-once delivery.
