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
  type Group,
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
  /** Quads per axis for this viewport tier; a change rebuilds the bundle. */
  segmentsAlong: number;
  segmentsAcross: number;
  /** Live pointer in [-1, 1] sheet space, written by the host component. */
  pointer: RefObject<PointerTarget>;
  /**
   * True when the hero is in its stacked layout, read from the same media
   * query the stylesheet uses. Not inferred from the canvas aspect ratio: at
   * 1024px the hero is still two columns but its wave layer is taller than it
   * is wide, so an aspect test would compose it as if it had stacked.
   */
  stacked: boolean;
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
  // Prefixed, because three reserves the bare name `tangent` for its own
  // tangent-space attribute and would rewrite the declaration out from under
  // this shader.
  geometry.setAttribute("aSpine", new BufferAttribute(data.tangent, 3));
  geometry.setAttribute("aBlade", new BufferAttribute(data.blade, 1));
  geometry.setIndex(new BufferAttribute(data.index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Builds the sheet in a Worker, falling back to inline generation when Workers
 * are unavailable or the module fails to load. Both routes call the same
 * generator, so the two can never drift apart visually.
 */
function useWaveGeometry(segmentsAlong: number, segmentsAcross: number) {
  const [geometry, setGeometry] = useState<BufferGeometry | null>(null);

  useEffect(() => {
    let cancelled = false;
    let settled = false;
    let worker: Worker | null = null;
    const options: WaveGeometryOptions = {
      ...DEFAULT_WAVE_GEOMETRY,
      segmentsAlong,
      segmentsAcross,
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
  }, [segmentsAlong, segmentsAcross]);

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

/**
 * Where the bundle sits, per layout.
 *
 * The ribbons are anchored by their common root, which is pushed off the
 * bottom-right corner so only the fan's open end is on screen — the same
 * composition as the reference, and the reason the hero needs no mask to keep
 * its shape off the headline column. `spin` is the bundle's own roll: it turns
 * the fan from "pointing right" to "sweeping up and to the left", and `fit` is
 * the longest ribbon's span as a fraction of the layer's diagonal — the
 * diagonal, not either axis, because the bundle is placed corner to corner and
 * a width-based fit collapses it on a layer taller than it is wide.
 */
const DESKTOP_LAYOUT = {
  root: [1.0, -1.12] as const,
  spin: 1.95,
  tilt: [-0.16, 0.2] as const,
  fit: 1.14,
};

/**
 * Stacked: rooted past the top-right corner with the fan opening left, so the
 * bundle crosses the hero as a band and its tips leave through the left edge.
 *
 * The tips are why the band runs across rather than down. They carry a long
 * alpha feather — the desktop layout aims them off the top of the frame, where
 * nobody sees them resolve. Rooting the bundle at the top-right and letting it
 * sweep down-left instead, which is closer to what the reference does on a
 * narrow viewport, lands that feather squarely on the headline and the body
 * copy: a half-transparent periwinkle tail over warm paper reads as an olive
 * smudge across the text, not as a ribbon. Across the top the tips exit
 * sideways and the copy sits on paper.
 *
 * The stacked hero pays for the band in vertical space; see the padding this
 * layout's breakpoint adds to `.hero-copy`.
 */
const STACKED_LAYOUT = {
  root: [0.86, 1.14] as const,
  spin: 3.42,
  tilt: [-0.12, 0.16] as const,
  fit: 0.84,
};

function RibbonBundle({
  segmentsAlong,
  segmentsAcross,
  stacked,
  pointer,
  onDrawn,
}: Omit<HeroWaveSceneProps, "active">) {
  const material = useRef<HeroWaveMaterialImpl>(null);
  const group = useRef<Group>(null);
  const geometry = useWaveGeometry(segmentsAlong, segmentsAcross);
  const palette = usePaletteTexture();
  const eased = useRef({ x: 0, y: 0 });
  const drawnFrames = useRef(0);
  const viewport = useThree((state) => state.viewport);

  const layout = stacked ? STACKED_LAYOUT : DESKTOP_LAYOUT;
  const diagonal = Math.hypot(viewport.width, viewport.height);
  const scale = (diagonal / DEFAULT_WAVE_GEOMETRY.length) * layout.fit;

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

    // A slow roll of the whole bundle, on a period long enough that it never
    // resolves into a loop. Without it the silhouettes are fixed and only the
    // light inside them moves, which reads as a video texture on a still.
    const node = group.current;
    if (node) {
      const time = impl.uTime;
      node.rotation.z =
        layout.spin + Math.sin(time * 0.11) * 0.035 + Math.sin(time * 0.047) * 0.02;
      node.rotation.x = layout.tilt[0] + Math.sin(time * 0.083 + 1.4) * 0.03;
      node.rotation.y = layout.tilt[1] + Math.sin(time * 0.062 + 0.6) * 0.04;
    }

    if (drawnFrames.current < 3) {
      drawnFrames.current += 1;
      if (drawnFrames.current === 3) onDrawn();
    }
  });

  if (!geometry) return null;

  return (
    <group
      position={[
        layout.root[0] * viewport.width * 0.5,
        layout.root[1] * viewport.height * 0.5,
        0,
      ]}
      ref={group}
      rotation={[layout.tilt[0], layout.tilt[1], layout.spin]}
      scale={scale}
    >
      <mesh frustumCulled={false} geometry={geometry}>
        {/* Opaque body, depth-tested: the ribbons overlap, and which one is in
            front has to be decided by depth rather than by index order. Only
            the feathered ends are actually blended, which is why the material
            can keep `depthWrite` on without punching holes in the fan. */}
        <heroWaveMaterial
          depthWrite
          key={HeroWaveMaterial.key}
          ref={material}
          side={DoubleSide}
          transparent
          uFieldSize={fieldSize}
          uPalette={palette}
        />
      </mesh>
    </group>
  );
}

const fieldSize = new Vector2(
  DEFAULT_WAVE_GEOMETRY.length,
  DEFAULT_WAVE_GEOMETRY.length * 0.6,
);

export function HeroWaveScene({
  segmentsAlong,
  segmentsAcross,
  stacked,
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
      <RibbonBundle
        onDrawn={onDrawn}
        pointer={pointer}
        segmentsAcross={segmentsAcross}
        segmentsAlong={segmentsAlong}
        stacked={stacked}
      />
    </Canvas>
  );
}
