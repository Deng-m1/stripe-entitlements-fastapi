# Landing Redesign Brief — "Engineering Ledger Paper"

Status: approved direction, v2. This brief SUPERSEDES the v1 "Settlement
Field" dark-ink/phosphor direction (commits `04eb423`…`aa54ea3`), which was
implemented and rejected in visual review as a generic dark AI-site look.

Scope: `web/` marketing surface only. No billing backend behavior changes.

## 0. Why this brief was rewritten (process correction)

The v1 brief cited two concept renders that were never committed to the repo
and contained **zero** verifiable design references. Implementation therefore
had nothing concrete to match against, and review had nothing to reject
against. Correction, binding from now on:

- Every visual decision in this brief traces to a **Mobbin reference with a
  full URL** that any reviewer can open.
- The Mobbin clauses in §2 are **contract terms**, not mood. An
  implementation that does not visibly resemble the cited references fails
  review (§3).
- Generated concept art may be used for exploration but can never substitute
  for, or override, a Mobbin clause. This brief intentionally ships without
  any non-repo image dependencies.

## 1. One-line direction (decided)

A light "engineering ledger paper" landing: warm off-white canvas with a faint
dotted grid, near-black ink typography, ONE settlement-orange accent, and the
product's real artifacts — a dark terminal window, a ledger table filling with
events, an event-pipeline node graph — framed as thin-bordered paper cards.
Dark is demoted from page theme to a single contrast band. The product
narrative is unchanged: out-of-order Stripe events in, deterministic
entitlements out — but it is now told as *reconciliation on paper*, the way
Midday, Anchor, and Cloudflare Workers tell it, not as a neon terminal.

Why the reversal is justified by evidence, not taste: every category-adjacent
reference found (billing, payments, fintech dev tools — Midday, Anchor, Mews'
product cards, Cloudflare Workers) uses a light paper canvas with restrained
accents and real UI artifacts. The rejected phosphor-dark direction matched
none of them; it pattern-matched "generic AI dev site" instead.

## 2. Mobbin reference contract (hard constraints)

Each clause below was written after inspecting the actual Mobbin screenshot,
not its metadata. Format: URL → what the screenshot actually shows → what we
MUST borrow (acceptance-checkable) → what we must NOT borrow.

### M1 — Cloudflare Workers: page canvas, grid, accent discipline

URL: https://mobbin.com/sites/sections/0aa3bdd1-b2cf-4922-b0a2-39ce4ade272e

Observed: cream/off-white page over a faint dotted-dot grid. Centered
headline "Go from localhost → global in minutes" with the two key words set
in orange (one in mono style), tiny gray subline. Below, thin-bordered white
cards in an asymmetric two-column grid: a syntax-highlighted code editor card
(orange/blue tokens on white, real file tabs), a white terminal card with mac
traffic-light dots and a single `npx wrangler deploy` prompt line, and a
spiky orange area chart with a dashed annotation line labeled "685k requests
per second". Small hand-drawn arrow doodles and tiny mono tags ("PLAYER 1")
sit between cards.

MUST borrow:
- Page canvas: warm off-white (`--paper`) with a faint dotted grid visible in
  section backgrounds (CSS `radial-gradient` dots, opacity ≤ 8%).
- Thin-bordered (1px, `--line`) white cards as the ONLY framing device for
  product artifacts. No shadows heavier than 0–2px, no glassmorphism.
- Exactly one warm accent (settlement orange) used for: highlighted headline
  words, primary CTA fill, chart stroke, annotation labels. Counted per
  viewport: ≤ 3 orange elements visible at once.
- One annotated metric chart somewhere on the page: spiky line/area chart +
  dashed reference line + small mono label stating a concrete number (ours:
  events replayed / duplicate deliveries absorbed).

MUST NOT borrow: the hand-drawn doodle arrows and game-y "PLAYER" tags
(wrong tone for billing infrastructure); the centered hero layout (our hero
is left-aligned per M2).

### M2 — Anchor (developer section): hero composition

URL: https://mobbin.com/sites/sections/d99917c8-d6a4-42f2-92ce-00e32442c35c

Observed: very light gray-green background. Left: large near-black grotesque
headline "Made for developers, by developers.", small gray body copy, one
solid orange rounded CTA ("View docs"). Right: a near-black rounded code
window titled `developersection.js` with mac dots, tilted a few degrees,
showing a `curl --request POST` call with green/cream syntax highlighting and
line numbers. Scattered below at varying angles: rounded pill cards — dark
green `<Accounts/>` in mono, mint "return payments", cream "export
({Cards})", solid orange "Transfers" — over rows of plain light-gray
placeholder pills.

