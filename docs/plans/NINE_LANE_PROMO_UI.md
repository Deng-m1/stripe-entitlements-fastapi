# Nine-lane plan: Stripe promo UI expansion

This is the ticket breakdown and execution order for expanding the promotional surface
of this reference implementation — pricing presentation, demo material, and an eventual
safe path to Stripe Coupons and Promotion Codes — without weakening any
[billing invariant](../INVARIANTS.md). The phased policy, attribution decisions, and
test matrix that several lanes depend on live in
[Promotion codes and coupons](../PROMOTION_CODES.md).

Scope anchor: today every discount shape on an Invoice fails closed, and the ~40%
annual saving is explicit yearly pricing in `plans.toml`, not a Coupon. On this
integration branch, Phase 1 is **display, docs, and prohibition tests only** — Checkout
Session creation must never send `allow_promotion_codes`, including via a default-off
feature flag (see the parent override in
[promo-ui-expansion-9-lane-plan.md](promo-ui-expansion-9-lane-plan.md)). Lanes that
would accept discounted Invoices are Phase 2 and merge only as a complete unit.

## Lane summaries

| Lane | Phase | Title | Primary files |
| --- | --- | --- | --- |
| A | 1 | Pricing-page promo presentation | `web/app/pricing/`, `web/components/` |
| B | 1 | Promo demo recording refresh | `web/promo/ui-tour.spec.ts`, `scripts/run_promo_ui.sh`, `scripts/build_promo_video.sh` |
| C | 1 | Prohibit Checkout promo-code parameter | `tests/test_checkout_promo_prohibition.py`, `stripe_gateway.py` comments, `.env.example` |
| D | 1 | Promotion-code phase plan | `docs/PROMOTION_CODES.md` |
| E | 1 | Invariant future gates + testing gates | `docs/INVARIANTS.md`, `docs/TESTING.md` |
| F | 2 | Discount-aware Invoice attribution | `src/stripe_entitlements/invoice_policy.py`, `processor.py`, `stripe_gateway.py`, `migrations/` |
| G | 1 | Nine-lane plan and coordination | `docs/plans/NINE_LANE_PROMO_UI.md` |
| H | 2 | Promo test matrix implementation | `tests/` |
| I | 2 | Real-Stripe and browser promo gates | `tests/` (`real_stripe`), `web/e2e/`, release evidence |

Lanes D, E, and G are documentation coordination. Lane C on this branch is the
**prohibition** gate (Session params / Settings must not expose `allow_promotion_codes`),
not a reserved enablement hook.

### Lane A — Pricing-page promo presentation (Phase 1)

Goal: present the annual saving and plan comparison with stronger promotional clarity,
borrowing the restrained Linear/Resend pricing patterns described in
[Promotion codes and coupons](../PROMOTION_CODES.md). Display only: the saving claim
keeps the same-currency / strictly-lower guard, never controls tier direction or
transition timing, and no coupon or urgency language is introduced.
Done when: frontend suite (lint, typecheck, tests, build) passes and the backend
catalog-drift test still proves the public JSON matches `plans.toml`.

### Lane B — Promo demo recording refresh (Phase 1)

Goal: update the scripted UI tour and demo video pipeline to capture the expanded
pricing presentation from Lane A. No billing semantics; evidence boundaries in
[Demo recording](../DEMO_VIDEO.md) stay accurate.
Depends on: Lane A.
Done when: `scripts/run_promo_ui.sh` and `scripts/build_promo_video.sh` produce the
refreshed recording and the review script passes.

### Lane C — Prohibit Checkout promo-code parameter (Phase 1)

Goal: keep Checkout Session creation free of `allow_promotion_codes` at every layer
(no Settings field, no gateway constructor argument, no Session parameter). Document
the charged-but-not-entitled failure mode and enforce it with
`tests/test_checkout_promo_prohibition.py` plus gateway assertions.
Done when: prohibition tests pass, `.env.example` states there is intentionally no
enablement switch, and Ruff/Mypy/pytest pass.

### Lane D — Promotion-code phase plan (Phase 1, this change)

