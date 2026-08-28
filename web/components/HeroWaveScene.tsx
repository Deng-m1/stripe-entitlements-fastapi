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
  type Mesh,
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
  HERO_RIBBON_LAYERS,
  ribbonLayerGeometryOptions,
  type WaveGeometryData,
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
  /**
   * Quads per axis for the primary sheet at this viewport tier; the other
   * ribbon layers derive their counts from it. A change rebuilds the stack.
   */
  segmentsX: number;
  segmentsY: number;
  /** Live pointer in [-1, 1] sheet space, written by the host component. */
  pointer: RefObject<PointerTarget>;
  /** False while the hero is offscreen or the tab is hidden. */
  active: boolean;
  /** Fires once the renderer has actually put pixels on the canvas. */
  onDrawn: () => void;
  /** Fires when the browser revokes the WebGL context (GPU reset, eviction). */
  onContextLost: () => void;
}

/**
 * Exact repeat period of the shader's wave field: every time coefficient in
 * `waveField`/the ramp shimmer is a multiple of 0.01, so 200π seconds later
 * every sin() argument has advanced by a whole number of turns. Wrapping
 * uTime on this period is invisible on screen and keeps the float32 sine
 * arguments small on long-lived tabs, where precision loss would otherwise
 * warp the wave. Per-layer uTimeShift values are constants, so they shift the
 * field without touching its period.
 */
export const WAVE_TIME_PERIOD = Math.PI * 200;

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
 * Builds every ribbon layer's sheet in one Worker batch, falling back to
 * inline generation when Workers are unavailable or the module fails to load.
 * Both routes call the same generator with the same per-layer options, so the
 * two can never drift apart visually, and the stack always arrives as a
 * complete generation — layers from different builds never mix.
 */
function useWaveGeometries(segmentsX: number, segmentsY: number) {
  const [geometries, setGeometries] = useState<BufferGeometry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    let settled = false;
    let worker: Worker | null = null;
    const sheets = HERO_RIBBON_LAYERS.map((layer) =>
      ribbonLayerGeometryOptions(layer, segmentsX, segmentsY),
    );

    const accept = (data: WaveGeometryData[]) => {
      if (cancelled || settled) return;
      settled = true;
      setGeometries(data.map(toBufferGeometry));
    };

    const buildInline = () => {
      if (cancelled || settled) return;
      accept(sheets.map((options) => createWaveGeometryData(options)));
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
          accept(event.data.sheets);
        },
      );
      worker.addEventListener("error", buildInline);
      worker.addEventListener("messageerror", buildInline);
      worker.postMessage({
        requestId: 1,
        sheets,
      } satisfies WaveGeometryRequest);
    } catch {
      buildInline();
    }

    return () => {
      cancelled = true;
      worker?.terminate();
    };
  }, [segmentsX, segmentsY]);

  // Releases the previous stack's GPU buffers on a tier change and on unmount.
  useEffect(
    () => () => geometries?.forEach((geometry) => geometry.dispose()),
    [geometries],
  );

  return geometries;
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
 * The layered ribbon stack. Every layer shares one wrapped clock and one
 * eased pointer, so the sheets read as one weather system; each mesh carries
 * its own fold recipe, palette window, and depth discipline from
 * `HERO_RIBBON_LAYERS`, which is what lets crests thread over and under the
 * neighbouring sheets instead of compositing as a single thick wash.
 */
