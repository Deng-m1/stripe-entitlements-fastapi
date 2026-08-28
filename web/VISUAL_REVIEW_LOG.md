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

---

## Round 3 — WebGL hero landing — 2026-08-28

- Stream: WebGL hero implementation
- Reviewed at: branch `cursor/landing-settlement-field`, isolated worktree,
  `next build` + `next start` (production, not dev — the fallback handover and
  the dynamically imported renderer chunk both behave differently under the
  dev overlay)
- Screenshots: `/tmp/hero-webgl-v1/` — `{desktop-1440,laptop-1024,mobile-390}`
  plus `desktop-1440-late` (phase stability) and
  `desktop-1440-reduced-motion` (poster path), each as full page and hero crop,
  with `report.json` recording per-viewport `drawn` / canvas count / renderer
- Renderer under review: `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device
  (Subzero)), SwiftShader driver)` — software rasterisation, so the frame
  timings here say nothing about a GPU-backed visitor

### Fixed this round

1. **Neither end of the brand ramp reached the screen.** The palette ramp was
   spread across the whole sheet while the alpha term dissolved its outer
   band, so violet and lemon landed inside the dissolved margins and the hero
   rendered as a magenta-to-coral wash. Ramp re-origined onto the window that
   survives the dissolve.
2. **The sheet drew its own outline.** Rim light peaks on silhouettes, which
   reads as glow over a dark canvas and as a drawn edge over paper; combined
   with a narrow trough window it put a ruled diagonal across the hero at
   1024 px. Rim reduced, edge and trough falloffs widened.
3. **The 390 px wave was a corner smudge.** The stacked breakpoint inherited a
   mask whose job is to clear a headline column that does not exist in a
   stacked layout; it multiplied with the shader's own left dissolve. The band
   now keeps a lateral gradient that never reaches full transparency.
4. **The baked poster contained page content.** The capture took a locator
   screenshot of a layer whose negative insets overhang the section below, so
   the following section's copy and cards were baked into the fallback every
   visitor on the poster path saw. The capture now isolates the layer.

### Verified green

- WebGL context, animation, and both degradation paths are gated by
  `promo/hero-webgl.spec.ts` (`scripts/run_hero_webgl.sh`), not by eye.
- Reduced-motion poster and live render are visually interchangeable at
  1440 px, which is the point of baking the poster from the renderer itself.

### Known gaps

- `THREE.Clock` deprecation warning originates inside `@react-three/fiber`;
  nothing in this repo constructs it.
- Frame cost is unmeasured on real GPUs. `PerformanceMonitor` drops DPR on
  decline, but no budget has been asserted against hardware.
- P1-5 (hero headline rag at 1440 px) is still open and now unblocked.

---

## Round 4 — visual review round 2, production build — 2026-08-28

- Reviewer: fable 5 (visual review lead, round 2)
- Baseline reviewed: commit `69e0941` (branch `cursor/landing-settlement-field`,
  Round 3 hero merged), isolated worktree
- Preview: `next build` + `next start` (production). The config boundary
  correctly refuses `NEXT_PUBLIC_BILLING_API_MODE=mock` in a production build,
  so the production preview runs in `http` mode: `/` and the hero are fully
  representative, while `/pricing`, `/account`, and `/billing/success` render
  their unconfigured-API states. Hydrated billing states were re-verified on a
  second worktree under `next dev` + mock on another port.
- Screenshots: `/tmp/visual-review/round3/` — `prod/` (baseline, production,
  now including `/billing/success`), `mock/` (hydrated dev screens),
  `hero-v2`…`hero-v5` (iteration trail), `hero-final/` + `prod-v6/` (after
  this round's fixes), `reference/` (live `stripe.com/zh-us` captures at 1440
  and 390, taken this round for side-by-side reading)

### Issues

#### P0

1. **The WebGL hero read as a page-filling fog, not a ribbon.** Live render
   confirmed (every rig viewport reports `drawn=true`), but the composition
   failed against the zh-us reference: crest/trough alpha modulation was 40%
   deep over a very wide window, so the sheet painted the whole hero — the
   headline column, the CTA row, and the band under the event pills all sat on
   a pastel wash, and saturated ramp colours at 10–40% alpha over warm paper
   grey out into a dirty mauve. Stripe's band is the opposite: crisp curved
   silhouettes, bare canvas between crests, colour only on the crests.
   Evidence: `round3/prod/landing-desktop-first-viewport.png` vs
   `round3/reference/stripe-zh-us-1440.png`.
   **Fixed this round — in the shader, not the report:** fold-driven alpha is
   now the silhouette owner (`uTroughFade` 0.4 → 0.97 with a short
   `smoothstep(0.14, 0.52)` window on the fold field), crest alpha raised,
   specular sharpened (0.36/58 → 0.52/92), ramp window retuned
   (origin/scale 0.34/2.15 → 0.3/1.75), fold count 2.4 → 3.1 so the visible
   window keeps two–three bands after the overscale below.
