# Promo UI test and review gates

This checklist is the minimum evidence for promotional UI changes. Phase 1 is the
network-free pull-request gate. Phase 2 is the browser, Stripe test-mode, and publication
gate. A checked Phase 1 item must not be reported as Phase 2 evidence.

## Policy boundary

- `allow_promotion_codes` is prohibited as a standalone Checkout option. Checkout
  Session creation must omit the parameter unconditionally; a configurable default-off
  switch is not acceptable.
- Any discounted Invoice fails closed, including a discount object whose computed amount
  is zero. No entitlement is granted for that Invoice.
- Phase 1 does not test or claim the happy path for enabling promo collection. That
  journey remains out of scope until coupon support has an explicit funding policy.

## Phase 1: deterministic pull-request gate

### Required matrix

| Invariant | Mandatory cases | Blocking assertion | Gate |
| --- | --- | --- | --- |
| Unsupported Invoice adjustments | Invoice and line discount objects, including `amount=0`; Invoice and line tax objects, including `amount=0`; automatic tax; non-zero starting/ending balance, credit-note amounts, and overpayment | Every participating shape returns `True`; explicit empty lists, disabled automatic tax, and integer zero balance fields return `False` | `uv run pytest tests/test_invoice_policy.py -q` plus existing processor and gateway tests |
| Transition policy | All 3 tiers × 2 cadences as source and target, under both `full_period_reset` and `prorated_delta` | The complete 72-case matrix remains explicit; same plan/cadence is `noop`, annual-origin and lower-tier changes defer, and only policy-supported upgrades are immediate | `uv run pytest tests/test_primitives.py -q` |
| Public pricing | Starter, Pro, and Ultra; monthly/yearly toggle; annual total, monthly equivalent, and savings; cross-currency or non-discounted annual price | Displayed values come from the reference catalog and no savings claim is invented | `npm --prefix web test -- --run lib/money.test.ts components/BillingScreens.test.tsx` |
| Scope honesty | Landing heading, plan table, FAQ/JSON-LD, and pricing copy | Visible copy says coupons are not claimed; it must not imply support for coupons, trials, tax, multi-currency, or seats | Existing `web/app/seo.test.tsx`; extend it only when the claim moves or changes |
| Billing state | Checkout, immediate preview, period-end preview, failed payment/recovery, and webhook-projected account state | Client responses never grant entitlement; target state appears only after account polling observes backend projection | `web/components/BillingScreens.test.tsx` and `web/lib/mock-api.test.ts` |
| Safety and accessibility | Sanitized provider/network errors, same-origin redirects, secret-free browser environment, dialog Escape/focus restoration, semantic headings/buttons/tables | No secret or provider detail reaches rendered output; keyboard and role-based interactions remain usable | Web unit suite, lint, typecheck, and production build |

### Phase 1 review checklist

- [ ] Review the diff for unsupported-product claims, hard-coded prices, and client-side
      entitlement authority.
- [ ] Run the focused Invoice policy test and the existing discount/tax/balance processor
      and gateway cases.
- [ ] Run `uv run pytest -m "not real_stripe"` when backend fixtures, parsing, or shared
      test infrastructure changed.
- [ ] In `web/`, run `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, and
      `npm run build` when UI, copy, catalog data, or test configuration changed.
- [ ] Run `git diff --check` and confirm generated recordings, traces, identifiers, and
      credentials are absent from Git.

## Phase 2: browser and publication gate

### Required execution matrix

| Mode | Required journey | Required evidence | Must not be claimed |
| --- | --- | --- | --- |
| Local mock promo | Landing → capabilities → catalog → FAQ → monthly/yearly pricing → preview acknowledgement → account/entitlements | `scripts/run_promo_ui.sh` passes; all 10 named screenshots, `timeline.json`, and a 1440 × 810 video are present and visually reviewed | Stripe network, signed webhook, or real entitlement evidence |
| Real `full_period_reset` | Declined Checkout → 3DS Checkout → Starter/300 projection → full-period Pro preview/apply → Pro/1,000 projection | Endpoint-mode `scripts/run_browser_e2e.sh` passes with exact Event/Invoice lineage, no unresolved incident, and strict cleanup | Prorated-delta behavior or live-mode behavior |
| Real `prorated_delta` | Declined Checkout → 3DS Checkout → Starter/300 projection → `+700` delta preview/apply → Pro/1,000 projection | Endpoint-mode browser gate passes with source/target/net settlement binding, signed delivery, no unresolved incident, and strict cleanup | Full-period behavior or live-mode behavior |
| Responsive/manual | Landing, pricing table/toggle, preview dialog, recovery action, and account state at 1440 × 810 and a narrow mobile viewport | No clipping, hidden action, unreadable copy, focus loss, or layout overlap; screenshots are reviewed | Automated accessibility conformance unless a dedicated audit ran |
| Final promotional cut | Public mock footage plus reviewed Stripe test-mode footage only | `scripts/build_promo_video.sh` and `scripts/review_promo_video.sh` pass; inspect all 15 scenes, payment masks, test-mode badge, transitions, audio, and final URL | Production payment, current release, or endpoint evidence unless separately recorded and verified |

Run both real policies explicitly with an isolated Stripe test account and a temporary,
version-pinned endpoint:

```bash
E2E_TRANSITION_POLICY=full_period_reset scripts/run_browser_e2e.sh
E2E_TRANSITION_POLICY=prorated_delta scripts/run_browser_e2e.sh
```

### Phase 2 review checklist

- [ ] Record the request API version, signed endpoint payload version, Event API retrieval
      view, Stripe library version, PostgreSQL version, transport, and cleanup result as
      separate evidence fields.
- [ ] Confirm every public coupon/tax/trial/currency statement matches the fail-closed
      Invoice policy; zero-valued adjustment objects remain unsupported.
- [ ] Review desktop and narrow-layout captures rather than inferring responsiveness from
      a production build.
- [ ] Keep Checkout recordings, traces, customer/Event/Invoice IDs, test email addresses,
      and recovery manifests private and outside Git history.
- [ ] Treat Stripe CLI forwarding as signed-transport evidence only, never as endpoint
      metadata or API-version pinning evidence.
- [ ] Mark any unexecuted browser, real Stripe, responsive, privacy, or publication item
      as **not run** with a reason; do not inherit results from an older release or video.
