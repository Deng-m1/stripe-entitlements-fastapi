"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Sitewide scroll-progress driver (DESIGN_BRIEF.md v3 §3.2), mounted once in
 * the root layout. It owns two custom-property contracts that globals.css
 * turns into motion:
 *
 * - `[data-parallax]` elements receive `--scroll-progress`: 0 as the element's
 *   top enters the bottom of the scrollport, 1 as its bottom leaves the top
 *   (the default `view()` cover range). 0.5 is the viewport-centered pose.
 * - `[data-scroll-drift]` elements receive `--scroll-exit`: 0 until the
 *   element starts leaving through the top of the scrollport, 1 once it has
 *   fully left (the `exit` range). The hero wave's scroll drift reads this.
 *
 * On browsers with CSS scroll timelines the stylesheet animates both
 * properties natively (`animation-timeline: view()`); this component detects
 * that and stays completely inert. Everywhere else it acts as the small
 * polyfill the brief allows: a rAF-synced scroll listener writing the same
 * variables, computed from layout boxes (offsetTop chains) rather than
 * getBoundingClientRect, so the transforms it drives can never feed back
 * into their own measurements.
 *
 * Entry reveals stay in ScrollReveal.tsx (IntersectionObserver, per-page),
 * and ScrollReveal's px-valued `[data-depth]` layer shifts are a separate
 * contract — this component deliberately claims only `[data-parallax]` and
 * `[data-scroll-drift]`.
 *
 * `prefers-reduced-motion: reduce` keeps the driver off (and every consumer
 * rule in globals.css sits behind `no-preference`), so a reduce visitor gets
 * a fully static page. The preference is re-read live on mid-session flips.
 */

const PROGRESS_SELECTOR = "[data-parallax], [data-scroll-drift]";

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function supportsScrollTimeline(): boolean {
  return (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("animation-timeline: view()")
  );
}

/** Document-space top of the element's layout box, ignoring transforms. */
function layoutTop(element: HTMLElement): number {
  let top = 0;
  let node: Element | null = element;
  while (node instanceof HTMLElement) {
    top += node.offsetTop;
    node = node.offsetParent;
  }
  return top;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function collect(root: HTMLElement, selector: string): HTMLElement[] {
  const found = Array.from(root.querySelectorAll<HTMLElement>(selector));
  if (root.matches(selector)) found.unshift(root);
  return found;
}

export function ScrollMotion() {
  const pathname = usePathname();
  const [reduceMotion, setReduceMotion] = useState(
    () => typeof window !== "undefined" && prefersReducedMotion(),
  );

  // Track the preference live; a mid-session flip tears the polyfill down
  // (clearing its inline variables) or brings it up via the effect below.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (reduceMotion || supportsScrollTimeline()) return;

    const targets = new Set<HTMLElement>(
      document.querySelectorAll<HTMLElement>(PROGRESS_SELECTOR),
    );
    let frame = 0;

    const update = () => {
      frame = 0;
      const viewport = window.innerHeight;
      const scrollY = window.scrollY;
      for (const element of targets) {
        const height = element.offsetHeight;
        if (height === 0) continue;
        const top = layoutTop(element);
        if (element.hasAttribute("data-scroll-drift")) {
          const exit = clamp01((scrollY - top) / height);
          element.style.setProperty("--scroll-exit", exit.toFixed(4));
        } else {
          const cover = clamp01(
            (scrollY + viewport - top) / (viewport + height),
          );
          element.style.setProperty("--scroll-progress", cover.toFixed(4));
        }
      }
    };

    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    };

    // Client screens can mount progress consumers after a fetch resolves;
    // pick them up without re-running the whole effect.
    const watcher = new MutationObserver((mutations) => {
      let grew = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          for (const target of collect(node, PROGRESS_SELECTOR)) {
            targets.add(target);
            grew = true;
          }
        }
      }
      if (grew) schedule();
    });
    watcher.observe(document.body, { childList: true, subtree: true });

    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      watcher.disconnect();
      for (const element of targets) {
        element.style.removeProperty("--scroll-progress");
        element.style.removeProperty("--scroll-exit");
      }
    };
  }, [pathname, reduceMotion]);

  return null;
}
