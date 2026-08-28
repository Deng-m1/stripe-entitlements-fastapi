/**
 * Ribbon-bundle geometry for the hero wave.
 *
 * Round 3 rendered one wide folded rectangle and dissolved its border with a
 * long alpha ramp. Measured against the reference (see
 * `scripts/hero-hue-histogram.mjs`), that shape fails twice: the dissolve
 * covers 67% of the frame in pastel where Stripe covers 28% in saturated
 * colour, and the rectangle's own corner keeps surfacing as a ruled diagonal
 * that then needs a CSS mask to hide. Stripe's hero is not a sheet with soft
 * edges — it is a **fan of tapering ribbons** whose silhouette is the shape.
 * Because each ribbon tapers to a point at both ends, its outline is produced
 * by the geometry, so the surface can stay fully opaque and fully saturated
 * and still meet the paper without a seam.
 *
 * Each ribbon is a twisted, curled strip swept along a quadratic Bezier spine:
 *
 *   P(t, s) = S(t) + s·w(t)·D(t) + c(t, s)·E(t)
 *
 * with (T, B, Z) an orthonormal frame on the planar spine, D and E the frame
 * rotated by the twist angle θ(t), w the taper, and c a parabolic curl across
 * the strip. Everything has a closed-form t- and s-derivative, so exact vertex
 * normals and tangents come out of the same evaluation the positions do, and
 * the unit tests can check them against central finite differences.
 *
 * The module imports nothing from `three` so it can run in a Worker, in jsdom,
 * and in Node without pulling a renderer in.
 */

/** Reciprocal golden ratio: an irrational per-ribbon phase avoids a visible beat. */
const INVERSE_GOLDEN_RATIO = 0.6180339887498949;

export interface WaveGeometryOptions {
  /** Ribbons in the fan. */
  ribbonCount: number;
  /** Quads along each ribbon's spine. The vertex grid is one larger. */
  segmentsAlong: number;
  /** Quads across each ribbon. The vertex grid is one larger. */
  segmentsAcross: number;
  /** Spine length of the middle ribbon, in world units. */
  length: number;
  /** Ratio of the shortest ribbon's length to the longest. */
  lengthFalloff: number;
  /** Total fan angle covered by the bundle, in radians. */
  spread: number;
  /** Peak half-width of the widest ribbon, in world units. */
  halfWidth: number;
  /** Ratio of the narrowest ribbon's half-width to the widest. */
  widthFalloff: number;
  /** Taper exponent at the root. Must be >= 1 to keep w' finite there. */
  rootTaper: number;
  /** Taper exponent at the tip. Higher is a sharper point. */
  tipTaper: number;
  /**
   * Width the taper never falls below, as a fraction of the peak. A ribbon
   * that reaches exactly zero has a degenerate cross product at its ends and
   * therefore no defined normal; a sliver two thousandths of the width wide
   * still reads as a point on screen.
   */
  tipFloor: number;
  /** Sideways offset of the spine's control point, as a fraction of length. */
  bend: number;
  /** Twist accumulated from root to tip, in radians. */
  twist: number;
  /** Depth of the parabolic curl across the strip, relative to its width. */
  curl: number;
  /** Depth range the ribbons are stacked over, in world units. */
  depthSpread: number;
}

