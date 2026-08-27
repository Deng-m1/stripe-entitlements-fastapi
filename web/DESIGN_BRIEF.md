# Landing Redesign Brief — "Settlement Field"

Status: approved direction (planning phase — no landing code changed yet).
Scope: `web/` marketing surface only. No billing backend behavior changes.

## 1. One-line direction

A dark "ledger ink" landing page whose single hero visual — a Canvas particle
field where chaotic Stripe webhook events settle into a perfectly ordered
entitlement lattice — dramatizes the product's actual guarantee:
deterministic entitlements out of non-deterministic event streams.

Concept renders (generated, for art direction only, not shipped assets):

- Hero: `landing-hero-concept-settlement-field.png` (agent artifact)
- Matrix section: `landing-upgrade-matrix-section-concept.png` (agent artifact)
- Reviewer note: these renders are NOT present in the repo or on this server.
  They are non-normative mood references; the written spec in this brief is the
  contract. Do not block implementation on locating them.

## 2. Diagnosis of the current landing (`web/app/page.tsx`, `globals.css`)

1. Template look: pale teal-gray wash + white cards + Space Grotesk/IBM Plex is
   indistinguishable from generic SaaS boilerplate; no memorable brand image.
2. No visual anchor: the hero is typography plus a faint animated background
   grid (`.landing-hero-plane::before/::after`); nothing depicts the product.
3. Landing behaves like a dashboard: a full 6-column comparison table
   (`.comparison-table`) and three math tiles (`.savings-grid`) duplicate
   `/pricing` and force reading, not persuasion.
4. The strongest differentiator (complete 6 × 6 upgrade matrix, race-safety
   invariants) is buried in body copy of `capabilities[]` and FAQ answers.
5. The pipeline strip (`.hero-pipeline`) is the right story told too small —
   four gray list items under the fold line.
6. Header/footer are neutral chrome with a 12px gradient square as the only
   mark; `DemoNotice` yellow banner visually outranks the brand.

## 3. Visual system (decided)

### Tokens (replace the light theme on the landing route)

```css
:root[data-theme="ink"] {
  --bg-0: #0b100e;        /* page base: green-black ink, not pure black */
  --bg-1: #111917;        /* raised plane / bands */
  --bg-2: #18231f;        /* cards, matrix panel */
  --line: #223029;        /* hairlines */
  --line-strong: #2f4237;
  --ink: #ecf4ee;         /* primary text */
  --ink-dim: #9dafa4;     /* secondary text */
  --phosphor: #56e39f;    /* settled / entitlement accent */
  --phosphor-dim: #2e7d5b;
  --signal-amber: #e4b65c;/* money figures, period-end states */
  --signal-red: #f26d5f;  /* refund / dispute states */
  --focus: #7ff0bc;
}
```

Usage discipline: phosphor is a thin accent (dots, numerals, one primary CTA),
never large fills; amber only on money/period-end semantics; red only on
refund/dispute semantics. This keeps the palette away from "Matrix" kitsch.

### Type

- Display: Schibsted Grotesk (next/font/google), tight tracking, for h1/h2.
- Body: keep IBM Plex Sans (already loaded — reduces churn, reads technical).
- Mono: add IBM Plex Mono as a loaded font for eyebrows, event IDs, matrix
  labels, all tabular figures (`font-variant-numeric: tabular-nums`).
- Space Grotesk is retired.

### Composition

Single full-bleed hero plane (~88vh): headline block left, settlement field
filling the plane; no floating badges, no stacked cards, no screenshot frames.
Below the fold, sections alternate `--bg-0` / `--bg-1` bands separated by
hairlines, editorial one-column headings with content right or below.

## 4. Motion / rendering tech (decided)

- Hero: hand-rolled Canvas 2D particle system (`HeroSettlementCanvas.tsx`,
  client component, zero dependencies, target < 8 KB min+gz).
  Not three.js / react-three-fiber / OGL: the composition is flat 2D; three.js
  costs ~150 KB+ gz and measurable TTI on mid-range mobile for no gain here.
