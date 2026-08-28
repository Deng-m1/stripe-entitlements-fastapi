import { describe, expect, it } from "vitest";
import {
  createPaletteRamp,
  HERO_WAVE_PALETTE,
  MESH_STOPS,
  PALETTE_TEXTURE_WIDTH,
  type PaletteStop,
} from "@/lib/hero-wave-palette";

function hueOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const chroma = max - Math.min(r, g, b);
  if (chroma === 0) return 0;
  let hue;
  if (max === r) hue = ((g - b) / chroma + 6) % 6;
  else if (max === g) hue = (b - r) / chroma + 2;
  else hue = (r - g) / chroma + 4;
  return hue * 60;
}

describe("hero wave palette ramp", () => {
  it("rasterizes an opaque RGBA ramp of the requested width", () => {
    const ramp = createPaletteRamp();

    expect(ramp).toHaveLength(PALETTE_TEXTURE_WIDTH * 4);
    for (let texel = 0; texel < PALETTE_TEXTURE_WIDTH; texel += 1) {
      expect(ramp[texel * 4 + 3]).toBe(255);
    }
  });

  it("reproduces the endpoint stops exactly", () => {
    const ramp = createPaletteRamp();
    const last = PALETTE_TEXTURE_WIDTH - 1;
    const first = HERO_WAVE_PALETTE[0].color;
    const final = HERO_WAVE_PALETTE[HERO_WAVE_PALETTE.length - 1].color;

    expect([ramp[0], ramp[1], ramp[2]]).toEqual([...first]);
    expect([ramp[last * 4], ramp[last * 4 + 1], ramp[last * 4 + 2]]).toEqual([
      ...final,
    ]);
  });

  it("interpolates in linear light, not in sRGB bytes", () => {
    // The sRGB midpoint of 0 and 255 is 128; the linear-light midpoint is the
    // perceptually brighter 188. Blending sRGB bytes would darken every crest.
    const stops: PaletteStop[] = [
      { offset: 0, color: [0, 0, 0] },
      { offset: 1, color: [255, 255, 255] },
    ];
    const ramp = createPaletteRamp(stops, 3);

    expect(ramp[4]).toBe(188);
    expect(ramp[4]).toBe(ramp[5]);
    expect(ramp[4]).toBe(ramp[6]);
  });

  it("passes through every declared stop at its own offset", () => {
    const ramp = createPaletteRamp();

    for (const stop of HERO_WAVE_PALETTE) {
      const texel = Math.round(stop.offset * (PALETTE_TEXTURE_WIDTH - 1));
      const sampled = [
        ramp[texel * 4],
        ramp[texel * 4 + 1],
        ramp[texel * 4 + 2],
      ];
      // Tolerance covers the sub-texel rounding of offsets that do not land on
      // an exact texel centre; a segment-selection bug misses by far more.
      for (let channel = 0; channel < 3; channel += 1) {
        expect(Math.abs(sampled[channel] - stop.color[channel])).toBeLessThan(4);
      }
    }
  });

  it("anchors on the four normative mesh stops in ramp order", () => {
    // DESIGN_SYSTEM.md §3.2 fixes both the values and their violet → pink →
    // orange → lemon order; the shader and the poster both read this ramp.
    const anchors = [
      MESH_STOPS.violet,
      MESH_STOPS.pink,
      MESH_STOPS.orange,
      MESH_STOPS.lemon,
    ];
    const offsets = anchors.map((anchor) => {
      const stop = HERO_WAVE_PALETTE.find(
        (candidate) => String(candidate.color) === String(anchor),
      );
      expect(stop, `missing mesh anchor ${anchor}`).toBeDefined();
      return stop?.offset ?? -1;
    });

    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it("advances hue in one direction from periwinkle to lemon", () => {
    // Round 3 asserted that red rose monotonically, which is only a proxy for
    // "the ramp warms up" and rules out the cool lead-in the reference has.
    // The real invariant is directional hue: the ramp must sweep one way round
    // the wheel and never double back, because the shader lays it across the
    // fan and a fold-back would put the same hue on two different ribbons.
    const ramp = createPaletteRamp();
    const hues: number[] = [];
    let turns = 0;

    for (let texel = 0; texel < PALETTE_TEXTURE_WIDTH; texel += 1) {
      const hue = hueOf(ramp[texel * 4], ramp[texel * 4 + 1], ramp[texel * 4 + 2]);
      const previous = hues[hues.length - 1];
      // Unwrap across the 360-to-0 seam the pink-to-coral crossover sits on.
      if (previous !== undefined && hue + turns * 360 < previous - 180) turns += 1;
      hues.push(hue + turns * 360);
    }

    for (let texel = 1; texel < hues.length; texel += 1) {
      expect(hues[texel]).toBeGreaterThanOrEqual(hues[texel - 1] - 1.5);
    }
    // Periwinkle in, lemon out, the long way round through magenta.
    expect(hues[0]).toBeGreaterThan(200);
    expect(hues[0]).toBeLessThan(240);
    expect(hues[hues.length - 1] - hues[0]).toBeGreaterThan(160);
  });

  it("visits every arc the reference hero spends its pixels in", () => {
    // scripts/hero-hue-histogram.mjs against the captured reference: roughly a
    // fifth of its saturated pixels are cool (210-270), a quarter are magenta
    // (285-330) and a third are warm (15-45). A ramp that skips an arc cannot
    // put it on screen however the shader samples it.
    const ramp = createPaletteRamp();
    const covered = (from: number, to: number) => {
      for (let texel = 0; texel < PALETTE_TEXTURE_WIDTH; texel += 1) {
        const hue = hueOf(ramp[texel * 4], ramp[texel * 4 + 1], ramp[texel * 4 + 2]);
        if (hue >= from && hue <= to) return true;
      }
      return false;
    };

    expect(covered(210, 270), "cool periwinkle arc").toBe(true);
    expect(covered(285, 330), "magenta arc").toBe(true);
    expect(covered(330, 360), "pink arc").toBe(true);
    expect(covered(15, 45), "amber arc").toBe(true);
  });

  it("rejects ramps that cannot be sampled", () => {
    expect(() => createPaletteRamp([HERO_WAVE_PALETTE[0]])).toThrow(RangeError);
    expect(() =>
      createPaletteRamp([
        { offset: 0.5, color: [0, 0, 0] },
        { offset: 0.2, color: [255, 255, 255] },
      ]),
    ).toThrow(/does not ascend/);
    expect(() =>
      createPaletteRamp([
        { offset: 0, color: [0, 0, 0] },
        { offset: 1.4, color: [255, 255, 255] },
      ]),
    ).toThrow(/outside \[0, 1\]/);
    expect(() => createPaletteRamp(HERO_WAVE_PALETTE, 1)).toThrow(RangeError);
  });
});
