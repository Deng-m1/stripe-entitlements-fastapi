/**
 * M1 annotated metric chart: a spiky orange area chart with a dashed
 * reference line and a small mono label stating a concrete number. Static
 * inline SVG — no animation, no canvas.
 */

const POINTS: ReadonlyArray<readonly [number, number]> = [
  [0, 78],
  [12, 62],
  [22, 74],
  [34, 40],
  [44, 68],
  [56, 30],
  [64, 58],
  [76, 46],
  [88, 70],
  [100, 24],
  [110, 55],
  [122, 38],
  [134, 64],
  [146, 20],
  [158, 50],
  [170, 34],
  [182, 60],
  [194, 16],
  [206, 44],
  [218, 28],
  [230, 58],
  [242, 22],
  [254, 48],
  [266, 12],
  [278, 40],
  [290, 30],
  [302, 52],
  [312, 26],
  [320, 44],
];

const LINE_PATH = POINTS.map(
  ([x, y], index) => `${index === 0 ? "M" : "L"}${x},${y}`,
).join(" ");
const AREA_PATH = `${LINE_PATH} L320,100 L0,100 Z`;

export function SettlementChart() {
  return (
    <figure
      aria-label="PostgreSQL race gates cover replay, reordering, and duplicate grants"
      className="settlement-chart"
    >
      <svg aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 320 100">
        <path className="chart-area" d={AREA_PATH} />
        <path className="chart-line" d={LINE_PATH} vectorEffect="non-scaling-stroke" />
        <line
          className="chart-ref"
          vectorEffect="non-scaling-stroke"
          x1={0}
          x2={320}
          y1={12}
          y2={12}
        />
      </svg>
      <figcaption className="chart-label">
        PostgreSQL replay · concurrent races · duplicate grants blocked
      </figcaption>
    </figure>
  );
}