2. **The sheet's rectangle border drew a ruled diagonal at 1440 px.** The
   Round 3 wide-uv-fade recipe hid the border only while the whole sheet was
   foggy; any crisp crest crossing the border terminates in a straight line.
   Overscale now pushes every border a crest can cross out of the layer
   (wide-viewport scale 1.34 → 1.66), and the uv fades shrink to a safety
   net. Verified: no ruled edge at 1440/1024/390 in `hero-final/`.
3. **`/pricing` mobile panned 42 px again — regression class of Round 1 P0-2,
   new culprit.** The unconfigured-API `.inline-error` banner (long
   unbreakable `NEXT_PUBLIC_BILLING_API_BASE_URL.` token + non-wrapping flex
   row) propagated min-content past the 390 px viewport; `/billing/success`
   overflowed 3 px the same way. Round 1's rig never saw it because mock mode
   shows no banner — the production preview is what exposed it.
   **Fixed:** `flex-wrap: wrap` + `overflow-wrap: anywhere` on
   `.inline-error`. All four routes now report 0 px at 390 px (probe:
   `scripts/overflow-probe.mjs`).

#### P1

4. **Headline lockup shattered into five lines on laptop widths.** Below
   ~1080 px the §2.2 display clamp outruns the narrowed headline column and
   strands “Your” on its own line (`round3/hero/laptop-1024-hero.png`). The
   1440 px four-line lockup (successor of Round 1 P1-5 “chaos.” rag; the
   two-block `.h1-line` split landed with the hero stream) is deliberate and
   reads well — only the laptop range was broken.
   **Fixed:** a 851–1080 px hold-back on `.hero-copy h1`
   (`clamp(2.5rem, 1.1rem + 3.1vw, 3.5rem)`), documented as a §2.2 amendment
   in `DESIGN_SYSTEM.md`.
5. **Poster/live drift.** The baked posters still showed the Round 3 fog
   composition; after the shader rework the reduced-motion path and the live
   render disagreed about what the hero even is. **Fixed:** posters rebaked
   from the final shader (`scripts/build-hero-wave-poster.mjs`); the
   reduced-motion capture in `hero-final/` is compositionally interchangeable
   with the live frame.
6. **The stacked (≤850 px) hero was a muddy backdrop behind the whole copy
   block.** The mobile mask never reached full transparency (a Round 3 guard
   against the corner-smudge failure that fold-driven alpha has since
   retired), so a half-alpha crest sat behind the headline and support copy as
   a grey-lavender stain and body contrast suffered. **Fixed:** the stacked
   band now hugs the top-right corner (height 64% → 52%, mask reaches full
   transparency on the left), matching Stripe's stacked composition.

#### P2

7. **Hero WebGL gate raced its own poster fade.** The handover assertion read
   `opacity` once, mid-900ms-transition, and failed on a fast machine.
   **Fixed:** retrying `toHaveCSS("opacity", "0")`; all four gates green
   against the production build.
8. **Demo banner cost at 390 px (Round 1 P2-7) and `/account` credits-card
   void (P2-8): open here, owned elsewhere.** Both surfaces
   (`DemoNotice.tsx`, `AccountScreen.tsx`, sitewide tokens) are mid-rewrite in
   the parallel white-canvas/iris restyle stream that was uncommitted in the
   shared checkout during this round; patching them here would only
   manufacture conflicts. Handed over with evidence:
   `round3/mock/landing-mobile-first-viewport.png` (banner ≈ 4 lines),
   `round3/mock/account-desktop-full.png` (void between balance and facts).
9. **Terminal body type at 390 px (Round 1 P2-10):** re-checked on the
   production build; 0.68rem mono is legible on a 2× phone frame
   (`round3/prod/landing-mobile-full.png`). Closing unless the restyle stream
   changes the terminal.

### Verified green this round

- Hero: `drawn=true` at 1440/1024/390, all four `hero-webgl.spec.ts` gates
  pass against `next start`; left column and CTA row sit on bare canvas at
  1440; band silhouettes follow fold curves at every viewport; phase drift
  across a 9-second gap keeps one colour identity
  (`hero-final/desktop-1440-late-hero.png`).
- 0 px horizontal overflow at 390 px on `/`, `/pricing`, `/account`, and
  `/billing/success` in production `http` mode (worst historical mode for
  overflow, since every banner renders).
- Unit suite 139/139, ESLint and `tsc --noEmit` clean on the reviewed tree.
- `/billing/success` desktop composition (centered card, status chips,
  actions) holds in both the polling-timeout state (production, no API) and
  the settled mock state.

### Open items carried forward

- P2-8 credits-card balance void and P2-7 banner height — explicitly handed
  to the in-flight sitewide restyle stream (with the note that the restyle
  should re-run `scripts/visual-review-pages.mjs` + `overflow-probe.mjs`,
  since this round proved the production `http` states catch regressions the
  mock rig cannot).
