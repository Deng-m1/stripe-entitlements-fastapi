"use client";

import { shaderMaterial } from "@react-three/drei";
import type { ThreeElements } from "@react-three/fiber";
import type { Ref } from "react";
import { Color, Texture, Vector2, Vector3 } from "three";

/**
 * Shading model for the hero ribbon bundle.
 *
 * Two decisions here are load-bearing and were both wrong in round 3.
 *
 * **The surface is opaque.** Round 3 dissolved a rectangular sheet with alpha
 * ramps 30% of the sheet wide, which is why the measured render covered 67% of
 * the frame in pastel while the reference covers 28% in saturated colour: an
 * alpha ramp over paper *is* a tint toward white. Here the silhouette comes
 * from the geometry — every ribbon tapers to a point — so alpha stays at 1
 * across the body and only feathers at the two ends, and the colour reaching
 * the screen is the colour in the palette.
 *
 * **Colour management is explicit.** The palette texture is uploaded as raw
 * bytes, decoded from sRGB on sample, lit in linear light, and encoded back on
 * output. Mixing saturated violet and amber in gamma space greys out the
 * crossover, which is most of this ramp.
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
 * Travelling swell along the ribbon, plus the pointer's local lift.
 *
 * Written as a pure function of (along, across) so the vertex stage can
 * difference it for the animated normal. The envelope pins both ends: the tips
 * are the silhouette, and a moving silhouette on a one-pixel point shimmers.
 */
const WAVE_FIELD_GLSL = /* glsl */ `
float ribbonEnvelope(float along) {
  return smoothstep(0.0, 0.16, along) * smoothstep(0.0, 0.2, 1.0 - along);
}

float travellingLift(float along, float across, float phase) {
  float w = 0.0;
  w += sin(along * 7.4 - uTime * 0.78 + phase) * 0.52;
  w += sin(along * 12.1 + uTime * 0.49 + phase * 1.7 + 1.3) * 0.28;
  w += sin(along * 4.3 - uTime * 0.33 + across * 1.15 + phase * 0.6) * 0.2;
  return w * ribbonEnvelope(along);
}

float pointerLift(vec2 world) {
  vec2 pointer = uPointer * uFieldSize * 0.5;
  float reach = distance(world, pointer) / max(uPointerRadius, 1e-3);
  return exp(-reach * reach) * uPointerStrength;
}
`;

