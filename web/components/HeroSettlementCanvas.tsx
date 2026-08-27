"use client";

import { useEffect, useRef } from "react";

/**
 * Settlement field: chaotic Stripe webhook events enter from the left in
 * mixed hues, cross the event-inbox gate, and settle into an ordered
 * phosphor entitlement lattice that accumulates on the right.
 *
 * Canvas 2D on purpose (design-brief ruling): the composition is flat,
 * particle counts stay small, and the glow is a pre-rendered
 * radial-gradient sprite drawn with additive blending. No WebGL, no
 * animation libraries.
 *
 * Budget and degradation:
 * - DPR clamped at 2; ~220 particles desktop, ~90 mobile.
 * - rAF pauses when the hero is offscreen or the tab is hidden.
 * - prefers-reduced-motion renders one static settled frame (no loop).
 * - The canvas is aria-hidden; no-JS keeps the plain dark hero.
 */

type Rgb = readonly [number, number, number];

const PHOSPHOR: Rgb = [86, 227, 159];
const CHAOS_HUES: readonly Rgb[] = [
  [86, 227, 159], // phosphor: some deliveries are already clean
  [228, 182, 92], // amber: retries and period-end noise
  [242, 109, 95], // red: refunds and disputes
  [157, 175, 164], // ink-dim: unrecognized chatter
];

const GATE_X = 0.52;
const LATTICE_X0 = 0.6;
const LATTICE_X1 = 0.94;
const LATTICE_Y0 = 0.18;
const LATTICE_Y1 = 0.84;
const LATTICE_ROWS = 9;

interface Particle {
  x: number;
  y: number;
  vx: number;
  wobble: number;
  amp: number;
  hue: number;
  mix: number;
  slot: number;
  settled: boolean;
  hold: number;
  ghost: boolean;
  alpha: number;
  releasing: boolean;
}

