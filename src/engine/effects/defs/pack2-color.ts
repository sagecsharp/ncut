import type { EffectDef } from '../types';

/** color pack: corrections and simple looks. all of them mix back to the untouched picture at amount 0. */
export const PACK2_COLOR_EFFECTS: EffectDef[] = [
  {
    id: 'adjust',
    name: 'adjust',
    category: 'color',
    description: 'brightness, contrast, saturation, temperature and tint in one place',
    posterTime: 0.5,
    params: [
      { key: 'brightness', label: 'brightness', min: -100, max: 100, step: 1, default: 0, unit: '%' },
      { key: 'contrast', label: 'contrast', min: -100, max: 100, step: 1, default: 15, unit: '%' },
      { key: 'saturation', label: 'saturation', min: -100, max: 100, step: 1, default: 15, unit: '%' },
      { key: 'temperature', label: 'warmth', min: -100, max: 100, step: 1, default: 0, unit: '%' },
      { key: 'tint', label: 'tint', min: -100, max: 100, step: 1, default: 0, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float ct = p_contrast / 100.0;
  vec3 col = c + p_brightness / 100.0 * 0.3;
  // contrast pivots around mid gray: +100 doubles the slope, -100 flattens it by 80 percent
  col = (col - 0.5) * (ct >= 0.0 ? 1.0 + ct : 1.0 + ct * 0.8) + 0.5;
  // saturation: -100 = gray, +100 = twice as colorful
  col = mix(vec3(luma(col)), col, 1.0 + p_saturation / 100.0);
  // warmth: red up and blue down. tint: green down (magenta) or up
  float w = p_temperature / 100.0;
  float t = p_tint / 100.0;
  col += vec3(w * 0.12 + t * 0.04, -t * 0.08, -w * 0.12 + t * 0.04);
  return vec4(mix(c, col, u_amount), 1.0);
}`,
  },
  {
    id: 'black-and-white',
    name: 'black and white',
    category: 'color',
    description: 'drains all color, with adjustable contrast',
    posterTime: 0.5,
    params: [{ key: 'contrast', label: 'contrast', min: 0, max: 100, step: 1, default: 25, unit: '%' }],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float l = (luma(c) - 0.5) * (1.0 + p_contrast / 100.0 * 1.5) + 0.5;
  return vec4(mix(c, vec3(l), u_amount), 1.0);
}`,
  },
  {
    id: 'sepia',
    name: 'sepia',
    category: 'color',
    description: 'warm brown old photo tone',
    posterTime: 0.5,
    params: [
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 100, unit: '%' },
      { key: 'fade', label: 'fade', min: 0, max: 100, step: 1, default: 15, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  vec3 s = vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131)));
  // lifted blacks, like a faded print
  s = mix(s, vec3(0.93, 0.85, 0.7), p_fade / 100.0 * 0.35);
  return vec4(mix(c, s, p_strength / 100.0 * u_amount), 1.0);
}`,
  },
  {
    id: 'invert',
    name: 'invert',
    category: 'color',
    description: 'negative: flips all colors, or only the brightness',
    posterTime: 0.5,
    params: [
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 100, unit: '%' },
      { key: 'mode', label: 'mode', min: 0, max: 1, step: 1, default: 0, options: ['all colors', 'brightness only'] },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  // brightness only keeps the hue: shifting every channel by the same amount flips the luma
  vec3 inv = p_mode < 0.5 ? 1.0 - c : c + vec3(1.0 - 2.0 * luma(c));
  return vec4(mix(c, inv, p_strength / 100.0 * u_amount), 1.0);
}`,
  },
  {
    id: 'posterize',
    name: 'posterize',
    category: 'color',
    description: 'crushes the picture to a few flat tones',
    posterTime: 0.5,
    params: [
      { key: 'levels', label: 'levels', min: 2, max: 16, step: 1, default: 5, unit: 'x' },
      { key: 'mode', label: 'mode', min: 0, max: 1, step: 1, default: 0, options: ['per color', 'brightness'] },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float n = max(floor(p_levels + 0.5), 2.0);
  vec3 q;
  if (p_mode < 0.5) {
    q = floor(sat(c) * n * 0.9999) / (n - 1.0);
  } else {
    float l = luma(c);
    float ql = floor(sat(l) * n * 0.9999) / (n - 1.0);
    q = c * (ql / max(l, 0.02));
  }
  return vec4(mix(c, q, u_amount), 1.0);
}`,
  },
  {
    id: 'threshold',
    name: 'threshold',
    category: 'color',
    description: 'pure black and white split at one brightness',
    posterTime: 0.5,
    params: [
      { key: 'level', label: 'level', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'edge', label: 'edge', min: 0, max: 50, step: 1, default: 3, unit: '%' },
      { key: 'mode', label: 'mode', min: 0, max: 1, step: 1, default: 0, options: ['black and white', 'keep color'] },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float lv = p_level / 100.0;
  float ed = max(p_edge / 100.0, 0.002);
  float m = smoothstep(lv - ed, lv + ed, luma(c));
  vec3 res = p_mode < 0.5 ? vec3(m) : c * m;
  return vec4(mix(c, res, u_amount), 1.0);
}`,
  },
  {
    id: 'chroma-key',
    name: 'chroma key',
    category: 'color',
    description: 'removes one color from the picture and fills it with a gray. no transparency here',
    posterTime: 0.5,
    params: [
      { key: 'hue', label: 'key hue', min: 0, max: 360, step: 1, default: 120, unit: 'deg' },
      { key: 'tolerance', label: 'tolerance', min: 0, max: 100, step: 1, default: 30, unit: '%' },
      { key: 'softness', label: 'softness', min: 0, max: 100, step: 1, default: 30, unit: '%' },
      { key: 'spill', label: 'spill', min: 0, max: 100, step: 1, default: 60, unit: '%' },
      { key: 'fill', label: 'fill', min: 0, max: 100, step: 1, default: 0, unit: '%' },
    ],
    glsl: `
// effects run on the finished picture of everything below and always return an opaque frame
// (the runner forces alpha to 1), so a keyed pixel cannot become see-through. it is replaced by a
// plain gray (fill 0 = black, 100 = white) instead.
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  vec3 hsv = rgb2hsv(c);
  // hue distance to the key in degrees, 0..180, wraps around the wheel
  float dh = abs(fract(hsv.x - p_hue / 360.0 + 0.5) - 0.5) * 360.0;
  float tol = p_tolerance * 0.6;
  float soft = 1.0 + p_softness * 0.4;
  // gray and very dark pixels have no reliable hue, never key them
  float colorful = smoothstep(0.12, 0.35, hsv.y) * smoothstep(0.04, 0.15, hsv.z);
  float key = (1.0 - smoothstep(tol, tol + soft, dh)) * colorful;
  // spill: the kept pixels around the key hue lose some of their color
  float close = (1.0 - smoothstep(tol + soft, tol + soft + 40.0, dh)) * colorful;
  vec3 kept = mix(c, vec3(luma(c)), close * p_spill / 100.0);
  vec3 res = mix(kept, vec3(p_fill / 100.0), key);
  return vec4(mix(c, res, u_amount), 1.0);
}`,
  },
  {
    id: 'tint',
    name: 'tint',
    category: 'color',
    description: 'pushes the whole picture toward one hue without changing the brightness',
    posterTime: 0.5,
    params: [
      { key: 'hue', label: 'hue', min: 0, max: 360, step: 1, default: 210, unit: 'deg' },
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 50, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  vec3 tc = hsv2rgb(vec3(p_hue / 360.0, 1.0, 1.0));
  // (tc - its luma) adds nothing to the brightness, only the hue. weight the middle tones most
  float l = luma(c);
  float w = mix(0.4, 1.0, 4.0 * l * (1.0 - l));
  vec3 res = c + (tc - vec3(luma(tc))) * p_strength / 100.0 * 0.6 * w;
  return vec4(mix(c, res, u_amount), 1.0);
}`,
  },
  {
    id: 'fade-film',
    name: 'fade film',
    category: 'color',
    description: 'lifted blacks, soft contrast and a cool shadow tone, like faded film',
    posterTime: 0.5,
    params: [
      { key: 'fade', label: 'fade', min: 0, max: 100, step: 1, default: 40, unit: '%' },
      { key: 'softness', label: 'softness', min: 0, max: 100, step: 1, default: 40, unit: '%' },
      { key: 'tone', label: 'tone', min: 0, max: 100, step: 1, default: 30, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float lift = p_fade / 100.0 * 0.16;
  // the lifted black is slightly blue green, the highlights stay put
  vec3 black = mix(vec3(lift), vec3(lift * 0.9, lift * 1.05, lift * 1.2), p_tone / 100.0);
  vec3 col = black + c * (1.0 - lift);
  // flatter contrast, a little less color
  col = (col - 0.5) * (1.0 - p_softness / 100.0 * 0.3) + 0.5;
  col = mix(vec3(luma(col)), col, 1.0 - p_fade / 100.0 * 0.2);
  return vec4(mix(c, col, u_amount), 1.0);
}`,
  },
];
