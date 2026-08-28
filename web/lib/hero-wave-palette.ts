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
 * Violet → magenta → coral → amber, read off the Stripe hero wave. The two
 * near-duplicate magenta stops slow the ramp through the fold crests, where
 * the surface spends the most screen area.
 */
export const HERO_WAVE_PALETTE: readonly PaletteStop[] = [
  { offset: 0.0, color: [86, 46, 214] },
  { offset: 0.14, color: [122, 62, 240] },
  { offset: 0.3, color: [166, 78, 240] },
  { offset: 0.44, color: [225, 84, 200] },
  { offset: 0.56, color: [255, 92, 152] },
  { offset: 0.68, color: [255, 108, 98] },
  { offset: 0.8, color: [255, 141, 61] },
  { offset: 0.9, color: [255, 180, 48] },
  { offset: 1.0, color: [255, 226, 92] },
];

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