- Real-GPU frame budget for the hero remains unasserted (inherited from
  Round 3).
- The reviewed tree predates the parallel restyle; once that stream lands,
  the hero ribbon must be re-read against the new white canvas — the trough
  dissolve currently melts into warm paper `#faf6ef`, and pure white will
  slightly raise the band's apparent contrast.

---

## Round 5 — settlement moment (/billing/success, /billing/error) — 2026-08-28

- Stream: billing-route settlement redesign (fable 5)
- Reviewed at: commit `ea1086b` (branch `cursor/landing-settlement-field`),
  isolated worktrees — `next build` + `next start` on one port (production,
  http mode: honest failure states) and `next dev` + mock on another
  (hydrated polling/confirmed states)
- Screenshots: `/tmp/billing-v2/` — 14 shots via the new
  `scripts/billing-shots.mjs` rig covering every reachable screen state:
  `error-{payment-failed,payment-canceled,authentication-failed,fallback}`,
  `success-{invalid,timedout-banner,polling,timedout,confirmed}` at
  1440×900 and 390×844

### What changed

1. **Both billing returns now sit on one M5 settlement band.** A full-bleed
   gradient band over the new `--band-deep: #0f0a2e` token (§3.5 — violet
   radial top-left, pink radial bottom-right, faint orange glint; never flat
   black) frames a single white settlement card (≤ 640px) with a blurred
   mesh gradient shadow base under it (§4.3). Pure CSS — the §5.4
   zero-heavy-JS clause holds; no canvas, no new client JS.
2. **Status chips carry the semantics.** Mono-caps chip on the card:
   `Webhook verified` (`--success`) only after the projection is confirmed;
   `Awaiting webhook`/`Unconfirmed` (`--warning`) while polling or timed
   out; `Unverifiable`/`No state change` (`--danger`) for invalid returns
   and stopped billing actions. The old mark misfiled timed-out as danger —
   a timed-out poll is pending, not failed (§3.4).
3. **The celebratory element is earned, not assumed.** The §5.4 mesh-ramp
   medallion (conic ring, white core, `--success` check) renders only in the
   webhook-confirmed state; the bare redirect keeps a neutral mark.
4. **CTA grammar per §5.4:** one filled primary (`View account` /
   `Review account`) + one outline secondary (`Back to pricing`); a
   timed-out return promotes the safe retry (`Check account state again`)
   to the primary slot.
5. **Display hold-back documented:** the card H1 uses
   `clamp(2.05rem, 1.6rem + 1.9vw, 2.85rem)`; the unmoderated §2.2 clamp
   shatters a status sentence inside the 640px card. Logged as a §5.4
   amendment in `DESIGN_SYSTEM.md` together with the band framing, chip
   semantics, and the accent-token note (CTAs bind to `--accent`, so the
   routes inherit iris automatically when the §3.3 migration lands).

### Verified green

- 0 px horizontal overflow at 390 px on all six probe routes against the
  production build in http mode (worst historical mode — every banner
  renders), including the two `/billing/error` routes newly added to
  `scripts/overflow-probe.mjs`; every `billing-shots.mjs` capture also
  reports 0 px at both widths.
- Computed-style probes on the running build: band shows the layered
  violet/pink gradient over `#0f0a2e`; card is a centered 640px white plane;
  medallion is the conic mesh ring with `--success` check; chips resolve to
  the semantic token pairs; error card at 390px is 358px wide with the H1 on
  two lines.
- Unit suite 139/139, ESLint, `tsc --noEmit` clean; SuccessScreen behavior
  (polling, idempotency-key completion, restart) untouched — all existing
  headings and copy asserted by `BillingScreens.test.tsx` unchanged.

### Open items

- The settlement band should be re-read against the white-canvas/iris
  restyle when that stream lands — the band gradient already samples the
  mesh ramp, but the card CTAs will flip from settlement orange to iris via
  the shared token.
- `visual-review-pages.mjs` now includes `/billing/error?code=payment_failed`
  so future full-site rounds cover both settlement routes.

---

## Round 6 — /account P2 closure — 2026-08-28

- Stream: account page optimization (fable 5)
- Landed: `b5d13f1` + `0401d0f` (branch `cursor/landing-settlement-field`);
  scope was `AccountScreen.tsx` + `globals.css` only — no billing behavior,
  API, or polling changes
- Screenshots: `/tmp/account-v2/` — full `visual-review-pages.mjs` run at
  1440 px and 390 px from an isolated worktree at the branch tip
  (`next dev` + mock; the shared checkout carried another stream's
  uncommitted work and was not used as evidence)

### What changed

1. **Credits-card void (Round 1 P2-8) closed.** The card is now a flex
   column: stat block up top (display-scale balance with a mono-caps
   `credits` unit and an honest webhook-projection caption), a grant meter
   in the middle, and the fact rows pinned to the bottom edge, so the card
   composes at full grid height next to the denser subscription card. The
   meter is data, not decoration — `balance / grant_amount` as a
   settlement-orange fill on a paper track, echoing the landing chart's
   data-stroke rule; it renders only when a grant exists.
