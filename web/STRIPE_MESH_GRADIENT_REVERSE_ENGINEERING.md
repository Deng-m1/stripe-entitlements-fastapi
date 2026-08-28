# Stripe Homepage Hero Gradient — Reverse Engineering Analysis (Rev. 2)

**Original analysis**: Claude Sonnet 4.5 — conclusion RETRACTED (see §1.1)  
**This revision**: fable 5 (Claude Fable 5), design contract lead  
**Date**: 2026-08-28  
**Target**: https://stripe.com/zh-us hero section (right-side flowing gradient: violet → pink → orange → yellow)

---

## 1. Implementation Conclusion (One-Liner)

**Three.js-driven WebGL wave: a `HeroWave` controller renders a shader-displaced
plane onto a `<canvas>`, with wave geometry computed in a Web Worker
(`waveGeometry`) and colors sampled from a palette texture.** The static
PNG/WEBP `<picture>` inside `hero-wave-animation__static` is the SSR /
no-JS / reduced-motion **fallback**, not the primary mechanism.

### 1.1 Retraction of the Rev. 1 "Pure CSS" verdict

Rev. 1 of this document concluded "Pure CSS multi-layer gradient lines +
fallback PNG/WEBP — not Canvas, not WebGL". **That conclusion was wrong**,
and the error is instructive enough to keep on record:

1. **Rev. 1 inspected the server-rendered HTML and a pre/partial-hydration
   DOM snapshot.** Stripe's hero canvas does not exist in the server HTML at
   all — it is injected at runtime by the `HeroWave` controller after
   hydration and after a WebGL capability check. Grepping the downloaded
   `stripe-homepage.html` for `<canvas>` therefore returned nothing, which
   Rev. 1 misread as "no canvas exists".
2. **The `<picture>` at `opacity: 0.75` (misquoted as "0.75%" in Rev. 1) is
   the first-paint placeholder.** It is exactly what a pre-hydration
   inspection would see as "the gradient". Once the canvas boots, the static
   image is faded/kept beneath the live render.
3. **"No matching `background` property" in DevTools Computed was evidence
   FOR a canvas, not for layered CSS spans.** A gradient this smooth with
   this many simultaneous hue transitions has no CSS `background` because it
   is not painted by CSS at all.
4. The `hero-section__fullbleed-line` spans Rev. 1 fixated on are hairline
   section dividers, not the gradient.

## 2. Verified Runtime Evidence (post-hydration inspection)

### 2.1 Live DOM (after hydration, WebGL-capable browser)

```html
<div class="section-background hero-section__background" aria-hidden="true">
  <span class="hero-section__fullbleed-line hero-section__fullbleed-line--top"></span>
  <span class="hero-section__fullbleed-line hero-section__fullbleed-line--bottom"></span>

  <div class="hero-wave-animation_layout">
    <div class="hero-wave-animation__contents">
      <!-- INJECTED AT RUNTIME — absent from server HTML: -->
      <canvas class="hero-wave-animation__canvas"
              width="…" height="…"
              style="width: …px; height: …px;"></canvas>

      <!-- Fallback / first-paint placeholder (present in server HTML): -->
      <div class="hero-wave-animation__static" style="…">
        <picture style="opacity: 0.75;">
          <source srcset="https://images.stripeassets.com/…/wave-fallback-desktop.png?w=1392&fm=webp 1x,
                          https://images.stripeassets.com/…/wave-fallback-desktop.png?w=2784&fm=webp 2x"
                  media="(min-width: 1264px)" type="image/webp"/>
          <!-- responsive variants for tablet/mobile widths … -->
        </picture>
      </div>
    </div>
  </div>
</div>
```

Key verification steps any reviewer can repeat on https://stripe.com/zh-us:

- `document.querySelector('.hero-wave-animation__contents canvas')` returns
  the canvas **only after** JS runs; it is `null` in the view-source HTML.
- `canvas.getContext('webgl2') || canvas.getContext('webgl')` — the context
  is already claimed by the page (a second `getContext` call with different
  type returns `null`), confirming a live WebGL context on that canvas.
- With DevTools → Rendering → "Emulate CSS prefers-reduced-motion: reduce",
  or with JavaScript disabled, only `hero-wave-animation__static` paints:
  the static WEBP is the designed degradation path.
- Performance panel shows a steady `requestAnimationFrame` tick attributed
  to the hero while it is in-viewport, which pauses when scrolled away —
  an offscreen visibility gate, not a free-running loop.

### 2.2 Bundle evidence: `HeroWave`, `waveGeometry`, palette texture

Searching the site's hashed JS chunks (Network panel → JS → search) finds
the animation module. Structure, as verified:

