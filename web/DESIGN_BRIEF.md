# Marketing Surface Redesign Brief — "Stripe-Grade Gradient Field" (v3)

Status: approved direction, v3. This brief SUPERSEDES the v2 "Engineering
Ledger Paper" brief and, before it, the v1 "Settlement Field" direction. It
also supersedes the constraint set in `STRIPE_VISUAL_ANALYSIS.md` Part C
wherever that document assumes a no-Three.js rule.

Scope: `web/` marketing and app chrome surface — `/`, `/pricing`, `/account`,
`/billing/success`, `/billing/error`. No billing backend behavior changes.

Binding companions:

- `web/DESIGN_SYSTEM.md` — fonts, heading hierarchy, palette, spacing, and
  per-route visual unification. Normative; an implementation that contradicts
  it fails review.
- `web/STRIPE_MESH_GRADIENT_REVERSE_ENGINEERING.md` (Rev. 2) — the verified
  architecture of Stripe's hero (HeroWave controller + waveGeometry Web
  Worker + palette texture + runtime-injected canvas). The hero in §3.1
  mirrors that architecture.

## 0. Process correction (binding, read first)

The v2 brief (§6/§8) declared "NO WebGL / three.js / r3f / OGL / GSAP" and
called a GPU pipeline "résumé-driven engineering". **That prohibition was
invented by the drafting sub-agent. The user never issued it.** The user has
since stated the opposite, explicitly and as a hard requirement:

> Advanced front-end (WebGL / Three.js class) is **MUST use**, not merely
> allowed. The target is Stripe-level polish — no simplified version.

Consequences, binding on every future revision of this brief:

1. Any clause banning WebGL, Three.js, shaders, workers, or scroll-driven
   animation is void and must not be reintroduced without an explicit user
   instruction quoted verbatim in the revision.
2. The v2 "restraint is the premium signal" argument is retired. The
   benchmark for "premium" is https://stripe.com/zh-us itself, judged by
   side-by-side screenshots (§7), not by minimalism principles.
3. Where v2's Mobbin clauses (M1–M6) conflict with the Stripe benchmark,
   the Stripe benchmark wins. Mobbin references may still inform section
   layout skeletons, but they no longer cap the rendering technology or the
   motion budget.

## 1. One-line direction (decided)

A Stripe-grade landing: a live WebGL mesh-gradient wave behind a pristine
white canvas, a bold single-family grotesque type system, 3D-layered real
product UI composites, and scroll-driven motion throughout — telling the
unchanged product story (out-of-order Stripe events in, deterministic
entitlements out) with the same rendering ambition Stripe applies to its own
homepage. `/pricing`, `/account`, and `/billing/*` inherit the same type
system, palette, and hero temperament so the site reads as one product, not
a landing page stapled to an app.

## 2. Reference contract

- **Primary benchmark: https://stripe.com/zh-us.** Every visual review round
  MUST place fresh screenshots of our build next to fresh screenshots of the
  Stripe zh-us homepage (hero, product-card section, gradient band, footer)
  and judge parity of: gradient quality, type confidence, depth layering,
  and motion feel. "Looks fine in isolation" is not a pass; "holds up next
  to Stripe" is the bar.
- **Implementation reference:** `STRIPE_MESH_GRADIENT_REVERSE_ENGINEERING.md`
  Rev. 2 — verified: Stripe's hero is a Three.js WebGL canvas (runtime
  injected), wave geometry simulated in a Web Worker, colors sampled from a
  palette texture, with a static WEBP `<picture>` as the designed fallback.
  Rev. 1's "pure CSS" claim is retracted; do not build to it.
- **Secondary references:** `STRIPE_VISUAL_ANALYSIS.md` Parts A/B/D remain
  valid gap analysis (gradients, 3D depth, scroll motion). Its Part C
  "hybrid without three.js" plan is superseded by this brief.
