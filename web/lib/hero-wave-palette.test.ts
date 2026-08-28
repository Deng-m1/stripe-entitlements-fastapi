import { describe, expect, it } from "vitest";
import {
  createPaletteRamp,
  HERO_WAVE_PALETTE,
  PALETTE_TEXTURE_WIDTH,
  type PaletteStop,
} from "@/lib/hero-wave-palette";

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

  it("drives red monotonically from violet toward amber", () => {
    const ramp = createPaletteRamp();

    let previousRed = ramp[0];
    for (let texel = 1; texel < PALETTE_TEXTURE_WIDTH; texel += 1) {
      const red = ramp[texel * 4];
      expect(red).toBeGreaterThanOrEqual(previousRed);
      previousRed = red;
    }
    expect(previousRed).toBe(255);
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
