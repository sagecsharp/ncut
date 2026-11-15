/** shared glsl for every effect program. see the contract in types.ts. */

export const VERTEX_SRC = `#version 300 es
uniform float u_flip;
out vec2 v_uv;
void main() {
  // one big triangle that covers the viewport, no buffers needed
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p.x * 2.0 - 1.0, (p.y * 2.0 - 1.0) * u_flip, 0.0, 1.0);
}`;

export const PRELUDE = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform vec2 u_size;
uniform float u_time;
uniform float u_duration;
uniform float u_amount;
uniform float u_seed;

#define PI 3.14159265359
#define TAU 6.28318530718

/** the picture below the effect. clamp-to-edge outside 0..1. */
vec4 tex(vec2 uv) { return texture(u_tex, uv); }

/** width / height of the frame */
float aspect() { return u_size.x / u_size.y; }

float sat(float x) { return clamp(x, 0.0, 1.0); }
vec3 sat(vec3 x) { return clamp(x, 0.0, 1.0); }

/* hashes: cheap, stable across gpus (no sin). they follow "hash without sine" by david hoskins,
   shadertoy.com/view/4djSRW, mit license, copyright (c) 2014 david hoskins (see THIRD-PARTY-NOTICES.md) */
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hash31(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

/** smooth 1d value noise, 0..1 */
float noise1(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash11(i), hash11(i + 1.0), f);
}
/** smooth 1d noise, -1..1 */
float snoise1(float x) { return noise1(x) * 2.0 - 1.0; }
/** smooth 2d value noise, 0..1 */
float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
/** 4 octaves of noise2, 0..1 */
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise2(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return v / 0.9375;
}

vec2 rot(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

/**
 * where to sample so the picture looks moved by offset (fraction of the frame, +x right, +y down),
 * rotated clockwise by angle (radians) and zoomed by zoom (>1 = bigger) around the frame center.
 * aspect correct: rotation never shears.
 */
vec2 xform(vec2 uv, vec2 offset, float angle, float zoom) {
  vec2 p = uv - 0.5 - offset;
  p.x *= aspect();
  p = rot(p, -angle) / max(zoom, 0.0001);
  p.x /= aspect();
  return p + 0.5;
}
`;

export const MAIN = `
void main() {
  vec4 c = effect(v_uv);
  outColor = vec4(clamp(c.rgb, 0.0, 1.0), 1.0);
}`;

/*
 * the alpha helpers. only an effect with `alpha` ('moves' / 'own') gets them, in every build (and FX_ALPHA, 1 in the
 * alpha build, 0 else). in the alpha build tex() gives premultiplied colour (rgb already times a) and effect() returns
 * premultiplied colour with its own alpha (MAIN_ALPHA keeps it). in the plain build they are identities and MAIN drops
 * the alpha, so the same code is the old maths on an opaque frame.
 * rules for an effect with alpha:
 *  - moving and mixing samples (taps, averages, weighted sums, a mix between two samples): on the whole vec4.
 *  - each colour moved on its own (rgb split, ripple, lens, glitch, rgb trail): three vec4 samples or sums, then pick3.
 *    the alpha is the max of the three, the outline of all the ghosts.
 *  - non-linear colour work (contrast, thresholds, tone curves, tint from luma, noise or specks mixed in): unpm() to
 *    straight colour, the old lines, then repm() with the alpha of the sample. light added this way only lands on the
 *    picture.
 *  - light that spreads past the outline (bloom, the glow of soft focus) brings its own alpha:
 *    a = 1 - (1 - a) * (1 - max(glow.r, max(glow.g, glow.b))).
 *  - shading that is part of the look (vignette, scanlines, rib shading, fog, a tube mask) darkens .rgb only. shading is
 *    not a hole.
 *  - never scale rgb by .a by hand and never return vec4(..., 1.0): use repm.
 *  - if a gpu gives the plain build a different pixel than the old code, keep the old lines under #if FX_ALPHA / #else.
 */
export const PLAIN_BLOCK = `#define FX_ALPHA 0
vec3 unpm(vec4 c) { return c.rgb; }
vec4 repm(vec3 rgb, float a) { return vec4(rgb, 1.0); }
vec4 pick3(vec4 r, vec4 g, vec4 b) { return vec4(r.r, g.g, b.b, 1.0); }
`;

export const ALPHA_BLOCK = `#define FX_ALPHA 1
/** straight colour of a premultiplied pixel, black where nothing covers it */
vec3 unpm(vec4 c) { return c.a > 0.0 ? min(c.rgb / c.a, vec3(1.0)) : vec3(0.0); }
/** a straight colour back on the coverage a */
vec4 repm(vec3 rgb, float a) { return vec4(rgb * a, a); }
/** each colour from its own sample. the outline is where any of them is */
vec4 pick3(vec4 r, vec4 g, vec4 b) { return vec4(r.r, g.g, b.b, max(r.a, max(g.a, b.a))); }
`;

/** a keep effect inside an alpha run: it reads straight colour, like the plain run, and MAIN_CUT cuts it to the alpha */
export const CUT_BLOCK = `#define FX_ALPHA 0
vec4 fx_straight(vec2 uv) {
  vec4 c = texture(u_tex, uv);
  return vec4(c.a > 0.0 ? min(c.rgb / c.a, vec3(1.0)) : vec3(0.0), c.a);
}
#define tex(uv) fx_straight(uv)
`;

/** an effect with alpha on one clip: effect() returns premultiplied rgba, its alpha is the new outline */
export const MAIN_ALPHA = `
void main() {
  vec4 c = effect(v_uv);
  float a = clamp(c.a, 0.0, 1.0);
  outColor = vec4(clamp(c.rgb, 0.0, a), a);
}`;

/** a keep effect inside an alpha run: opaque colour out, cut to the alpha the picture has at this pixel, premultiplied */
export const MAIN_CUT = `
void main() {
  vec4 c = effect(v_uv);
  float a = texture(u_tex, v_uv).a;
  outColor = vec4(clamp(c.rgb, 0.0, 1.0) * a, a);
}`;