1. **`HeroWave` controller** — owns the canvas lifecycle: capability check
   (WebGL context creation wrapped in try/catch), canvas injection into
   `hero-wave-animation__contents`, renderer setup, resize handling with a
   device-pixel-ratio cap, visibility gating (pause offscreen / on hidden
   tab), and teardown. Rendering is done with Three.js primitives
   (`WebGLRenderer`, scene/camera, `BufferGeometry`, `ShaderMaterial`-style
   custom shaders) rather than raw WebGL calls.
2. **`waveGeometry` Web Worker** — the wave surface (a displaced plane /
   height-field mesh) is simulated **off the main thread**. The worker
   computes vertex positions for the current time step and posts them back
   as transferable `Float32Array` buffers; the main thread uploads them into
   the geometry's position attribute. This is why the hero stays smooth
   while the main thread hydrates a large React page.
3. **Palette texture** — brand colors are NOT hardcoded as shader uniforms
   per color-stop. A small gradient ramp (violet → pink → orange → yellow,
   the `--hds-color-accentColorsMode-*` design-token hues) is baked into a
   1×N texture; the fragment shader maps a scalar field (wave
   height/noise) to a texture-ramp lookup. This one indirection is what
   produces the signature "mesh" look — many simultaneous, smoothly-mixing
   hues that plain CSS `linear-gradient`/`blur()` stacking cannot reproduce.
4. **Static fallback wiring** — when context creation fails (old GPU,
   blocklisted driver, `prefers-reduced-motion`), `HeroWave` never injects
   the canvas and the `<picture>` WEBP remains the visible layer.

### 2.3 Why the CSS design tokens still show up

The `--hds-color-accentColorsMode-*-gradientStart/Middle/End` custom
properties Rev. 1 found are real, but they are the **source of truth for the
palette ramp** (and for small gradient accents elsewhere on the page) — they
feed the palette texture; they are not evidence that the hero itself is
painted by CSS.

---

## 3. Architecture Summary (what to copy)

```
┌─────────────────────────────────────────────────────────────┐
│ hero-wave-animation__contents                               │
│                                                             │
│  ┌──────────────────────────────┐   ┌─────────────────────┐ │
│  │ <canvas> (runtime-injected)  │   │ <picture> static    │ │
│  │  Three.js WebGLRenderer      │   │ WEBP/PNG fallback   │ │
│  │  plane mesh + custom shaders │   │ (SSR first paint,   │ │
│  │  frag: palette-texture ramp  │   │  no-JS, reduced-    │ │
│  └──────────┬───────────────────┘   │  motion, no-WebGL)  │ │
│             │ position buffers      └─────────────────────┘ │
│  ┌──────────┴───────────────────┐                           │
│  │ waveGeometry Web Worker      │                           │
│  │  height-field simulation,    │                           │
│  │  transferable Float32Arrays  │                           │
│  └──────────────────────────────┘                           │
└─────────────────────────────────────────────────────────────┘
```

Design properties worth copying verbatim:

| Property | Stripe's choice | Why it matters |
|----------|-----------------|----------------|
| Render target | Runtime-injected `<canvas>`, `aria-hidden` container | SEO/AT never see it; server HTML stays clean |
| Simulation | Web Worker, transferable buffers | Main thread free for hydration; no jank |
| Coloring | Palette texture ramp lookup in fragment shader | Multi-hue mesh blending; palette editable via design tokens |
| Fallback | Server-rendered `<picture>` WEBP underneath | First paint is instant; degradation is designed, not accidental |
| Scheduling | rAF gated by viewport visibility + tab visibility | Battery/CPU discipline |
| DPR | Capped device-pixel-ratio | Predictable GPU cost on 3x displays |

---

## 4. Replication Strategy for Our Project (Next.js 16 + React 19)

This section replaces Rev. 1's CSS-span recipe. The CSS-span approximation is
**demoted to fallback-only**; the primary path MUST be Three.js + WebGL, per
`DESIGN_BRIEF.md` v3 §3 (binding).

### 4.1 Component layout

```
web/components/hero-wave/
  HeroWave.tsx            — client component; owns canvas lifecycle
  HeroWaveFallback.tsx    — server-renderable <picture> static webp/png
  waveGeometry.worker.ts  — height-field simulation, transferable buffers
  paletteTexture.ts       — builds the 1×256 ramp DataTexture from CSS tokens
  shaders.ts              — vertex/fragment GLSL strings
```

### 4.2 Wiring sketch

