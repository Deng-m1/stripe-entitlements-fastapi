# Promotion codes and coupons: phased plan

This document defines how Stripe Coupons and Promotion Codes may eventually enter this
reference implementation without weakening any invariant in
[Billing invariants](INVARIANTS.md). It separates a Phase-1 slice that is safe today
(display, documentation, reserved configuration hooks, all default-off) from a Phase-2
slice that actually accepts discount-bearing Invoices, with explicit money-to-entitlement
decisions, the modules that must change, and the test matrix that must pass first.

The nine-lane ticket breakdown and execution order live in
[Nine-lane promo UI plan](plans/NINE_LANE_PROMO_UI.md).

## Current state

Every discount shape on an Invoice fails closed today:

- `has_unsupported_invoice_adjustments` in `src/stripe_entitlements/invoice_policy.py`
  rejects `discount`, non-empty `discounts`, `total_discount_amounts`, line-level
  `discount_amounts`, and nonzero `pretax_credit_amounts`. Presence matters even when
  the computed amount is zero: a zero-valued discount object still means the Invoice is
  outside the documented single-item contract.
- The paid webhook path in `src/stripe_entitlements/processor.py` raises
  `balance, credit notes, taxes and discounts are not supported`. The exception rolls
  back the event-inbox claim so Stripe retries (invariant 7); shapes that cannot be
  retried into acceptance end as durable `billing_incidents` rows, never as silent
  grants.
- Both transition policies reject discounts symmetrically. The preview estimate in
  `src/stripe_entitlements/stripe_gateway.py` sums `total_discount_amounts` and line
  `discount_amounts`, and coerces a presence-only sentinel: a non-empty `discounts`
  array with a zero computed sum still records `discount_amount = 1`, so presence alone
  disqualifies the preview. `src/stripe_entitlements/plan_changes.py` requires
  `estimate.discount_amount == 0` in the safety checks of **both** `prorated_delta` and
  `full_period_reset`; an unsafe preview is deferred to `period_end` rather than settled
  immediately.
- **The annual saving is not a Coupon.** `plans.toml` sets explicit yearly totals
  approximately 40% below twelve monthly payments. That is annual price design: the
  pricing UI shows a saving only when both prices share a currency and the yearly total
  is strictly lower, and the displayed saving never controls tier direction or
  transition timing. No Stripe Coupon, Promotion Code, or discount object participates
  anywhere in the funded path today.
- Hosted Checkout does not display a promotion-code field unless the reserved
  `CHECKOUT_ALLOW_PROMOTION_CODES` hook is enabled. It defaults to off; see Phase 1 for
  its exact semantics and the production prohibition.

## Phase 1 — minimal safe slice (display, docs, fail-closed gates)

Phase 1 changes what is *shown and documented*, never what is *granted*.

In scope:

- Pricing-page and FAQ copy that presents the annual saving as an explicit price fact
  (not a limited-time coupon), plus promo-focused demo-recording updates. Display only;
  the existing same-currency / strictly-lower guard on the saving claim stays.
- This document, optional invariant future-gate notes, and
  [promo UI test gates](plans/TEST_GATES_PROMO_UI.md).
- Negative regression tests proving Checkout Session creation **never** includes
  `allow_promotion_codes`, and discounted Invoices (including zero-valued discount
  objects) remain fail-closed.

Hard rule:

> **Do not pass `allow_promotion_codes` to Stripe Checkout Session creation on this
> branch — including via a default-off feature flag.** A customer who redeems a code
> would be charged the discounted amount, receive no entitlement under today's
> `has_unsupported_invoice_adjustments` policy, and become a durable incident requiring
> manual refund and repair. Charged-but-not-entitled is the worst customer outcome this
> system can produce. There is no safe "hook only" Phase-1.

Explicitly out of Phase-1 scope: any `CHECKOUT_ALLOW_PROMOTION_CODES` setting, any
Session parameter that enables promotion codes, and any change to `invoice_policy.py`,
`processor.py`, `plan_changes.py` acceptance logic, refund math, migrations, or grant
attribution. Those belong only to a later atomic Phase that ships attribution + tests
together (see Phase 2 / the parent override in
[promo-ui-expansion-9-lane-plan.md](plans/promo-ui-expansion-9-lane-plan.md)).

## Phase 2 — full Coupon / Promotion Code support

Phase 2 is the first change allowed to accept a discount-bearing Invoice. It ships only
as a complete unit: attribution decisions, schema, acceptance contract, and the full
test matrix below in the same release.

### Attribution decisions

