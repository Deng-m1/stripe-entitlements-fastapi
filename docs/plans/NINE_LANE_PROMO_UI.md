# Nine-lane plan: Stripe promo UI expansion

Committed English summary of the nine parallel work orders on integration branch
`cursor/stripe-promo-ui-expand-7789` (base `9620941`): promotional presentation,
branding, and a safe phased path toward Stripe Coupons and Promotion Codes, without
weakening any [billing invariant](../INVARIANTS.md).

Authoritative companions:

- dispatch record with worktree mechanics and the file-ownership map:
  [promo-ui-expansion-9-lane-plan.md](promo-ui-expansion-9-lane-plan.md);
- policy contract and Phase-2 decisions:
  [Promotion codes and coupons](../PROMOTION_CODES.md);
- evidence gates: [Promo UI test and review gates](TEST_GATES_PROMO_UI.md) and the
  [promo future gates](../TESTING.md);
- invariant: [Billing invariants §16](../INVARIANTS.md).

## Binding override decision (2026-08-26)

After a read-only review, the integration branch ships **no enableable Checkout promo
collection in Phase 1**:

- `allow_promotion_codes` is never sent to Checkout Session creation, not even behind a
  default-off feature flag; `tests/test_checkout_promo_prohibition.py` enforces the
  omission.
- `has_unsupported_invoice_adjustments` is not widened before durable promo
  authorization, gross/discount/net Invoice verification, fixed catalog credits, and
  the complete refund/out-of-order/concurrency matrix ship atomically (Phase 2).
- The original Lane D idea of "default-off flag + restricted acceptance" is downgraded
  to an explicit later wave; no lane may wire the parameter early.

Scope anchor: today every discount shape on an Invoice fails closed, and the ~40%
annual saving is explicit yearly pricing in `plans.toml`, not a Coupon.

## Lane summaries