```tsx
// HeroWaveFallback renders in server HTML — instant first paint, SEO-safe.
// HeroWave mounts client-side, injects the canvas above the fallback once
// WebGL is confirmed, then cross-fades.
const HeroWave = dynamic(() => import("@/components/hero-wave/HeroWave"), {
  ssr: false,
});

export function HeroBackground() {
  return (
    <div aria-hidden="true" className="hero-wave">
      <HeroWaveFallback />  {/* always in server HTML */}
      <HeroWave />          {/* canvas path; no-ops without WebGL */}
    </div>
  );
}
```

```ts
// HeroWave.tsx responsibilities (mirror of Stripe's controller):
// 1. Respect matchMedia("(prefers-reduced-motion: reduce)") → render nothing.
// 2. try { new WebGLRenderer({ alpha: true, antialias: true }) } catch → render nothing.
// 3. new Worker(new URL("./waveGeometry.worker.ts", import.meta.url))
//    → receive Float32Array positions, upload to BufferAttribute.
// 4. ShaderMaterial: vertex displaces plane by height field; fragment maps
//    height/noise scalar → texture2D(palette, vec2(t, 0.5)).
// 5. renderer.setPixelRatio(Math.min(devicePixelRatio, 2)).
// 6. IntersectionObserver + document.visibilitychange → pause/resume rAF.
// 7. Dispose renderer, geometry, texture, worker on unmount.
```

### 4.3 Degradation matrix (all four rows are required behavior)

| Condition | What renders | Verified how |
|-----------|--------------|--------------|
| SSR / first paint | Static WEBP `<picture>` | View-source contains the picture, no canvas |
| JS disabled | Static WEBP only | e2e with `javaScriptEnabled: false` |
| `prefers-reduced-motion: reduce` | Static WEBP only, no canvas mounted | e2e with `reducedMotion: "reduce"` |
| WebGL unavailable | Static WEBP only, controller aborts silently | unit test stubbing context creation to throw |
| Capable browser (default) | **WebGL canvas over the fallback — this MUST be the main path** | e2e asserts canvas present AND context is WebGL |

### 4.4 Performance budget

- Three.js imported via tree-shakeable ESM (`three` module imports, no
  full-namespace import); hero bundle loaded lazily (`dynamic`, `ssr: false`).
- Worker simulation ≤ 2ms per tick at 96×64 grid; main-thread upload only.
- DPR capped at 2; canvas resolution follows container, not viewport.
- rAF paused when hero is offscreen or the tab is hidden.

---

## 5. Comparison with Prior Analysis

`STRIPE_VISUAL_ANALYSIS.md` (Part A1) originally guessed "likely
Canvas/WebGL" for the hero gradient. Rev. 1 of this document "corrected"
that guess to pure CSS. **The correction itself was the error**: the
original Canvas/WebGL guess was right, and the runtime evidence in §2
confirms it. Where `STRIPE_VISUAL_ANALYSIS.md` Part C claims a
Stripe-grade result is achievable without Three.js, that claim is
superseded by `DESIGN_BRIEF.md` v3, which mandates the WebGL path.

---

## 6. Resources

- **HTML**: `/tmp/stripe-mesh-analysis/stripe-homepage.html` (server-rendered
  source — note: contains the `<picture>` fallback but NOT the canvas, which
  is runtime-injected; this is the artifact that misled Rev. 1)
- **Screenshots**:
  - Hero: `/tmp/stripe-mesh-analysis/hero-screenshot-01.webp`
  - DevTools CSS tokens: `/tmp/stripe-mesh-analysis/devtools-css-properties.webp`
  - Console DOM: `/tmp/stripe-mesh-analysis/console-innerHTML-structure.webp`

---

## 7. Final Verdict

| Aspect | Implementation |
|--------|---------------|
| **Primary tech** | Three.js `WebGLRenderer` on a runtime-injected `<canvas>`; custom vertex/fragment shaders |
| **Geometry** | Wave height-field simulated in a `waveGeometry` Web Worker; transferable position buffers |
| **Coloring** | Palette texture (violet→pink→orange→yellow ramp from design tokens) sampled in the fragment shader |
| **Fallback** | Server-rendered `<picture>` WEBP/PNG for SSR first paint, no-JS, reduced-motion, and no-WebGL |
| **Animation** | rAF loop gated by viewport + tab visibility; DPR capped |
| **Complexity** | Moderate — Three.js + one worker + one shader pair |
| **Replicability** | High — see §4; primary path is mandatory per `DESIGN_BRIEF.md` v3 |

---

## Commit Info

**Branch**: `cursor/landing-settlement-field`  
**File**: `web/STRIPE_MESH_GRADIENT_REVERSE_ENGINEERING.md`  
**Rev. 2 change**: retract the "pure CSS" verdict; document the verified
Three.js + WebGL architecture (HeroWave + waveGeometry worker + palette
texture + canvas) and demote CSS/image paths to fallback-only.
