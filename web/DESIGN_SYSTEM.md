# Design System — Stripe-Grade Marketing & App Surface (v1)

Status: normative companion to `DESIGN_BRIEF.md` v3. Where an implementation
choice contradicts this document, the implementation is wrong until this
document is amended in the same PR with rationale.

Scope: all `web/` routes — `/`, `/pricing`, `/account`, `/billing/success`,
`/billing/error` — plus shared chrome (`SiteHeader`, footer, `DemoNotice`).

## 1. Principles

1. **One product, one voice.** Landing, pricing, account, and billing result
   screens share one type system, one accent, one palette. A visitor moving
   from `/` to `/account` must not feel a theme switch.
2. **White canvas over a live atmosphere.** Content sits on pristine white;
   the brand's mesh-gradient field (WebGL on `/`, static derivatives
   elsewhere) provides the premium signal behind and between content planes.
3. **Depth is deliberate.** Layered shadows, gradient shadow bases, and
   stacked UI composites are the framing grammar — not 1px hairline boxes.
4. **Motion follows the scroll** on marketing surfaces and stays out of the
   way on workspace surfaces (`/account`).

## 2. Typography (MUST upgrade — the template feel is retired)

### 2.1 Families

| Role | Face | Loading | Replaces |
|------|------|---------|----------|
| Display + body | **Instrument Sans** (variable, `wght` 400–700) | `next/font/google`, `--font-sans` | IBM Plex Sans (body) and Schibsted Grotesk (display) — both retired |
| Mono (code, figures, eyebrows) | **IBM Plex Mono** 400/500/600 | `next/font/google`, `--font-mono` | — (retained) |

Rationale: Stripe sets display and body in one proprietary grotesque
(Söhne), and the single-family discipline is a large part of the "product,
not template" feel. Instrument Sans is the closest well-hinted variable
grotesque on Google Fonts. The IBM Plex Sans + Schibsted pairing is the
template signature we are removing. Space Grotesk stays retired.

Stacks (tokens in `globals.css`):

```css
--font-sans-stack: var(--font-sans, "Instrument Sans"), "Helvetica Neue",
  ui-sans-serif, system-ui, sans-serif;
--font-mono-stack: var(--font-mono, "IBM Plex Mono"), ui-monospace,
  "SFMono-Regular", Menlo, Consolas, monospace;
```

Feature settings: body text `font-feature-settings: "ss01" off;` (default);
all numeric UI (tables, prices, ledger figures) MUST set
`font-variant-numeric: tabular-nums`.

### 2.2 Heading hierarchy (sitewide, all routes)

| Level | Size | Weight | Tracking | Line-height | Usage |
|-------|------|--------|----------|-------------|-------|
| Display / H1 | `clamp(2.75rem, 2rem + 3.2vw, 4.25rem)` | 640 | `-0.028em` | 1.04 | One per route. Landing hero; route titles on `/pricing`, `/billing/*` |
| H2 | `clamp(1.9rem, 1.5rem + 1.8vw, 2.75rem)` | 620 | `-0.022em` | 1.08 | Landing section heads; `/account` page title |
| H3 | `1.375rem` | 600 | `-0.012em` | 1.25 | Card titles, plan names |
| H4 | `1.0625rem` | 600 | `0` | 1.4 | Sub-cards, FAQ questions |
| Lede | `clamp(1.0625rem, 1rem + 0.4vw, 1.25rem)` | 400 | `0` | 1.55 | Support line under H1/H2, `--text-muted` |
| Body | `1rem` | 400 | `0` | 1.6 | Copy |
| Eyebrow | `0.75rem` mono | 500 | `+0.14em`, uppercase | 1 | Section kickers, guarantee microcopy |
| Caption | `0.8125rem` | 450 | `+0.01em` | 1.45 | Table meta, legal, footnotes |

Rules:

- Exactly ONE H1 per route; heading levels never skip.
- Landing-hero exception (Round 4 review): in a two-column hero the Display
  clamp may be held back on 851–1080 px viewports
  (`clamp(2.5rem, 1.1rem + 3.1vw, 3.5rem)`) — at the full scale the headline
  column is narrower than the word “entitlements” there and the lockup
  shatters into five ragged lines. Full Display scale resumes above 1080 px.
- Gradient text (mesh ramp, `background-clip: text`) is allowed on **one
  phrase of one headline per route**, with a solid `--iris` fallback color
  declared before the clip for non-supporting engines.
- Eyebrows are mono-caps and MUST precede every landing H2.
- No serif faces anywhere.

