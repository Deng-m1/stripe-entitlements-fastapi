/**
 * Folded-sheet geometry for the hero wave.
 *
 * The surface is an analytic parametric sheet over (u, v) in [0,1]^2. Keeping
 * it analytic matters twice over: the worker can emit exact vertex normals
 * without a second averaging pass over the index buffer, and the unit tests can
 * check those normals against central finite differences of the same surface.
 *
 * The module is deliberately free of any `three` import so it can run inside a
 * Worker, inside jsdom, and inside Node without pulling a renderer in.
 */

/** Reciprocal golden ratio: an irrational harmonic keeps folds from repeating. */
const INVERSE_GOLDEN_RATIO = 0.6180339887498949;

/** Weight of the third harmonic, and the divisor that keeps `fold` in [-1, 1]. */
const DRIFT_WEIGHT = 0.22;

export interface WaveGeometryOptions {
  /** Sheet extent along x, in world units. */
  width: number;
  /** Sheet extent along y, in world units. */
  height: number;
  /** Quads across x. The vertex grid is one larger. */
  segmentsX: number;
  /** Quads across y. The vertex grid is one larger. */
  segmentsY: number;
  /** Number of full fold periods across the skewed fold axis. */
  foldCount: number;
  /** Peak displacement along z, in world units. */
  foldDepth: number;
  /** Angle of the fold axis, in radians. 0 folds across x only. */
  foldSkew: number;
  /**
   * Bends the fold axis into a parabola across v. At 0 the creases are
   * straight diagonals, which reads as folded card rather than as cloth.
   */
  foldCurvature: number;
  /**
   * Blend from a single smooth fold (0) toward a creased double-frequency fold
   * (1). Stripe's sheet sits near 0.35: readable creases, no hard ridges.
   */
  crestSharpness: number;
}