- v2's Mobbin URLs (M1–M6) remain in git history for layout archaeology;
  they are no longer acceptance criteria.

## 3. MUST-use technology clauses (hard requirements)

### 3.1 Hero: Three.js + WebGL shader wave — MUST

- The landing hero background MUST be rendered by **Three.js on a WebGL
  canvas** with custom vertex/fragment shaders, mirroring the verified
  Stripe architecture:
  - `HeroWave`-style client controller that injects the `<canvas>` at
    runtime after a WebGL capability check (`aria-hidden` container; canvas
    absent from server HTML);
  - wave height-field geometry simulated in a **Web Worker**
    (`waveGeometry.worker.ts`), posting transferable `Float32Array` position
    buffers to the main thread;
  - fragment shader coloring via a **palette texture** (1×256 ramp built
    from the design tokens in `DESIGN_SYSTEM.md` §3: violet → pink → orange
    → yellow), not hardcoded per-stop uniforms;
  - rAF loop gated by IntersectionObserver + `visibilitychange`; DPR capped
    at 2; full disposal on unmount.
- A CSS-gradient or static-image hero on the default path is a review-
  blocking defect, equal in severity to a failing test.

### 3.2 Scroll-driven animation and parallax — MUST

- Below-the-fold sections MUST move with scroll, Stripe-style:
  - section entry reveals (fade + translate) driven by scroll position;
  - at least two layers with distinct parallax rates in the product-artifact
    sections (e.g. gradient base at 1.0×, card stack at ~0.85×);
  - the hero gradient responds to scroll (drift/translate as it leaves the
    viewport).
- Implementation may use the CSS scroll-timeline API with polyfill, or a
  rAF-synced scroll listener, or Three.js uniforms driven by scroll —
  whichever fits each section; the requirement is the observable motion, and
  none of these techniques is banned.

### 3.3 3D-layered product UI composites — MUST

- Product artifacts (terminal transcript, `event_inbox` ledger table,
  pipeline node graph, upgrade matrix) MUST be composed in depth, not flat:
  stacked UI layers at offset/scale (front artifact + faded sibling behind),
  perspective tilts (2–4°), and gradient shadow bases (blurred radial
  gradient underlays), matching the Stripe product-card grammar documented
  in `STRIPE_VISUAL_ANALYSIS.md` A2.
