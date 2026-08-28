"use client";

import { useEffect } from "react";

/**
 * Scroll-driven parallax for the landing (DESIGN_BRIEF.md v3 §3.2).
 *
 * One rAF-synced scroll listener drives every layer, so the number of moving
 * elements does not multiply the number of listeners. Each participating
 * element declares its own rate:
 *
 *   <div data-parallax="0.16"> → travels 16% of its distance from the viewport
 *                                centre, in the direction of the scroll
 *
 * Sibling layers inside one artifact take different rates, which is what
 * produces the depth the brief asks for (gradient base at 1.0×, card stack at
 * ~0.85×). The hero's own drift is published separately as --hero-drift on
 * the hero section, because the wave layer is positioned, not flowed.
 *
 * Nothing here runs without motion consent: under `prefers-reduced-motion:
 * reduce` the effect returns before binding, leaving every layer at its
 * static CSS position. The server HTML is likewise unaffected — the shifts
 * are inline custom properties applied after mount.
 */

const MAX_SHIFT_PX = 90;

export function ScrollParallax() {
  useEffect(() => {
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;

    const layers = Array.from(
      document.querySelectorAll<HTMLElement>("[data-parallax]"),
    ).map((element) => ({
      element,
      rate: Number.parseFloat(element.dataset.parallax ?? "0") || 0,
    }));
    const hero = document.querySelector<HTMLElement>(".paper-hero");
    if (layers.length === 0 && !hero) return;

    let frame = 0;

    const apply = () => {
      frame = 0;
      const viewport = window.innerHeight || 1;
      for (const layer of layers) {
        const bounds = layer.element.getBoundingClientRect();
        if (bounds.height === 0) continue;
        // Distance of the layer's centre from the viewport's centre, in
        // viewport halves: -1 when it is entering, +1 when it is leaving.
        const offset =
          (bounds.top + bounds.height / 2 - viewport / 2) / (viewport / 2);
        const shift = Math.max(
          -MAX_SHIFT_PX,
          Math.min(MAX_SHIFT_PX, offset * layer.rate * viewport * 0.5),
        );
        layer.element.style.setProperty(
          "--parallax-shift",
          `${shift.toFixed(2)}px`,
        );
      }
      if (hero) {
        // The hero wave keeps drifting for exactly one viewport of scroll,
        // then holds — past that the section is gone and the loop is idle.
        const progress = Math.min(1, Math.max(0, window.scrollY / viewport));
        hero.style.setProperty(
          "--hero-drift",
          `${(progress * 72).toFixed(2)}px`,
        );
        hero.style.setProperty(
          "--hero-copy-drift",
          `${(progress * -26).toFixed(2)}px`,
        );
      }
    };

    const schedule = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(apply);
    };

    apply();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      for (const layer of layers) {
        layer.element.style.removeProperty("--parallax-shift");
      }
      hero?.style.removeProperty("--hero-drift");
      hero?.style.removeProperty("--hero-copy-drift");
    };
  }, []);
  return null;
}