export interface WaveGeometryData {
  /** xyz per vertex. */
  position: Float32Array;
  /** Unit surface normal per vertex. */
  normal: Float32Array;
  /** Unit along-spine tangent per vertex; the shader tilts normals with it. */
  tangent: Float32Array;
  /** uv per vertex: u runs root-to-tip, v runs across the strip. */
  uv: Float32Array;
  /** Fan position of the owning ribbon in [0, 1]; drives the palette lookup. */
  blade: Float32Array;
  index: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

export const DEFAULT_WAVE_GEOMETRY: WaveGeometryOptions = {
  ribbonCount: 6,
  segmentsAlong: 200,
  segmentsAcross: 24,
  length: 5.6,
  lengthFalloff: 0.62,
  spread: 0.62,
  halfWidth: 0.96,
  widthFalloff: 0.66,
  rootTaper: 1.15,
  tipTaper: 1.85,
  tipFloor: 0.02,
  bend: 0.26,
  twist: 1.35,
  curl: 0.62,
  depthSpread: 0.5,
};

/**
 * Subdivision by rendered CSS width. A ribbon needs far more resolution along
 * its spine than across it — the spine carries the bend, the twist and the
 * travelling wave, while the cross-section is a parabola that four quads
 * already resolve.
 */
const QUALITY_TIERS: ReadonlyArray<{
  maxWidth: number;
  segmentsAlong: number;
  segmentsAcross: number;
}> = [
  { maxWidth: 700, segmentsAlong: 104, segmentsAcross: 12 },
  { maxWidth: 1200, segmentsAlong: 152, segmentsAcross: 18 },
  { maxWidth: Number.POSITIVE_INFINITY, segmentsAlong: 216, segmentsAcross: 26 },
];

export function waveQualityTier(width: number): {
  segmentsAlong: number;
  segmentsAcross: number;
} {
  const tier =
    QUALITY_TIERS.find((candidate) => width <= candidate.maxWidth) ??
    QUALITY_TIERS[QUALITY_TIERS.length - 1];
  return {
    segmentsAlong: tier.segmentsAlong,
    segmentsAcross: tier.segmentsAcross,
  };
}

/** Fan parameter of ribbon `index` in [0, 1]; a lone ribbon sits mid-fan. */
export function ribbonFan(index: number, ribbonCount: number): number {
  return ribbonCount <= 1 ? 0.5 : index / (ribbonCount - 1);
}

interface Taper {
  value: number;
  slope: number;
}

/**
 * w(t) = floor + (1 − floor)·t^a·(1 − t)^b / peak, and its exact slope.
 *
 * Normalising by the peak keeps `halfWidth` meaning the widest half-width
 * whatever the exponents are, so the two tapers can be retuned without also
 * rescaling the bundle.
 */
function taper(t: number, rootTaper: number, tipTaper: number, floor: number): Taper {
  const peakAt = rootTaper / (rootTaper + tipTaper);
  const peak =
    Math.pow(peakAt, rootTaper) * Math.pow(1 - peakAt, tipTaper);
  const root = Math.pow(t, rootTaper);
  const tip = Math.pow(1 - t, tipTaper);
  const raw = root * tip;
  // d/dt [t^a (1−t)^b] = a·t^(a−1)(1−t)^b − b·t^a(1−t)^(b−1)
  const rawSlope =
    rootTaper * Math.pow(t, rootTaper - 1) * tip -
    tipTaper * root * Math.pow(1 - t, tipTaper - 1);
  const span = 1 - floor;
  return {
    value: floor + (span * raw) / peak,
    slope: (span * rawSlope) / peak,
  };
}

export interface RibbonSample {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  /** Unit tangent along the spine direction. */
  tx: number;
  ty: number;
  tz: number;
}

/**
 * Evaluates ribbon `ribbon` at spine parameter `t` and cross parameter
 * `s` in [-1, 1].
 */
export function sampleRibbonSurface(
  ribbon: number,
  t: number,
  s: number,
  options: WaveGeometryOptions,
): RibbonSample {
  const {
    ribbonCount,
    length,
    lengthFalloff,
    spread,
    halfWidth,
    widthFalloff,
    rootTaper,
    tipTaper,
    tipFloor,
    bend,
    twist,
    curl,
    depthSpread,
  } = options;

  const fan = ribbonFan(ribbon, ribbonCount);
  const centred = fan - 0.5;
  const angle = centred * spread;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);

  // Outer ribbons are shorter and narrower, which is what makes the bundle
  // read as one object seen in perspective rather than as a row of stripes.
  // `edge` is 0 mid-fan and 1 at either rim, so the falloffs are literally the
  // rim-to-middle ratios their names claim.
  const edge = Math.abs(centred) * 2;
  const taperedLength = length * (1 - (1 - lengthFalloff) * edge);
  const bladeWidth = halfWidth * (1 - (1 - widthFalloff) * edge);
  const depth = centred * depthSpread;