## 3. Color palette

### 3.1 Neutrals and ink

```css
--surface: #ffffff;        /* content canvas — replaces warm paper #faf6ef */
--surface-sunken: #f6f8fb; /* alternating quiet sections, table stripes */
--ink: #0b1e3d;            /* headlines & body — deep navy-ink */
--text-muted: #4f5e7b;     /* secondary text */
--hairline: #e4e9f1;       /* 1px rules inside components only */
```

### 3.2 Brand mesh ramp (the atmosphere)

Single source of truth for: the WebGL palette texture (see
`STRIPE_MESH_GRADIENT_REVERSE_ENGINEERING.md` §4), the static fallback
WEBP/PNG renders, gradient bands, gradient text, and OG imagery.

```css
--mesh-violet: #7a5af8;
--mesh-pink:   #ff5c8f;
--mesh-orange: #ff8a3c;
--mesh-lemon:  #ffd44d;
--mesh-stops: var(--mesh-violet), var(--mesh-pink),
              var(--mesh-orange), var(--mesh-lemon);
```

- The ramp order is fixed (violet → pink → orange → yellow, matching the
  Stripe zh-us hero temperature drift). Section gradient bands may use a
  two-stop slice of the ramp (e.g. violet → pink for the pipeline band).
- These are OUR tokens: do not import Stripe's `--hds-*` values verbatim.

### 3.3 Interactive accent

```css
--iris: #5b4cf5;        /* primary actions, links, focus rings */
--iris-strong: #4638c9; /* hover/active */
--iris-soft: #eeecfe;   /* selected/soft backgrounds */
```

Iris replaces the teal `--accent: #0e7285` family everywhere, including
`/account` and `/billing/*`. Settlement orange survives only as a
data-visualization stroke inside charts/matrix highlights, never on
interactive elements. Accent budget: iris on interactive elements is
unlimited; decorative mesh-ramp usage ≤ 2 elements per viewport outside the
hero/bands.

### 3.4 Semantic (unchanged roles, re-tuned to the navy ink)

```css
--success: #0e7a52;  --success-soft: #e2f5ec;
--warning: #91580a;  --warning-soft: #fbf3e0;
--danger:  #b3261c;  --danger-soft:  #fdecea;
```

Green appears on marketing surfaces ONLY inside the proof band's
"consistent/balanced" chip; red only for dispute/refund/error semantics.

### 3.5 Dark band ink

```css
--band-deep: #0f0a2e; /* base under gradient bands, never flat-black */
```

Full-width bands are gradients over `--band-deep`, not flat fills.

## 4. Spacing, layout, depth

### 4.1 Scale

4px base: `--space-1: 4px` … `--space-6: 24px`, `--space-8: 32px`,
`--space-12: 48px`, `--space-16: 64px`, `--space-24: 96px`,
`--space-32: 128px`. No off-scale margins/paddings.

- Section vertical rhythm (landing): `--space-24` minimum between sections,
  `--space-32` around full-width gradient bands.
- Container: max-width `1200px`, gutter `--space-6` mobile / `--space-8`
  desktop. App routes (`/account`, `/billing/*`) may use a `960px` reading
  container.

### 4.2 Radii and borders

`--radius-sm: 8px`, `--radius-md: 12px`, `--radius-lg: 16px`,
pills `999px`. Hairline borders live only INSIDE composites (table rules,
input fields); card framing comes from depth (§4.3), not 1px outlines.

### 4.3 Depth grammar (replaces v2's flat-card rule)

```css
--shadow-card:
  0 1px 2px rgba(11, 30, 61, 0.06),
  0 12px 32px rgba(11, 30, 61, 0.10);
--shadow-float:
  0 2px 4px rgba(11, 30, 61, 0.08),
  0 24px 64px rgba(11, 30, 61, 0.16);
```

- **Gradient shadow base:** major artifacts get a blurred radial underlay
  (`::after`, mesh-ramp color at ~30% opacity, `blur(20px+)`) — the Stripe
  "lift" — in addition to, not instead of, the layered shadow.
- **Stacking:** front artifact full-scale; sibling behind at 0.95 scale,
  offset, opacity ~0.6. Tilts 2–4° via `perspective()` transforms.

### 4.4 Buttons and pills

Two styles sitewide: **iris-filled pill** (white text) and **1px ink-outline
pill**. Focus: 2px `--iris` ring at 2px offset. No gradient-filled buttons;
the atmosphere is gradient, the controls are solid.