These decisions are fixed now so implementation lanes cannot reinterpret them:

- **D1 — Catalog credits never scale with discounts.** A discounted paid Starter
  Monthly Invoice still grants exactly 300 credits, or nothing. Discounts change cash,
  never entitlement quantity. This extends invariant 14's cash/entitlement separation:
  money proves that Stripe settled the purchase; the catalog alone sizes the grant.
- **D2 — Refund and dispute ratios use the discounted amount actually paid.**
  Cumulative partial-refund ratios, clawback debts, and all invariant-4 convergence
  permutations compute against the Invoice's `amount_paid`, never the pre-discount list
  price. Computing against list price would let a full refund of discounted cash claw
  back less than the full grant, or spending recreate refunded funding.
- **D3 — Slice 1 accepts first-purchase Checkout Invoices with one `duration=once`
  coupon only.** Renewal Invoices discounted by `repeating`/`forever` coupons remain
  fail-closed until a later slice adds per-cycle discount facts. This keeps the accepted
  shape enumerable and testable.
- **D4 — Plan-change paths stay discount-free.** Both `full_period_reset` and
  `prorated_delta` previews and paid settlements keep requiring
  `discount_amount == 0`. Promotion codes never enter proration math; a discounted
  upgrade Invoice keeps failing closed symmetrically on preview and paid sides.
- **D5 — Zero-due Invoices are rejected.** A 100%-off Invoice provides no new-money
  proof for a grant. Slice 1 requires `amount_paid > 0`; free-account campaigns need a
  separately designed mechanism, not a silent widening of this contract.
- **D6 — Discount facts are durable and transactional.** Coupon ID, Promotion Code ID,
  `percent_off`/`amount_off` snapshot, the summed discount total, and `amount_paid`
  commit in the same PostgreSQL transaction as the grant they fund, keyed to the
  immutable Invoice (extend `stripe_invoice_state` or add `billing_invoice_discounts`).
  Refund processing reads these facts instead of re-deriving from mutable objects.
- **D7 — Annual slot arithmetic is unchanged.** A discounted annual Invoice still funds
  up to 12 monthly slots of full catalog size (D1). Refunds monotonically reduce future
  allowed slots using the paid-ratio rule (D2, invariant 6).

### Accepted Invoice shape (slice 1)

A discount-bearing Invoice may fund a grant only when all of the following hold; any
other discount participation keeps today's fail-closed behavior:

- Checkout-originated first purchase for the account's claim (invariant 5 identity);
- exactly one order-level discount whose Coupon has `duration=once`, resolved through a
  Promotion Code redeemed in hosted Checkout;
- `total_discount_amounts` consistent with that single discount; no line-level
  `discount_amounts` surprises, no `pretax_credit_amounts`, no tax, balance, or credit
  notes (those stay rejected exactly as today);
- `amount_paid > 0` and `amount_paid == total` after the discount;
- the single-payment shape checks in `invoice_policy.py` still pass.

### Modules to change

| Module | Change |
| --- | --- |
| `src/stripe_entitlements/invoice_policy.py` | Split the blanket discount rejection into "accepted slice-1 shape" vs "everything else fails closed"; keep zero-valued-presence rejection for all non-slice-1 fields |
| `src/stripe_entitlements/stripe_gateway.py` | Snapshot discount facts from paid-Invoice payloads; keep preview `discount_amount` sentinel untouched (D4) |
| `src/stripe_entitlements/processor.py` | Accept slice-1 first-purchase Invoices, persist D6 facts with the grant, compute refund ratios from `amount_paid` (D2) |
| `src/stripe_entitlements/plan_changes.py` | No behavior change; add explicit tests proving the flag cannot leak discounts into either policy (D4) |
| `migrations/` | Durable discount-fact storage keyed to the Invoice, with constraints preventing a second conflicting fact row |
| `src/stripe_entitlements/config.py`, health surface | Promote `CHECKOUT_ALLOW_PROMOTION_CODES` from reserved hook to supported flag; expose state on health/config responses |
| `web/` | Promo-code aware Checkout copy and account-page display of the applied discount (display only) |
| `docs/` | Convert [Billing invariants §16](INVARIANTS.md) future gates into the operative invariant; update `PLAN_TRANSITIONS.md`, `TESTING.md`, `STRIPE_CLI.md` |

### Must-test matrix

Phase 2 does not merge until every row exists and passes (see also
[promo future gates](TESTING.md)):

