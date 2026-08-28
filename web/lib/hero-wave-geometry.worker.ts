/// <reference lib="webworker" />

/**
 * Builds the hero's ribbon sheets off the main thread.
 *
 * The multi-sheet hero needs two or three geometries per tier; at the desktop
 * tier the stack adds up to roughly 2 MB of attribute buffers. One batched
 * request builds every sheet in a single worker turn and transfers all of the
 * backing buffers together, so the main thread pays one message round-trip
 * for the whole stack instead of racing three, and either receives a complete
 * generation or falls back inline as a unit — a mixed stack (some sheets from
 * the worker, some inline after a mid-batch failure) can never mount.
 */

import {
  createWaveGeometryData,
  waveGeometryTransferables,
  type WaveGeometryData,
  type WaveGeometryOptions,
} from "./hero-wave-geometry";

export interface WaveGeometryRequest {
  requestId: number;
  /** One options set per ribbon layer, in mount order. */
  sheets: WaveGeometryOptions[];
}

export interface WaveGeometryResult {
  requestId: number;
  /** Built sheets, index-aligned with the request's `sheets`. */
  sheets: WaveGeometryData[];
}

export interface WaveGeometryFailure {
  requestId: number;
  error: string;
}

export type WaveGeometryMessage = WaveGeometryResult | WaveGeometryFailure;

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener("message", (event: MessageEvent<WaveGeometryRequest>) => {
  const { requestId, sheets } = event.data;
  try {
    const built = sheets.map((options) => createWaveGeometryData(options));
    // Every sheet's buffers are detached by this call; nothing may read the
    // built data after it.
    scope.postMessage(
      { requestId, sheets: built } satisfies WaveGeometryResult,
      built.flatMap((data) => waveGeometryTransferables(data)),
    );
  } catch (error) {
    scope.postMessage({
      requestId,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WaveGeometryFailure);
  }
});
