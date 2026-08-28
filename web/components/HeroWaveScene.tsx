"use client";

import { PerformanceMonitor } from "@react-three/drei";
import { Canvas, extend, useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DataTexture,
  DoubleSide,
  LinearFilter,
  NoColorSpace,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
} from "three";
import {
  HeroWaveMaterial,
  type HeroWaveMaterialImpl,
} from "@/components/hero-wave-material";
import {
  createWaveGeometryData,
  DEFAULT_WAVE_GEOMETRY,
  type WaveGeometryData,
  type WaveGeometryOptions,
} from "@/lib/hero-wave-geometry";
import type {
  WaveGeometryMessage,
  WaveGeometryRequest,
} from "@/lib/hero-wave-geometry.worker";
import {
  createPaletteRamp,
  PALETTE_TEXTURE_WIDTH,
} from "@/lib/hero-wave-palette";

extend({ HeroWaveMaterial });

export interface PointerTarget {
  x: number;
  y: number;
}

export interface HeroWaveSceneProps {
  /** Quads per axis for this viewport tier; a change rebuilds the sheet. */
  segmentsX: number;
  segmentsY: number;
  /** Live pointer in [-1, 1] sheet space, written by the host component. */
  pointer: RefObject<PointerTarget>;
  /** False while the hero is offscreen or the tab is hidden. */
  active: boolean;
  /** Fires once the renderer has actually put pixels on the canvas. */
  onDrawn: () => void;
}

