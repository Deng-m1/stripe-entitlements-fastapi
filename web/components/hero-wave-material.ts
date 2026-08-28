"use client";

import { shaderMaterial } from "@react-three/drei";
import type { ThreeElements } from "@react-three/fiber";
import type { Ref } from "react";
import { Color, Texture, Vector2, Vector3 } from "three";

/**
 * Shading model for the folded hero sheet.
 *
 * Colour management is handled explicitly here rather than through three's
 * shader chunks: the palette texture is uploaded as raw bytes, decoded from
 * sRGB to linear on sample, lit in linear light, and encoded back on output.
 * Mixing saturated violet and amber in gamma space greys out the crossover,
 * which is precisely the part of the ramp the folds put on screen.
 */

const COLOR_SPACE_GLSL = /* glsl */ `
vec3 srgbToLinear(vec3 srgb) {
  bvec3 cutoff = lessThanEqual(srgb, vec3(0.04045));
  vec3 low = srgb / 12.92;
  vec3 high = pow((srgb + 0.055) / 1.055, vec3(2.4));
  return mix(high, low, vec3(cutoff));
}

vec3 linearToSrgb(vec3 linear) {
  bvec3 cutoff = lessThanEqual(linear, vec3(0.0031308));
  vec3 low = linear * 12.92;
  vec3 high = 1.055 * pow(max(linear, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(high, low, vec3(cutoff));
}
`;

/**
 * Travelling swell added on top of the baked folds, plus the pointer's local
 * lift. Written as a pure function of sheet-space xy so the vertex stage can
 * finite-difference it for the animated normal.
 */
const WAVE_FIELD_GLSL = /* glsl */ `
// Deliberately high spatial frequency relative to the sheet: a low-frequency
// field behaves like a tide and slides the whole palette up and down with it,
// which turns a stable violet-to-amber hero into a colour cycle.
float waveField(vec2 p) {
  float w = 0.0;
  w += sin(p.x * 2.05 + uTime * 0.42) * 0.48;
  w += sin(p.y * 2.85 - uTime * 0.31 + 1.9) * 0.32;
  w += sin((p.x * 1.35 + p.y * 1.72) * 1.45 + uTime * 0.55) * 0.28;
  w += sin((p.x * 3.1 - p.y * 2.2) + uTime * 0.24 + 2.4) * 0.15;
  return w;
}

// Keeps the animated lift away from the sheet border, so the alpha falloff
// never has to dissolve a moving silhouette.
float sheetEnvelope(vec2 p) {
  vec2 grid = p / uSheetSize + 0.5;
  return smoothstep(0.0, 0.18, grid.x) * smoothstep(0.0, 0.18, 1.0 - grid.x) *
         smoothstep(0.0, 0.22, grid.y) * smoothstep(0.0, 0.22, 1.0 - grid.y);
}

float displacement(vec2 p) {
  vec2 pointer = uPointer * uSheetSize * 0.5;
  float reach = distance(p, pointer) * 1.35;
  float swell = exp(-reach * reach) * uPointerStrength;
  return (waveField(p) + swell) * uAmplitude * sheetEnvelope(p);
}
`;

