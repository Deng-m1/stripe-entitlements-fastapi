# Promotion codes and coupons: phased plan

This document defines how Stripe Coupons and Promotion Codes may eventually enter this
reference implementation without weakening any invariant in
[Billing invariants](INVARIANTS.md). It separates a Phase-1 slice that is safe today
(display, documentation, and prohibition test gates — no Checkout promo collection at
all) from a Phase-2 slice that actually accepts discount-bearing Invoices, with
explicit money-to-entitlement decisions, the modules that must change, and the test
matrix that must pass first.

The nine-lane ticket breakdown and execution order live in
[Nine-lane promo UI plan](plans/NINE_LANE_PROMO_UI.md). The pull-request and browser
evidence gates for promotional UI changes live in
[Promo UI test and review gates](plans/TEST_GATES_PROMO_UI.md).

## Current state

Every discount shape on an Invoice fails closed today:

- `has_unsupported_invoice_adjustments` in `src/stripe_entitlements/invoice_policy.py`
  rejects `discount`, non-empty `discounts`, `total_discount_amounts`, line-level
  `discount_amounts`, and nonzero `pretax_credit_amounts`. Presence matters even when
  the computed amount is zero: a zero-valued discount object still means the Invoice is
  outside the documented single-item contract.
- The paid webhook paths in `src/stripe_entitlements/processor.py` fail closed: the
  first-purchase/full-period path records a durable incident without granting, and the
  prorated-delta settlement path records `invalid_prorated_delta_invoice` with
  `balance, credit notes, taxes and discounts are not supported`. Both paths acknowledge
  the fail-closed decision and commit the durable Event audit/incident without an
  entitlement effect; an unexpected processing exception instead rolls the transaction
  back so Stripe can retry (invariant 7). No discounted Invoice ever grants silently.
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
- **Hosted Checkout never shows a promotion-code field.** `create_checkout_session`
  unconditionally omits `allow_promotion_codes`; the gateway carries an invariant
  comment at the parameter site, `.env.example` documents why no flag exists, and
  `tests/test_checkout_promo_prohibition.py` proves the Session parameters never
  contain the field.

## Phase 1 — minimal safe slice (display, docs, prohibition gates)

Phase 1 changes what is *shown, documented, and tested*, never what is *collected or
granted*.

In scope:

- Pricing-page and FAQ copy that presents the annual saving as an explicit price fact
  (not a limited-time coupon), plus promo-focused demo-recording updates. Display only;
  the existing same-currency / strictly-lower guard on the saving claim stays.
- This document, [Billing invariants §16](INVARIANTS.md), the
  [promo future gates](TESTING.md) testing section, and the
  [promo UI test and review gates](plans/TEST_GATES_PROMO_UI.md).
- Prohibition regression tests: Checkout Session parameter omission and the zero-valued
  discount/tax shape rejections in `tests/test_invoice_policy.py`.
- No discount shape is collected or accepted in Phase 1 — not `percent_off`, not
  `amount_off`, and not 100%-off. Those shapes appear below only as Phase-2 design
  material behind the full attribution gate.

Hard rule (integration-branch override decision, 2026-08-26):

> **Checkout Session creation must not send `allow_promotion_codes` — not even behind a
> default-off feature flag — while [Billing invariants §16](INVARIANTS.md) stands.** An
> earlier draft of this plan reserved a default-off configuration hook; the read-only
> review override rejected it because a wired parameter is one configuration flip away
> from the worst customer outcome this system can produce: with the field visible, any
> active promotion code in the Stripe account becomes redeemable (Stripe cannot
> restrict coupon duration or shape at the Session level), the customer pays the
> discounted amount, and every discounted Invoice fails closed — charged, not entitled,
> durable incident, manual refund. Promo collection may therefore ship only atomically
> with Phase 2: durable promo authorization, restricted Invoice acceptance with
> gross/discount/net verification, fixed catalog credits, and the complete
> refund/out-of-order/concurrency matrix in one merge unit.

Explicitly out of Phase-1 scope: any change to `invoice_policy.py` acceptance,
`processor.py` grant paths, `plan_changes.py` policy checks, refund math, migrations,
or Checkout Session parameters.

## Phase 2 — full Coupon / Promotion Code support

Phase 2 is the first change allowed to collect promotion codes and accept a
discount-bearing Invoice. It ships only as a complete unit: the durable promo-collection
authorization (a persisted, auditable record of scope, operator, and activation time —
never a bare environment switch alone), the restricted acceptance contract, schema,
attribution decisions, and the full test matrix below in the same release. A flag wired before its acceptance contract is a §16
violation, not a head start.

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
  back less than the full grant, or let spending recreate refunded funding.