- At least one section MUST layer white UI cards over a full-width gradient
  band (Stripe's dashboard-section grammar, A4).

### 3.4 Degradation — MUST have, but MUST NOT become the main path

- Server HTML MUST contain a static WEBP/PNG render of the hero gradient
  (`<picture>` with responsive sources) so first paint, no-JS, and SEO
  never depend on the canvas.
- `prefers-reduced-motion: reduce` MUST suppress the canvas mount and all
  scroll-driven motion, leaving the static fallback and fully readable
  static layouts.
- WebGL-unavailable browsers MUST silently keep the static fallback.
- On capable browsers with default settings, the WebGL canvas MUST be the
  rendered path. A build where the fallback ships as the de facto default
  fails acceptance (§7.1 defines the proof).

### 3.5 Dependency policy

- `three` is a sanctioned dependency (tree-shaken ESM imports; hero module
  lazy-loaded via `next/dynamic` with `ssr: false`).
- Added client JS for the hero + motion system ≤ 220 KB gzip total; hero
  must not block LCP (fallback image is the LCP candidate).
- Animation orchestration libraries (GSAP, Framer Motion, Lenis) are
  permitted where they reduce bespoke code, subject to the same budget —
  they are optional tools, not requirements.

## 4. Visual system

Normative tokens, fonts, heading hierarchy, spacing, and route-by-route
requirements live in `web/DESIGN_SYSTEM.md`. Summary of the deltas from v2:

- Canvas: pristine white (`#ffffff`) content plane floating over the WebGL
  gradient field — the warm "paper" (`#faf6ef`) page tint and dotted-grid
  texture are retired.
- Palette: mesh ramp (violet → pink → orange → yellow) as the brand
  atmosphere; iris violet as the single interactive accent sitewide;
  settlement orange demoted to data-visualization semantics.
- Type: single grotesque family across display and body (see
  `DESIGN_SYSTEM.md` §2 — the IBM Plex Sans body is retired as
  template-feeling), plus mono for code/figures. Gradient text is permitted
  on at most one headline phrase per page.
- Depth: layered shadows + gradient shadow bases replace the v2 "no shadows
  heavier than 2px" rule.

## 5. Information architecture (landing)

The v2 section skeleton survives; every section is re-skinned to the
Stripe benchmark and gains the motion required by §3.2/§3.3:

1. **Hero** — WebGL wave (§3.1) top-right, white canvas left; H1 keeps the
   narrative ("Billing events are chaos. Your entitlements aren't.") with
   ONE gradient-text phrase; support line keeps the verbatim SEO phrase
   "Stripe billing reference for FastAPI, PostgreSQL, and Next.js";
   mono-caps guarantee microcopy; the dark terminal window moves below the
   fold (Stripe shows no product artifact in viewport 1).
2. **Logo/stack strip** — monochrome FastAPI / PostgreSQL / Stripe / Next.js
   marks on white, Stripe logo-bar grammar.
3. **Sources → ledger centerpiece** — jittered webhook events dropping via
   connectors into the ordered `event_inbox` table; the table is a 3D-tilted
   card over a gradient base (§3.3); rows settle with scroll-driven entry.
4. **Pipeline node graph** — white node cards layered over a full-width
   violet gradient band; duplicate-delivery branch ends in "no-op (already
   claimed)".
5. **Upgrade matrix** — the 6×6 plan-transition grid as a depth-composed
   card; gradient glow on the highlighted `prorated_delta` cell.
6. **Proof band** — gradient (not flat black) full-width band: test-gate
   checklist (Checkout, decline, 3DS, signed webhook, Test Clock renewal) +
   white popover card with the single green "consistent" chip.
7. **Catalog teaser + slim SEO table → `/pricing`**; FAQ (content and
   JSON-LD unchanged) restyled to the new system; footer per
   `DESIGN_SYSTEM.md` §5.

## 6. Cross-route scope (this phase, not deferred)

Unlike v2 §8, the app routes are IN scope for visual unification. Headings,
fonts, and hero temperament MUST align across:

- `/` — full treatment per §3/§5.
- `/pricing` — shared type scale and accent; a slim gradient header ribbon
  (static image or low-cost canvas reuse) so the route visibly belongs to
  the landing's world; plan cards adopt the depth grammar.
- `/account` — app chrome: same fonts, same heading hierarchy, iris accent,
  quiet gradient accent line; no heavy motion (it is a workspace).
- `/billing/success`, `/billing/error` — settlement moment: same H1 scale,
  a gradient accent element consistent with the hero palette; success/error
  semantics via the semantic tokens, not new colors.

Per-route specifics are normative in `DESIGN_SYSTEM.md` §5.

## 7. Acceptance clause (binding for implementation PR and visual review)

### 7.1 WebGL proof — the PR must demonstrate it

The implementation PR description MUST include, and CI/e2e MUST enforce:

1. An e2e assertion (default browser profile) that
   `.hero-wave canvas` exists and its context is WebGL — e.g. evaluate
   `!!(c.getContext('webgl2') || c.getContext('webgl'))` — and that the
   canvas has nonzero drawn dimensions.
2. An e2e assertion that with `reducedMotion: "reduce"` and with JavaScript
   disabled, the static `<picture>` fallback renders and NO canvas mounts.
3. Bundle evidence that `three` ships in the hero chunk (build output or
   bundle analyzer excerpt in the PR).
4. A short screen recording or frame-sequence screenshots of the live wave
   and of scroll parallax in motion.

