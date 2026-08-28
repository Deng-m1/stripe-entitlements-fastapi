/**
 * The hero wave palette, baked into a 1-D lookup texture.
 *
 * Sampling a ramp texture rather than chaining `mix()` calls in the fragment
 * shader is what keeps the violet → magenta → coral → amber transition smooth:
 * the GPU interpolates between adjacent texels in hardware, so adding a stop
 * costs nothing at draw time and the ramp can be unit-tested on the CPU.
 *
 * Interpolation happens in linear light. Blending sRGB bytes directly darkens
 * the midpoint of every pair of saturated stops, which is exactly where this
 * ramp spends most of its length.
 */

export interface PaletteStop {
  /** Ramp position in [0, 1]. Stops must be strictly ascending. */
  offset: number;
  /** sRGB bytes, 0-255. */
  color: readonly [number, number, number];
}

/**
 * The four normative `--mesh-*` stops from `DESIGN_SYSTEM.md` §3.2, in the
 * fixed violet → pink → orange → lemon order. These anchor the ramp; changing
 * them changes the shader, the static poster, and the CSS gradients together.
 */
export const MESH_STOPS = {
  violet: [122, 90, 248],
  pink: [255, 92, 143],
  orange: [255, 138, 60],
  lemon: [255, 212, 77],
} as const satisfies Record<string, readonly [number, number, number]>;

/**
 * The ramp the hero samples, with the four design-system anchors in their
 * fixed order and interleaved stops shaping where the ramp spends its length.
 *
 * The interleaved values are not invented. `scripts/stripe-hero-reference.mjs`
 * and `scripts/hero-hue-histogram.mjs` reduce the reference hero to the hues
 * it actually puts on screen and how much of the frame each covers, and the
 * two widest bands there are a magenta around hue 309 (16% of the reference's
 * saturated pixels) and an amber around hue 37 (18%). Round 3's ramp ran
 * straight from violet to pink and gave the magenta arc nowhere to live.
 *
 * The ramp also *leads in cool*. The reference spends roughly a fifth of its
 * saturated pixels between hue 210 and 270 — a light periwinkle, not a deep
 * indigo — which is the colour the ribbons turn where they tilt away from the
 * key light. Round 3 led in with `#562ed6`, darker and more saturated than
 * `--mesh-violet`, so the cool end of the ramp had nowhere to go but down into
 * shadow and never read as a distinct hue at all.
 */
export const HERO_WAVE_PALETTE: readonly PaletteStop[] = [
  { offset: 0.0, color: [150, 176, 236] },
  { offset: 0.07, color: [141, 154, 240] },
  { offset: 0.15, color: MESH_STOPS.violet },
  { offset: 0.24, color: [154, 106, 246] },
  { offset: 0.33, color: [193, 118, 240] },
  { offset: 0.43, color: [238, 116, 224] },
  { offset: 0.52, color: [252, 106, 190] },
  { offset: 0.6, color: MESH_STOPS.pink },
  { offset: 0.7, color: [255, 108, 98] },
  { offset: 0.82, color: MESH_STOPS.orange },
  { offset: 0.92, color: [255, 163, 45] },
  { offset: 1.0, color: MESH_STOPS.lemon },
];

/**
 * How much of the ramp's length each arc of the wheel gets.
 *
 * The offsets above are spaced to these proportions rather than spread evenly,
 * because ramp length is what decides on-screen area once the shader lays the
 * ramp across the fan. Measured on the reference hero, its coloured pixels
 * divide roughly 30% cool / 26% magenta / 39% warm; an evenly spaced ramp puts
 * two thirds of the hero in the cool half and leaves the amber — the single
 * widest band in the reference — as a stripe.
 */
export const RAMP_ARC_SHARE = {
  cool: [0, 0.3],
  magenta: [0.3, 0.6],
  warm: [0.6, 1],
} as const;

export const PALETTE_TEXTURE_WIDTH = 256;

function srgbByteToLinear(byte: number): number {
  const channel = byte / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function linearToSrgbByte(linear: number): number {
  const channel =
    linear <= 0.0031308
      ? linear * 12.92
      : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(channel * 255)));
}

function assertValidStops(stops: readonly PaletteStop[]): void {
  if (stops.length < 2) {
    throw new RangeError("A palette ramp needs at least two stops.");
  }
  for (let i = 0; i < stops.length; i += 1) {
    const { offset } = stops[i];
    if (!Number.isFinite(offset) || offset < 0 || offset > 1) {
      throw new RangeError(`Palette stop ${i} is outside [0, 1].`);
    }
    if (i > 0 && offset <= stops[i - 1].offset) {
      throw new RangeError(`Palette stop ${i} does not ascend.`);
    }
  }
}

/**
 * Rasterizes the ramp into RGBA bytes for a `width × 1` texture. Alpha is
 * always opaque; the shader owns the wave's own transparency.
 */
export function createPaletteRamp(
  stops: readonly PaletteStop[] = HERO_WAVE_PALETTE,
  width: number = PALETTE_TEXTURE_WIDTH,
): Uint8Array {
  assertValidStops(stops);
  if (!Number.isInteger(width) || width < 2) {
    throw new RangeError("A palette ramp needs at least two texels.");
  }

  const pixels = new Uint8Array(width * 4);
  let segment = 0;

  for (let texel = 0; texel < width; texel += 1) {
    const t = texel / (width - 1);
    while (segment < stops.length - 2 && t > stops[segment + 1].offset) {
      segment += 1;
    }
    const from = stops[segment];
    const to = stops[segment + 1];
    const span = to.offset - from.offset;
    const local = span === 0 ? 0 : Math.min(1, Math.max(0, (t - from.offset) / span));

    for (let channel = 0; channel < 3; channel += 1) {
      const a = srgbByteToLinear(from.color[channel]);
      const b = srgbByteToLinear(to.color[channel]);
      pixels[texel * 4 + channel] = linearToSrgbByte(a + (b - a) * local);
    }
    pixels[texel * 4 + 3] = 255;
  }

  return pixels;
}