const VERTEX_SHADER = /* glsl */ `
attribute float aBlade;
attribute vec3 aSpine;

uniform float uTime;
uniform float uAmplitude;
uniform float uBladePhase;
uniform vec2 uFieldSize;
uniform vec2 uPointer;
uniform float uPointerRadius;
uniform float uPointerStrength;
uniform float uTiltAlong;
uniform float uTiltAcross;
uniform vec3 uRampAxis;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewDirection;
varying float vBlade;
varying float vLift;
varying float vField;

${WAVE_FIELD_GLSL}

void main() {
  vUv = uv;
  vBlade = aBlade;

  float phase = aBlade * uBladePhase;
  float across = uv.y * 2.0 - 1.0;
  float lift = travellingLift(uv.x, across, phase);
  vLift = lift;

  float swell = pointerLift(position.xy);
  float offset = (lift + swell) * uAmplitude;
  vec3 displaced = position + normal * offset;

  // Tilt the baked normal by the lift's own gradient, expressed in the
  // surface's frame. The metric of the parametric ribbon is folded into the
  // two tilt strengths rather than shipped as another attribute: the ribbon is
  // near-isometric along its spine, and across it the metric is just the local
  // width, so a constant is within a few percent over the visible body.
  float delta = 0.004;
  float alongStep =
    travellingLift(clamp(uv.x + delta, 0.0, 1.0), across, phase) - lift;
  float acrossStep = travellingLift(uv.x, across + delta * 2.0, phase) - lift;

  vec3 spine = normalize(aSpine);
  vec3 bitangent = normalize(cross(normal, spine));
  vec3 tilted = normalize(
    normal
      - spine * (alongStep / delta) * uTiltAlong
      - bitangent * (acrossStep / delta) * uTiltAcross
  );

  // The palette coordinate is a plane through the *bundle*, not a coordinate
  // on any one ribbon. Read per-ribbon — from aBlade, or from uv.x along the
  // spine — the ramp restarts at every blade, so two overlapping ribbons meet
  // at unrelated points on a violet-to-lemon palette and the bundle reads as
  // candy stripes. Sampling one object-space plane instead makes hue continue
  // across a ribbon boundary, so the fan looks cut from a single gradient and
  // the folds show up as the shading terms below push hue locally along it.
  vField = dot(displaced, uRampAxis);

  vec4 viewPosition = modelViewMatrix * vec4(displaced, 1.0);
  vNormal = normalize(normalMatrix * tilted);
  vViewDirection = normalize(-viewPosition.xyz);
  gl_Position = projectionMatrix * viewPosition;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uPalette;
uniform float uTime;
uniform vec3 uKeyLight;
uniform vec3 uFillLight;
uniform vec3 uSheenColor;
uniform float uSpecularStrength;
uniform float uShininess;
uniform float uRimStrength;
uniform vec3 uRimColor;
uniform float uOpacity;
uniform float uRampOrigin;
uniform float uRampSpan;
uniform float uRampField;
uniform float uRampBlade;
uniform float uRampAlong;
uniform float uRampAcross;
uniform float uRampShade;
uniform float uRampGrazing;
uniform float uRampEdge;
uniform float uRampLift;
uniform float uStriation;
uniform float uRootFade;
uniform float uTipFade;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewDirection;
varying float vBlade;
varying float vLift;
varying float vField;

${COLOR_SPACE_GLSL}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

/** Value noise, stretched along the ribbon so it reads as a fibre not a dot. */
float fibre(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  vec2 smoothed = local * local * (3.0 - 2.0 * local);
  float a = hash(cell);
  float b = hash(cell + vec2(1.0, 0.0));
  float c = hash(cell + vec2(0.0, 1.0));
  float d = hash(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, smoothed.x), mix(c, d, smoothed.x), smoothed.y);
}

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
  float rim = pow(1.0 - clamp(dot(normal, view), 0.0, 1.0), 3.0);

  float across = vUv.y * 2.0 - 1.0;
  // Lengthwise fibres. Very high frequency along the ribbon, very low across
  // it, which is the anisotropy that makes the reference read as a brushed
  // sheet rather than as a smooth gradient fill.
  float grain = fibre(vec2(vUv.x * 86.0 + vBlade * 31.0, vUv.y * 3.4)) - 0.5;

  // Where the ramp is read from, and why each term exists.
  //
  // vField carries it: one object-space plane across the whole bundle, so
  // the palette runs periwinkle at the fan's leading rim through magenta in
  // its body to amber at the tips, continuously, whichever ribbon a fragment
  // belongs to. The per-ribbon terms that remain are deliberately small — just
  // enough that two overlapping blades of the same hue still separate.
  //
  // The cooling terms model geometry, not lighting. In the reference,
  // periwinkle appears where a ribbon is seen edge-on or is running out of
  // width. Driving it from the key-light wrap instead leaves the cool arc off
  // screen entirely, because almost every visible face is lit.
  //
  // Both are raised to a power before they are applied. A linear falloff is
  // not a rim term at all: a face pointing straight at the camera still has a
  // grazing factor of about a quarter, so a linear term strong enough to reach
  // periwinkle at the silhouette drags the whole surface several stops down
  // the ramp with it. Cubed, the same amplitude leaves a facing fragment
  // within one percent of where it started. Their amplitude is now a third of
  // what it was: once the field supplies the cool rim, rim terms strong enough
  // to supply it again only draw a bright wire down every blade.
  float grazing = 1.0 - clamp(dot(normal, view), 0.0, 1.0);
  float rimward = pow(grazing, 2.6);
  float edgeward = pow(abs(across), 3.4);
  float ramp = clamp(
    uRampOrigin +
      uRampSpan *
        (vField * uRampField +
          vBlade * uRampBlade +
          vUv.x * uRampAlong +
          across * uRampAcross +
          vLift * uRampLift) -
      uRampShade * (1.0 - keyWrap) -
      uRampGrazing * rimward -
      uRampEdge * edgeward +
      grain * uStriation * 0.35,
    0.0,
    1.0
  );

  vec3 base = srgbToLinear(texture2D(uPalette, vec2(ramp, 0.5)).rgb);
  // Shading stays close to unity. Over paper a darkened trough reads as an
  // olive smudge rather than as shadow, and the reference's own troughs are
  // not dark — they are a different hue, which the ramp term above supplies.
  vec3 shaded = base * (0.82 + 0.2 * keyWrap + 0.14 * lambert + 0.08 * fillWrap);
  shaded += srgbToLinear(uSheenColor) * specular * uSpecularStrength;
  shaded += srgbToLinear(uRimColor) * rim * uRimStrength;
  shaded *= 1.0 + grain * uStriation;

  // Crisp everywhere except the two ends. The ribbon's outline is geometry, so
  // multisampling resolves it; feathering the whole silhouette is what turned
  // round 3's hero into a wash. The tip fade is the longer of the two because
  // it is the end that ends on screen.
  float alpha = uOpacity;
  alpha *= smoothstep(0.0, uRootFade, vUv.x);
  alpha *= smoothstep(0.0, uTipFade, 1.0 - vUv.x);

  vec3 output_ = linearToSrgb(shaded);
  // 8-bit output bands visibly across a ramp this long and this smooth.
  float dither = hash(gl_FragCoord.xy + fract(uTime));
  output_ += (dither - 0.5) * (1.6 / 255.0);

  gl_FragColor = vec4(output_, clamp(alpha, 0.0, 1.0));
}
`;