function makeSprite(rgb: Rgb): HTMLCanvasElement {
  const sprite = document.createElement("canvas");
  sprite.width = 48;
  sprite.height = 48;
  const spriteContext = sprite.getContext("2d");
  if (spriteContext) {
    const glow = spriteContext.createRadialGradient(24, 24, 0, 24, 24, 24);
    glow.addColorStop(0, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.6)`);
    glow.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
    spriteContext.fillStyle = glow;
    spriteContext.fillRect(0, 0, 48, 48);
  }
  return sprite;
}

export function HeroSettlementCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    // jsdom and very old browsers: keep the plain dark hero (no-JS parity).
    if (typeof window.matchMedia !== "function") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const chaosSprites = CHAOS_HUES.map(makeSprite);
    const settledSprite = makeSprite(PHOSPHOR);

    let width = 0;
    let height = 0;
    let particles: Particle[] = [];
    let freeSlots: number[] = [];
    let slotCount = 0;
    let frame = 0;
    let last = 0;
    let clock = 0;
    let inView = true;

    const slotX = (slot: number): number => {
      const columns = Math.max(1, Math.ceil(slotCount / LATTICE_ROWS));
      const column = Math.floor(slot / LATTICE_ROWS);
      const span = (LATTICE_X1 - LATTICE_X0) * width;
      return LATTICE_X0 * width + (columns === 1 ? 0 : (column * span) / (columns - 1));
    };

    const slotY = (slot: number): number => {
      const row = slot % LATTICE_ROWS;
      const span = (LATTICE_Y1 - LATTICE_Y0) * height;
      return LATTICE_Y0 * height + (row * span) / (LATTICE_ROWS - 1);
    };

    const spawn = (particle: Particle, pairY: number | null): void => {
      particle.x = -width * (0.02 + Math.random() * 0.08);
      particle.y =
        pairY === null ? height * (0.08 + Math.random() * 0.84) : pairY + 7;
      particle.vx = width * (0.05 + Math.random() * 0.05);
      particle.wobble = Math.random() * Math.PI * 2;
      particle.amp = 14 + Math.random() * 26;
      particle.hue = Math.floor(Math.random() * CHAOS_HUES.length);
      particle.mix = 0;
      particle.slot = -1;
      particle.settled = false;
      particle.hold = 0;
      particle.ghost = pairY !== null;
      particle.alpha = 0;
      particle.releasing = false;
    };

    const respawn = (particle: Particle): void => {
      if (particle.slot >= 0) {
        freeSlots.push(particle.slot);
        freeSlots.sort((a, b) => a - b);
      }
      // A slice of deliveries are duplicates: spawn as a ghost twin that
      // merges (fades) at the inbox gate instead of settling twice.
      let pairY: number | null = null;
      if (Math.random() < 0.18 && particles.length > 0) {
        const partner = particles[Math.floor(Math.random() * particles.length)];
        if (partner !== particle && !partner.settled && partner.slot < 0) {
          pairY = partner.y;
        }
      }
      spawn(particle, pairY);
    };

    const initialize = (settledFraction: number): void => {
      const target = window.innerWidth < 720 ? 90 : 220;
      slotCount = Math.round(target * 0.62);
      particles = [];
      freeSlots = [];
      for (let index = 0; index < slotCount; index += 1) freeSlots.push(index);
      const settledTarget = Math.min(
        slotCount,
        Math.round(target * settledFraction),
      );
      for (let index = 0; index < target; index += 1) {
        const particle: Particle = {
          x: 0,
          y: 0,
          vx: 0,
          wobble: 0,
          amp: 0,
          hue: 0,
          mix: 0,
          slot: -1,
          settled: false,
          hold: 0,
          ghost: false,
          alpha: 0,
          releasing: false,
        };
        spawn(particle, null);
        if (index < settledTarget && freeSlots.length > 0) {
          particle.slot = freeSlots.shift() ?? -1;
          particle.settled = true;
          particle.mix = 1;
          particle.alpha = 1;
          particle.hold = 6 + Math.random() * 16;
        } else {
          // Pre-scatter the field so the first frame already tells the story.
          particle.x = width * Math.random() * GATE_X;
          particle.alpha = 0.4 + Math.random() * 0.55;
        }
        particles.push(particle);
      }
    };

    const step = (dt: number): void => {
      clock += dt;
      const gate = GATE_X * width;
      for (const particle of particles) {
        if (particle.settled) {
          if (!particle.releasing) {
            particle.alpha = Math.min(1, particle.alpha + dt * 2);
            particle.hold -= dt;
            if (particle.hold <= 0) particle.releasing = true;
          } else {
            particle.alpha -= dt * 2.4;
            if (particle.alpha <= 0) respawn(particle);
          }
          continue;
        }
        if (particle.slot >= 0) {
          const targetX = slotX(particle.slot);
          const targetY = slotY(particle.slot);
          const ease = 1 - Math.exp(-4.5 * dt);
          particle.x += (targetX - particle.x) * ease;
          particle.y += (targetY - particle.y) * ease;
          particle.mix = Math.min(1, particle.mix + dt * 2.2);
          if (
            Math.abs(targetX - particle.x) < 0.6 &&
            Math.abs(targetY - particle.y) < 0.6
          ) {
            particle.settled = true;
            particle.hold = 8 + Math.random() * 14;
          }
          continue;
        }
        particle.alpha = Math.min(
          particle.ghost ? 0.7 : 0.95,
          particle.alpha + dt * 1.5,
        );
        particle.x += particle.vx * dt;
        particle.y += Math.sin(clock * 1.7 + particle.wobble) * particle.amp * dt;
        if (particle.y < height * 0.05) particle.y = height * 0.05;
        if (particle.y > height * 0.95) particle.y = height * 0.95;
        if (particle.ghost) {
          if (particle.x >= gate - width * 0.03) {
            particle.x = Math.min(particle.x, gate - 2);
            particle.alpha -= dt * 3.2;
            if (particle.alpha <= 0) respawn(particle);
          }
        } else if (particle.x >= gate) {
          const slot = freeSlots.shift();
          if (slot === undefined) {
            respawn(particle);
          } else {
            particle.slot = slot;
          }
        }
      }
    };

    const draw = (): void => {
      context.clearRect(0, 0, width, height);
      const gate = GATE_X * width;
      // Event-inbox gate: one hairline with a whisper of phosphor.
      context.fillStyle = "rgba(86, 227, 159, 0.05)";
      context.fillRect(gate - 3, height * 0.06, 7, height * 0.88);
      context.fillStyle = "rgba(47, 66, 55, 0.95)";
      context.fillRect(gate, height * 0.06, 1, height * 0.88);

      for (const particle of particles) {
        const alpha = Math.max(0, Math.min(1, particle.alpha));
        if (alpha <= 0) continue;
        const x = particle.settled ? slotX(particle.slot) : particle.x;
        const y = particle.settled ? slotY(particle.slot) : particle.y;
        const chaos = CHAOS_HUES[particle.hue];
        const mix = particle.mix;
        const glowSize = particle.settled ? 15 : 19;
        context.globalCompositeOperation = "lighter";
        if (mix < 1) {
          context.globalAlpha = alpha * (1 - mix) * 0.9;
          context.drawImage(
            chaosSprites[particle.hue],
            x - glowSize / 2,
            y - glowSize / 2,
            glowSize,
            glowSize,
          );
        }
        if (mix > 0) {
          context.globalAlpha = alpha * mix * 0.9;
          context.drawImage(
            settledSprite,
            x - glowSize / 2,
            y - glowSize / 2,
            glowSize,
            glowSize,
          );
        }
        context.globalCompositeOperation = "source-over";
        context.globalAlpha = alpha;
        context.fillStyle = `rgb(${Math.round(chaos[0] + (PHOSPHOR[0] - chaos[0]) * mix)}, ${Math.round(chaos[1] + (PHOSPHOR[1] - chaos[1]) * mix)}, ${Math.round(chaos[2] + (PHOSPHOR[2] - chaos[2]) * mix)})`;
        context.beginPath();
        context.arc(x, y, particle.settled ? 1.7 : 2, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    };

    const tick = (now: number): void => {
      const dt = last === 0 ? 0.016 : Math.min((now - last) / 1000, 0.05);
      last = now;
      step(dt);
      draw();
      frame = window.requestAnimationFrame(tick);
    };

    const updateRunState = (): void => {
      const shouldRun = inView && !document.hidden && !reducedMotion.matches;
      if (shouldRun && frame === 0) {
        last = 0;
        frame = window.requestAnimationFrame(tick);
      } else if (!shouldRun && frame !== 0) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
    };

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const target = window.innerWidth < 720 ? 90 : 220;
      if (particles.length !== target) {
        initialize(reducedMotion.matches ? 0.85 : 0.55);
      }
      if (reducedMotion.matches) draw();
    };

    const onMotionPreferenceChange = (): void => {
      initialize(reducedMotion.matches ? 0.85 : 0.55);
      draw();
      updateRunState();
    };

    resize();
    updateRunState();

    const disposers: Array<() => void> = [];
    if (typeof ResizeObserver === "function") {
      const resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(canvas);
      disposers.push(() => resizeObserver.disconnect());
    } else {
      const onResize = (): void => resize();
      window.addEventListener("resize", onResize);
      disposers.push(() => window.removeEventListener("resize", onResize));
    }
    if (typeof IntersectionObserver === "function") {
      const intersectionObserver = new IntersectionObserver((entries) => {
        inView = entries.some((entry) => entry.isIntersecting);
        updateRunState();
      });
      intersectionObserver.observe(canvas);
      disposers.push(() => intersectionObserver.disconnect());
    }
    const onVisibilityChange = (): void => updateRunState();
    document.addEventListener("visibilitychange", onVisibilityChange);
    reducedMotion.addEventListener("change", onMotionPreferenceChange);

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      frame = 0;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      reducedMotion.removeEventListener("change", onMotionPreferenceChange);
      for (const dispose of disposers) dispose();
    };
  }, []);

  return <canvas aria-hidden="true" className="hero-canvas" ref={canvasRef} />;
}
