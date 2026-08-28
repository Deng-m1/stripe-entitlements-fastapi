"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerTarget } from "@/components/HeroWaveScene";
import { waveQualityTier } from "@/lib/hero-wave-geometry";

/**
 * Host for the hero wave.
 *
 * Everything that decides *whether* to render WebGL lives here, and none of it
 * runs on the server: the markup this component emits during SSR is the static
 * poster alone. The renderer chunk (three + the scene) is only requested once
 * the client has confirmed a WebGL context, motion consent, and a visible
 * hero, so a reduced-motion or software-rendering visitor never downloads it.
 *
 * Once the renderer reports a real drawn frame the host flips `data-drawn`,
 * which cross-fades the poster out — the same handover Stripe performs on its
 * own hero wave.
 */

type HeroWaveSceneComponent =
  typeof import("@/components/HeroWaveScene").HeroWaveScene;

function supportsWebGl(): boolean {
  if (typeof WebGLRenderingContext === "undefined") return false;
  try {
    const probe = document.createElement("canvas");
    const context =
      probe.getContext("webgl2") ??
      (probe.getContext("webgl") as WebGLRenderingContext | null);
    if (!context) return false;
    // Release the probe's context immediately; drivers cap concurrent contexts.
    context.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function prefersLessData(): boolean {
  const connection = (
    navigator as Navigator & { connection?: { saveData?: boolean } }
  ).connection;
  return connection?.saveData === true;
}

function rendererAllowed(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
    !prefersLessData() &&
    supportsWebGl()
  );
}

export function HeroWaveCanvas() {
  const stage = useRef<HTMLDivElement>(null);
  const pointer = useRef<PointerTarget>({ x: 0, y: 0 });
  const [enabled, setEnabled] = useState(false);
  const [Scene, setScene] = useState<HeroWaveSceneComponent | null>(null);
  const [visible, setVisible] = useState(true);
  const [pageVisible, setPageVisible] = useState(true);
  const [tier, setTier] = useState(() => waveQualityTier(1440));
  const [drawn, setDrawn] = useState(false);

  // Whenever the renderer is (re)denied, `drawn` must release with it: the
  // `data-drawn` handover is reversible, and leaving it latched after the
  // canvas unmounts would keep the poster at opacity 0 with no canvas behind
  // it — the hero would vanish to bare paper.
  const applyRendererState = useCallback((allowed: boolean) => {
    setEnabled(allowed);
    if (!allowed) setDrawn(false);
  }, []);

  // Motion consent and renderer capability. Re-evaluated when the visitor
  // changes their reduced-motion preference mid-session.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const evaluate = () => applyRendererState(rendererAllowed());
    evaluate();
    query.addEventListener("change", evaluate);
    return () => query.removeEventListener("change", evaluate);
  }, [applyRendererState]);

  // Load the renderer only after the capability/consent gate has passed.
  // An explicit import is used instead of next/dynamic here because a client-
  // only dynamic component toggled on from a hydration effect can remain in a
  // pending Suspense boundary under Next development servers. In that state
  // the loader entry arrives but its Three.js/R3F chunks are never requested,
  // leaving capable browsers on the poster indefinitely.
  useEffect(() => {
    if (!enabled || Scene) return;
    let current = true;
    void import("@/components/HeroWaveScene")
      .then((module) => {
        if (current) setScene(() => module.HeroWaveScene);
      })
      .catch(() => {
        // A renderer chunk failure is a degradation condition, not a reason to
        // replace the usable poster with an application error boundary.
        if (current) applyRendererState(false);
      });
    return () => {
      current = false;
    };
  }, [Scene, applyRendererState, enabled]);

  // GPU resets and context eviction land here. Fall back to the poster now;
  // re-probe once, after the driver has had a moment, so a transient reset
  // restores the live wave and a genuinely gone GPU keeps the poster.
  const contextProbe = useRef<number | undefined>(undefined);
  const handleContextLost = useCallback(() => {
    applyRendererState(false);
    window.clearTimeout(contextProbe.current);
    contextProbe.current = window.setTimeout(
      () => applyRendererState(rendererAllowed()),
      1_500,
    );
  }, [applyRendererState]);
  useEffect(() => () => window.clearTimeout(contextProbe.current), []);

  // Subdivision follows the rendered width, so a phone never builds a sheet
  // sized for a 27-inch display.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = (width: number) => {
      const next = waveQualityTier(width);
      setTier((current) =>
        current.segmentsX === next.segmentsX &&
        current.segmentsY === next.segmentsY
          ? current
          : next,
      );
    };
    measure(element.clientWidth || window.innerWidth);
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) measure(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Stop the render loop the moment the hero scrolls away.
  useEffect(() => {
    const element = stage.current;
    if (!element || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setVisible(entry.isIntersecting);
      },
      { rootMargin: "80px", threshold: 0 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const sync = () => setPageVisible(!document.hidden);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  // Pointer tracking is bound to the window, not the canvas: the canvas is
  // pointer-transparent so the headline and CTAs above it stay clickable.
  // When the pointer leaves the window (or the window loses focus) the target
  // returns to rest, so the swell drifts home instead of freezing wherever
  // the cursor happened to exit — Stripe's wave settles the same way.
  useEffect(() => {
    if (!enabled) return;
    const track = (event: PointerEvent) => {
      const element = stage.current;
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0) return;
      pointer.current.x = Math.max(
        -1.6,
        Math.min(1.6, ((event.clientX - bounds.left) / bounds.width) * 2 - 1),
      );
      pointer.current.y = Math.max(
        -1.6,
        Math.min(1.6, 1 - ((event.clientY - bounds.top) / bounds.height) * 2),
      );
    };
    const rest = () => {
      pointer.current.x = 0;
      pointer.current.y = 0;
    };
    const trackExit = (event: PointerEvent) => {
      if (!event.relatedTarget) rest();
    };
    window.addEventListener("pointermove", track, { passive: true });
    window.addEventListener("pointerout", trackExit, { passive: true });
    window.addEventListener("blur", rest);
    return () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerout", trackExit);
      window.removeEventListener("blur", rest);
      rest();
    };
  }, [enabled]);

  const handleDrawn = useCallback(() => setDrawn(true), []);

  return (
    <div
      aria-hidden="true"
      className="hero-wave"
      data-drawn={drawn ? "true" : undefined}
      ref={stage}
    >
      <picture className="hero-wave-fallback">
        <source
          media="(max-width: 719px)"
          srcSet="/hero-wave-mobile.webp"
          type="image/webp"
        />
        <source
          srcSet="/hero-wave-desktop.webp 1x, /hero-wave-desktop-2x.webp 2x"
          type="image/webp"
        />
        {/* Art-directed decorative poster: a raw <img> inside <picture> keeps
            the 1x/2x and small-viewport sources intact. The asset is already
            encoded at its delivery sizes, so next/image adds nothing. */}
        <img alt="" decoding="async" fetchPriority="high" src="/hero-wave-desktop.png" />
      </picture>
      {enabled && Scene ? (
        <Scene
          active={visible && pageVisible}
          onContextLost={handleContextLost}
          onDrawn={handleDrawn}
          pointer={pointer}
          segmentsX={tier.segmentsX}
          segmentsY={tier.segmentsY}
        />
      ) : null}
    </div>
  );
}