function RibbonField({
  segmentsX,
  segmentsY,
  pointer,
  onDrawn,
  onContextLost,
}: Omit<HeroWaveSceneProps, "active">) {
  const materials = useRef<(HeroWaveMaterialImpl | null)[]>([]);
  const meshes = useRef<(Mesh | null)[]>([]);
  const clock = useRef(0);
  const geometries = useWaveGeometries(segmentsX, segmentsY);
  const palette = usePaletteTexture();
  const eased = useRef({ x: 0, y: 0 });
  const drawnFrames = useRef(0);
  const viewport = useThree((state) => state.viewport);
  const gl = useThree((state) => state.gl);

  // A lost context leaves a blank canvas behind; the host has to know so it
  // can bring the poster back instead of showing bare paper.
  useEffect(() => {
    const canvas = gl.domElement;
    const handleLost = () => onContextLost();
    canvas.addEventListener("webglcontextlost", handleLost);
    return () => canvas.removeEventListener("webglcontextlost", handleLost);
  }, [gl, onContextLost]);

  useFrame((_, delta) => {
    // Clamped so a tab returning from the background advances the wave by one
    // frame instead of by the whole time it spent hidden; wrapped on the
    // field's exact repeat period so long sessions never lose sine precision.
    // One clock feeds every layer — the stack must never desynchronise.
    clock.current =
      (clock.current + Math.min(delta, 1 / 30)) % WAVE_TIME_PERIOD;

    // Frame-rate independent exponential easing toward the live pointer.
    const blend = 1 - Math.pow(0.0016, delta);
    eased.current.x += (pointer.current.x - eased.current.x) * blend;
    eased.current.y += (pointer.current.y - eased.current.y) * blend;

    let anyDrawn = false;
    for (let index = 0; index < HERO_RIBBON_LAYERS.length; index += 1) {
      const impl = materials.current[index];
      if (impl) {
        impl.uTime = clock.current;
        impl.uPointer.set(eased.current.x, eased.current.y);
        anyDrawn = true;
      }
      const mesh = meshes.current[index];
      const layer = HERO_RIBBON_LAYERS[index];
      if (mesh) {
        // Pointer parallax: the front lace leans furthest, the rear weave
        // barely moves. This differential motion — not the z offsets, which
        // are invisible from a fixed camera — is what sells the stack as
        // physically separated sheets.
        mesh.position.x = layer.drift[0] + eased.current.x * layer.parallax;
        mesh.position.y =
          layer.drift[1] + eased.current.y * layer.parallax * 0.6;
      }
    }
    if (!anyDrawn) return;

    if (drawnFrames.current < 3) {
      drawnFrames.current += 1;
      if (drawnFrames.current === 3) onDrawn();
    }
  });

  if (!geometries) return null;

  // Fit the whole primary sheet into the frustum, then overscale so its long
  // edges bleed past the layer instead of floating inside it. Without this
  // the stack is cropped to a single fold and reads as a flat wash.
  const contain = Math.min(
    viewport.width / DEFAULT_WAVE_GEOMETRY.width,
    viewport.height / DEFAULT_WAVE_GEOMETRY.height,
  );
  const wide = viewport.aspect > 1.15;
  // Overscale pushes each sheet's rectangular border out of the layer on every
  // side that a crest can cross: any border that stays inside the crop draws a
  // ruled line wherever it cuts a saturated band, no matter how wide the uv
  // fade is. The fold count rose with the overscale so the visible window
  // still holds two to three crest bands.
  const scale = contain * (wide ? 1.66 : 2.05);
  // The shader dissolves each sheet's left half, so a narrow layer has to
  // slide the dense right half back into frame or the band all but disappears.
  const offsetX = wide ? 0.34 : -0.2 * DEFAULT_WAVE_GEOMETRY.width * scale;

  return (
    <group
      position={[offsetX, wide ? 0.04 : 0.12, 0]}
      rotation={[wide ? -0.34 : -0.46, 0.14, -0.2]}
      scale={scale}
    >
      {HERO_RIBBON_LAYERS.map((layer, index) => (
        <mesh
          frustumCulled={false}
          geometry={geometries[index]}
          key={layer.id}
          position={[layer.drift[0], layer.drift[1], layer.zLift]}
          ref={(instance) => {
            meshes.current[index] = instance;
          }}
          // Blending must run back-to-front in layer order. Three's own
          // transparent sort keys on bounding-sphere distance, which the
          // interpenetrating, differently-rotated sheets would flip between
          // frames; the explicit order pins it.
          renderOrder={index}
          rotation={[layer.tilt[0], layer.tilt[1], layer.tilt[2]]}
        >
          <heroWaveMaterial
            depthWrite={layer.depthWrite}
            key={HeroWaveMaterial.key}
            ref={(instance: HeroWaveMaterialImpl | null) => {
              materials.current[index] = instance;
            }}
            side={DoubleSide}
            transparent
            uAlphaClip={layer.alphaClip}
            uAmplitude={layer.amplitude}
            uCrestGlow={layer.crestGlow}
            uOpacity={
              layer.opacity * (wide ? 1 : layer.narrowOpacityScale)
            }
            uPalette={palette}
            uPointerStrength={layer.pointerStrength}
            uRampOrigin={layer.rampOrigin}
            uRampScale={layer.rampScale}
            uSheetSize={sheetSize}
            uTimeShift={layer.timeShift}
            uTroughHigh={layer.troughHigh}
            uTroughLow={layer.troughLow}
          />
        </mesh>
      ))}
    </group>
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
  onContextLost,
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
      <RibbonField
        onContextLost={onContextLost}
        onDrawn={onDrawn}
        pointer={pointer}
        segmentsX={segmentsX}
        segmentsY={segmentsY}
      />
    </Canvas>
  );
}