export const HeroWaveMaterial = shaderMaterial(
  {
    uTime: 0,
    uAmplitude: 0.06,
    uBladePhase: 4.2,
    uFieldSize: new Vector2(5.6, 3.4),
    uPointer: new Vector2(0, 0),
    uPointerRadius: 1.15,
    uPointerStrength: 0.55,
    uTiltAlong: 0.05,
    uTiltAcross: 0.16,
    uPalette: null as Texture | null,
    uKeyLight: new Vector3(-0.36, 0.72, 0.68),
    uFillLight: new Vector3(0.74, -0.3, 0.5),
    uSheenColor: new Color("#fff2d8"),
    uSpecularStrength: 0.3,
    uShininess: 42,
    uRimColor: new Color("#dfe4ff"),
    uRimStrength: 0.1,
    uOpacity: 1,
    // One plane through the bundle carries the ramp.
    //
    // In object space the ribbons leave the origin along +x and fan about it
    // in xy, so a dot product with this axis is "how far across the fan, plus
    // how far out along it". The negative y puts the cool end of the palette
    // on the rim that faces the headline column and the warm end on the rim
    // that runs off frame; the positive x carries the tips up into amber. The
    // magnitudes are set so the dot product spans roughly one palette width
    // over the visible mass, which is what `uRampOrigin` is then offsetting.
    //
    // Neither of the two per-ribbon drivers this replaces can do that job.
    // Fan-driven (`uRampBlade`) makes each ribbon one flat hue and, in a
    // right-hand composition that only ever shows the fan's outer ribbons,
    // spends most of the palette off screen: measured, 12.7% cool against 2.1%
    // warm, and reversing it only swapped which end was missing. Spine-driven
    // (`uRampAlong`) restarts the palette at every blade, so overlapping
    // ribbons meet at unrelated hues and the mass reads as candy stripes
    // rather than as satin. Both survive here only as small offsets that keep
    // neighbours from merging.
    uRampAxis: new Vector3(0.075, -0.26, 0.1),
    uRampOrigin: 0.6,
    uRampSpan: 1,
    uRampField: 1.7,
    uRampBlade: 0.09,
    uRampAlong: 0.06,
    uRampAcross: 0.05,
    uRampShade: 0.1,
    uRampGrazing: 0.22,
    uRampEdge: 0.18,
    uRampLift: 0.05,
    uStriation: 0.06,
    uRootFade: 0.06,
    uTipFade: 0.24,
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
  uBladePhase?: number;
  uFieldSize?: Vector2;
  uPointer?: Vector2;
  uPointerRadius?: number;
  uPointerStrength?: number;
  uTiltAlong?: number;
  uTiltAcross?: number;
  uRampAxis?: Vector3;
  uPalette?: Texture | null;
  uKeyLight?: Vector3;
  uFillLight?: Vector3;
  uSheenColor?: Color;
  uSpecularStrength?: number;
  uShininess?: number;
  uRimColor?: Color;
  uRimStrength?: number;
  uOpacity?: number;
  uRampOrigin?: number;
  uRampSpan?: number;
  uRampField?: number;
  uRampBlade?: number;
  uRampAlong?: number;
  uRampAcross?: number;
  uRampShade?: number;
  uRampGrazing?: number;
  uRampEdge?: number;
  uRampLift?: number;
  uStriation?: number;
  uRootFade?: number;
  uTipFade?: number;
};

declare module "@react-three/fiber" {
  interface ThreeElements {
    heroWaveMaterial: HeroWaveMaterialElement;
  }
}
