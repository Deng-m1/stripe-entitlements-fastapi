import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeroWaveCanvas } from "@/components/HeroWaveCanvas";

/**
 * jsdom has no WebGL and no IntersectionObserver, which is exactly the
 * degraded environment the host component has to survive: it must render the
 * static poster, mount no renderer, and never reach for the three.js chunk.
 */

function withMatchMedia(reducedMotion: boolean) {
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: reducedMotion,
      addEventListener: (_: string, handler: () => void) =>
        listeners.add(handler),
      removeEventListener: (_: string, handler: () => void) =>
        listeners.delete(handler),
    })),
  );
  return listeners;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HeroWaveCanvas", () => {
  it("renders an art-directed decorative poster with WebP sources", () => {
    withMatchMedia(false);
    const { container } = render(<HeroWaveCanvas />);

    const layer = container.querySelector(".hero-wave");
    expect(layer).not.toBeNull();
    expect(layer).toHaveAttribute("aria-hidden", "true");

    const sources = container.querySelectorAll("picture source");
    expect(sources).toHaveLength(2);
    expect(sources[0]).toHaveAttribute("media", "(max-width: 719px)");
    expect(sources[0]).toHaveAttribute("type", "image/webp");
    expect(sources[1].getAttribute("srcSet")).toMatch(/1x,.*2x/);

    const poster = container.querySelector("picture img");
    expect(poster).toHaveAttribute("src", "/hero-wave-desktop.png");
    // Decorative: it must stay out of the accessibility tree entirely.
    expect(poster).toHaveAttribute("alt", "");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("mounts no renderer when the platform cannot supply a WebGL context", () => {
    withMatchMedia(false);
    const { container } = render(<HeroWaveCanvas />);

    expect(container.querySelector("canvas")).toBeNull();
    // The poster is still the visible frame, so the handover never fires.
    expect(container.querySelector(".hero-wave")).not.toHaveAttribute(
      "data-drawn",
    );
  });

  it("keeps the renderer unmounted when reduced motion is requested", () => {
    withMatchMedia(true);
    const { container } = render(<HeroWaveCanvas />);

    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector("picture")).not.toBeNull();
  });
});
