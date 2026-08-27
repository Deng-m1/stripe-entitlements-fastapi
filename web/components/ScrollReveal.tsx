"use client";

import { useEffect } from "react";

/**
 * One IntersectionObserver that toggles a CSS class on [data-reveal]
 * sections. The hidden pre-reveal state only applies once `js-reveal` is on
 * the body, so no-JS visitors and search engines always see full content.
 * The global prefers-reduced-motion kill-switch neutralizes the transition.
 */
export function ScrollReveal() {
  useEffect(() => {
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>("[data-reveal]"),
    );
    if (elements.length === 0) return;
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof IntersectionObserver !== "function" || reduceMotion) {
      for (const element of elements) element.classList.add("is-revealed");
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
    for (const element of elements) observer.observe(element);
    return () => {
      observer.disconnect();
      document.body.classList.remove("js-reveal");
    };
  }, []);
  return null;
}
