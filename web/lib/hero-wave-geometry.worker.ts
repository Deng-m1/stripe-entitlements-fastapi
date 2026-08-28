/// <reference lib="webworker" />

/**
 * Builds the hero wave sheet off the main thread.
 *
 * At the desktop quality tier the sheet is ~57k vertices, so the attribute
 * buffers add up to a little over 1 MB. Generating that inline stalls the main
 * thread long enough to be visible as a hitch during hero entrance; generating
 * it here and transferring the backing buffers costs the main thread nothing
 * beyond wrapping them in BufferAttributes.
 */

import {
  createWaveGeometryData,
  waveGeometryTransferables,
  type WaveGeometryData,
  type WaveGeometryOptions,
} from "./hero-wave-geometry";

export interface WaveGeometryRequest {
  requestId: number;
  options: WaveGeometryOptions;
}

export interface WaveGeometryResult {
  requestId: number;
  data: WaveGeometryData;
}

export interface WaveGeometryFailure {
  requestId: number;
  error: string;
}

export type WaveGeometryMessage = WaveGeometryResult | WaveGeometryFailure;

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener("message", (event: MessageEvent<WaveGeometryRequest>) => {
  const { requestId, options } = event.data;
  try {
    const data = createWaveGeometryData(options);
    // The buffers are detached by this call; nothing may read `data` after it.
    scope.postMessage(
      { requestId, data } satisfies WaveGeometryResult,
      waveGeometryTransferables(data),
    );
  } catch (error) {
    scope.postMessage({
      requestId,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WaveGeometryFailure);
  }
});