MUST borrow:
- Hero composition: headline block LEFT (grotesque, near-black, ≤ 8 words per
  line), ONE dark terminal/code window RIGHT as the only dark object in the
  hero. The dark window is where the terminal aesthetic survives: it shows a
  real webhook payload / `stripe trigger` transcript with restrained syntax
  color on near-black.
- Slight rotation (2–4°) on the dark window OR on the event pills — one of
  the two, not both.
- Domain-object pills in a muted palette (dark green, mint, cream, orange)
  used for our vocabulary: `invoice.paid`, `charge.refunded`,
  `entitlement.granted`, `dispute.created`. Mono type inside pills.

MUST NOT borrow: the decorative rows of empty placeholder pills (visual
filler); more than one solid-orange object in the hero.

### M3 — Midday (how it works): sources → ledger section

URL: https://mobbin.com/sites/sections/feaf92f2-1f1e-45bc-b9a0-39b2102c816e

Observed: white/cream page, huge whitespace. Right: a thin-bordered card
containing a "Transactions" label, four small account icons in a row, dotted
vertical connector lines dropping from the icons into a ledger table (Date /
Description / Amount / Category) with three filled rows — colored category
chips (blue, light blue, green), the newest row rendered faded as if just
arriving — followed by many empty ruled rows. Left: serif "How it works"
heading over a vertical five-step list where only the active step is black
(with a small square marker) and the rest are faded gray.

MUST borrow:
- The page's centerpiece section: sources-above, dotted connector lines
  dropping into a ledger table below. Ours: Stripe webhook types on top
  (out of order, jittered) → dotted lines → `event_inbox` ledger table whose
  rows are ordered and deduplicated. The newest row appears faded (M3's
  arriving-row trick) — this IS the product story drawn as a diagram.
- Empty ruled rows below the filled ones (the ledger visibly has room —
  quiet confidence, and it reads as paper).
- Vertical stepper with a single active (ink) step and faded (gray) siblings
  for the four pipeline stages: signature verify → inbox claim → one
  transaction → projected entitlement.

MUST NOT borrow: the serif display face for our H1 (we stay grotesque per
M2/M6; serif is permitted ONLY for section eyebrows if at all); Midday's
near-invisible nav (ours keeps visible CTAs).

### M4 — Retool (use cases): event-pipeline node graph

URL: https://mobbin.com/sites/sections/57a4e887-2d6e-4fda-8eea-bd4fcc1a98a4

Observed: white background. Bold black h2 ("Monitoring & alerting"), gray
body, one black CTA. Below: a left-to-right node graph of white 1px-bordered
cards, each with a plain-language title ("Every day at 09:00 PT", "Get list
of expiring trials") and a colored mono chip naming the tech (`crontab`
green, `PostgreSQL` blue, `JavaScript` yellow, `Slack` red) with matching
icon; thin colored elbow lines with dot terminals connect the cards, and the
graph branches into two end nodes. A faded watermark of tiny gray text lines
sits behind the graph.