- **D3 — Slice 1 accepts first-purchase Checkout Invoices with one `duration=once`
  coupon only.** Renewal Invoices discounted by `repeating`/`forever` coupons remain
  fail-closed until a later slice adds per-cycle discount facts. Because Stripe cannot
  restrict coupon shape at the Session level, server-side acceptance is the only
  backstop; operations must keep the account's promotion-code inventory within the
  slice-1 shape, and bootstrap validation must verify it.
- **D4 — Plan-change paths stay discount-free.** Both `full_period_reset` and
  `prorated_delta` previews and paid settlements keep requiring
  `discount_amount == 0`. Promotion codes never enter proration math; a discounted
  upgrade Invoice keeps failing closed symmetrically on preview and paid sides.
- **D5 — Zero-due Invoices are rejected.** A 100%-off Invoice provides no new-money
  proof for a grant and makes the D2 refund-ratio denominator zero. Slice 1 requires
  `amount_paid > 0`; free-account campaigns need a separately designed mechanism, not a
  silent widening of this contract.
- **D6 — Discount facts are durable and transactional.** Coupon ID, Promotion Code ID,
  `percent_off`/`amount_off` snapshot, the summed discount total, and `amount_paid`
  commit in the same PostgreSQL transaction as the grant they fund, keyed to the
  immutable Invoice (extend `stripe_invoice_state` or add `billing_invoice_discounts`).
  Refund processing reads these facts instead of re-deriving from mutable objects. The
  raw customer-entered promotion code string is never persisted — not in the database,
  logs, incidents, or metadata; redemptions are identified by Stripe object IDs
  (Coupon and Promotion Code IDs) only.
- **D7 — Annual Invoices stay out of slice 1.** The promotion-code field is enabled
  only for monthly Checkout Sessions. An annual Invoice funds up to 12 monthly slots
  and refunds monotonically reduce future slots (invariant 6), so discounts touch that
  arithmetic; a discounted annual Invoice remains fail-closed until a later slice
  proves full-size slots (D1) and paid-ratio slot reduction (D2).

### Accepted Invoice shape (slice 1)

A discount-bearing Invoice may fund a grant only when all of the following hold; any
other discount participation keeps today's fail-closed behavior:

- Checkout-originated first purchase for the account's claim (invariant 5 identity),
  monthly interval only (D7);
- exactly one order-level discount whose Coupon has `duration=once`, resolved through a
  Promotion Code redeemed in hosted Checkout;
- `total_discount_amounts` consistent with that single discount; no line-level
  `discount_amounts` surprises, no `pretax_credit_amounts`, no tax, balance, or credit
  notes (those stay rejected exactly as today);
- gross/discount/net arithmetic verified: catalog list price minus the discount equals
  `total`, and `amount_paid == total > 0`;
- the single-payment shape checks in `invoice_policy.py` still pass.

### Modules to change

| Module | Change |
| --- | --- |
| `src/stripe_entitlements/invoice_policy.py` | Split the blanket discount rejection into "accepted slice-1 shape" vs "everything else fails closed"; keep zero-valued-presence rejection for all non-slice-1 fields |
| `src/stripe_entitlements/stripe_gateway.py` | Introduce the flag-conditional `allow_promotion_codes` parameter for monthly Sessions in the same merge unit as acceptance; snapshot discount facts from paid-Invoice payloads; keep the preview `discount_amount` sentinel untouched (D4) |
| `src/stripe_entitlements/processor.py` | Accept slice-1 first-purchase Invoices, persist D6 facts with the grant, compute refund ratios from `amount_paid` (D2) |
| `src/stripe_entitlements/plan_changes.py` | No behavior change; add explicit tests proving the flag cannot leak discounts into either policy (D4) |
| `src/stripe_entitlements/config.py`, `app.py`, health surface | Add the promo-collection authorization surface (default off, backed by the durable persisted record above) and expose its state; it lands only with acceptance |
| `migrations/` | Durable discount-fact storage keyed to the Invoice, with constraints preventing a second conflicting fact row |
| `scripts/bootstrap_stripe.py` | Validate that the account's active Coupons/Promotion Codes match the slice-1 shape (D3) |
| `docs/OPERATIONS.md` | Operational constraint: Dashboard promo inventory must stay within slice-1 shapes; out-of-band coupons remain incident material |
| `web/` | Promo-code aware Checkout copy and account-page display of the applied discount (display only) |
| `docs/` | Convert [Billing invariants §16](INVARIANTS.md) future gates into the operative invariant; update `PLAN_TRANSITIONS.md`, `TESTING.md`, `STRIPE_CLI.md`, [test gates](plans/TEST_GATES_PROMO_UI.md) |

