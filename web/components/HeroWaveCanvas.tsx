"use client";

import dynamic from "next/dynamic";
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

const HeroWaveScene = dynamic(
  () => import("@/components/HeroWaveScene").then((module) => module.HeroWaveScene),
  { ssr: false },
);

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

export function HeroWaveCanvas() {
  const stage = useRef<HTMLDivElement>(null);
  const pointer = useRef<PointerTarget>({ x: 0, y: 0 });
  const [enabled, setEnabled] = useState(false);
  const [visible, setVisible] = useState(true);
  const [pageVisible, setPageVisible] = useState(true);
  const [tier, setTier] = useState(() => waveQualityTier(1440));
  const [drawn, setDrawn] = useState(false);

  // Motion consent and renderer capability. Re-evaluated when the visitor
  // changes their reduced-motion preference mid-session.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const evaluate = () => {
      setEnabled(!query.matches && !prefersLessData() && supportsWebGl());
    };
    evaluate();
    query.addEventListener("change", evaluate);
    return () => query.removeEventListener("change", evaluate);
  }, []);

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
    window.addEventListener("pointermove", track, { passive: true });
    return () => window.removeEventListener("pointermove", track);
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
      {enabled ? (
        <HeroWaveScene
          active={visible && pageVisible}
          onDrawn={handleDrawn}
          pointer={pointer}
          segmentsX={tier.segmentsX}
          segmentsY={tier.segmentsY}
        />
      ) : null}
    </div>
  );
}
