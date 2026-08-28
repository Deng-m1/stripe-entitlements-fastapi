import { describe, expect, it } from "vitest";
import {
  createWaveGeometryData,
  DEFAULT_WAVE_GEOMETRY,
  ribbonFan,
  sampleRibbonSurface,
  waveGeometryTransferables,
  waveQualityTier,
  type WaveGeometryOptions,
} from "@/lib/hero-wave-geometry";

const options: WaveGeometryOptions = {
  ...DEFAULT_WAVE_GEOMETRY,
  ribbonCount: 3,
  segmentsAlong: 24,
  segmentsAcross: 6,
};

const perRibbon = 25 * 7;

describe("hero ribbon geometry", () => {
  it("emits one fully indexed strip per ribbon", () => {
    const data = createWaveGeometryData(options);

    expect(data.vertexCount).toBe(perRibbon * 3);
    expect(data.triangleCount).toBe(24 * 6 * 2 * 3);
    expect(data.position).toHaveLength(data.vertexCount * 3);
    expect(data.normal).toHaveLength(data.vertexCount * 3);
    expect(data.tangent).toHaveLength(data.vertexCount * 3);
    expect(data.uv).toHaveLength(data.vertexCount * 2);
    expect(data.blade).toHaveLength(data.vertexCount);
    expect(data.index).toHaveLength(data.triangleCount * 3);

    for (const vertex of data.index) {
      expect(vertex).toBeLessThan(data.vertexCount);
    }
    // Every vertex referenced, or a ribbon has holes in it.
    expect(new Set(data.index).size).toBe(data.vertexCount);
  });

  it("never indexes across a ribbon boundary", () => {
    // Two ribbons stitched together by a stray triangle would drag a sheet of
    // colour across the gap the fan is supposed to leave open.
    const data = createWaveGeometryData(options);

    for (let triangle = 0; triangle < data.triangleCount; triangle += 1) {
      const owners = new Set(
        [0, 1, 2].map((corner) =>
          Math.floor(data.index[triangle * 3 + corner] / perRibbon),
        ),
      );
      expect(owners.size).toBe(1);
    }
  });

  it("is deterministic for identical options", () => {
    expect(createWaveGeometryData(options).position).toEqual(
      createWaveGeometryData(options).position,
    );
    expect(createWaveGeometryData(options).normal).toEqual(
      createWaveGeometryData(options).normal,
    );
  });

  it("tags every vertex with its own ribbon's fan position", () => {
    const data = createWaveGeometryData(options);

    for (let vertex = 0; vertex < data.vertexCount; vertex += 1) {
      const ribbon = Math.floor(vertex / perRibbon);
      expect(data.blade[vertex]).toBeCloseTo(ribbonFan(ribbon, 3), 6);
    }
    // The fan has to reach both rims, because the fragment shader lays the
    // whole palette across it. A bundle that only spanned the middle would
    // repeat round 3's failure of never showing either end of the ramp.
    expect(Math.min(...data.blade)).toBe(0);
    expect(Math.max(...data.blade)).toBe(1);
  });

  it("spans the full uv range on every ribbon", () => {
    const data = createWaveGeometryData(options);

    for (let ribbon = 0; ribbon < 3; ribbon += 1) {
      const first = ribbon * perRibbon;
      const last = first + perRibbon - 1;
      expect(data.uv[first * 2]).toBe(0);
      expect(data.uv[first * 2 + 1]).toBe(0);
      expect(data.uv[last * 2]).toBe(1);
      expect(data.uv[last * 2 + 1]).toBe(1);
    }
  });

  it("tapers each ribbon to a point at both ends", () => {
    // The taper is the whole reason the surface can stay opaque: it is what
    // draws the silhouette. If a ribbon ended at full width it would meet the
    // paper as a straight cut.
    const wide = sampleRibbonSurface(1, 0.42, 1, options);
    const wideOpposite = sampleRibbonSurface(1, 0.42, -1, options);
    const waist = Math.hypot(
      wide.x - wideOpposite.x,
      wide.y - wideOpposite.y,
      wide.z - wideOpposite.z,
    );

    for (const t of [0, 1]) {
      const edge = sampleRibbonSurface(1, t, 1, options);
      const opposite = sampleRibbonSurface(1, t, -1, options);
      const width = Math.hypot(
        edge.x - opposite.x,
        edge.y - opposite.y,
        edge.z - opposite.z,
      );
      expect(width).toBeLessThan(waist * 0.06);
      // Not exactly zero: a degenerate end has no defined normal.
      expect(width).toBeGreaterThan(0);
    }
  });

  it("emits unit normals and unit spine tangents", () => {
    const data = createWaveGeometryData(options);

    for (let vertex = 0; vertex < data.vertexCount; vertex += 1) {
      const n = [0, 1, 2].map((axis) => data.normal[vertex * 3 + axis]);
      const t = [0, 1, 2].map((axis) => data.tangent[vertex * 3 + axis]);
      expect(Math.hypot(...n)).toBeCloseTo(1, 5);
      expect(Math.hypot(...t)).toBeCloseTo(1, 5);
      // The shader builds a frame as cross(normal, spine); if the two were
      // ever parallel that cross product would collapse and the animated
      // normal would spin.
      const parallel = Math.abs(n[0] * t[0] + n[1] * t[1] + n[2] * t[2]);
      expect(parallel).toBeLessThan(0.02);
    }
  });

  it("matches central finite differences of the same surface", () => {
    // Guards the hand-derived Bezier, frame, twist and taper derivatives. A
    // wrong derivative still renders; it just lights the ribbons incorrectly.
    const epsilon = 1e-5;

    for (const ribbon of [0, 2, 5]) {
      for (const t of [0.13, 0.37, 0.5, 0.72, 0.91]) {
        for (const s of [-0.8, -0.2, 0.35, 0.9]) {
          const exact = sampleRibbonSurface(ribbon, t, s, DEFAULT_WAVE_GEOMETRY);
          const at = (dt: number, ds: number) =>
            sampleRibbonSurface(ribbon, t + dt, s + ds, DEFAULT_WAVE_GEOMETRY);

          const tPlus = at(epsilon, 0);
          const tMinus = at(-epsilon, 0);
          const sPlus = at(0, epsilon);
          const sMinus = at(0, -epsilon);

          const alongT = [
            (tPlus.x - tMinus.x) / (2 * epsilon),
            (tPlus.y - tMinus.y) / (2 * epsilon),
            (tPlus.z - tMinus.z) / (2 * epsilon),
          ];
          const alongS = [
            (sPlus.x - sMinus.x) / (2 * epsilon),
            (sPlus.y - sMinus.y) / (2 * epsilon),
            (sPlus.z - sMinus.z) / (2 * epsilon),
          ];
          const cross = [
            alongT[1] * alongS[2] - alongT[2] * alongS[1],
            alongT[2] * alongS[0] - alongT[0] * alongS[2],
            alongT[0] * alongS[1] - alongT[1] * alongS[0],
          ];
          const crossLength = Math.hypot(...cross);
          const tangentLength = Math.hypot(...alongT);

          expect(cross[0] / crossLength).toBeCloseTo(exact.nx, 4);
          expect(cross[1] / crossLength).toBeCloseTo(exact.ny, 4);
          expect(cross[2] / crossLength).toBeCloseTo(exact.nz, 4);
          expect(alongT[0] / tangentLength).toBeCloseTo(exact.tx, 4);
          expect(alongT[1] / tangentLength).toBeCloseTo(exact.ty, 4);
          expect(alongT[2] / tangentLength).toBeCloseTo(exact.tz, 4);
        }
      }
    }
  });

  it("keeps outer ribbons shorter and narrower than the middle one", () => {
    const middle = sampleRibbonSurface(3, 1, 0, DEFAULT_WAVE_GEOMETRY);
    const rim = sampleRibbonSurface(0, 1, 0, DEFAULT_WAVE_GEOMETRY);

    expect(Math.hypot(rim.x, rim.y)).toBeLessThan(Math.hypot(middle.x, middle.y));
  });

  it("rejects counts that cannot form a bundle", () => {
    expect(() =>
      createWaveGeometryData({ ...options, segmentsAlong: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      createWaveGeometryData({ ...options, segmentsAcross: 4.5 }),
    ).toThrow(TypeError);
    expect(() => createWaveGeometryData({ ...options, ribbonCount: 0 })).toThrow(
      RangeError,
    );
    expect(() => createWaveGeometryData({ ...options, rootTaper: 0.5 })).toThrow(
      RangeError,
    );
  });

  it("lists one transferable buffer per attribute", () => {
    const data = createWaveGeometryData(options);
    const transferables = waveGeometryTransferables(data);

    expect(transferables).toHaveLength(6);
    expect(new Set(transferables).size).toBe(6);
    expect(transferables[0]).toBe(data.position.buffer);
    expect(transferables[5]).toBe(data.index.buffer);
  });

  it("scales subdivision with the rendered width", () => {
    const phone = waveQualityTier(390);
    const laptop = waveQualityTier(1024);
    const desktop = waveQualityTier(1920);

    expect(phone.segmentsAlong).toBeLessThan(laptop.segmentsAlong);
    expect(laptop.segmentsAlong).toBeLessThan(desktop.segmentsAlong);
    expect(waveQualityTier(700)).toEqual(phone);
    expect(waveQualityTier(701)).toEqual(laptop);
  });
});