2. **Entitlement tiles (Round 1 P2-9) re-textured.** Flat `--surface-soft`
   boxes became the landing's node-card grammar: raised paper, thin border,
   quiet border-color hover. Boolean values render as mint/cream square-dot
   chips (the ledger-table chip grammar), numeric values as mono
   `tabular-nums` figures, and the raw entitlement key closes each tile as
   a dashed-rule receipt footer pinned to the tile bottom.
3. **Heading hierarchy per DESIGN_SYSTEM §5.3/§2.2.** The page title drops
   from the sitewide H1 display clamp to the H2 scale
   (`clamp(1.9rem, 1.5rem + 1.8vw, 2.75rem)`) with the route's single brand
   signal — a 3px × 64px mesh-ramp rule — under it. Card titles drop to the
   H3 scale (plan name holds 1.75rem to anchor against the credit figure);
   pending-banner titles tightened to 1.3rem.
4. **Fact lists read as ledger lines.** Each `dt/dd` row is a flex line:
   mono-caps key left, right-aligned mono figure right, hairline rules
   between rows (opening rule in `--line`). Wrapped values keep hugging the
   right edge via `margin-left: auto` (`0401d0f`).
5. **Status unified on the ledger chip.** `active`/`Enforceable` are mint
   square-dot chips, `past_due`/`Paused` cream, unknown states plain
   bordered — same grammar as the landing ledger's applied/absorbed chips.
   Manage-card actions reordered to landing CTA priority (primary first)
   and left-aligned; the projection-loaded line became mono microcopy.

### Verified green

- 0 px horizontal overflow at 390 px on all six probe routes from the
  branch-tip worktree run; account hydrates and settles at both widths.
- Unit suite 139/139, ESLint, `tsc --noEmit` clean on the clean tree; all
  existing `AccountScreen.test.tsx` assertions (headings, empty states,
  past-due copy, pending-change flow) pass unchanged.

### Process note

Two commits from this stream (`b5d13f1`, `0401d0f`) were cut from the
shared checkout while parallel streams held uncommitted work there, and
each swept some of that work in early (the `--band-deep`/settlement styles
later owned by `ea1086b`, and pricing-route CSS later owned by `e6e2468`).
Nothing was lost — both owners' follow-up commits subsumed their work and
the tip is coherent — but future rounds should cut commits from an
isolated worktree, as this round's evidence run already does.

### Open items

- Re-read /account against the white-canvas/iris restyle when it lands:
  the grant meter and title rule bind to `--accent`/`--gradient-accent`,
  so they follow the token flip automatically, but mint/cream chip
  contrast should be re-checked on pure white.

---

## Round 7 — site chrome on the white canvas — 2026-08-28

- Stream: chrome/token unification (fable 5)
- Baseline: branch tip after Round 6 (`b05033e`), isolated worktree — per
  Round 6's process note, no commit was cut from the shared checkout
- Preview: production `next build` + `next start` for the header states
  (hero renderer and poster handover differ under the dev overlay);
  mock-mode `next dev` for the demo notice, which production `http` builds
  never render
- Screenshots: `/tmp/chrome-v2/` — `prod-{desktop-1440,mobile-390}-{top,
  scrolled}[-header].png` (header transparent-over-hero vs white-blur bar)
  and `mock-{desktop-1440,mobile-390}-demo-notice.png`

### Landed this round

1. **Paper tokens retired sitewide.** `:root` now carries the
   DESIGN_SYSTEM.md §3 white-canvas system — navy ink, iris interactive
   accent, retuned chip family, §4.3 layered shadows, §4.1 spacing scale —
   with the old names (`--paper`, `--accent`, `--line`, …) kept as aliases
   so every parallel stream's selectors resolve into the new palette. The
   dotted-grid body texture is gone; settlement orange survives only as
   `--data-orange` in the ledger chart and the matrix-highlight cell.
2. **Chrome coordinated with the WebGL hero.** The header rests transparent
   on the opening viewport and gains a `saturate(160%) blur(14px)` white
   bar once scrolled (verified: `rgba(255, 255, 255, 0.82)` + flag at both
   widths); the brand mark and nav underline speak in the mesh ramp.
3. **Round 1 P2-7 closed.** The demo notice is a single-line pill — 29px
   body, 0px overflow at 390px (was ≈4 lines) — with the trailing
   production-rejection clause visually dropped below 860px but intact in
   the accessibility tree (`DemoNotice.tsx` adopted from the polish
   stream verbatim).
4. **Type unified per §2.1.** Instrument Sans carries display and body
   (Bricolage Grotesque retired), IBM Plex Mono replaces Spline Sans Mono;
   `--font-display-stack`/`--font-body-stack` remain as aliases of
   `--font-sans-stack`, so no selector changed.
