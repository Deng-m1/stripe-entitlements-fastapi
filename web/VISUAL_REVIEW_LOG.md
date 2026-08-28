# Visual Review Log — landing / pricing / account

Iterative visual QA against the "engineering ledger paper" brief
(`DESIGN_BRIEF.md`) and the Stripe polish gap analysis
(`STRIPE_VISUAL_ANALYSIS.md`). Each round: mock-mode preview → 1440 px and
390 px screenshots of `/`, `/pricing`, `/account` → prioritized issue list →
small fixes land in the same round, structural work is handed to the owning
implementation stream.

Screenshot rig: `scripts/visual-review-shots.mjs` (landing sections) and
`scripts/visual-review-pages.mjs` (all three pages, both widths). Screenshots
are written to `/tmp` on the review machine and are regenerable from any
commit; paths below are evidence pointers, not repo artifacts.

---

## Round 1 — 2026-08-28

- Reviewer: fable 5 (visual review lead)
- Baseline reviewed: commit `ae53f74` (branch `cursor/landing-settlement-field`),
  isolated worktree, `next dev` mock mode
- Screenshots: `/tmp/visual-review/round1-baseline/` (true baseline) and
  `/tmp/visual-review/round2/` (after this round's fixes),
  15 shots per round: `{landing,pricing,account}-{desktop,mobile}-{first-viewport,full,bottom}`
- Note: the WebGL hero rework was in flight during this round; the hero was
  reviewed as committed at `ae53f74` and the gap list below does not wait on it.

### Environment finding (blocked the review itself)

**Dev preview opened via `127.0.0.1` never hydrates.** Next.js 16 blocks
cross-origin requests to dev resources and treats `127.0.0.1` as a different
origin than `localhost`. The page serves SSR HTML and loads every chunk with
zero console/page errors, but React effects never run and clicks are silently
dead. Symptoms that had been misread as product bugs: `/account` stuck on the
"Loading account state…" spinner forever, every pricing CTA disabled at
"Loading account…", interval toggle inert. Production builds are unaffected.

Fixed this round: `allowedDevOrigins: ["127.0.0.1"]` in `next.config.mjs`
(dev-only setting). Review tooling should still prefer `http://localhost:<port>`.
Any prior visual/UX assessment made through a `127.0.0.1` dev preview should be
considered contaminated by this and re-verified.

### Issues

#### P0

1. **Design-system fracture between landing and billing surfaces.** `/` is the
   brief's warm ledger paper (off-white canvas, dotted grid, near-black ink,
   settlement-orange accent, thin-bordered cards). `/pricing` and `/account`
   are a different product: cool blue-gray canvas, teal/navy accents, soft
   drop-shadow cards, no grid, no orange anywhere. Navigating landing → pricing
   reads as leaving the site. The landing's own "Three tiers" section renders
   the same catalog in paper style, which makes the mismatch obvious.
   Evidence: `round1-baseline/landing-desktop-full.png` vs
   `round1-baseline/pricing-desktop-full.png`, `account-desktop-full.png`.
   **Status: resolved in parallel** — the design-token stream landed
   `ce40159` ("promote paper tokens sitewide") during this round. Merged with
   this round's fixes and re-verified: `/pricing` and `/account` now sit on
   the warm paper canvas with settlement-orange accents and mono eyebrows,
   coherent with the landing. Evidence: `/tmp/visual-review/round2-merged/`.
2. **`/pricing` mobile pans 154 px of dead canvas.** The 640 px comparison
   table propagated layout overflow to the document even though its wrapper
   scrolls (`overflow-x: auto` on a static-positioned wrapper). Whole page
   became horizontally pannable at 390 px.
   Evidence: `round1-baseline/pricing-mobile-full.png` (table cut at right
   edge), rig output `pricing mobile horizontal overflow px: 154`.
   **Status: fixed this round** — `position: relative` on
   `.comparison-table-wrap` (scoped in `PricingScreen.tsx` local styles).
   Round 2 rig reports 0 px overflow on all three pages.
3. *(environment)* The hydration/`127.0.0.1` finding above — fixed this round.

#### P1

4. **Price typography rendered "$19 . 00".** `.price-block strong` sets
   `font-variant-numeric: tabular-nums`; Schibsted Grotesk gives the decimal
   point a full digit advance, so every price shows a floating period. The
   money moment is the weakest type on the page — the opposite of Stripe.
   Evidence: `round1-baseline/pricing-desktop-first-viewport.png`.
   **Status: fixed this round** — proportional figures for the display price
   (scoped override); the comparison table keeps tabular-nums for column scans.
   Round 2: `$19.00 / $49.00 / $149.00` render tight.
5. **Hero headline rag at 1440 px.** "Billing events are / chaos." leaves
   "chaos." as a near-widow and the left column has a large dead zone under
   the CTAs before the proof chips. `text-wrap: balance` on the hero h1 plus a
   tighter max-width would fix it. **Status: open — hero markup/styles
   (`app/page.tsx`, `globals.css`) are owned by the in-flight WebGL hero
   stream this round; re-review after it lands.**
6. **Billing surfaces have no premium depth layer.** Flat white cards +
   default-looking shadows on `/pricing` and `/account`; no gradient, texture,
   or layered artifact anywhere (see `STRIPE_VISUAL_ANALYSIS.md` A2/A4).
   Absorbed into the P0-1 token work. **Status: open.**

#### P2

7. **DEMO ONLY banner costs ~3 lines at 390 px** and pushes the hero fold down
   (`round1-baseline/landing-mobile-first-viewport.png`). Consider a one-line
   compact variant on small screens. **Status: open.**
8. **`/account` credits card is sparse at 1440 px** — large empty region under
   "214 available credits" while the left card is dense; grid could rebalance
   or the card could take the entitlement chips. **Status: open.**
9. **Entitlement chips on `/account` are flat gray boxes** — reads unfinished
   next to the landing's bordered paper cards; will be covered by P0-1 token
   unification. **Status: open.**
10. **Hero terminal body type is small at 390 px**
    (`round1-baseline/landing-mobile-full.png`); verify legibility after the
    WebGL hero replaces/reframes the terminal. **Status: open / re-check.**

### What was verified green in Round 1

- Landing at both widths: coherent paper direction, zero horizontal overflow,
  FAQ/footer clean, reveal states all fire after settle-scroll.
- `/account` (once hydrated): correct mock projection (Starter, 214 credits,
  enforceable entitlements), sane hierarchy at both widths.
- `/pricing` interval toggle, plan CTAs, and mock account gating all work once
  hydration works; "Current plan" correctly pins the Starter card.

### Round 2 verification (same day)

`/tmp/visual-review/round2/`: price typography tight, 0 px mobile overflow on
all three pages, pricing/account fully hydrated with live CTAs via both
`localhost` and `127.0.0.1`.

Post-merge verification (`/tmp/visual-review/round2-merged/`, after merging
the parallel `ce40159` paper-token restyle): landing, pricing, and account now
share one design system; this round's price-figure and table-overflow fixes
survive the restyle; overflow still 0 px at 390 px on all three pages.

Open items carried to the next round: P1-5 hero rag (re-check after the WebGL
hero lands), P2-7 demo banner height on mobile, P2-8 sparse credits card,
P2-10 terminal legibility at 390 px.
