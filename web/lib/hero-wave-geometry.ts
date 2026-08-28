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
  /**
   * Constant phase added to the fold argument, in radians. A multi-sheet hero
   * bakes each ribbon layer from the same field with a different phase, so the
   * layers share one visual language while their crests land in different
   * places — without this every sheet folds in lockstep and the stack reads
   * as one thick sheet with a drop shadow.
   */
  foldPhase: number;
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
  foldPhase: 0,
};

/**
 * One ribbon sheet of the multi-layer hero.
 *
 * stripe.com's hero is not a single folded surface: two or three translucent
 * sheets thread over and under each other, so a crest of the back sheet can
 * surface through a trough of the front one. Each layer here is the same
 * analytic surface with its own fold recipe, transform, palette window, and
 * blend discipline. The spec lives in this renderer-free module so the layer
 * relationships (distinct phases, back-to-front depth order, opacity taper)
 * stay unit-testable without a WebGL context.
 */
export interface HeroRibbonLayer {
  id: "back" | "primary" | "front";
  /** Fold recipe merged over `DEFAULT_WAVE_GEOMETRY` for this sheet. */
  fold: Pick<
    WaveGeometryOptions,
    | "foldCount"
    | "foldDepth"
    | "foldSkew"
    | "foldCurvature"
    | "crestSharpness"
    | "foldPhase"
  >;
  /**
   * Per-axis multiplier on the quality tier's segment counts. Rear sheets are
   * softer and mostly occluded, so they can carry far fewer vertices than the
   * primary sheet without the difference ever reading on screen.
   */
  segmentScale: number;
  /**
   * Sheet-local z offset inside the shared hero group, in the same units as
   * `foldDepth`. Kept well below the fold displacement range on purpose:
   * layers must interpenetrate for crests to thread over and under each
   * other, not float apart as parallel planes.
   */
  zLift: number;
  /** Small per-layer rotation delta [x, y, z] over the group pose, radians. */
  tilt: readonly [number, number, number];
  /** Sheet-local [x, y] drift so the layers' compositions do not stack. */
  drift: readonly [number, number];
  /**
   * Pointer parallax in sheet-local units per unit of eased pointer. The
   * front sheet leans furthest, which is what sells the stack as depth.
   */
  parallax: number;
  /** Layer opacity multiplier (uOpacity). */
  opacity: number;
  /**
   * Extra opacity multiplier on narrow (portrait-ish) viewports, where all
   * three sheets stack behind the headline column. The primary sheet keeps
   * the round-11 mobile identity at 1; the companion layers duck so the
   * lockup never sits on three sheets' worth of wash.
   */
  narrowOpacityScale: number;
  /**
   * Constant seconds added to the shared wrapped clock (uTimeShift). A pure
   * offset keeps every sine argument period-exact under the 200π wrap while
   * decorrelating the layers' travelling swells.
   */
  timeShift: number;
  /** Travelling-swell amplitude (uAmplitude). */
  amplitude: number;
  /** Pointer swell strength (uPointerStrength). */
  pointerStrength: number;
  /** Palette window (uRampOrigin / uRampScale): rear cool, front warm. */
  rampOrigin: number;
  rampScale: number;
  /**
   * Fold-alpha window (uTroughLow / uTroughHigh). A wide window makes broad
   * soft washes, a high narrow one slims the sheet to crest-top ribbons.
   */
  troughLow: number;
  troughHigh: number;
  /** Crest-core luminance mix (uCrestGlow). */
  crestGlow: number;
  /**
   * Fragments below this alpha are discarded (uAlphaClip). Occluding layers
   * need it: with plain depth-writing a sheet's invisible troughs would still
   * write depth and punch holes into everything behind them.
   */
  alphaClip: number;
  /**
   * Whether the sheet's surviving fragments write depth. Depth-writing cores
   * are what let a rear crest surface *through* a nearer sheet; the frontmost
   * sheet skips the write so its translucent edges never occlude anything.
   */
  depthWrite: boolean;
}

/**
 * Back-to-front. Draw order follows array order (explicit renderOrder), so
 * blending stays deterministic regardless of three's distance sort.
 */