5. **Manifest, favicon, and social card re-skinned** to white + iris/mesh
   in the same change as the tokens (§6), adopted verbatim from the polish
   stream so the eventual merge is byte-identical.

### Verified green

- `scripts/pages-polish-assert.mjs` (retargeted at the white canvas and
  the §2.1 fonts): 30/30 PASS across `/`, `/pricing`, `/account` — fonts
  loaded and applied, white canvas, grid retired, header transparent at
  top and white-blur on scroll, 0px overflow, gradient hero accent and 8
  terminal lines intact.
- Unit suite 139/139, ESLint, `tsc --noEmit` clean after rebasing over the
  Round 5/6 and pricing-scorecard commits.

### Open items

- The hero ribbon must be re-read against pure white (inherited from
  Round 4): the trough dissolve was tuned for warm paper. Owned by the
  hero-v2 stream; no shader file was touched here.
- The terminal window and proof band now sit on `--band-deep` flat fills
  via the `--band-ink` alias; the gradient-over-band treatment (§3.5)
  stays with the polish stream's landing rework.
- The two dark-object foreground palettes (warm whites `#e8efe9`,
  `#f0e2c8` in the terminal; `243, 246, 243` in the proof band) read fine
  over the indigo base but should be retuned when those bands are redone.

---

## Round 8 — scroll motion (§3.2): hero drift + sitewide progress — 2026-08-28

- Reviewer/implementer: fable 5 (scroll-motion owner)
- Reviewed against: production `next start` builds of this branch before
  (`fa69bc9`) and after (`b3ac861` + the in-flight depth-composite diff)
- Evidence: `/tmp/scroll-motion-v2/{before,after}/` — a scroll-through
  screen recording (`scroll-through-{before,after}.webm`), hero frames at
  scrollY 0/260/520/780, per-section low/high poses, and machine-readable
  computed-transform probes (`parallax-probe.json`,
  `reduced-motion-probe.json`) captured by the new
  `scripts/scroll-motion-shots.mjs` rig.

### What landed

- **Two scroll-progress contracts, one sitewide driver.** `ScrollMotion`
  (mounted once in the root layout) owns `[data-parallax]` →
  `--scroll-progress` (view cover range, 0.5 = centered pose) and
  `[data-scroll-drift]` → `--scroll-exit` (leave-through-the-top range).
  Browsers with CSS scroll timelines animate both properties natively
  (registered `@property` + `animation-timeline: view()`); everywhere else
  the component is the brief-sanctioned small polyfill — a rAF-synced
  scroll listener writing the same variables from offsetTop chains (layout
  boxes, so the driven transforms cannot feed back into measurement).
  `ScrollReveal` keeps the IntersectionObserver entry reveals and its own
  px-valued `[data-depth]` layer shifts; the attribute namespaces are
  deliberately disjoint.
- **Hero gradient responds to scroll (§3.2 bullet 3).** The `.hero-wave`
  wrapper — canvas and poster together, the shader untouched — drifts
  down-right and thins on `--scroll-exit`; the terminal artifact floats
  ahead on `--scroll-progress`. Probe on the after build (native timeline
  path, Chromium): wave translate (0,0) → (26.3, 86.3)px with opacity
  1 → 0.68 across scrollY 0 → 780; terminal +2.5px → −18px over the same
  travel. Before build: `transform: none`, opacity 1 at every offset.
- **≥2 distinct parallax rates in the artifact sections (§3.2 bullet 2),**
  from the depth-composite stream's `[data-depth]` layers, verified moving
  in the same probe: ledger glow −9.9px vs ledger card stack +14.3px
  (opposite directions), matrix glow −8.1px vs stack +12.8px, proof
  popover +14.2px against a static proof table.

### Reduced motion / degradation

- `prefers-reduced-motion: reduce` probe at scrollY 0 and 520: every
  scroll-driven transform reads `none`; the only non-none transforms are
  the static §3.3 perspective poses (ledger/matrix card tilts) and the
  popover's own `-50%` centering, byte-identical at both offsets — the
  page is fully static. Both drivers also stand down (JS bails, consumer
  CSS sits behind `no-preference`), and a mid-session flip clears every
  inline variable (unit-tested).
- No-JS legacy browsers hold the zero-offset pose through the registered
  initial values (0.5 cover / 0 exit).

### Gates run this round

- `vitest` 147/147 (8 new `ScrollMotion.test.tsx` cases: cover/exit math,
  clamping, native-support and reduced-motion inertness, mid-session
  flips, MutationObserver pickup of late-mounted consumers, unmount
  cleanup), ESLint and `tsc --noEmit` clean.
- `overflow-probe.mjs`: 0px horizontal overflow on all six routes at
  390px against the after build.
- `hero-webgl.spec.ts`: 5/6 pass. The failing one — headline lockup
  ≤4 lines at 1440px — is **independent of this round**: removing
  `data-scroll-drift`/`data-parallax` from the live DOM leaves the H1 at
  6 lines in an unchanged 539px column. Owned by the hero-lockup stream;
  also expected to shift again when the remote type-unification commits
  (Instrument Sans display) integrate.