function toBufferGeometry(data: WaveGeometryData): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(data.position, 3));
  geometry.setAttribute("normal", new BufferAttribute(data.normal, 3));
  geometry.setAttribute("uv", new BufferAttribute(data.uv, 2));
  geometry.setAttribute("fold", new BufferAttribute(data.fold, 1));
  geometry.setIndex(new BufferAttribute(data.index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Builds the sheet in a Worker, falling back to inline generation when Workers
 * are unavailable or the module fails to load. Both routes call the same
 * generator, so the two can never drift apart visually.
 */
function useWaveGeometry(segmentsX: number, segmentsY: number) {
  const [geometry, setGeometry] = useState<BufferGeometry | null>(null);

  useEffect(() => {
    let cancelled = false;
    let settled = false;
    let worker: Worker | null = null;
    const options: WaveGeometryOptions = {
      ...DEFAULT_WAVE_GEOMETRY,
      segmentsX,
      segmentsY,
    };

    const accept = (data: WaveGeometryData) => {
      if (cancelled || settled) return;
      settled = true;
      setGeometry(toBufferGeometry(data));
    };

    const buildInline = () => {
      if (cancelled || settled) return;
      accept(createWaveGeometryData(options));
    };

    try {
      worker = new Worker(
        new URL("../lib/hero-wave-geometry.worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.addEventListener(
        "message",
        (event: MessageEvent<WaveGeometryMessage>) => {
          if ("error" in event.data) {
            buildInline();
            return;
          }
          accept(event.data.data);
        },
      );
      worker.addEventListener("error", buildInline);
      worker.addEventListener("messageerror", buildInline);
      worker.postMessage({
        requestId: 1,
        options,
      } satisfies WaveGeometryRequest);
    } catch {
      buildInline();
    }

    return () => {
      cancelled = true;
      worker?.terminate();
    };
  }, [segmentsX, segmentsY]);

  // Releases the previous sheet's GPU buffers on a tier change and on unmount.
  useEffect(() => () => geometry?.dispose(), [geometry]);

  return geometry;
}

function usePaletteTexture(): DataTexture {
  const texture = useMemo(() => {
    const ramp = new DataTexture(
      createPaletteRamp(),
      PALETTE_TEXTURE_WIDTH,
      1,
      RGBAFormat,
      UnsignedByteType,
    );
    // The shader decodes sRGB itself, so three must hand the bytes over raw.
    ramp.colorSpace = NoColorSpace;
    ramp.minFilter = LinearFilter;
    ramp.magFilter = LinearFilter;
    ramp.wrapS = ClampToEdgeWrapping;
    ramp.wrapT = ClampToEdgeWrapping;
    ramp.generateMipmaps = false;
    ramp.needsUpdate = true;
    return ramp;
  }, []);

  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

function WaveSheet({
  segmentsX,
  segmentsY,
  pointer,
  onDrawn,
}: Omit<HeroWaveSceneProps, "active">) {
  const material = useRef<HeroWaveMaterialImpl>(null);
  const geometry = useWaveGeometry(segmentsX, segmentsY);
  const palette = usePaletteTexture();
  const eased = useRef({ x: 0, y: 0 });
  const drawnFrames = useRef(0);
  const viewport = useThree((state) => state.viewport);

  useFrame((_, delta) => {
    const impl = material.current;
    if (!impl) return;

    // Clamped so a tab returning from the background advances the wave by one
    // frame instead of by the whole time it spent hidden.
    impl.uTime += Math.min(delta, 1 / 30);

    // Frame-rate independent exponential easing toward the live pointer.
    const blend = 1 - Math.pow(0.0016, delta);
    eased.current.x += (pointer.current.x - eased.current.x) * blend;
    eased.current.y += (pointer.current.y - eased.current.y) * blend;
    impl.uPointer.set(eased.current.x, eased.current.y);

    if (drawnFrames.current < 3) {
      drawnFrames.current += 1;
      if (drawnFrames.current === 3) onDrawn();
    }
  });

  if (!geometry) return null;

  // Fit the whole sheet into the frustum, then overscale so its long edges
  // bleed past the layer instead of floating inside it. Without this the sheet
  // is cropped to a single fold and reads as a flat wash.
  const contain = Math.min(
    viewport.width / DEFAULT_WAVE_GEOMETRY.width,
    viewport.height / DEFAULT_WAVE_GEOMETRY.height,
  );
  const wide = viewport.aspect > 1.15;
  // A stacked hero gets a short, wide layer, so the sheet has to be pushed
  // further past it than on desktop — at desktop overscale its rectangular
  // corner lands inside the band and reads as a ruled diagonal.
  const scale = contain * (wide ? 1.34 : 2.05);
  // The shader dissolves the sheet's left half, so a narrow layer has to slide
  // the dense right half back into frame or the band all but disappears.
  const offsetX = wide ? 0.24 : -0.2 * DEFAULT_WAVE_GEOMETRY.width * scale;

  return (
    <mesh
      frustumCulled={false}
      geometry={geometry}
      position={[offsetX, wide ? 0.04 : 0.12, 0]}
      rotation={[wide ? -0.34 : -0.46, 0.14, -0.2]}
      scale={scale}
    >
      <heroWaveMaterial
        depthWrite={false}
        key={HeroWaveMaterial.key}
        ref={material}
        side={DoubleSide}
        transparent
        uPalette={palette}
        uSheetSize={sheetSize}
      />
    </mesh>
  );
}

const sheetSize = new Vector2(
  DEFAULT_WAVE_GEOMETRY.width,
  DEFAULT_WAVE_GEOMETRY.height,
);

export function HeroWaveScene({
  segmentsX,
  segmentsY,
  pointer,
  active,
  onDrawn,
}: HeroWaveSceneProps) {
  const ceiling = useMemo(
    () => Math.min(2, typeof window === "undefined" ? 1 : window.devicePixelRatio),
    [],
  );
  const [dpr, setDpr] = useState(() => Math.min(1.5, ceiling));

  return (
    <Canvas
      camera={{ far: 20, fov: 40, near: 0.1, position: [0, 0, 2.9] }}
      dpr={dpr}
      flat
      frameloop={active ? "always" : "never"}
      gl={{
        alpha: true,
        antialias: true,
        depth: true,
        powerPreference: "high-performance",
        premultipliedAlpha: false,
        stencil: false,
      }}
      resize={{ scroll: false }}
      style={{ pointerEvents: "none" }}
    >
      {/* Drops resolution before the wave can cost the page its frame budget,
          and restores it when the device proves it can keep up. */}
      <PerformanceMonitor
        onDecline={() => setDpr(1)}
        onIncline={() => setDpr(ceiling)}
      />
      <WaveSheet
        onDrawn={onDrawn}
        pointer={pointer}
        segmentsX={segmentsX}
        segmentsY={segmentsY}
      />
    </Canvas>
  );
}
