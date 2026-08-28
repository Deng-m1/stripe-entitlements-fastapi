import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrollMotion } from "@/components/ScrollMotion";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

/**
 * jsdom has no CSS scroll timelines, which is exactly the environment where
 * ScrollMotion must act as the polyfill: a rAF-synced scroll listener writing
 * --scroll-progress / --scroll-exit onto its data-attribute contracts. The
 * native-support and reduced-motion paths must both leave the DOM untouched.
 */

interface MediaState {
  matches: boolean;
}

function withMatchMedia(state: MediaState) {
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return state.matches;
      },
      addEventListener: (_: string, handler: () => void) =>
        listeners.add(handler),
      removeEventListener: (_: string, handler: () => void) =>
        listeners.delete(handler),
    })),
  );
  return listeners;
}

function withScrollEnvironment({
  nativeTimelines = false,
  scrollY = 0,
  innerHeight = 800,
} = {}) {
  vi.stubGlobal("CSS", { supports: vi.fn(() => nativeTimelines) });
  vi.stubGlobal("scrollY", scrollY);
  vi.stubGlobal("innerHeight", innerHeight);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
}

function addTarget(
  attribute: "data-parallax" | "data-scroll-drift",
  { top, height }: { top: number; height: number },
): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute(attribute, "");
  Object.defineProperty(element, "offsetTop", { value: top });
  Object.defineProperty(element, "offsetHeight", { value: height });
  document.body.appendChild(element);
  return element;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document
    .querySelectorAll("[data-parallax], [data-scroll-drift]")
    .forEach((node) => node.remove());
});

describe("ScrollMotion", () => {
  it("writes view-cover progress onto [data-parallax] elements", async () => {
    withMatchMedia({ matches: false });
    withScrollEnvironment();
    // Element top at 1000px with an 800px viewport: offscreen below at load.
    const layer = addTarget("data-parallax", { top: 1000, height: 200 });

    render(<ScrollMotion />);
    expect(layer.style.getPropertyValue("--scroll-progress")).toBe("0.0000");

    // Scrolled 700px: (700 + 800 - 1000) / (800 + 200) = 0.5 — centered.
    vi.stubGlobal("scrollY", 700);
    window.dispatchEvent(new Event("scroll"));
    await waitFor(() =>
      expect(layer.style.getPropertyValue("--scroll-progress")).toBe("0.5000"),
    );
  });

  it("writes exit progress onto [data-scroll-drift] elements", async () => {
    withMatchMedia({ matches: false });
    withScrollEnvironment();
    const hero = addTarget("data-scroll-drift", { top: 0, height: 900 });

    render(<ScrollMotion />);
    // Parked at the top: the hero has not started leaving yet.
    expect(hero.style.getPropertyValue("--scroll-exit")).toBe("0.0000");
    expect(hero.style.getPropertyValue("--scroll-progress")).toBe("");

    vi.stubGlobal("scrollY", 450);
    window.dispatchEvent(new Event("scroll"));
    await waitFor(() =>
      expect(hero.style.getPropertyValue("--scroll-exit")).toBe("0.5000"),
    );
  });

  it("clamps progress to the [0, 1] range", async () => {
    withMatchMedia({ matches: false });
    withScrollEnvironment({ scrollY: 5000 });
    const layer = addTarget("data-parallax", { top: 1000, height: 200 });
    const hero = addTarget("data-scroll-drift", { top: 0, height: 900 });

    render(<ScrollMotion />);
    expect(layer.style.getPropertyValue("--scroll-progress")).toBe("1.0000");
    expect(hero.style.getPropertyValue("--scroll-exit")).toBe("1.0000");
  });

  it("stays inert when the browser animates scroll timelines natively", () => {
    withMatchMedia({ matches: false });
    withScrollEnvironment({ nativeTimelines: true });
    const layer = addTarget("data-parallax", { top: 1000, height: 200 });

    render(<ScrollMotion />);
    window.dispatchEvent(new Event("scroll"));
    expect(layer.style.getPropertyValue("--scroll-progress")).toBe("");
  });

  it("stays inert under prefers-reduced-motion", () => {
    withMatchMedia({ matches: true });
    withScrollEnvironment();
    const layer = addTarget("data-parallax", { top: 1000, height: 200 });
    const hero = addTarget("data-scroll-drift", { top: 0, height: 900 });

    render(<ScrollMotion />);
    window.dispatchEvent(new Event("scroll"));
    expect(layer.style.getPropertyValue("--scroll-progress")).toBe("");
    expect(hero.style.getPropertyValue("--scroll-exit")).toBe("");
  });

  it("clears its variables when reduced motion turns on mid-session", async () => {
    const media = { matches: false };
    const listeners = withMatchMedia(media);
    withScrollEnvironment();
    const layer = addTarget("data-parallax", { top: 1000, height: 200 });

    render(<ScrollMotion />);
    expect(layer.style.getPropertyValue("--scroll-progress")).toBe("0.0000");

    media.matches = true;
    listeners.forEach((listener) => listener());
    await waitFor(() =>
      expect(layer.style.getPropertyValue("--scroll-progress")).toBe(""),
    );
  });

  it("picks up progress consumers mounted after a client fetch", async () => {
    withMatchMedia({ matches: false });
    withScrollEnvironment();

    render(<ScrollMotion />);
    const late = addTarget("data-parallax", { top: 1000, height: 200 });
    await waitFor(() =>
      expect(late.style.getPropertyValue("--scroll-progress")).toBe("0.0000"),
    );
  });

  it("removes its inline variables on unmount", () => {
    withMatchMedia({ matches: false });
    withScrollEnvironment();
    const layer = addTarget("data-parallax", { top: 1000, height: 200 });

    const { unmount } = render(<ScrollMotion />);
    expect(layer.style.getPropertyValue("--scroll-progress")).toBe("0.0000");
    unmount();
    expect(layer.style.getPropertyValue("--scroll-progress")).toBe("");
  });
});