Goal: `docs/PROMOTION_CODES.md` — current fail-closed state, Phase-1 minimal safe
slice, Phase-2 attribution decisions D1–D7 (catalog credits never scale with discounts;
refund ratios use discounted `amount_paid`; slice-1 `duration=once` first-purchase
scope; plan-change paths stay discount-free; zero-due rejected; durable transactional
discount facts; annual slots unchanged), module change list, 14-row must-test matrix,
reference-site borrowing points, and risk register.
Done when: the document is merged and Lanes F/H/I reference it as their contract.

### Lane E — Invariant future gates + testing gates (Phase 1, this change)

Goal: append [Billing invariants §16](../INVARIANTS.md) (“Discounts remain fail-closed
until promo attribution gates pass”) recording the gates a future change must meet,
without weakening invariants 1, 4, or 14; append the
[promo future gates](../TESTING.md) section marking these gates as not-yet-run and
distinct from current release evidence.
Done when: both sections are merged and consistent with Lane D.

### Lane F — Discount-aware Invoice attribution (Phase 2)

Goal: implement the slice-1 accepted shape from Lane D — one `duration=once` coupon on
a Checkout first-purchase Invoice, `amount_paid > 0` — with durable discount facts
committed in the grant transaction and refund ratios computed from paid cash. Plan
changes (`plan_changes.py`) keep rejecting all discounts in both policies; everything
outside the slice keeps today's fail-closed behavior.
Depends on: Lanes C, D, E. Merges only together with Lane H.
Done when: the Lane H matrix passes and §16's gates are converted into the operative
invariant text.

### Lane G — Nine-lane plan and coordination (Phase 1, this change)

Goal: this document — lane map, dependencies, execution order, and hard gates. Keep it
updated as lanes land; a lane whose scope drifts from Lane D's contract must update the
contract first, not diverge silently.
Done when: merged; revisited at each phase boundary.

### Lane H — Promo test matrix implementation (Phase 2)

Goal: implement all 14 rows of the must-test matrix in
[Promotion codes and coupons](../PROMOTION_CODES.md): flag-off regression equivalence,
happy-path once-coupons, duplicate-Event and same-grant guards, refund/dispute
convergence on discounted paid amounts, clawback debt, zero-due and repeating-coupon
rejection, symmetric preview/paid drift rejection for both policies, discounted annual
slots, and real PostgreSQL concurrency on one discounted funding Invoice.
Depends on: Lane F (same PR series; F and H are one merge unit per the definition of
done in `AGENTS.md`).
Done when: rows 1–12 run in the default suite and pass without weakening concurrency
tests.

### Lane I — Real-Stripe and browser promo gates (Phase 2)

Goal: matrix rows 13–14 — a `real_stripe` test-mode lifecycle that creates a Coupon and
Promotion Code, redeems it in hosted Checkout, polls the real `invoice.paid`, verifies
full catalog credits, and cleans up only run-owned objects with a zero-inventory
assertion; plus a browser-gate variant that redeems a promo code end to end. Update
release evidence recording in [Testing](../TESTING.md).
Depends on: Lanes F and H merged.
Done when: both gates pass in test mode and the evidence table records them; only then
may Checkout Session creation be allowed to send `allow_promotion_codes` on a
production path under the Phase-2 contract.

## Execution order

1. **G, D, E** — documentation contract (promotion phase plan, invariant 16, testing
   gates). Must exist before any acceptance code lands.
2. **C** — prohibition tests and comments ensuring Session/Settings never expose
   `allow_promotion_codes` on this branch.
3. **A, then B** — Phase-1 display and demo work, parallel to C. B waits for A's UI.
4. **F + H** — the Phase-2 attribution change and its test matrix as one merge unit,
   gated on the D/E contract.
5. **I** — networked promo gates and release evidence, last, because they prove the
   real payload shapes that F/H assumed.

Parallelism: A/B, C, and D/E/G have no code overlap and can proceed concurrently.
F/H/I are strictly ordered after D/E and must not start from an undocumented contract.

## Hard gates

- Checkout Session creation must not send `allow_promotion_codes` until Lanes F, H,
  and I are complete ([Billing invariants §16](../INVARIANTS.md)).
- No lane may weaken the symmetric preview/paid discount-drift rejection in
  `full_period_reset` and `prorated_delta`.
- Catalog credits never scale with discounts, in any lane, in any phase.
- Phase-2 lanes merge only with their tests (F+H together), per `AGENTS.md`'s
  definition of done.
