"use client";

import { useEffect } from "react";

/**
 * Scroll-driven motion system for the marketing surface (brief v3 §3.2).
 *
 * Reveals: one IntersectionObserver toggles `.is-revealed` on [data-reveal]
 * sections. The hidden pre-reveal state only applies once `js-reveal` is on
 * the body, so no-JS visitors and search engines always see full content.
 * `data-reveal="group"` sections stagger their `.reveal-item` children
 * instead of moving as one block (delays come from each item's `--stagger`).
 *
 * Parallax: elements carrying [data-depth="<px>"] get a `--parallax-shift`
 * custom property from a rAF-synced scroll listener. (The attribute is
 * deliberately NOT `data-parallax`, which the sitewide ScrollMotion progress
 * polyfill claims for its own `--scroll-progress` contract.) The shift tracks the
 * owning section's travel through the viewport, so sibling layers with
 * different depths move at visibly different rates (§3.2 requires at least
 * two). Positive depths lag the scroll (~0.85×), negative depths lead it.
 * Measurements are taken on the untransformed ancestor section, never on the
 * shifted layer itself, to avoid feedback. Consumers apply the variable via
 * `.parallax-layer` or fold it into their own transform.
 *
 * The global prefers-reduced-motion kill-switch suppresses both systems, and
 * parallax stays off below 851px where the sections stack.
 */
export function ScrollReveal() {
  useEffect(() => {
    const revealElements = Array.from(
      document.querySelectorAll<HTMLElement>("[data-reveal]"),
    );
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof IntersectionObserver !== "function" || reduceMotion) {
      for (const element of revealElements) {
        element.classList.add("is-revealed");
      }
      return;
    }

    document.body.classList.add("js-reveal");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-revealed");
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    for (const element of revealElements) observer.observe(element);

    const parallaxLayers = Array.from(
      document.querySelectorAll<HTMLElement>("[data-depth]"),
    );
    const wideViewport = window.matchMedia("(min-width: 851px)");
    let frame = 0;
    const applyShifts = () => {
      frame = 0;
      for (const layer of parallaxLayers) {
        if (!wideViewport.matches) {
          layer.style.removeProperty("--parallax-shift");
          continue;
        }
        const depth = Number.parseFloat(layer.dataset.depth ?? "");
        if (!Number.isFinite(depth) || depth === 0) continue;
        const scope = layer.closest("section") ?? layer;
        const rect = scope.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        // -0.5 as the section enters at the bottom, +0.5 as it leaves the top.
        const travel = window.innerHeight + rect.height;
        const progress = (window.innerHeight - rect.top) / travel - 0.5;
        const clamped = Math.max(-0.5, Math.min(0.5, progress));
        layer.style.setProperty(
          "--parallax-shift",
          `${(clamped * 2 * depth).toFixed(2)}px`,
        );
      }
    };
    const queueShifts = () => {
      if (frame === 0) frame = window.requestAnimationFrame(applyShifts);
    };
    if (parallaxLayers.length > 0) {
      window.addEventListener("scroll", queueShifts, { passive: true });
      window.addEventListener("resize", queueShifts, { passive: true });
      applyShifts();
    }

    return () => {
      observer.disconnect();
      document.body.classList.remove("js-reveal");
      if (parallaxLayers.length > 0) {
        window.removeEventListener("scroll", queueShifts);
        window.removeEventListener("resize", queueShifts);
        if (frame !== 0) window.cancelAnimationFrame(frame);
      }
    };
  }, []);
  return null;
}