### Open items carried forward

- The branch carried three concurrent streams (this one, the local
  hero/depth stream, and a remote chrome/type stream); they converge in
  the merge that lands this round, and the post-merge gate results are
  recorded in that merge commit. The lockup gate should be re-read on the
  merged head by the hero-lockup stream.
- `scroll-motion-shots.mjs` probes `.ledger-stage-glow`/`.matrix-stack`
  and friends by class; if the depth-composite stream renames its layers,
  update the probe list in the same commit.

## Round 9 — landing sections (§3.2 reveals + §3.3 depth composites) — 2026-08-28

- Reviewer/implementer: fable 5 (landing sections owner; the
  "depth-composite stream" referenced by Round 8)
- Scope: every landing section except the hero — ledger, pipeline node
  graph, upgrade matrix, proof band, catalog, FAQ. Hero shader files
  untouched (owned by the hero stream). No copy changes, so
  `seo.test.tsx` and the promo specs needed no sync.
- Evidence: `/tmp/landing-sections-v2/` — desktop/mobile/reduced-motion
  section shots from `visual-review-shots.mjs`, plus
  `motion/parallax-shifts.json` and per-section frame sequences from the
  new `scripts/landing-sections-shots.mjs` rig.

### What landed

- **Staggered entry reveals (§3.2 bullet 1).** `ScrollReveal` now supports
  `data-reveal="group"`: the section's IntersectionObserver hit cascades
  its `.reveal-item` children on `--stagger × 80ms` delays
  (`reveal-rise`: 24px lift + fade). Applied to the node-graph cards and
  connectors, capability grid, proof gates, catalog tiles/table, and FAQ
  items; ledger steps keep their own nth-child cascade.