- Reviewer ruling (WebGL vs Canvas, final): Canvas 2D upheld. At ≤ ~220 flat
  particles WebGL adds shader boilerplate, context-loss handling, and driver
  blocklist failures that would require a Canvas fallback anyway — double the
  code for zero visual gain. The "premium" glow WebGL implies is achieved in
  Canvas via a pre-rendered radial-gradient sprite (offscreen canvas) drawn
  with `globalCompositeOperation: "lighter"` additive blending. Revisit only
  if the design later demands > 2,000 particles or per-pixel post-processing.
- Behavior: particles spawn left with jitter in mixed hues (a few duplicate
  "ghost pairs" merge at the gate), cross a hairline "event inbox" gate, then
  snap to lattice rows that accumulate on the right.
- Performance budget: cap DPR at 2; ~220 particles desktop / ~90 mobile
  (viewport-width based); rAF paused via IntersectionObserver when offscreen
  and on `document.visibilitychange`.
- Accessibility/degradation: canvas is `aria-hidden`; headline is real text so
  LCP is unaffected; `prefers-reduced-motion: reduce` renders one static
  settled frame (single draw, no loop); no-JS gets the plain dark hero.
- Scroll reveals: CSS class toggled by one IntersectionObserver; existing
  global reduced-motion kill-switch in `globals.css` already covers it.

## 5. Information architecture (top to bottom)

Each section has exactly one job; copy skeleton is the contract:

1. Hero — the claim. H1: "Billing events are chaos. Your entitlements aren't."
   Support: "An open-source Stripe billing reference for FastAPI, PostgreSQL,
   and Next.js that turns noisy webhook streams into deterministic access."
   CTAs: "Explore the live demo" (phosphor) / "View the source" (ghost).
   SEO tradeoff (reviewer-decided): the slogan H1 drops the keyword-rich
   current H1. Accepted ONLY under these compensations, which are binding:
   the support paragraph keeps the full phrase "Stripe billing reference for
   FastAPI, PostgreSQL, and Next.js" verbatim; at least one section h2 below
   the fold contains "Stripe billing"; metadata titles/description and JSON-LD
   stay keyword-rich and untouched; `seo.test.tsx` asserts the keyword-bearing
   support paragraph (not only the slogan H1) so the keyword surface cannot
   silently regress.
2. Pipeline band — how (kept content, restaged). The four existing steps as a
   full-width mono strip: signature → inbox claim → one transaction →
   projected entitlement.
3. Invariants — why trust it. Reframe `capabilities[]` as "Guarantees, not
   features": numbered invariants with mono indices (race-safe webhooks,
   idempotent grants, refund/dispute convergence, real Stripe test gates).
4. Upgrade matrix — the differentiator. "All 36 plan transitions, defined."
   Static 6 × 6 CSS grid (server-rendered), legend: immediate / period-end /
   no-op; one highlighted cell shows a `prorated_delta` tooltip.
5. Catalog teaser — what it costs. Three compact tiles (plan, price, credits,
   annual saving) + link to `/pricing`. The full comparison table moves out of
   the landing; the `<table>` itself is kept in DOM (visually restyled) only if
   we choose to preserve current SEO assertions — decision: keep a slim table,
   restyled dark, to retain the tabular SEO surface.
6. Test gates — proof. Terminal-styled strip listing real gates: Checkout,
   decline, 3DS, signed webhook, Test Clock renewal, UI projection.
   Kitsch guard: same accent discipline as the hero — no full-green text
   blocks, no blinking cursor, no scanline effects; mono type + one phosphor
   status dot per line is the ceiling.
7. FAQ — objections + JSON-LD (content unchanged, dark restyle).
8. Final CTA + footer — repo link, license, "reference UI only" note.

## 6. File plan

- `web/app/globals.css` — token system + dark landing styles (largest diff).
- `web/app/page.tsx` — section restructure per IA above; JSON-LD kept.
- `web/components/HeroSettlementCanvas.tsx` — new client component.
- `web/components/UpgradeMatrix.tsx` — new, server-renderable.
- `web/components/SiteHeader.tsx` — token-aware chrome (transparent over ink
  on `/`, solid on app routes); `DemoNotice` restyled subordinate to brand.