## 5. Route-by-route requirements

Shared chrome first: `SiteHeader` and footer render identically on every
route (white, hairline bottom/top rule, Instrument Sans, iris links), so the
routes are visibly one site.

### 5.1 `/` (landing)

- Hero: WebGL wave per `DESIGN_BRIEF.md` §3.1 (MUST), white canvas, H1 with
  one gradient phrase, mono-caps guarantee eyebrows, two pill CTAs.
- Full §3/§4 motion + depth grammar; sections per brief §5.
- The ONLY route with a live rAF loop by default.

### 5.2 `/pricing`

- H1 (§2.2 Display scale) + lede reusing the landing type exactly.
- A slim gradient ribbon (≤ 240px tall) behind the header area: a static
  render (WEBP/CSS) derived from the same `--mesh-stops` ramp — visibly the
  hero's world without paying the canvas cost. Canvas reuse here is
  permitted but optional.
- Plan cards use `--shadow-card` + gradient shadow base on the highlighted
  plan only; price figures in mono `tabular-nums`; interval toggle and CTAs
  in iris.
- Comparison table: `--surface-sunken` stripes, hairlines inside only.

### 5.3 `/account`

- Workspace temperament: NO parallax, no scroll-driven motion, no canvas.
  Transitions ≤ 200ms opacity/transform on state changes only.
- H2-scale page title (§2.2), same family and tracking as marketing.
- One quiet brand signal: a 2–3px gradient accent rule (mesh ramp) at the
  top of the page card or under the page title — nothing larger.
- All statuses/actions through §3.3 iris + §3.4 semantic tokens (teal
  retired here too); entitlement/credit figures in mono `tabular-nums`.

### 5.4 `/billing/success` and `/billing/error`

- Settlement moment: centered narrow container (`≤ 640px`), H1 at Display
  scale, one-sentence lede, one primary iris CTA ("Back to account") and one
  outline secondary.
- `success`: a small static mesh-gradient medallion/arc as the celebratory
  element (same ramp; static asset, no canvas) + `--success` semantics for
  the confirmation chip. `error`: identical layout, `--danger` semantics,
  no gradient celebration.
- These screens land mid-checkout: LCP-critical, zero heavy JS.

## 6. Assets and derivatives

- Static hero fallback (WEBP/PNG, responsive sizes) is generated FROM the
  `--mesh-stops` ramp so canvas and fallback never drift apart; regenerate
  when tokens change (script under `web/scripts/`).
- OG/twitter images and favicons re-skin to ink-on-white + mesh ramp accent
  in the same PR that lands the new tokens.
- No Stripe-owned imagery, wordmarks, or downloaded stripeassets.com files
  in the repo — techniques yes, brand assets no.

## 7. Accessibility and QA gates

- Contrast: body ≥ 4.5:1, large display text ≥ 3:1 — including text over
  gradient bands (test against the LIGHTEST stop in the band).
- Gradient text always declares a solid fallback color; never gradient text
  below H2 scale.
- `prefers-reduced-motion: reduce`: no canvas mount, no parallax, no
  scroll-linked animation, sitewide — verified by e2e per brief §7.1.
- Focus visible on every interactive element (§4.4 ring); `:focus-visible`
  only, no `outline: none` without replacement.
- Type/token changes must keep `npm run lint`, `typecheck`, `vitest`, and
  the promo capture suites green; capture specs pin reduced-motion.

## 8. Migration map (from current `globals.css`)

| Current | Becomes |
|---------|---------|
| `--bg: #f3f6f6` body tint + radial wash | `--surface: #ffffff` (+ WebGL/static atmosphere per route) |
| `--accent/--accent-strong/--accent-soft` teal family | `--iris/--iris-strong/--iris-soft` |
| `--cta: #0d2027` filled buttons | iris-filled pill (§4.4) |
| `--text: #0c1b21`, `--muted: #4d6069` | `--ink: #0b1e3d`, `--text-muted: #4f5e7b` |
| `--font-body` (IBM Plex Sans) + `--font-display` (Schibsted Grotesk) | `--font-sans` (Instrument Sans) for both roles |
| v2 paper tokens (`--paper`, `--grid-dot`, `--line` framing) | retired; depth grammar §4.3 |
| `--shadow-card` single soft shadow | §4.3 layered `--shadow-card`/`--shadow-float` + gradient bases |

Semantic tokens (`--success*`, `--warning*`, `--danger*`) and radii carry
over unchanged. `--radius-lg` moves 14px → 16px.