A PR that cannot produce items 1–4 does not merge, regardless of how the
static screenshots look.

### 7.2 Visual review protocol — every round

1. Every review round captures our `/`, `/pricing`, `/account`,
   `/billing/success` at 1440×900 and 390×844, and captures the current
   https://stripe.com/zh-us hero + one product section at the same sizes.
2. Screenshots are reviewed side-by-side. The reviewer scores gradient
   quality, type confidence, depth, and motion (from the recording) against
   the Stripe captures. A route that reads "template" next to Stripe fails.
3. Any deviation from a §3 MUST clause requires updating this brief in the
   same PR with rationale. Silent drift is a review-blocking defect.
4. Reviewer self-check: `grep -in "MUST" web/DESIGN_BRIEF.md` returns the
   §3 clauses; a brief revision that drops them is invalid.

## 8. Test impact (update in lockstep, same commit as the change)

- `web/app/seo.test.tsx`: keep asserting the keyword-bearing support
  paragraph and JSON-LD (SoftwareApplication + FAQPage); the hero fallback
  `<picture>` must be present in server HTML for these tests to remain
  meaningful.
- `web/promo/*` visual specs: captures MUST use
  `page.emulateMedia({ reducedMotion: "reduce" })` so the static fallback
  path keeps captures deterministic; add the §7.1 WebGL-proof spec as a
  separate non-reduced run.
- New unit coverage: palette-texture builder (token → ramp), worker message
  contract (buffer shapes), controller abort paths (no WebGL / reduced
  motion).
- `npm run lint`, `typecheck`, `vitest` green; no backend tests touched.
- Workspace hygiene: the checkout carries unrelated uncommitted diffs
  (`web/lib/mock-api*`, `web/lib/runtime.ts`, `web/next.config.mjs`,
  `web/lib/next-config.test.mjs`). Redesign commits must not absorb them.

## 9. Not doing (explicitly)

- No reintroduction of any WebGL/Three.js ban, in any wording (§0).
- No shipping the static fallback as the default path on capable browsers.
- No warm-paper page tint, dotted-grid texture, or "engineering notebook"
  framing — retired with v2.
- No scanlines, phosphor-green theming, or purple/white "AI template"
  gradient clichés — the palette is the §4 mesh ramp, tuned per
  `DESIGN_SYSTEM.md`, not a stock preset.
- No changes to FastAPI backend, webhook logic, catalog data, or tests
  outside `web/`.
- No copying of Stripe's proprietary assets: no Stripe wordmarks/logos as
  brand, no downloaded stripeassets.com imagery in our repo, no verbatim
  copy. We replicate the *techniques*, we do not clone the brand.

## 10. Implementation order (for the implementing agent)

1. `DESIGN_SYSTEM.md` tokens + fonts into `globals.css` and `layout.tsx`
   (single grotesque family, mesh ramp tokens, spacing scale). Update
   `seo.test.tsx` in the same commit if heading copy shifts.
2. Hero fallback first: server-rendered `<picture>` static WEBP of the
   gradient (generated from the palette tokens), white-canvas hero layout,
   new type scale.
3. `hero-wave/` module: `waveGeometry.worker.ts`, `paletteTexture.ts`,
   `shaders.ts`, `HeroWave.tsx` controller; mount over the fallback; wire
   reduced-motion/no-WebGL aborts. Add the §7.1 e2e proofs in the same PR.
4. Scroll system: entry reveals + parallax layers + hero scroll drift.
5. Section re-skins in §5 order (ledger centerpiece → node graph band →
   matrix → proof band → catalog/FAQ/footer).
6. Route unification per §6: `/pricing` ribbon + cards, `/account` chrome,
   `/billing/*` settlement screens.
7. OG/twitter/icon re-skin to the mesh palette; lint/typecheck/vitest
   green; assemble the §7 proof pack in the PR description.