- Theme scoping mechanism (reviewer-decided): header/footer live outside the
  landing wrapper in `layout.tsx`, so a wrapper-level `data-theme` cannot
  style them. Use `body:has(.landing-page)` selectors in `globals.css` to
  re-chrome header/footer/demo-notice on `/` (supported by all browsers this
  project targets); keep `SiteHeader` a server component — no `usePathname`
  client conversion. Dark-theme `:focus-visible` must switch to the `--focus`
  token inside the ink scope (the global teal outline is invisible on ink).
- `web/app/icon.svg`, `opengraph-image.tsx`, `twitter-image.tsx` — re-skin to
  ink/phosphor after the landing lands.
- `/pricing`, `/account`, `/billing/*` keep the light app theme this phase;
  they inherit accent tokens only.
- No new npm dependencies.

## 7. Test impact (must be updated in lockstep)

- `web/app/seo.test.tsx` asserts the current H1 ("Race-safe Stripe billing…"),
  the comparison table name, and copy fragments — update assertions to the new
  copy skeleton in the same commit; keep SoftwareApplication + FAQPage graph.
  Note: `featureList` in the JSON-LD derives from `capabilities[].title`;
  when reframing capabilities as guarantees, keep those titles keyword-
  meaningful (they are indexed structured data, not just UI copy).
- `web/promo/ui-tour.spec.ts` asserts EXACT heading copy (H1 and three h2s),
  not just selectors — every renamed heading breaks the promo tour and must be
  updated in the same commit as `page.tsx`.
- Canvas determinism in captures: Playwright's `animations: "disabled"`
  screenshot option does NOT stop a rAF canvas loop. The promo spec (and any
  screenshot test crossing the hero) must call
  `page.emulateMedia({ reducedMotion: "reduce" })` so the hero renders the
  static settled frame and captures stay reproducible.
- `npm run lint`, `typecheck`, `vitest` must pass; no backend tests touched.
- Workspace hygiene: the checkout currently carries unrelated uncommitted
  diffs (`web/lib/mock-api*`, `web/lib/runtime.ts`, `web/next.config.mjs`,
  `web/lib/next-config.test.mjs`). Landing commits must not absorb them; keep
  them out of every redesign commit.

## 8. Risks and mitigations

- Canvas jank on low-end mobile → particle cap by viewport, DPR clamp,
  offscreen pause; worst case ships the static settled frame permanently.
- Dark-theme contrast → all text pairs checked to WCAG AA (ink-dim on bg-0 is
  ~7:1; phosphor reserved for non-text accents and large CTA text).
- SEO regression → metadata, JSON-LD, robots/sitemap fail-closed logic remain
  untouched; copy changes mirrored into `seo.test.tsx`.
- Mixed theme (dark landing / light app) → mediated by tokenized header and a
  shared accent family; revisit app-screen dark skin as a later phase.

## 9. Not doing (explicitly)

- No purple/white gradients, cream+serif+terracotta, newspaper grids, default
  Inter/Roboto, hero badge chips, or floating card stacks.
- No three.js / r3f / OGL / GSAP / Framer Motion dependencies.
- No full comparison-table dashboard on the landing (slim SEO table only).
- No changes to FastAPI backend, webhook logic, catalog data, or tests outside
  `web/`.
- No dark re-skin of `/account` and `/pricing` interactive screens this phase.

## 10. Implementation order

1. Tokens + fonts in `globals.css` / `layout.tsx` (behind `data-theme="ink"`
   on the landing wrapper), header/footer/demo-notice re-chrome.
2. Landing section restructure in `page.tsx` + static styles; update
   `seo.test.tsx` in the same commit.
3. `UpgradeMatrix.tsx` static grid + legend.
4. `HeroSettlementCanvas.tsx` with reduced-motion static frame; perf pass
   (DPR clamp, pause hooks) before merge.
5. OG/twitter/icon re-skin; promo tour re-check; lint/typecheck/vitest green.
