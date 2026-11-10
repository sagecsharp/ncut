import type { EffectDef } from '../types';

/** color grading style looks: the picture keeps its detail but the colors change. */
export const COLOR_EFFECTS: EffectDef[] = [
  {
    id: 'duotone-strobe',
    name: 'duotone strobe',
    category: 'color',
    description: 'two color gradient map that changes color pair on a fast beat',
    posterTime: 0.3,
    sync: { param: 'rate', cycles: 1 },
    params: [
      { key: 'rate', label: 'rate', min: 1, max: 30, step: 0.5, default: 8, unit: 'hz' },
      { key: 'contrast', label: 'contrast', min: 20, max: 300, step: 5, default: 100, unit: '%' },
      { key: 'saturation', label: 'saturation', min: 0, max: 200, step: 5, default: 100, unit: '%' },
    ],
    glsl: `
// 6 color pairs (dark / light): green blue, magenta blue, red blue, pink yellow, orange green, cyan yellow
const vec3 DS_DK[6] = vec3[6](
  vec3(0.20, 0.85, 0.20), vec3(0.90, 0.10, 0.80), vec3(0.95, 0.10, 0.15),
  vec3(1.00, 0.30, 0.60), vec3(1.00, 0.30, 0.05), vec3(0.10, 0.90, 1.00));
const vec3 DS_LT[6] = vec3[6](
  vec3(0.15, 0.40, 0.95), vec3(0.20, 0.30, 1.00), vec3(0.25, 0.30, 1.00),
  vec3(1.00, 0.95, 0.20), vec3(0.40, 0.95, 0.20), vec3(1.00, 0.95, 0.25));

vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float l = luma(c);
  // which pair is on right now
  int idx = int(mod(floor(u_time * p_rate) + floor(u_seed), 6.0));
  // map by luma around the middle of the card, contrast sets how hard the split is
  float t = sat((l - 0.43) * (p_contrast / 100.0 * 8.0) + 0.5);
  vec3 col = mix(DS_DK[idx], DS_LT[idx], t);
  // keep some of the picture's detail
  col *= 0.8 + 0.4 * l;
  col = mix(vec3(luma(col)), col, p_saturation / 100.0);
  return vec4(mix(c, col, u_amount), 1.0);
}`,
  },
  {
    id: 'duotone-glide',
    name: 'duotone glide',
    category: 'color',
    description: 'two color gradient map whose colors travel around a wheel, gliding or cutting on a beat',
    posterTime: 0.3,
    sync: { param: 'rate', cycles: 1 },
    params: [
      { key: 'rate', label: 'rate', min: 0.5, max: 30, step: 0.1, default: 3.9, unit: 'hz' },
      { key: 'contrast', label: 'contrast', min: 20, max: 300, step: 5, default: 100, unit: '%' },
      { key: 'saturation', label: 'saturation', min: 0, max: 200, step: 5, default: 100, unit: '%' },
      { key: 'glide', label: 'glide', min: 0, max: 100, step: 1, default: 100, unit: '%' },
    ],
    glsl: `
// the wheel both colors travel on: green, cyan, blue, magenta, red, yellow
const vec3 DS_W[6] = vec3[6](
  vec3(0.447, 0.949, 0.322), vec3(0.463, 0.953, 0.969), vec3(0.035, 0.110, 0.922),
  vec3(0.890, 0.235, 0.910), vec3(0.871, 0.208, 0.145), vec3(0.949, 0.969, 0.314));

vec3 ds_wheel(float x) {
  x = mod(x, 6.0);
  int i = int(floor(x));
  return mix(DS_W[i], DS_W[(i + 1) % 6], fract(x));
}

vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float l = luma(c);
  // one step = two colors on (green -> blue -> red -> green), rate = steps per second
  float st = u_time * p_rate;
  float e = fract(st);
  // glide: the share of a step spent moving. the rest is a hold on the color. 0 = a hard cut on every step
  float w = p_glide / 100.0 * 0.82;
  float m = w > 0.001 ? sat((e - 0.5 * (1.0 - w)) / w) : step(0.5, e);
  float pos = (floor(st) + floor(u_seed) + m) * 2.0;
  vec3 dark = ds_wheel(pos);
  vec3 light = ds_wheel(pos + 2.0);
  // map by luma around the middle of the card, contrast sets how hard the split is
  float t = sat((l - 0.43) * (p_contrast / 100.0 * 8.0) + 0.5);
  vec3 col = mix(dark, light, t);
  // keep a little of the picture's detail
  col *= 0.95 + 0.1 * l;
  col = mix(vec3(luma(col)), col, p_saturation / 100.0);
  return vec4(mix(c, col, u_amount), 1.0);
}`,
  },
  {
    id: 'hue-wash',
    name: 'hue wash',
    category: 'color',
    description: 'a soft color overlay that travels around the whole hue wheel',
    posterTime: 0.5,
    sync: { param: 'speed', cycles: 1 },
    params: [
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 35, unit: '%' },
      { key: 'speed', label: 'speed', min: 0.05, max: 3, step: 0.05, default: 0.42, unit: 'hz' },
      { key: 'saturation', label: 'saturation', min: 0, max: 100, step: 1, default: 90, unit: '%' },
    ],
    glsl: `
// soft light (pegtop)
vec3 hw_soft(vec3 a, vec3 b) {
  return (1.0 - 2.0 * b) * a * a + 2.0 * b * a;
}

vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  // hue goes around the wheel, speed = loops per second
  float h = fract(u_time * p_speed + u_seed / 100.0);
  vec3 wash = hsv2rgb(vec3(h, p_saturation / 100.0, 1.0));
  // blend: half soft light, half tinted multiply / screen
  vec3 soft = hw_soft(c, wash);
  vec3 mulscr = mix(c * wash * 1.8, 1.0 - (1.0 - c) * (1.0 - wash), luma(c));
  vec3 tinted = mix(soft, mulscr, 0.5);
  float k = sat(p_strength / 100.0 * 1.6) * u_amount;
  return vec4(mix(c, tinted, k), 1.0);
}`,
  },
  {
    id: 'hue-gel',
    name: 'color gel',
    category: 'color',
    description: 'a colored gel over the picture that travels around the whole hue wheel',
    posterTime: 0.5,
    sync: { param: 'speed', cycles: 1 },
    params: [
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 23, unit: '%' },
      { key: 'speed', label: 'speed', min: 0.05, max: 3, step: 0.01, default: 0.83, unit: 'hz' },
      { key: 'saturation', label: 'saturation', min: 0, max: 100, step: 1, default: 90, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  // hue goes around the wheel, speed = loops per second
  float h = fract(u_time * p_speed + u_seed / 100.0);
  vec3 wash = hsv2rgb(vec3(h, p_saturation / 100.0, 1.0));
  // like a gel in front of the lens: the wash color multiplies the picture, its own color stays as bright
  float k = p_strength / 100.0 * u_amount;
  return vec4(c * mix(vec3(1.0), wash, k), 1.0);
}`,
  },
  {
    id: 'flash',
    name: 'flash',
    category: 'color',
    description: 'rhythmic exposure flashes that bloom to white and fall back',
    posterTime: 0.05,
    sync: { param: 'rate', cycles: 1 },
    params: [
      { key: 'rate', label: 'rate', min: 0.2, max: 12, step: 0.1, default: 2, unit: 'hz' },
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 80, unit: '%' },
      { key: 'decay', label: 'decay', min: 1, max: 30, step: 0.5, default: 8, unit: 'x' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  // position inside the current flash, 0..1
  float ph = fract(u_time * p_rate);
  // near instant attack, exponential fall back
  float env = exp(-ph * p_decay) * smoothstep(0.0, 0.01, ph);
  float k = p_strength / 100.0 * env * u_amount;
  // additive exposure: gain plus a white lift, fully white at k = 1
  vec3 col = c * (1.0 + 3.0 * k) + vec3(k);
  return vec4(col, 1.0);
}`,
  },
  {
    id: 'soft-flash',
    name: 'soft flash',
    category: 'color',
    description: 'rhythmic flashes of light added on top of the picture, darks and lights lift the same, and it falls back fast',
    posterTime: 0.05,
    sync: { param: 'rate', cycles: 1 },
    params: [
      { key: 'rate', label: 'rate', min: 0.2, max: 12, step: 0.1, default: 2, unit: 'hz' },
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 30, unit: '%' },
      { key: 'decay', label: 'decay', min: 1, max: 30, step: 0.5, default: 6, unit: 'x' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  // position inside the current flash, 0..1
  float ph = fract(u_time * p_rate);
  // near instant attack, exponential fall back
  float env = exp(-ph * p_decay) * smoothstep(0.0, 0.01, ph);
  float k = p_strength / 100.0 * env * u_amount;
  // light added on top: darks and lights lift by the same amount, fully white at k = 1
  return vec4(c + vec3(k), 1.0);
}`,
  },
  {
    id: 'flicker',
    name: 'flicker',
    category: 'color',
    description: 'the brightness dips and comes back on a fast beat, like a failing lamp',
    posterTime: 0.07,
    sync: { param: 'rate', cycles: 1 },
    params: [
      { key: 'rate', label: 'rate', min: 0.5, max: 30, step: 0.5, default: 7.5, unit: 'hz' },
      { key: 'depth', label: 'depth', min: 0, max: 100, step: 1, default: 20, unit: '%' },
      { key: 'shape', label: 'shape', min: 0, max: 2, step: 1, default: 0, options: ['ramp', 'on / off', 'random'] },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float x = u_time * p_rate;
  float ph = fract(x);
  // how far down the light is right now, 0..1
  float d;
  if (p_shape < 0.5) d = 1.0 - abs(2.0 * ph - 1.0);
  else if (p_shape < 1.5) d = step(0.5, ph);
  else d = hash11(floor(x + 0.002) + u_seed);
  return vec4(c * (1.0 - p_depth / 100.0 * d * u_amount), 1.0);
}`,
  },
  {
    id: 'light-leak',
    name: 'light leak',
    category: 'color',
    description: 'warm glow leaking in from a corner, pink outside and hot yellow in the core',
    posterTime: 1.0,
    params: [
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 80, unit: '%' },
      { key: 'size', label: 'size', min: 10, max: 150, step: 1, default: 105, unit: '%' },
      { key: 'warmth', label: 'warmth', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'drift', label: 'drift', min: 0, max: 3, step: 0.05, default: 0.4, unit: 'hz' },
      { key: 'angle', label: 'angle', min: 0, max: 360, step: 5, default: 45, unit: 'deg' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float t = u_time * p_drift + u_seed;
  // aspect corrected space, height = 1
  vec2 p = (uv - 0.5) * vec2(aspect(), 1.0);
  // direction of the source: 0 deg = right, 90 deg = up, pushed onto the frame edge / corner
  vec2 dr = vec2(cos(radians(p_angle)), -sin(radians(p_angle)));
  dr = dr / max(abs(dr.x), abs(dr.y));
  vec2 src = dr * vec2(aspect(), 1.0) * 0.5;
  // slow drift and breathing
  src += 0.07 * vec2(snoise1(t), snoise1(t + 9.0));
  float radius = p_size / 100.0 * 1.8 * (1.0 + 0.08 * sin(t * PI));
  float x = length(p - src) / max(radius, 0.01);
  float glow = pow(sat(1.0 - x), 1.5);
  float core = pow(sat(1.0 - x * 1.15), 1.6);
  // pink magenta outside, pale yellow white in the hot core
  float w = p_warmth / 100.0;
  vec3 outer = hsv2rgb(vec3(mix(0.92, 1.04, w), 0.8, 1.0));
  vec3 hot = hsv2rgb(vec3(mix(0.12, 0.15, w), 0.25, 1.0));
  vec3 leak = mix(outer, hot, core) * glow * (p_strength / 100.0) * 1.7 * u_amount;
  // screen blend
  vec3 col = 1.0 - (1.0 - c) * (1.0 - sat(leak));
  return vec4(col, 1.0);
}`,
  },
  {
    id: 'vignette',
    name: 'vignette',
    category: 'color',
    description: 'darkens toward the corners',
    posterTime: 0.5,
    params: [
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 90, unit: '%' },
      { key: 'size', label: 'size', min: 0, max: 100, step: 1, default: 60, unit: '%' },
      { key: 'softness', label: 'softness', min: 0, max: 100, step: 1, default: 60, unit: '%' },
      { key: 'roundness', label: 'roundness', min: 0, max: 100, step: 1, default: 50, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  vec2 p = (uv - 0.5) * 2.0;
  vec2 q = p * vec2(aspect(), 1.0);
  // distance 0 at the center, 1 at the corner, for a frame shaped and a round vignette
  float d_frame = length(p) / 1.41421356;
  float d_circle = length(q) / length(vec2(aspect(), 1.0));
  float d = mix(d_frame, d_circle, p_roundness / 100.0);
  float d0 = p_size / 100.0 * 0.8;
  float d1 = d0 + 0.05 + p_softness / 100.0 * 0.8;
  float v = smoothstep(d0, d1, d);
  return vec4(c * (1.0 - v * p_strength / 100.0 * u_amount), 1.0);
}`,
  },
];