### Must-test matrix

Phase 2 does not merge until every row exists and passes (see also the
[promo future gates](TESTING.md)):

| # | Case | Expectation |
| --- | --- | --- |
| 1 | Parameter-omission and shape regression (today's gate, kept green) | Without the Phase-2 flag, Checkout Session parameters never contain `allow_promotion_codes` and every discount shape is rejected exactly as today |
| 2 | `percent_off` and `amount_off` once-coupon, monthly first purchase | Paid → full catalog credits (D1), gross/discount/net verified, discount facts durable (D6) |
| 3 | Duplicate Event ID on a discounted paid Invoice | Second delivery is a no-op (inbox layer) |
| 4 | Different Event / same business grant on a discounted Invoice | `(stripe_invoice_id, grant_slot)` blocks the second grant |
| 5 | Partial refund before and after paid, on discounted `amount_paid` | Converging cumulative ratio per invariant 4, computed from paid cash (D2) |
| 6 | Full refund/dispute before and after paid, discounted Invoice | Converges to closed funding; `closure_applied` idempotent |
| 7 | Clawback exceeding spendable balance on a discounted grant | `billing_clawback_debts` retains missing units |
| 8 | Zero-due (100%-off) Invoice | Rejected, durable incident (D5) |
| 9 | `repeating`/`forever` coupon renewal Invoice | Rejected fail-closed, retry-safe incident (D3) |
| 10 | Discount drift between preview and paid Invoice, both policies | Symmetric rejection: preview defers, paid fails closed (D4) |
| 11 | Discounted annual Invoice | Rejected fail-closed in slice 1 (D7); the later annual slice must additionally prove 12 full-size slots and paid-ratio slot reduction |
| 12 | Two concurrent workers on one discounted funding Invoice | Real PostgreSQL concurrency: exactly one grant |
| 13 | Real Stripe test mode: create Coupon + Promotion Code, redeem in Checkout, poll `invoice.paid` | Actual payload shape parses; bootstrap inventory validation passes; strict run-scoped cleanup |
| 14 | Browser gate: redeem a promo code in hosted Checkout end to end | Webhook-projected entitlement equals full catalog credits |

## Reference sites: what to borrow

- **Stripe Billing documentation** (Coupons, Promotion Codes, Checkout discounts):
  the normative source for `duration` semantics (`once`/`repeating`/`forever`),
  promotion-code restrictions (`first_time_transaction`, `minimum_amount`,
  `expires_at`, `max_redemptions`), `allow_promotion_codes` behavior on Checkout
  Sessions, and the Invoice `total_discount_amounts` / line `discount_amounts` shapes.
  Two load-bearing facts come from these docs: restrictions live on Coupon and
  Promotion Code objects, not the Session — which is why server-side acceptance is the
  only backstop (D3) — and the slice-1 accepted-shape contract must cite documented
  fields, confirmed by real test-mode fixtures (matrix row 13).
- **Linear** (linear.app pricing): restrained monthly/annual toggle with the annual
  saving stated as a plain price fact and a per-month equivalent — no countdown timers
  or urgency banners. This matches our position that the ~40% annual saving is explicit
  price design, and it is the Phase-1 display model for the pricing page.
- **Resend** (resend.com pricing): clear per-tier included usage (their email volume
  maps to our monthly credits), simple tier comparison, and pricing transparency without
  coupon gimmicks. A good template for keeping promotional copy visually separate from
  billing semantics, which mirrors our cash/entitlement separation.

## Risk register

- **R1 — Early parameter wiring.** Sending `allow_promotion_codes` — even behind a
  default-off flag — before Phase-2 acceptance produces charged-but-not-entitled
  customers and manual repair the moment the flag flips. Mitigation: the Phase-1 hard
  rule, invariant §16, and the parameter-omission regression test.
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
  proof, with a zero refund-ratio denominator. Mitigation: D5 plus matrix row 8.
- **R5 — Renewal-coupon scope creep.** `repeating`/`forever` shapes drifting into the
  slice-1 path without per-cycle facts. Mitigation: D3 plus matrix row 9.
- **R6 — Discount-scaled entitlement.** Any code path sizing credits or annual slots
  from discounted cash. Mitigation: D1/D7 plus matrix rows 2 and 11.
- **R7 — Out-of-band promo inventory.** Once the field is visible, any active
  promotion code in the account is redeemable, and Dashboard-applied coupons outside
  this application remain outside the contract in every phase: fail-closed incident,
  then operator runbook. Mitigation: bootstrap inventory validation, the operations
  constraint, and never treating out-of-contract shapes as slice-1 acceptances.