export const HERO_RIBBON_LAYERS: readonly HeroRibbonLayer[] = [
  {
    id: "back",
    // Slightly more, tighter folds at a steeper skew: the rear sheet reads as
    // a separate weave crossing behind the primary one, not as its echo. The
    // alpha window is banded (not a wash): the first cut of this layer ran
    // 0.02–0.5 and filled every white gap round 11 fought for with fog.
    fold: {
      foldCount: 2.5,
      foldDepth: 0.5,
      foldSkew: 0.7,
      foldCurvature: 1.3,
      crestSharpness: 0.26,
      foldPhase: 2.7,
    },
    segmentScale: 0.62,
    // Deep enough to cut the area where this sheet wins the depth test over
    // the primary (a rear band that wins too often washes the hero pastel),
    // shallow enough that crests still cross.
    zLift: -0.36,
    tilt: [0.1, -0.06, 0.14],
    drift: [-0.14, 0.18],
    parallax: 0.018,
    // Near-solid where it does surface: a translucent rear band over white
    // paper reads as pastel fog, not as a ribbon passing behind.
    opacity: 0.72,
    narrowOpacityScale: 0.4,
    timeShift: 41.3,
    amplitude: 0.15,
    pointerStrength: 0.3,
    // Cool window: the rear weave stays violet-to-magenta so the warm front
    // ribbons separate from it instead of doubling it.
    rampOrigin: 0.08,
    rampScale: 1.55,
    troughLow: 0.2,
    troughHigh: 0.56,
    crestGlow: 0.28,
    alphaClip: 0.3,
    depthWrite: true,
  },
  {
    id: "primary",
    // The round-11 hero identity, unchanged: broad two-to-three sweeps.
    fold: {
      foldCount: DEFAULT_WAVE_GEOMETRY.foldCount,
      foldDepth: DEFAULT_WAVE_GEOMETRY.foldDepth,
      foldSkew: DEFAULT_WAVE_GEOMETRY.foldSkew,
      foldCurvature: DEFAULT_WAVE_GEOMETRY.foldCurvature,
      crestSharpness: DEFAULT_WAVE_GEOMETRY.crestSharpness,
      foldPhase: 0,
    },
    segmentScale: 1,
    zLift: 0,
    tilt: [0, 0, 0],
    drift: [0, 0],
    parallax: 0.032,
    opacity: 1,
    narrowOpacityScale: 1,
    timeShift: 0,
    amplitude: 0.2,
    pointerStrength: 0.55,
    rampOrigin: 0.28,
    rampScale: 1.9,
    troughLow: 0.06,
    troughHigh: 0.42,
    crestGlow: 0.4,
    alphaClip: 0.24,
    depthWrite: true,
  },
  {
    id: "front",
    // One long sweeping fold with a high alpha window: only the crest top
    // survives, so this layer is a slim warm ribbon lacing across the stack.
    fold: {
      foldCount: 1.6,
      foldDepth: 0.62,
      foldSkew: 0.5,
      foldCurvature: 0.95,
      crestSharpness: 0.42,
      foldPhase: 2.3,
    },
    segmentScale: 0.8,
    zLift: 0.24,
    tilt: [-0.05, 0.05, -0.1],
    drift: [0.34, -0.22],
    parallax: 0.05,
    opacity: 0.72,
    narrowOpacityScale: 0.55,
    timeShift: 17.7,
    amplitude: 0.26,
    pointerStrength: 0.7,
    // Warm window: pink through lemon, so the lace reads against both the
    // primary sheet's mid-ramp and the rear weave's violets.
    rampOrigin: 0.42,
    rampScale: 2.2,
    troughLow: 0.33,
    troughHigh: 0.62,
    crestGlow: 0.5,
    alphaClip: 0,
    depthWrite: false,
  },
];

/**
 * Full geometry options for one layer at one quality tier. Segment counts
 * scale per axis and floor at one quad so a degenerate tier cannot throw.
 */
export function ribbonLayerGeometryOptions(
  layer: HeroRibbonLayer,
  segmentsX: number,
  segmentsY: number,
): WaveGeometryOptions {
  return {
    ...DEFAULT_WAVE_GEOMETRY,
    ...layer.fold,
    segmentsX: Math.max(1, Math.round(segmentsX * layer.segmentScale)),
    segmentsY: Math.max(1, Math.round(segmentsY * layer.segmentScale)),
  };
}

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
 * where p = q·s + foldPhase and q = 2π·foldCount. The constant phase drops
 * out of the derivative, so the slope expression is unchanged by it.
 */
function foldField(
  s: number,
  foldCount: number,
  crestSharpness: number,
  foldPhase: number,
): { value: number; slope: number } {
  const q = Math.PI * 2 * foldCount;
  const p = q * s + foldPhase;
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
    foldPhase,
  } = options;
  const skewU = Math.cos(foldSkew);
  // s(u, v) = u·cos θ + v·sin θ + c·(v − ½)², so ∂s/∂v picks up the 2c(v − ½).
  const centred = v - 0.5;
  const skewV = Math.sin(foldSkew) + 2 * foldCurvature * centred;
  const s = u * skewU + v * Math.sin(foldSkew) + foldCurvature * centred * centred;

  const fold = foldField(s, foldCount, crestSharpness, foldPhase);
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