| Lane | Wave | Title | Primary scope | Depends on |
| --- | --- | --- | --- | --- |
| A | 1 | Read-only current-state review | Audit of Checkout/invoice-policy/processor call sites; shared facts for all lanes | — |
| B | 1 | Brand and landing visuals | `web/app/globals.css`, `page.tsx`, `layout.tsx` | — |
| C | 1 | Pricing/Account experience | `web/components/*.tsx`, `BillingScreens.test.tsx`, `web/lib/types.ts` | — |
| D | 1 | Promo Phase-1 minimal safe slice | `src/*.py` prohibition surfaces, `docs/INVARIANTS.md`, `docs/PROMOTION_CODES.md` | — |
| E | 1 | Promo Phase-2 design | Phase-2 half of `docs/PROMOTION_CODES.md`, future design notes under `docs/plans/` | — |
| F | 2 | Promo config surface and catalog support | `app.py`, `catalog.py`, `scripts/bootstrap_stripe.py` | D |
| H | 2 | Backend test hardening | New files under `tests/` | D (uses A's report) |
| I | 2 | Frontend regression and E2E strengthening | Web test files, `web/lib/mock-api.ts`, e2e selectors | B, C |
| G | 3 | Docs and invariant consistency refresh | README/FAQ/SEO claims, cross-doc consistency | D, F, B |

### Lane A — Read-only current-state review (Wave 1)

Goal: establish the shared facts every other lane builds on — where
`create_checkout_session` builds Session parameters, the three fail-closed call sites
of `has_unsupported_invoice_adjustments` (preview facts, first-purchase paid path,
delta settlement path), and why parameter-only enablement equals
charged-but-not-entitled. Output: the survey section of the dispatch record and the
override decision above. No code.

### Lane B — Brand and landing visuals (Wave 1)

Goal: landing rebrand (display type, hero, savings tiles) in `web/app/` only. Display
only: the annual-saving claim keeps the same-currency / strictly-lower guard and never
controls tier direction or transition timing; copy must not imply coupon support.
Done when: web lint/typecheck/tests/build pass and the catalog-drift test still proves
the public JSON matches `plans.toml`.

### Lane C — Pricing/Account experience (Wave 1)

Goal: pricing and account screen refinement in `web/components/` with new CSS-Module
files (the shared `globals.css` belongs to Lane B). Client responses never grant
entitlement; target state appears only after polling observes backend projection.
Done when: the web suite passes, including the billing-screen and money display tests.

### Lane D — Promo Phase-1 minimal safe slice (Wave 1)

Goal (as overridden): document and enforce the no-collection posture instead of wiring
a flag. Landed: the gateway invariant comment at the parameter site, the `.env.example`
explanation of why no flag exists, `tests/test_checkout_promo_prohibition.py`,
[Billing invariants §16](../INVARIANTS.md), and the Phase-1 half of
[Promotion codes and coupons](../PROMOTION_CODES.md) with its hard rule.
Done when: the parameter-omission regression is green and the docs state the
prohibition posture unambiguously.

### Lane E — Promo Phase-2 design (Wave 1)

Goal: fix the Phase-2 contract before any implementation lane starts — attribution
decisions D1–D7 (catalog credits never scale with discounts; refund ratios use the
discounted `amount_paid`; slice-1 `duration=once` monthly first-purchase scope;
plan-change paths stay discount-free; zero-due rejected; durable transactional
discount facts; annual out of slice 1), the accepted Invoice shape, the module change
list, and the 14-row must-test matrix in
[Promotion codes and coupons](../PROMOTION_CODES.md).
Done when: merged and referenced by Lanes F/H/I as their contract.

### Lane F — Promo config surface and catalog support (Wave 2)

Goal: configuration and bootstrap groundwork that does not widen acceptance — health
and config exposure, `scripts/bootstrap_stripe.py` validation of the account's
Coupon/Promotion Code inventory against the slice-1 shape. No `allow_promotion_codes`
wiring; that parameter lands only atomically with Phase-2 acceptance.
Depends on: Lane D. Done when: backend gates pass and the prohibition test stays green.

### Lane G — Docs and invariant consistency refresh (Wave 3)

Goal: final consistency pass once Wave-2 lanes land — README/FAQ/SEO/JSON-LD "no
coupons" claims refreshed without overclaiming, cross-links between
[Promotion codes and coupons](../PROMOTION_CODES.md),
[Billing invariants §16](../INVARIANTS.md), [Testing](../TESTING.md), and
[test gates](TEST_GATES_PROMO_UI.md) verified, this plan updated with outcomes.
Depends on: D, F, B. Done when: no doc contradicts the shipped behavior and
`git diff --check` passes.

### Lane H — Backend test hardening (Wave 2)

Goal: new tests only — zero-valued discount/tax shape rejection in
`tests/test_invoice_policy.py`, processor and gateway discount cases, the complete
72-case transition matrix kept explicit, and the Phase-1 review checklist rows in
[test gates](TEST_GATES_PROMO_UI.md).
Depends on: Lane D. Done when: `uv run pytest -m "not real_stripe"` passes without
weakening concurrency tests.

### Lane I — Frontend regression and E2E strengthening (Wave 2)

Goal: web regression tests, mock-API coverage, and e2e selector hardening for the
rebranded screens; the scripted promo UI recording
(`scripts/run_promo_ui.sh`) stays a mock-only journey per the evidence boundary in
[test gates](TEST_GATES_PROMO_UI.md).
Depends on: Lanes B and C. Done when: the web suite and the promo recording gate pass.

## Execution order

1. **Wave 1 — A, B, C, D, E in parallel**, isolated by the file-ownership map in the
   dispatch record so no two lanes touch one hot file. A's review feeds the override
   decision; D and E fix the policy contract before any Phase-2 code exists.
2. **Merge Wave 1**, then **Wave 2 — F, H, I in parallel**: F and H depend on D's
   contract; I depends on B/C's shipped UI.
3. **Merge Wave 2**, then **Wave 3 — G** as the final consistency refresh over the
   merged result.

The eventual Phase-2 implementation (flag + restricted acceptance + migrations + full
matrix, one merge unit) is intentionally **not** one of these nine lanes; it starts
only from the Lane D/E contract after this plan completes.

## Hard gates

- No `allow_promotion_codes` on Checkout Session creation, even behind a default-off
  flag, while [Billing invariants §16](../INVARIANTS.md) stands; the omission test must
  stay green in every lane.
- No widening of `has_unsupported_invoice_adjustments` outside the atomic Phase-2 merge
  unit defined in [Promotion codes and coupons](../PROMOTION_CODES.md).
- Catalog credits never scale with discounts, in any lane, in any phase.
- No lane may weaken the symmetric preview/paid discount-drift rejection in
  `full_period_reset` and `prorated_delta`.