  // Quadratic Bezier spine: root at the local origin, tip along `angle`, with
  // the control point pushed sideways so the ribbon arcs instead of running
  // straight. Every ribbon's spine is planar in z, so the frame below stays
  // exact.
  const dirX = cosA;
  const dirY = sinA;
  const perpX = -sinA;
  const perpY = cosA;
  const bendAmount = bend * taperedLength * (1 + 0.55 * centred);

  const p0x = 0;
  const p0y = 0;
  const p1x = 0.5 * taperedLength * dirX + bendAmount * perpX;
  const p1y = 0.5 * taperedLength * dirY + bendAmount * perpY;
  const p2x = taperedLength * dirX;
  const p2y = taperedLength * dirY;

  const oneMinusT = 1 - t;
  const sx = oneMinusT * oneMinusT * p0x + 2 * oneMinusT * t * p1x + t * t * p2x;
  const sy = oneMinusT * oneMinusT * p0y + 2 * oneMinusT * t * p1y + t * t * p2y;

  // S'(t) and S''(t). The second derivative of a quadratic Bezier is constant.
  const vx = 2 * oneMinusT * (p1x - p0x) + 2 * t * (p2x - p1x);
  const vy = 2 * oneMinusT * (p1y - p0y) + 2 * t * (p2y - p1y);
  const ax = 2 * (p0x - 2 * p1x + p2x);
  const ay = 2 * (p0y - 2 * p1y + p2y);

  const speed = Math.hypot(vx, vy) || 1e-6;
  const tanX = vx / speed;
  const tanY = vy / speed;
  // T' = (S''|S'|² − S'(S'·S'')) / |S'|³
  const dot = vx * ax + vy * ay;
  const speedCubed = speed * speed * speed;
  const tanSlopeX = (ax * speed * speed - vx * dot) / speedCubed;
  const tanSlopeY = (ay * speed * speed - vy * dot) / speedCubed;

  // B = T × Z with Z = (0, 0, 1) and T planar, so B = (T.y, −T.x, 0) and is
  // already unit length.
  const bx = tanY;
  const by = -tanX;
  const bSlopeX = tanSlopeY;
  const bSlopeY = -tanSlopeX;

  // Twist rotates the cross-section out of the spine's plane. Each ribbon
  // starts at its own phase so the bundle never shows two identical blades.
  const phase = INVERSE_GOLDEN_RATIO * ribbon * Math.PI;
  const theta = phase + twist * (t - 0.5);
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);

  // D spans the width, E is the strip's own normal direction; both unit and
  // mutually orthogonal, both orthogonal to T.
  const dx = cosT * bx;
  const dy = cosT * by;
  const dz = sinT;
  const ex = -sinT * bx;
  const ey = -sinT * by;
  const ez = cosT;

  const dSlopeX = -sinT * twist * bx + cosT * bSlopeX;
  const dSlopeY = -sinT * twist * by + cosT * bSlopeY;
  const dSlopeZ = cosT * twist;
  const eSlopeX = -cosT * twist * bx - sinT * bSlopeX;
  const eSlopeY = -cosT * twist * by - sinT * bSlopeY;
  const eSlopeZ = -sinT * twist;

  const width = taper(t, rootTaper, tipTaper, tipFloor);
  const w = bladeWidth * width.value;
  const wSlope = bladeWidth * width.slope;

  // Parabolic curl across the strip, mean-zero so the curl does not translate
  // the ribbon off its own spine.
  const curlShape = s * s - 1 / 3;
  const c = curl * w * curlShape;
  const curlAlongT = curl * wSlope * curlShape;
  const curlAcrossS = 2 * curl * w * s;

  const x = sx + s * w * dx + c * ex;
  const y = sy + s * w * dy + c * ey;
  const z = depth + s * w * dz + c * ez;

  // ∂P/∂s = w·D + (∂c/∂s)·E
  const psx = w * dx + curlAcrossS * ex;
  const psy = w * dy + curlAcrossS * ey;
  const psz = w * dz + curlAcrossS * ez;

  // ∂P/∂t = S' + s(w'·D + w·D') + (∂c/∂t)·E + c·E'
  const ptx = vx + s * (wSlope * dx + w * dSlopeX) + curlAlongT * ex + c * eSlopeX;
  const pty = vy + s * (wSlope * dy + w * dSlopeY) + curlAlongT * ey + c * eSlopeY;
  const ptz = s * (wSlope * dz + w * dSlopeZ) + curlAlongT * ez + c * eSlopeZ;

  const nxRaw = pty * psz - ptz * psy;
  const nyRaw = ptz * psx - ptx * psz;
  const nzRaw = ptx * psy - pty * psx;
  const nLength = Math.hypot(nxRaw, nyRaw, nzRaw) || 1;

  const tLength = Math.hypot(ptx, pty, ptz) || 1;

  return {
    x,
    y,
    z,
    nx: nxRaw / nLength,
    ny: nyRaw / nLength,
    nz: nzRaw / nLength,
    tx: ptx / tLength,
    ty: pty / tLength,
    tz: ptz / tLength,
  };
}