- **Section-scoped parallax (§3.2 bullet 2).** A rAF-synced scroll
  listener in `ScrollReveal` writes px-valued `--parallax-shift` to
  `[data-depth]` layers (desktop ≥851px only; namespace disjoint from
  Round 8's `[data-parallax]`). Recorded at three scroll stops per
  section in `parallax-shifts.json`: ledger glow (depth −18) +12.6px →
  −0px → negative while the card stack (depth +26) runs −18.2px → +0px →
  positive — opposite directions at distinct rates; same pattern for the
  matrix stage and proof popover.
- **Depth composites (§3.3).** Ledger and matrix white cards float on
  `--shadow-float` over blurred `stage-glow` radial underlays with faded
  `stage-ghost` silhouettes and static perspective tilts. The pipeline
  node graph moved from paper onto a full-bleed violet/pink gradient band
  (`.pipeline-band`, layered radials over `--band-deep`) with the white
  node cards on layered shadows — the brief's "white product UI over a
  gradient band" MUST; the no-op node goes glassy
  (backdrop-filter + translucent white).
- **Design-system alignment.** Eyebrow spec (0.75rem / 500 / 0.14em, mesh
  gradient dash), H2 clamp scale + section ledes, 4px `--space-N` tokens
  for band/stage rhythm, iris accent tokens for links, catalog-tile H3
  and FAQ-summary H4 scales, hover float on tiles.

### Caught in this round's screenshot review

- **P1, fixed:** node-card titles on the gradient band were nearly
  invisible — the white cards inherited `.pipeline-band`'s light
  `#f6f5ff` text. `.pipeline-band .node-card` now resets `color:
  var(--ink)`; the glassy no-op override still wins in cascade order.
  Verified in the re-shot `desktop-nodegraph.png`.

### Reduced motion / degradation

- Reveal and parallax both stand down under
  `prefers-reduced-motion: reduce` (JS bails; `js-reveal` gating keeps
  no-JS content visible); `reduced-motion-{hero,ledger}.png` show the
  static pose. Parallax is inert below 851px — mobile shots show the
  resting composite.

### Gates run this round

- ESLint and `tsc --noEmit` clean; vitest 147/147.
- `landing-responsive.spec.ts` green (390px containment, reduced
  motion); re-shoot after the node-card fix reports 0px mobile
  horizontal overflow.

### Open items carried forward

- `ScrollReveal`'s `[data-depth]` writer and Round 8's `ScrollMotion`
  are deliberately separate drivers today; if a future round merges
  them, keep the px (`--parallax-shift`) vs progress
  (`--scroll-progress`) contracts distinct.
- The pipeline band's light-on-dark text pairs live in `globals.css`
  under `.pipeline-band`; any future recolor of the mesh ramp should
  re-check the band's eyebrow/lede contrast.

---

## Round 10 — /pricing product page — 2026-08-28

- Stream: pricing product page (fable 5); ran in parallel with rounds
  8–9 from the chrome-round tip and merged here (renumbered from its
  original "Round 8" to keep the log's numbering unique)
- Baseline: the rebuild itself landed as `e6e2468` (cut before the canvas
  flip); this round's evidence run is from an isolated worktree at the
  chrome-round tip (`301e3f9`)
- Preview: production `next build` + `next start`; the catalog renders
  from the reference fallback, so the pink API-not-configured banner in
  the captures is a property of the shot environment, not the page
- Screenshots: `/tmp/pricing-v2/` — `pricing-desktop-{monthly,yearly}-full`,
  `pricing-desktop-{viewport,compare}`, `pricing-mobile-full`,
  `pricing-mobile-compare-panned`, and `landing-desktop-viewport` for the
  shared display-token comparison (`.png`, tip build)

### Landed this round

1. **/pricing reads as a product page, not a documentation table**
   (`e6e2468`). A full-bleed hero band opens the route: the slim mesh-ramp
   ribbon (one crisp band plus its blurred glow, masked before the
   headline baseline), the display-token H1 with one gradient phrase
   clipped to the warm two-thirds of the ramp, the interval toggle with a
   savings pill, and a mono-caps guarantee strip. The route wrapper
   collapses the shared page padding so the ribbon opens at the very top
   even in loading and error states.
2. **The featured tier earns its elevation.** Pro carries a mesh gradient
   border, the `--shadow-float` layered shadow over a blurred gradient
   underlay (§4.3), a navy `Recommended` pill riding the card edge, and on
   desktop stands a step taller than its neighbours (the plain cards drop
   26px). Price lockups lead with the display face on proportional lining
   figures; the interval rides the baseline in the mono voice.
3. **The comparison table scans on phones.** Sunken row stripes, the
   featured column tinted with an accent top bar, and — below 850px — the
   row-header column pinned with opaque paint so every panned value keeps
   its label; the wrapper pans while the document keeps 0px overflow.
4. **Regression: the canvas flip truncated `globals.css`.** `ec81911`
   committed the file cut mid-declaration at `.pricing-page .price-row >
   span { color: var(--muted` — the final 179 lines (price-lockup tail,
   compare-plans styles, closing CTA, both pricing breakpoints) were gone
   from four commits of history while builds stayed green, because CSS
   parsers silently drop an unterminated final rule. Restored here on the
   white-canvas tokens: everything was already token-routed and follows
   the new palette automatically; the one literal — the featured column
   tint — moved from settlement orange to iris
   (`rgba(91, 76, 245, 0.05)`).

### Verified green

- `scripts/pricing-assert.mjs` 10/10 PASS against the tip production
  build: pricing H1 sharing the landing display token (68px both), ribbon
  present with the mesh band, featured card floating on a two-layer shadow
  the plain cards lack, blurred gradient base, accent phrase clipping a
  gradient, the flag on Pro, mobile row headers sticky over a pannable
  wrapper with opaque paint, even-row stripe distinct from odd, and 0px
  document overflow at 390px.
- Unit suite 139/139, ESLint, `tsc --noEmit` clean at the tip plus this
  restoration.
- Desktop and panned-mobile captures re-read after the flip: iris featured
  column and CTA, mesh ribbon and accent phrase over pure white.

### Process note

The truncation survived four rounds because nothing asserts the file's
tail. `pricing-assert.mjs` now pins the rules that vanished (stripes,
sticky column, CTA-adjacent layout), and its checks bind to token
relationships — shared scales, layer counts, stripe contrast — rather
than literal palette values, so it survives theme flips like
paper → white-canvas. Worth considering: a stylelint pass in CI would
have caught the unterminated rule at commit time.

### Open items

- The evidence captures carry the API-not-configured banner (no backend
  in the shot environment). A mock-mode capture like the chrome round's
  demo-notice run would show the resolved account CTAs instead.
- The yearly-interval captures show the per-plan savings pill from the
  catalog's explicit annual price; if the catalog ever drops a yearly
  price, the toggle hides the pill silently — no visual guard asserts
  that state.

---

## Round 11 — visual review round 4, ten-round merge head — 2026-08-28

- Reviewer: fable 5 (visual review lead, round 4)
- Baseline reviewed: merge `4faf9b9` (branch `cursor/landing-settlement-field`)
  — the head that converges rounds 5–10 (settlement band, account closure,
  white-canvas chrome/type, scroll motion, landing sections, pricing product
  page) plus the hero shading rework — in an isolated worktree
- Preview: `next build` + `next start` (production, `http` mode: honest
  unconfigured-API states) on one port; `next dev` + mock on another for the
  hydrated pricing/account/success states — the Round 4 protocol
- Screenshots: `.review/round4/` in the review worktree (evidence pointers,
  regenerable from any commit) — `prod/` and `prod2/` (before/after this
  round's fixes; five routes × 1440/390 × first-viewport/full/bottom),
  `mock/` (hydrated states), `hero/` + `hero2/` (hero rig with
  `report.json`, before/after), `sections/` (landing section motion frames),
  `slices/` (390px full-page cuts)

### Issues

#### P1

1. **Poster/live drift, third recurrence (class of Round 3 №4, Round 4 №5).**
   The four poster assets were last baked at `fc7ae2b` (the crest-band
   shader); the hero rework `46051b9` changed shading, palette and phase
   without rebaking, so every reduced-motion / no-WebGL / pre-hydration
   visitor saw the previous shader generation — including a saturated
   magenta band bleeding behind the transparent header that the live render
   never paints there (the nav links sat on hot pink), and a composition
   the animated canvas immediately contradicts on the poster→canvas fade.
   Evidence: `hero/desktop-1440-reduced-motion-hero.png` (stale) vs
   `hero/desktop-1440-late-hero.png` (live).
   **Fixed: all four assets rebaked** from the merged shader via
   `scripts/build-hero-wave-poster.mjs`; `hero2/…-reduced-motion-hero.png`
   is again compositionally interchangeable with the live frame. Process
   note: the bake belongs in any commit that retunes the shader — this is
   the third round to relearn that.
2. **`/pricing` at 390px: the ribbon's pill cap surfaced as a clipped dark
   blob and the eyebrow sat in the band's glow.** `left/right: -14%` is
   ~−55px at 390px — less than the pill's 84px cap radius — so the rounded
   end cap entered the frame as a hard-clipped magenta shape on the left
   edge, and the stacked four-line headline pushes the mono eyebrow up
   against the crisp band edge and its 0.38-alpha glow (muted gray on
   pink/orange, under 3:1). Evidence:
   `prod/pricing-mobile-first-viewport.png`.
   **Fixed in the ≤850px block:** caps pulled to −34%, band slimmed and
   lifted (132px tall at top −70px), glow raised and dimmed to 0.32, and
   the ≤560px hero padding moved 80→88px for first-line headroom. Desktop
   geometry untouched (`prod2/pricing-desktop-first-viewport.png`
   byte-comparable); verified at 390px in
   `prod2/pricing-mobile-first-viewport.png` — caps off-frame, eyebrow on
   white.
3. **The 1440px lockup gate failed on the merged head — a measurement bug,
   not a rendering regression.** `hero-webgl.spec.ts` counted heading lines
   with `Range.getClientRects()` over the whole H1; that range also returns
   the border boxes of the two block-level `.h1-line` spans. The type
   unification's new metrics separated those container tops from their
   first line fragment's top (fragment tops 208/279/349/420 at 1440×810,
   container tops 215/356), so the rounded-top count jumped 4 → 6 while
   the rendered lockup stayed the intended four lines — every 1440px
   capture this round concurs. **Fixed:** the counter now walks text nodes
   and counts only line fragments; the full gate is 6/6 against the
   production build.

#### P2 (noted, not fixed here)

4. Two price grammars, one product: the landing catalog cards set `$19.00`
   in wide mono while `/pricing` leads with the display face on
   proportional figures (Round 10 №2). The catalog cards should adopt the
   pricing lockup, or `DESIGN_SYSTEM.md` should state the mono-ledger
   rationale explicitly.
5. In unconfigured-API production `http` mode the pricing plan CTAs sit at
   "Loading account…" forever while the inline banner above them already
   reports the failure; the CTAs could settle into that error state. A
   demo-rig-only state — invisible in any configured deployment.
6. The hero terminal's third transcript line rags "late" onto its own line
   at 1024px (`hero2/laptop-1024-hero.png`).
7. The wordmark wraps to two lines at 390px and costs the header ~24px
   (`prod2/landing-mobile-first-viewport.png`).

### Verified green on the merged head

- Rounds 5–10 claims re-verified against the production build: one design
  system on all five routes (white canvas, Instrument Sans + IBM Plex Mono,
  iris accents), single-line demo notice at 390px (mock), account
  two-column workspace with the credits meter (Round 1 P2-8 stays closed),
  settlement band on both billing returns with correct chip semantics
  (timeout reads as pending, confirmed earns the medallion), pricing
  product page with hydrated CTA states (`Current plan` pinned on Starter,
  preview CTAs live), ledger/matrix/proof composites with staggered
  reveals and opposed parallax rates.
- Hero: `drawn=true` with exactly one canvas at 1440/1024/390;
  reduced-motion mounts no canvas; after the rebake the poster path
  matches the live composition; full `scripts/run_hero_webgl.sh` gate 6/6
  against the production build.
- 0px horizontal overflow at 390px on all six probe routes
  (`overflow-probe.mjs`, production `http` mode — every banner renders) —
  measured both before and after this round's CSS fix.
- vitest 147/147; ESLint and `tsc --noEmit` clean.

### Open items carried forward

- Real-GPU frame budget for the hero remains unasserted (inherited from
  Round 3; every rig in this log renders on SwiftShader).
- P2 №4–7 above; the price-grammar unification and the CTA loading state
  are natural first items for the next polish stream.
- Poster staleness has now bitten three rounds; if a future round touches
  the shader again, consider asserting poster freshness (for example a
  bake stamp committed beside the shader) instead of relying on review to
  catch the drift.