const VERTEX_SHADER = /* glsl */ `
attribute float fold;

uniform float uTime;
uniform float uAmplitude;
uniform vec2 uSheetSize;
uniform vec2 uPointer;
uniform float uPointerStrength;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewDirection;
varying float vFold;
varying float vLift;

${WAVE_FIELD_GLSL}

void main() {
  vUv = uv;
  vFold = fold;

  float lift = displacement(position.xy);
  vLift = lift / max(uAmplitude, 1e-4);
  vec3 displaced = position + normal * lift;

  // The baked sheet is a height field over xy, so its normal encodes the base
  // gradient directly: for z = f(x, y), n is parallel to (-fx, -fy, 1).
  vec2 baseGradient = -normal.xy / max(normal.z, 1e-4);
  float delta = 0.045;
  float alongX = displacement(position.xy + vec2(delta, 0.0));
  float alongY = displacement(position.xy + vec2(0.0, delta));
  vec2 liftGradient = vec2(alongX - lift, alongY - lift) / delta * normal.z;
  vec3 shapedNormal = normalize(vec3(-(baseGradient + liftGradient), 1.0));

  vec4 viewPosition = modelViewMatrix * vec4(displaced, 1.0);
  vNormal = normalize(normalMatrix * shapedNormal);
  vViewDirection = normalize(-viewPosition.xyz);
  gl_Position = projectionMatrix * viewPosition;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uPalette;
uniform vec3 uKeyLight;
uniform vec3 uFillLight;
uniform vec3 uSheenColor;
uniform vec3 uRimColor;
uniform float uSpecularStrength;
uniform float uShininess;
uniform float uRimStrength;
uniform float uOpacity;
uniform float uRampOrigin;
uniform float uRampScale;
uniform float uTroughFade;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewDirection;
varying float vFold;
varying float vLift;

${COLOR_SPACE_GLSL}

void main() {
  vec3 normal = normalize(vNormal);
  if (!gl_FrontFacing) {
    normal = -normal;
  }
  vec3 view = normalize(vViewDirection);
  vec3 key = normalize(uKeyLight);
  vec3 fill = normalize(uFillLight);

  float lambert = clamp(dot(normal, key), 0.0, 1.0);
  float keyWrap = clamp(dot(normal, key) * 0.5 + 0.5, 0.0, 1.0);
  float fillWrap = clamp(dot(normal, fill) * 0.5 + 0.5, 0.0, 1.0);
  float specular = pow(clamp(dot(normal, normalize(key + view)), 0.0, 1.0), uShininess);
  float rim = pow(1.0 - clamp(dot(normal, view), 0.0, 1.0), 2.6);

  // Violet at the far corner, lemon at the near one. The sheet is overscaled
  // past the layer and its outer band is dissolved by the alpha term below, so
  // the ramp is remapped onto the window that survives both — origin and scale
  // are chosen to put ramp 0 at the first opaque column and ramp 1 at the last.
  // Mapped over the whole sheet instead, violet and lemon land in the dissolved
  // margins and the hero never leaves the magenta middle.
  float diagonal = vUv.x * 0.66 + (1.0 - vUv.y) * 0.34;
  // Position and the baked folds own the ramp; the travelling lift only
  // nudges it, so the hero keeps one identity while the surface moves.
  float ramp = clamp(
    (diagonal - uRampOrigin) * uRampScale +
      vFold * 0.26 + vLift * 0.07 + normal.y * 0.1,
    0.0,
    1.0
  );

  vec3 base = srgbToLinear(texture2D(uPalette, vec2(ramp, 0.5)).rgb);
  // Over a light paper canvas a darkened trough reads as an olive smudge
  // rather than as shadow, so shading stays close to unity and the shadow is
  // spent on transparency instead (see the alpha term below).
  vec3 shaded = base * (0.8 + 0.26 * keyWrap + 0.18 * lambert);
  shaded += base * 0.1 * fillWrap;
  shaded += srgbToLinear(uSheenColor) * specular * uSpecularStrength;
  // Rim light peaks exactly on silhouettes. Over a dark canvas that reads as
  // glow; over paper it outlines the sheet, so it is kept low enough to warm
  // the turning crest without drawing it.
  shaded += srgbToLinear(uRimColor) * rim * uRimStrength;

  // The fold field owns the silhouette (Stripe's ribbon look): troughs clear
  // to bare canvas, so the visible shape is a set of curved crest bands and
  // the sheet's straight rectangle border almost always dies inside an
  // already-transparent trough. Round 2 replaced the previous "wide fades
  // everywhere" recipe, which read as a page-filling fog with one ruled
  // diagonal where the border crossed a saturated crest.
  float alpha = uOpacity;
  alpha *= smoothstep(0.0, 0.14, vUv.x) * smoothstep(0.0, 0.1, 1.0 - vUv.x);
  alpha *= smoothstep(0.0, 0.12, vUv.y) * smoothstep(0.0, 0.12, 1.0 - vUv.y);
  // Crests carry the colour; the window starts just below the flat midline so
  // the flattened border regions (camber pulls fold toward 0 there) melt out
  // instead of hanging as a half-transparent haze.
  // The transition band stays short on purpose: saturated ramp colours at
  // 10–40% alpha over warm paper grey out into a dirty mauve, so a long fade
  // reads as smudges on the page rather than as a translucent ribbon edge.
  alpha *= mix(
    1.0,
    smoothstep(0.14, 0.52, vFold * 1.3 + vLift * 0.45),
    uTroughFade
  );
  alpha *= 0.92 + 0.08 * keyWrap;

  vec3 output_ = linearToSrgb(shaded);
  // Ordered-free dither: 8-bit output banding is very visible across a ramp
  // this long and this smooth.
  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  output_ += (grain - 0.5) * (1.6 / 255.0);

  gl_FragColor = vec4(output_, clamp(alpha, 0.0, 1.0));
}
`;

export const HeroWaveMaterial = shaderMaterial(
  {
    uTime: 0,
    uAmplitude: 0.2,
    uSheetSize: new Vector2(3.4, 2.05),
    uPointer: new Vector2(0, 0),
    uPointerStrength: 0.5,
    uPalette: null as Texture | null,
    uKeyLight: new Vector3(-0.42, 0.78, 0.62),
    uFillLight: new Vector3(0.68, -0.36, 0.5),
    uSheenColor: new Color("#fff3d6"),
    uRimColor: new Color("#ffd0f0"),
    uSpecularStrength: 0.52,
    uShininess: 92,
    uRimStrength: 0.12,
    uOpacity: 1,
    uRampOrigin: 0.3,
    uRampScale: 1.75,
    uTroughFade: 0.97,
  },
  VERTEX_SHADER,
  FRAGMENT_SHADER,
);

export type HeroWaveMaterialImpl = InstanceType<typeof HeroWaveMaterial>;

/**
 * `ref` is replaced rather than intersected: the inherited
 * `Ref<ShaderMaterial>` is invariant, so a `Ref<HeroWaveMaterialImpl>` cannot
 * be assigned to it, and the uniform accessors are the whole point of holding
 * the ref.
 */
type HeroWaveMaterialElement = Omit<
  ThreeElements["shaderMaterial"],
  "ref" | "args"
> & {
  ref?: Ref<HeroWaveMaterialImpl>;
  uTime?: number;
  uAmplitude?: number;
  uSheetSize?: Vector2;
  uPointer?: Vector2;
  uPointerStrength?: number;
  uPalette?: Texture | null;
  uKeyLight?: Vector3;
  uFillLight?: Vector3;
  uSheenColor?: Color;
  uRimColor?: Color;
  uSpecularStrength?: number;
  uShininess?: number;
  uRimStrength?: number;
  uOpacity?: number;
  uRampOrigin?: number;
  uRampScale?: number;
  uTroughFade?: number;
};

declare module "@react-three/fiber" {
  interface ThreeElements {
    heroWaveMaterial: HeroWaveMaterialElement;
  }
}
