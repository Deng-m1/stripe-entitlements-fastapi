import { describe, expect, it } from "vitest";
import {
  createWaveGeometryData,
  DEFAULT_WAVE_GEOMETRY,
  sampleWaveSurface,
  waveGeometryTransferables,
  waveQualityTier,
  type WaveGeometryOptions,
} from "@/lib/hero-wave-geometry";

const options: WaveGeometryOptions = {
  ...DEFAULT_WAVE_GEOMETRY,
  segmentsX: 24,
  segmentsY: 18,
};

describe("hero wave geometry", () => {
  it("emits a fully indexed grid with matching attribute lengths", () => {
    const data = createWaveGeometryData(options);

    expect(data.vertexCount).toBe(25 * 19);
    expect(data.triangleCount).toBe(24 * 18 * 2);
    expect(data.position).toHaveLength(data.vertexCount * 3);
    expect(data.normal).toHaveLength(data.vertexCount * 3);
    expect(data.uv).toHaveLength(data.vertexCount * 2);
    expect(data.fold).toHaveLength(data.vertexCount);
    expect(data.index).toHaveLength(data.triangleCount * 3);

    for (const vertex of data.index) {
      expect(vertex).toBeLessThan(data.vertexCount);
    }
    // Every vertex has to be referenced, or the sheet has holes.
    expect(new Set(data.index).size).toBe(data.vertexCount);
  });

  it("is deterministic for identical options", () => {
    expect(createWaveGeometryData(options).position).toEqual(
      createWaveGeometryData(options).position,
    );
    expect(createWaveGeometryData(options).normal).toEqual(
      createWaveGeometryData(options).normal,
    );
  });

  it("keeps every vertex inside the declared extent", () => {
    const data = createWaveGeometryData(options);

    for (let vertex = 0; vertex < data.vertexCount; vertex += 1) {
      expect(Math.abs(data.position[vertex * 3])).toBeLessThanOrEqual(
        options.width / 2 + 1e-5,
      );
      expect(Math.abs(data.position[vertex * 3 + 1])).toBeLessThanOrEqual(
        options.height / 2 + 1e-5,
      );
      expect(Math.abs(data.position[vertex * 3 + 2])).toBeLessThanOrEqual(
        options.foldDepth + 1e-5,
      );
      expect(Math.abs(data.fold[vertex])).toBeLessThanOrEqual(1 + 1e-5);
    }
  });

  it("spans the full uv range with exact corner values", () => {
    const data = createWaveGeometryData(options);
    const last = data.vertexCount - 1;

    expect(data.uv[0]).toBe(0);
    expect(data.uv[1]).toBe(0);
    expect(data.uv[last * 2]).toBe(1);
    expect(data.uv[last * 2 + 1]).toBe(1);
  });

  it("emits unit normals that all face the camera", () => {
    const data = createWaveGeometryData(options);

    for (let vertex = 0; vertex < data.vertexCount; vertex += 1) {
      const nx = data.normal[vertex * 3];
      const ny = data.normal[vertex * 3 + 1];
      const nz = data.normal[vertex * 3 + 2];
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
      expect(nz).toBeGreaterThan(0);
    }
  });

  it("matches central finite differences of the same surface", () => {
    // Guards the hand-derived chain-rule slopes in sampleWaveSurface. A wrong
    // derivative still renders, it just lights the folds incorrectly.
    const epsilon = 1e-4;

    for (const u of [0.08, 0.31, 0.5, 0.77, 0.94]) {
      for (const v of [0.12, 0.4, 0.63, 0.88]) {
        const exact = sampleWaveSurface(u, v, DEFAULT_WAVE_GEOMETRY);
        const uPlus = sampleWaveSurface(u + epsilon, v, DEFAULT_WAVE_GEOMETRY);
        const uMinus = sampleWaveSurface(u - epsilon, v, DEFAULT_WAVE_GEOMETRY);
        const vPlus = sampleWaveSurface(u, v + epsilon, DEFAULT_WAVE_GEOMETRY);
        const vMinus = sampleWaveSurface(u, v - epsilon, DEFAULT_WAVE_GEOMETRY);

        const tangentU = [
          (uPlus.x - uMinus.x) / (2 * epsilon),
          (uPlus.y - uMinus.y) / (2 * epsilon),
          (uPlus.z - uMinus.z) / (2 * epsilon),
        ];
        const tangentV = [
          (vPlus.x - vMinus.x) / (2 * epsilon),
          (vPlus.y - vMinus.y) / (2 * epsilon),
          (vPlus.z - vMinus.z) / (2 * epsilon),
        ];
        const cross = [
          tangentU[1] * tangentV[2] - tangentU[2] * tangentV[1],
          tangentU[2] * tangentV[0] - tangentU[0] * tangentV[2],
          tangentU[0] * tangentV[1] - tangentU[1] * tangentV[0],
        ];
        const length = Math.hypot(...cross);

        expect(cross[0] / length).toBeCloseTo(exact.nx, 4);
        expect(cross[1] / length).toBeCloseTo(exact.ny, 4);
        expect(cross[2] / length).toBeCloseTo(exact.nz, 4);
      }
    }
  });

  it("rejects segment counts that cannot form quads", () => {
    expect(() =>
      createWaveGeometryData({ ...options, segmentsX: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      createWaveGeometryData({ ...options, segmentsY: 4.5 }),
    ).toThrow(TypeError);
  });

  it("lists one transferable buffer per attribute", () => {
    const data = createWaveGeometryData(options);
    const transferables = waveGeometryTransferables(data);

    expect(transferables).toHaveLength(5);
    expect(new Set(transferables).size).toBe(5);
    expect(transferables[0]).toBe(data.position.buffer);
    expect(transferables[4]).toBe(data.index.buffer);
  });

  it("scales subdivision with the rendered width", () => {
    const phone = waveQualityTier(390);
    const laptop = waveQualityTier(1024);
    const desktop = waveQualityTier(1920);

    expect(phone.segmentsX).toBeLessThan(laptop.segmentsX);
    expect(laptop.segmentsX).toBeLessThan(desktop.segmentsX);
    expect(waveQualityTier(700)).toEqual(phone);
    expect(waveQualityTier(701)).toEqual(laptop);
  });
});