export interface WaveGeometryData {
  /** xyz per vertex. */
  position: Float32Array;
  /** Unit surface normal per vertex, always +z facing. */
  normal: Float32Array;
  /** uv per vertex, both in [0, 1]. */
  uv: Float32Array;
  /** Signed fold field per vertex in [-1, 1]; drives the palette lookup. */
  fold: Float32Array;
  index: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

export const DEFAULT_WAVE_GEOMETRY: WaveGeometryOptions = {
  width: 4.0,
  height: 2.35,
  segmentsX: 256,
  segmentsY: 176,
  // Fewer, broader ribbons: the zh-us hero is two or three wide overlapping
  // sweeps, not a comb of thin bands. A high fold count reads as corrugation.
  foldCount: 2.2,
  foldDepth: 0.56,
  foldSkew: 0.62,
  // Round 3: the crease lines used to read as near-straight diagonals, which
  // over a white canvas look like ruled creases in paper rather than the
  // sweeping arcs of the stripe.com/zh-us ribbon. Bending the fold axis this
  // hard is what turns the bands into curves.
  foldCurvature: 1.15,
  crestSharpness: 0.3,
};

/**
 * Segment counts by rendered CSS width. Regenerating on tier change keeps a
 * 390px phone off a 90k-vertex sheet without giving a 1600px desktop a coarse
 * one. Tiers are matched low-to-high on `maxWidth`.
 */
const QUALITY_TIERS: ReadonlyArray<{
  maxWidth: number;
  segmentsX: number;
  segmentsY: number;
}> = [
  { maxWidth: 700, segmentsX: 128, segmentsY: 88 },
  { maxWidth: 1200, segmentsX: 192, segmentsY: 132 },
  { maxWidth: Number.POSITIVE_INFINITY, segmentsX: 288, segmentsY: 196 },
];

export function waveQualityTier(width: number): {
  segmentsX: number;
  segmentsY: number;
} {
  const tier =
    QUALITY_TIERS.find((candidate) => width <= candidate.maxWidth) ??
    QUALITY_TIERS[QUALITY_TIERS.length - 1];
  return { segmentsX: tier.segmentsX, segmentsY: tier.segmentsY };
}

/**
 * Fold field and its derivative with respect to the skewed axis `s`.
 *
 * f(s)  = (w0·sin p + w1·sin(2p + 1.7) + w2·sin(φ⁻¹p + 0.6)) / (1 + w2)
 * f'(s) = q · (w0·cos p + 2w1·cos(2p + 1.7) + φ⁻¹w2·cos(φ⁻¹p + 0.6)) / (1 + w2)
 * where p = q·s and q = 2π·foldCount.
 */
function foldField(
  s: number,
  foldCount: number,
  crestSharpness: number,
): { value: number; slope: number } {
  const q = Math.PI * 2 * foldCount;
  const p = q * s;
  const w0 = 1 - crestSharpness;
  const w1 = crestSharpness;
  const scale = 1 / (1 + DRIFT_WEIGHT);
  const value =
    (w0 * Math.sin(p) +
      w1 * Math.sin(2 * p + 1.7) +
      DRIFT_WEIGHT * Math.sin(INVERSE_GOLDEN_RATIO * p + 0.6)) *
    scale;
  const slope =
    q *
    (w0 * Math.cos(p) +
      2 * w1 * Math.cos(2 * p + 1.7) +
      INVERSE_GOLDEN_RATIO *
        DRIFT_WEIGHT *
        Math.cos(INVERSE_GOLDEN_RATIO * p + 0.6)) *
    scale;
  return { value, slope };
}

/** Camber envelope across v, flattening the sheet toward its long edges. */
function camber(v: number): { value: number; slope: number } {
  const t = (v - 0.5) * Math.PI;
  return {
    value: 0.35 + 0.65 * Math.cos(t),
    slope: -0.65 * Math.PI * Math.sin(t),
  };
}

/** Evaluates the sheet at (u, v): world position, exact normal, fold value. */
export function sampleWaveSurface(
  u: number,
  v: number,
  options: WaveGeometryOptions,
): {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  fold: number;
} {
  const {
    width,
    height,
    foldDepth,
    foldCount,
    foldSkew,
    foldCurvature,
    crestSharpness,
  } = options;
  const skewU = Math.cos(foldSkew);
  // s(u, v) = u·cos θ + v·sin θ + c·(v − ½)², so ∂s/∂v picks up the 2c(v − ½).
  const centred = v - 0.5;
  const skewV = Math.sin(foldSkew) + 2 * foldCurvature * centred;
  const s = u * skewU + v * Math.sin(foldSkew) + foldCurvature * centred * centred;

  const fold = foldField(s, foldCount, crestSharpness);
  const envelope = camber(v);

  const x = (u - 0.5) * width;
  const y = (v - 0.5) * height;
  const z = foldDepth * fold.value * envelope.value;

  // dz/du and dz/dv by the chain and product rules on z(u, v) above.
  const dzdu = foldDepth * fold.slope * skewU * envelope.value;
  const dzdv =
    foldDepth *
    (fold.slope * skewV * envelope.value + fold.value * envelope.slope);

  // cross((width, 0, dzdu), (0, height, dzdv)) = (-height·dzdu, -width·dzdv, width·height)
  const cx = -height * dzdu;
  const cy = -width * dzdv;
  const cz = width * height;
  const length = Math.hypot(cx, cy, cz) || 1;

  return {
    x,
    y,
    z,
    nx: cx / length,
    ny: cy / length,
    nz: cz / length,
    fold: fold.value,
  };
}

/** Builds the full interleaved-by-attribute buffer set for the folded sheet. */
export function createWaveGeometryData(
  options: WaveGeometryOptions,
): WaveGeometryData {
  const { segmentsX, segmentsY } = options;
  if (!Number.isInteger(segmentsX) || !Number.isInteger(segmentsY)) {
    throw new TypeError("Wave geometry segment counts must be integers.");
  }
  if (segmentsX < 1 || segmentsY < 1) {
    throw new RangeError("Wave geometry needs at least one quad per axis.");
  }

  const columns = segmentsX + 1;
  const rows = segmentsY + 1;
  const vertexCount = columns * rows;
  const triangleCount = segmentsX * segmentsY * 2;

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const fold = new Float32Array(vertexCount);
  const index = new Uint32Array(triangleCount * 3);

  for (let row = 0; row < rows; row += 1) {
    const v = row / segmentsY;
    for (let column = 0; column < columns; column += 1) {
      const u = column / segmentsX;
      const vertex = row * columns + column;
      const sample = sampleWaveSurface(u, v, options);

      position[vertex * 3] = sample.x;
      position[vertex * 3 + 1] = sample.y;
      position[vertex * 3 + 2] = sample.z;
      normal[vertex * 3] = sample.nx;
      normal[vertex * 3 + 1] = sample.ny;
      normal[vertex * 3 + 2] = sample.nz;
      uv[vertex * 2] = u;
      uv[vertex * 2 + 1] = v;
      fold[vertex] = sample.fold;
    }
  }

  let cursor = 0;
  for (let row = 0; row < segmentsY; row += 1) {
    for (let column = 0; column < segmentsX; column += 1) {
      const a = row * columns + column;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      index[cursor] = a;
      index[cursor + 1] = c;
      index[cursor + 2] = b;
      index[cursor + 3] = b;
      index[cursor + 4] = c;
      index[cursor + 5] = d;
      cursor += 6;
    }
  }

  return { position, normal, uv, fold, index, vertexCount, triangleCount };
}

/**
 * The backing buffers, in the order `postMessage` should transfer them. After a
 * transfer the source arrays are detached, so a worker must not touch the data
 * again once it has posted it.
 */
export function waveGeometryTransferables(
  data: WaveGeometryData,
): ArrayBuffer[] {
  return [
    data.position.buffer as ArrayBuffer,
    data.normal.buffer as ArrayBuffer,
    data.uv.buffer as ArrayBuffer,
    data.fold.buffer as ArrayBuffer,
    data.index.buffer as ArrayBuffer,
  ];
}