| # | Case | Expectation |
| --- | --- | --- |
| 1 | Flag off, every current discount fixture | Rejected exactly as today (regression equivalence) |
| 2 | `percent_off` and `amount_off` once-coupon, monthly and yearly first purchase | Paid → full catalog credits (D1), discount facts durable (D6) |
| 3 | Duplicate Event ID on a discounted paid Invoice | Second delivery is a no-op (inbox layer) |
| 4 | Different Event / same business grant on a discounted Invoice | `(stripe_invoice_id, grant_slot)` blocks the second grant |
| 5 | Partial refund before and after paid, on discounted `amount_paid` | Converging cumulative ratio per invariant 4, computed from paid cash (D2) |
| 6 | Full refund/dispute before and after paid, discounted Invoice | Converges to closed funding; `closure_applied` idempotent |
| 7 | Clawback exceeding spendable balance on a discounted grant | `billing_clawback_debts` retains missing units |
| 8 | Zero-due (100%-off) Invoice | Rejected, durable incident (D5) |
| 9 | `repeating`/`forever` coupon renewal Invoice | Rejected fail-closed, retry-safe incident (D3) |
| 10 | Discount drift between preview and paid Invoice, both policies | Symmetric rejection: preview defers, paid fails closed (D4) |
| 11 | Discounted annual Invoice: slot 1, worker slots, refund slot reduction | 12 full-size slots; reduction uses paid ratio (D7) |
| 12 | Two concurrent workers on one discounted funding Invoice | Real PostgreSQL concurrency: exactly one grant |
| 13 | Real Stripe test mode: create Coupon + Promotion Code, redeem in Checkout, poll `invoice.paid` | Actual payload shape parses; strict run-scoped cleanup |
| 14 | Browser gate: redeem a promo code in hosted Checkout end to end | Webhook-projected entitlement equals full catalog credits |

## Reference sites: what to borrow

- **Stripe Billing documentation** (Coupons, Promotion Codes, Checkout discounts):
  the normative source for `duration` semantics (`once`/`repeating`/`forever`),
  promotion-code restrictions (`first_time_transaction`, `minimum_amount`,
  `expires_at`, `max_redemptions`), `allow_promotion_codes` behavior on Checkout
  Sessions, and the Invoice `total_discount_amounts` / line `discount_amounts` shapes.
  The slice-1 accepted-shape contract must cite documented fields, not merely observed
  payloads, and real test-mode fixtures must confirm them (matrix row 13).
- **Linear** (linear.app pricing): restrained monthly/annual toggle with the annual
  saving stated as a plain price fact and a per-month equivalent — no countdown timers
  or urgency banners. This matches our position that the ~40% annual saving is explicit
  price design, and it is the Phase-1 display model for the pricing page.
- **Resend** (resend.com pricing): clear per-tier included usage (their email volume
  maps to our monthly credits), simple tier comparison, and pricing transparency without
  coupon gimmicks. A good template for keeping promotional copy visually separate from
  billing semantics, which mirrors our cash/entitlement separation.

## Risk register

- **R1 — Early flag enablement.** `CHECKOUT_ALLOW_PROMOTION_CODES=true` on a production
  path before Phase 2 produces charged-but-not-entitled customers and manual repair.
  Mitigation: default off, the Phase-1 hard rule, and invariant §16.
- **R2 — Preview/paid discount drift.** A Coupon attached in the Dashboard between
  preview and settlement changes the Invoice mid-flight. Today both `prorated_delta`
  and `full_period_reset` reject this symmetrically: previews store durable facts and
  require `discount_amount == 0` (presence alone sets the sentinel), and the paid path
  fails closed on any discount shape. Phase 2 must preserve exactly this symmetry for
  plan changes (D4); only slice-1 first-purchase Invoices are ever exempt.
- **R3 — Refund ratio against list price.** Would claw back too little on discounted
  funding and could let spending recreate refunded credits, violating invariant 4.
  Mitigation: D2 plus matrix rows 5–7.
- **R4 — Zero-due grants.** A 100%-off Invoice granting entitlement without new-money
  proof. Mitigation: D5 plus matrix row 8.
- **R5 — Renewal-coupon scope creep.** `repeating`/`forever` shapes drifting into the
  slice-1 path without per-cycle facts. Mitigation: D3 plus matrix row 9.
- **R6 — Discount-scaled entitlement.** Any code path sizing credits or annual slots
  from discounted cash. Mitigation: D1/D7 plus matrix rows 2 and 11.
- **R7 — Out-of-band Dashboard coupons.** Discounts applied outside this application
  remain outside the contract in every phase: fail-closed incident, then operator
  runbook. They must never be silently accepted as slice-1 shapes.