MUST borrow:
- The "guarantees" section renders our webhook path as exactly this node
  graph: white bordered node cards titled in plain language ("Verify
  signature on raw body", "Claim event in inbox", "Apply effects in one
  transaction", "Project entitlements") each with a mono tech chip
  (`FastAPI`, `PostgreSQL`, `Stripe CLI`) in that node's assigned color.
- Elbow connector lines with small dot terminals; ONE branch showing the
  duplicate-delivery path terminating in a "no-op (already claimed)" node —
  the race-safety differentiator drawn, not described.

MUST NOT borrow: the background text watermark (noise); tab bar above the
graph (we have one use case, not four).

### M5 — Mews (embedded payments): the single dark contrast band

URL: https://mobbin.com/sites/sections/5bfe32b1-3f5c-4b82-ae83-cba6b6feb2cb

Observed: near-black full-width section. Mono uppercase eyebrow ("EMBEDDED
PAYMENTS"), white bold h2 "Take the pain out of payments", gray subcopy.
Left: a dimmed dark table of dated rows overlaid by a white popover card
"Ledger activity report" listing labeled money values ending in "Net balance
$0.00" with a green-check chip "Ledgers balanced"; one cell carries a focus
outline. Right: white h3, three checklist rows with square check marks, one
white-outline mono-caps pill button.

MUST borrow:
- Exactly ONE near-black full-width band on the page: the "proof" section
  listing real test gates (Checkout, decline, 3DS, signed webhook, Test
  Clock renewal). Mono uppercase eyebrow + white h2 + checklist with square
  checks + one outline pill CTA — Mews' layout, our content.
- The white-popover-over-dark-table motif: a light card showing
  `entitlements: consistent` / `duplicates absorbed: N` with a single green
  "balanced"-style chip. Green appears ONLY inside this chip on the whole
  page (semantic, not thematic — this retires phosphor green as a theme).

MUST NOT borrow: making the whole page this dark theme (v1's mistake —
exactly one band); purple focus-outline accent.

### M6 — Vercel (hero): typography and restraint ceiling

URL: https://mobbin.com/sites/sections/42b13454-50c5-40ec-bd46-c7c1ea521873

Observed: white page, extreme whitespace. Left: two-line light-weight
grotesque headline "Agentic Infrastructure" in near-black; two pill buttons
(black filled, white outline). Center: one large solid-black triangle with a
soft shadow. Right: three lines of tiny mono uppercase microcopy ("FOR
CODING AGENTS / …"). Bottom: a single-row strip of small monochrome customer
logos.

MUST borrow:
- Typography ceiling: grotesque display + tiny mono-uppercase microcopy as
  the entire typographic system. Mono-caps microcopy column in the hero for
  our three guarantees ("RACE-SAFE WEBHOOKS / IDEMPOTENT GRANTS /
  DETERMINISTIC UPGRADES").
- Button grammar sitewide: exactly two styles — ink-filled pill and
  1px-outline pill. No gradients, no glows.
- A single-row monochrome strip near the footer for the stack (FastAPI,
  PostgreSQL, Stripe, Next.js) rendered as quiet gray marks, not colored
  badges.

MUST NOT borrow: the centered giant logo mark (we have no such brand
equity); pure-white background (ours is warm paper per M1).

## 3. Acceptance clause (binding for implementation PR and visual review)

1. The implementation PR description MUST contain a screen-by-screen mapping
   table: every landing section names the Mobbin clause(s) (M1–M6) it
   implements. A section that maps to no clause must be removed or justified
   as pure content (e.g. FAQ text).
2. Visual review MUST be able to place a section screenshot next to its cited
   Mobbin screenshot and see the resemblance in layout, framing, and accent
   discipline. If a reviewer cannot tell which reference a screen came from,
   the screen fails — regardless of how polished it looks in isolation.
3. Any deviation from a MUST-borrow item requires updating this brief in the
   same PR with the replacement Mobbin URL and rationale. Silent drift is a
   review-blocking defect, equal in severity to a failing test.
4. Reviewer self-check: `grep -i mobbin web/DESIGN_BRIEF.md` must return the
   clause URLs; a brief revision that drops them is invalid.

## 4. Visual system (derived from M1/M2/M5/M6)

```css
:root[data-theme="paper"] {
  --paper: #faf6ef;        /* page canvas (M1 cream) */
  --paper-raised: #ffffff; /* cards */
  --grid-dot: #d8d2c6;     /* dotted grid, ≤ 8% visual weight */
  --line: #e3ddd2;         /* 1px card borders */
  --ink: #17201c;          /* headlines, body (M2 near-black green-cast) */
  --ink-dim: #6b7570;      /* secondary text */
  --accent: #e35a1f;       /* settlement orange (M1/M2) — the ONLY accent */
  --pill-forest: #1e3a2f;  /* event pills (M2) */
  --pill-mint: #cfe8d8;
  --pill-cream: #f0e2c8;
  --ok-chip: #1f9d55;      /* ONLY inside the M5 "balanced" chip */
  --band-ink: #101513;     /* the single dark band (M5) */
}
```

Type: display + body = Schibsted Grotesk (already loaded); mono = IBM Plex
Mono for pills, microcopy, table figures (`tabular-nums`). IBM Plex Sans may
remain for long-form FAQ text. No serif display. Space Grotesk stays retired.

Accent budget (reviewable): ≤ 3 orange elements per viewport (M1); green only
in the M5 chip; red only on `dispute/refund` pill semantics.

## 5. Information architecture (each section cites its clause)

1. Hero [M2 + M6] — left headline (keep narrative: "Billing events are
   chaos. Your entitlements aren't."), support line keeping the verbatim
   SEO phrase "Stripe billing reference for FastAPI, PostgreSQL, and
   Next.js"; right: tilted dark terminal window replaying a `stripe trigger`
   transcript; scattered event pills; mono-caps guarantee microcopy column.
2. Sources → ledger [M3] — the centerpiece: jittered webhook types dropping
   via dotted connectors into an ordered `event_inbox` ledger table, newest
   row faded, empty ruled rows below; vertical 4-step pipeline stepper left.
3. Pipeline node graph [M4] — plain-language nodes with tech chips, one
   duplicate-delivery branch ending in "no-op (already claimed)".
4. Upgrade matrix [M1 card discipline] — the 6 × 6 plan-transition grid as a
   thin-bordered paper card, orange used only for the highlighted
   `prorated_delta` cell; legend in mono.
5. Proof band [M5] — the single dark band: test-gate checklist + light
   popover card with the green "consistent" chip; annotated metric chart
   [M1] may live here or in section 2.
6. Catalog teaser + slim SEO table — three compact tiles + link to
   `/pricing`; keep the slim restyled `<table>` for the tabular SEO surface.
7. FAQ (content unchanged, restyled to paper) + JSON-LD kept.
8. Footer [M6] — monochrome stack strip, repo link, license note.

## 6. Motion & rendering tech (decided, with degradation)

The v1 Canvas particle field is retired with the dark theme. On paper, the
references animate almost nothing — restraint is the premium signal.

- NO WebGL / three.js / r3f / OGL / GSAP / Framer Motion. Nothing in M1–M6
  needs a GPU pipeline; adding one would be résumé-driven engineering.
- Hero terminal [M2]: line-by-line reveal of a pre-scripted transcript.
  CSS-only (`@keyframes` steps + `animation-delay` per line, pure DOM text).
  No rAF loop. `prefers-reduced-motion: reduce` → all lines visible, static.
- Ledger drop [M3]: dotted connectors are inline SVG; on section entry
  (single IntersectionObserver) play `stroke-dashoffset` line-draw + a
  `translateY + opacity` row-settle transition, once, ~600ms total.
  Reduced-motion or no-JS → final settled state rendered statically
  (server-renderable markup; observer only adds a class).
- Node graph [M4] and metric chart [M1]: static inline SVG. No animation.
- Budget: zero new npm dependencies, zero canvas contexts, no persistent rAF;
  total added client JS for motion ≤ 2 KB (one observer utility).

## 7. Test impact (update in lockstep, same commit as the change)

- `web/app/seo.test.tsx`: keep asserting the keyword-bearing support
  paragraph and JSON-LD (SoftwareApplication + FAQPage). `featureList`
  derives from `capabilities[].title` — keep titles keyword-meaningful when
  re-labeling to plain-language node names.
- `web/promo/ui-tour.spec.ts`: asserts EXACT H1/h2 copy — update in the same
  commit as `page.tsx`. With the rAF canvas gone, the
  `page.emulateMedia({ reducedMotion: "reduce" })` guard is still required
  for the CSS/SVG animations to keep captures deterministic.
- `npm run lint`, `typecheck`, `vitest` green; no backend tests touched.
- Workspace hygiene: the checkout carries unrelated uncommitted diffs
  (`web/lib/mock-api*`, `web/lib/runtime.ts`, `web/next.config.mjs`,
  `web/lib/next-config.test.mjs`, `web/next-env.d.ts`). Redesign commits must
  not absorb them.

## 8. Not doing (explicitly)

- No dark page theme, no phosphor-green accents, no scanlines, no blinking
  cursors — the terminal exists only inside the M2 hero window and the M5
  band artifacts.
- No WebGL/three.js/animation libraries (§6).
- No purple/white AI gradients, glassmorphism, floating 3D blobs, or
  centered mega-logo heroes.
- No full comparison-table dashboard on the landing (slim SEO table only).
- No changes to FastAPI backend, webhook logic, catalog data, or tests
  outside `web/`.
- No re-theming of `/account`, `/billing/*`, `/pricing` interactive screens
  this phase; they keep the light app theme and inherit tokens only.

## 9. Implementation order (for the implementing agent)

1. Tokens + dotted-grid canvas + button/pill grammar in `globals.css`
   (`data-theme="paper"` on the landing wrapper; keep the existing
   `body:has(.landing-page)` header/footer re-chrome mechanism, re-pointed
   at paper tokens). Retire ink/phosphor tokens.
2. Hero [M2+M6]: layout, dark terminal window (static content first),
   event pills, mono microcopy column. Update `seo.test.tsx` same commit.
3. Sources → ledger section [M3] as server-rendered markup + SVG; then the
   node graph [M4] and upgrade-matrix card restyle.
4. Proof band [M5] + annotated chart [M1]; slim SEO table + FAQ restyle.
5. Motion pass per §6 (CSS reveals, one observer); promo tour copy + capture
   guards; delete `HeroSettlementCanvas.tsx` and dead ink styles.
6. OG/twitter/icon re-skin to paper/ink/orange; lint/typecheck/vitest green.
7. PR description includes the §3 screen→clause mapping table.