/** Builds the attribute set for the whole ribbon bundle. */
export function createWaveGeometryData(
  options: WaveGeometryOptions,
): WaveGeometryData {
  const { ribbonCount, segmentsAlong, segmentsAcross } = options;
  if (
    !Number.isInteger(segmentsAlong) ||
    !Number.isInteger(segmentsAcross) ||
    !Number.isInteger(ribbonCount)
  ) {
    throw new TypeError("Wave geometry counts must be integers.");
  }
  if (segmentsAlong < 1 || segmentsAcross < 1) {
    throw new RangeError("Wave geometry needs at least one quad per axis.");
  }
  if (ribbonCount < 1) {
    throw new RangeError("Wave geometry needs at least one ribbon.");
  }
  if (options.rootTaper < 1) {
    // Below 1 the taper's slope is unbounded at the root and the first row of
    // normals turns to noise.
    throw new RangeError("rootTaper below 1 leaves the root slope undefined.");
  }

  const columns = segmentsAcross + 1;
  const rows = segmentsAlong + 1;
  const perRibbon = columns * rows;
  const vertexCount = perRibbon * ribbonCount;
  const triangleCount = segmentsAlong * segmentsAcross * 2 * ribbonCount;

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const tangent = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const blade = new Float32Array(vertexCount);
  const index = new Uint32Array(triangleCount * 3);

  let cursor = 0;

  for (let ribbon = 0; ribbon < ribbonCount; ribbon += 1) {
    const base = ribbon * perRibbon;
    const fan = ribbonFan(ribbon, ribbonCount);

    for (let row = 0; row < rows; row += 1) {
      const t = row / segmentsAlong;
      for (let column = 0; column < columns; column += 1) {
        const s = (column / segmentsAcross) * 2 - 1;
        const vertex = base + row * columns + column;
        const sample = sampleRibbonSurface(ribbon, t, s, options);

        position[vertex * 3] = sample.x;
        position[vertex * 3 + 1] = sample.y;
        position[vertex * 3 + 2] = sample.z;
        normal[vertex * 3] = sample.nx;
        normal[vertex * 3 + 1] = sample.ny;
        normal[vertex * 3 + 2] = sample.nz;
        tangent[vertex * 3] = sample.tx;
        tangent[vertex * 3 + 1] = sample.ty;
        tangent[vertex * 3 + 2] = sample.tz;
        uv[vertex * 2] = t;
        uv[vertex * 2 + 1] = (s + 1) / 2;
        blade[vertex] = fan;
      }
    }

    for (let row = 0; row < segmentsAlong; row += 1) {
      for (let column = 0; column < segmentsAcross; column += 1) {
        const a = base + row * columns + column;
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
  }

  return {
    position,
    normal,
    tangent,
    uv,
    blade,
    index,
    vertexCount,
    triangleCount,
  };
}

/**
 * The backing buffers, in the order `postMessage` should transfer them. After
 * a transfer the source arrays are detached, so a worker must not touch the
 * data again once it has posted it.
 */
export function waveGeometryTransferables(
  data: WaveGeometryData,
): ArrayBuffer[] {
  return [
    data.position.buffer as ArrayBuffer,
    data.normal.buffer as ArrayBuffer,
    data.tangent.buffer as ArrayBuffer,
    data.uv.buffer as ArrayBuffer,
    data.blade.buffer as ArrayBuffer,
    data.index.buffer as ArrayBuffer,
  ];
}
