import type { EffectDef } from '../types';

/**
 * pack 4: looks. color grades, glass and lens distortions, drawn / screen styles.
 * sizes are in project pixels (u_size) or frame heights so the preview and the export match.
 */

/** brightness gradient of the picture (sobel), step e in uv units. shared by the drawn styles. */
const SOBEL = `
vec2 sobel(vec2 uv, vec2 e) {
  float tl = luma(tex(uv + vec2(-e.x, -e.y)).rgb);
  float tc = luma(tex(uv + vec2(0.0, -e.y)).rgb);
  float tr = luma(tex(uv + vec2(e.x, -e.y)).rgb);
  float ml = luma(tex(uv + vec2(-e.x, 0.0)).rgb);
  float mr = luma(tex(uv + vec2(e.x, 0.0)).rgb);
  float bl = luma(tex(uv + vec2(-e.x, e.y)).rgb);
  float bc = luma(tex(uv + vec2(0.0, e.y)).rgb);
  float br = luma(tex(uv + vec2(e.x, e.y)).rgb);
  return vec2((tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl), (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr));
}`;

export const PACK4_COLOR_EFFECTS: EffectDef[] = [
  {
    id: 'color-pop',
    name: 'color pop',
    category: 'color',
    description: 'keeps one color and turns everything else grey',
    posterTime: 0.5,
    params: [
      { key: 'hue', label: 'color', min: 0, max: 360, step: 1, default: 0, unit: 'deg' },
      { key: 'range', label: 'range', min: 10, max: 180, step: 1, default: 50, unit: 'deg' },
      { key: 'softness', label: 'softness', min: 0, max: 60, step: 1, default: 20, unit: 'deg' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  vec3 h = rgb2hsv(c);
  // distance on the color wheel in degrees, 0..180
  float d = abs(fract(h.x - p_hue / 360.0 + 0.5) - 0.5) * 360.0;
  float keep = 1.0 - smoothstep(p_range * 0.5, p_range * 0.5 + max(p_softness, 0.5), d);
  // greys have no color to keep
  keep *= smoothstep(0.08, 0.25, h.y);
  vec3 grey = vec3(luma(c));
  return vec4(mix(c, mix(grey, c, keep), u_amount), 1.0);
}`,
  },
  {
    id: 'teal-orange',
    name: 'teal and orange',
    category: 'color',
    description: 'the film grade: cool shadows, warm highlights, a little more contrast',
    posterTime: 0.5,
    params: [
      { key: 'split', label: 'strength', min: 0, max: 100, step: 1, default: 60, unit: '%' },
      { key: 'contrast', label: 'contrast', min: 0, max: 100, step: 1, default: 40, unit: '%' },
      { key: 'lift', label: 'faded blacks', min: 0, max: 100, step: 1, default: 15, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float l = luma(c);
  vec3 cool = vec3(0.0, 0.42, 0.5);
  vec3 warm = vec3(1.0, 0.6, 0.28);
  vec3 tintc = mix(cool, warm, smoothstep(0.15, 0.85, l));
  // only the color of the tint is added, so the brightness stays. black stays black
  vec3 g = sat(c + (tintc - luma(tintc)) * p_split * 0.006 * smoothstep(0.0, 0.3, l));
  // s curve
  g = mix(g, g * g * (3.0 - 2.0 * g), p_contrast * 0.01);
  float k = p_lift * 0.0012;
  g = g * (1.0 - k) + k;
  return vec4(mix(c, g, u_amount), 1.0);
}`,
  },
];

export const PACK4_DISTORT_EFFECTS: EffectDef[] = [
  {
    id: 'glass',
    name: 'glass',
    category: 'distort',
    description: 'the picture seen through frosted, ribbed or block glass',
    posterTime: 0.5,
    params: [
      { key: 'kind', label: 'glass', min: 0, max: 2, step: 1, default: 0, options: ['frosted', 'ribbed', 'blocks'] },
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'grain', label: 'size', min: 1, max: 40, step: 1, default: 4, unit: 'px' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float cell = max(p_grain, 1.0);
  vec2 px = uv * u_size;
  float k = p_strength * 0.01 * u_amount;
  vec3 c;
  if (p_kind < 0.5) {
    // three taps, each grain looks somewhere else
    vec2 id = floor(px / cell);
    c = vec3(0.0);
    for (int i = 0; i < 3; i++) {
      vec2 j = hash22(id + u_seed + float(i) * 19.7) - 0.5;
      vec2 off = j * k * 0.05;
      off.x /= aspect();
      c += tex(uv + off).rgb;
    }
    c /= 3.0;
  } else if (p_kind < 1.5) {
    // upright ribs: each one is a small lens
    float w = cell * 6.0;
    float f = fract(px.x / w) - 0.5;
    c = tex(uv + vec2(f * w * 1.6 * k / u_size.x, 0.0)).rgb;
    c *= 1.0 - 0.25 * k * abs(f) * 2.0;
  } else {
    // square blocks: each one shows a shrunk piece of the picture
    float w = cell * 10.0;
    vec2 f = fract(px / w) - 0.5;
    c = tex(uv + f * w * 1.4 * k / u_size).rgb;
    float rim = max(abs(f.x), abs(f.y)) * 2.0;
    c *= 1.0 - 0.35 * k * smoothstep(0.8, 1.0, rim);
  }
  return vec4(c, 1.0);
}`,
  },
  {
    id: 'prism',
    name: 'prism',
    category: 'distort',
    description: 'splits the colors apart toward the edges like a cheap lens',
    posterTime: 0.5,
    params: [
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 45, unit: '%' },
      { key: 'falloff', label: 'where', min: 0, max: 1, step: 1, default: 0, options: ['edges only', 'everywhere'] },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec2 d = uv - 0.5;
  vec2 da = vec2(d.x * aspect(), d.y);
  float edge = p_falloff < 0.5 ? sat(dot(da, da) * 2.5) : 1.0;
  float k = p_strength * 0.0012 * u_amount * edge;
  vec3 acc = vec3(0.0);
  vec3 wsum = vec3(0.0);
  // 12 taps across the spectrum: red is magnified least, blue most
  for (int i = 0; i < 12; i++) {
    float t = float(i) / 11.0;
    vec3 w = sat(vec3(1.0 - 2.0 * t, 1.0 - abs(2.0 * t - 1.0), 2.0 * t - 1.0)) + 0.02;
    acc += tex(0.5 + d * (1.0 - k * (t - 0.5) * 2.0)).rgb * w;
    wsum += w;
  }
  return vec4(acc / wsum, 1.0);
}`,
  },
];

export const PACK4_STYLIZE_EFFECTS: EffectDef[] = [
  {
    id: 'letterbox',
    name: 'letterbox',
    category: 'stylize',
    description: 'cinema bars at the top and bottom. fade it in to make them slide in',
    posterTime: 1,
    params: [
      { key: 'ratio', label: 'picture ratio', min: 1, max: 3, step: 0.01, default: 2.39, unit: 'x' },
      { key: 'darkness', label: 'darkness', min: 0, max: 100, step: 1, default: 100, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  // the share of the height that stays open so the open part has the chosen ratio
  float open = clamp(aspect() / max(p_ratio, 0.1), 0.0, 1.0);
  float bar = (1.0 - open) * 0.5 * u_amount;
  float soft = 1.0 / u_size.y;
  float d = min(uv.y, 1.0 - uv.y);
  float m = bar > 0.0 ? smoothstep(bar - soft, bar + soft, d) : 1.0;
  return vec4(c * mix(1.0 - p_darkness * 0.01, 1.0, m), 1.0);
}`,
  },
  {
    id: 'neon-edges',
    name: 'neon edges',
    category: 'stylize',
    description: 'glowing outlines on a dark picture',
    posterTime: 0.5,
    params: [
      { key: 'thickness', label: 'thickness', min: 0.5, max: 4, step: 0.1, default: 1.5, unit: 'px' },
      { key: 'glow', label: 'brightness', min: 0, max: 100, step: 1, default: 60, unit: '%' },
      { key: 'color', label: 'color', min: 0, max: 3, step: 1, default: 0, options: ['rainbow', 'from the picture', 'cyan', 'pink'] },
      { key: 'dark', label: 'darken picture', min: 0, max: 100, step: 1, default: 88, unit: '%' },
    ],
    glsl: `${SOBEL}
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  // never a step under one real pixel: a small preview would lose the edges the export finds
  vec2 g = sobel(uv, max(max(p_thickness, 0.5) / u_size, 1.0 / u_res));
  float line = sat((length(g) - 0.06) * 4.0);
  vec3 col;
  if (p_color < 0.5) col = hsv2rgb(vec3(fract(atan(g.y, g.x + 0.00001) / TAU + u_time * 0.08), 0.85, 1.0));
  else if (p_color < 1.5) col = c / max(max(c.r, max(c.g, c.b)), 0.08);
  else if (p_color < 2.5) col = vec3(0.2, 0.9, 1.0);
  else col = vec3(1.0, 0.25, 0.75);
  vec3 res = c * (1.0 - p_dark * 0.01) + col * line * (0.5 + p_glow * 0.015);
  return vec4(mix(c, res, u_amount), 1.0);
}`,
  },
  {
    id: 'emboss',
    name: 'emboss',
    category: 'stylize',
    description: 'a relief pressed into grey metal, lit from one side',
    posterTime: 0.5,
    params: [
      { key: 'angle', label: 'light angle', min: 0, max: 360, step: 1, default: 135, unit: 'deg' },
      { key: 'depth', label: 'depth', min: 0.5, max: 6, step: 0.1, default: 1.5, unit: 'px' },
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'color', label: 'keep color', min: 0, max: 100, step: 1, default: 0, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float a = radians(p_angle);
  vec2 d = vec2(cos(a), sin(a)) * max(p_depth, 0.25) / u_size;
  float relief = sat(0.5 + (luma(tex(uv - d).rgb) - luma(tex(uv + d).rgb)) * p_strength * 0.06);
  vec3 res = mix(vec3(relief), c * relief * 2.0, p_color * 0.01);
  return vec4(mix(c, res, u_amount), 1.0);
}`,
  },
  {
    id: 'sketch',
    name: 'sketch',
    category: 'stylize',
    description: 'pencil lines and hatching on paper',
    posterTime: 0.5,
    params: [
      { key: 'thickness', label: 'line', min: 0.5, max: 4, step: 0.1, default: 1.2, unit: 'px' },
      { key: 'ink', label: 'line strength', min: 0, max: 100, step: 1, default: 55, unit: '%' },
      { key: 'hatch', label: 'hatching', min: 0, max: 100, step: 1, default: 70, unit: '%' },
      { key: 'color', label: 'keep color', min: 0, max: 100, step: 1, default: 0, unit: '%' },
    ],
    glsl: `${SOBEL}
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  vec2 g = sobel(uv, max(max(p_thickness, 0.5) / u_size, 1.0 / u_res));
  float line = sat((length(g) - 0.05) * (1.5 + p_ink * 0.08));
  float tone = 1.0 - luma(c);
  // two sets of slanted strokes in project pixels: one for mid tones, a crossed one for the darks.
  // the noise bends them a little so they look drawn by hand
  vec2 px = uv * u_size;
  float bend = noise2(px / 70.0 + u_seed) * 0.4;
  float h1 = abs(fract((px.x + px.y) / 9.0 + bend) - 0.5) * 2.0;
  float h2 = abs(fract((px.x - px.y) / 9.0 - bend) - 0.5) * 2.0;
  float w1 = sat((tone - 0.3) * 1.3);
  float w2 = sat((tone - 0.62) * 1.8);
  // strokes thinner than a real pixel are drawn as their average instead (small previews)
  float fine = smoothstep(1.2, 3.0, 9.0 * u_res.y / u_size.y);
  float s1 = mix(w1 * 0.6, 1.0 - smoothstep(w1 - 0.12, w1 + 0.12, h1), fine) * step(0.001, w1);
  float s2 = mix(w2 * 0.6, 1.0 - smoothstep(w2 - 0.12, w2 + 0.12, h2), fine) * step(0.001, w2);
  float ink = max(line, max(s1, s2) * p_hatch * 0.008);
  vec3 paper = vec3(0.96, 0.95, 0.92) * (0.97 + 0.03 * noise2(px / 3.0 + u_seed));
  vec3 res = mix(paper, vec3(0.16, 0.16, 0.2), ink);
  res *= mix(vec3(1.0), sat(c * 1.4 + 0.25), p_color * 0.01);
  return vec4(mix(c, res, u_amount), 1.0);
}`,
  },
  {
    id: 'led-screen',
    name: 'led screen',
    category: 'stylize',
    description: 'the picture on a wall of lamps: dots, rgb stripes or squares',
    posterTime: 0.5,
    params: [
      { key: 'size', label: 'lamp size', min: 4, max: 60, step: 1, default: 14, unit: 'px' },
      { key: 'style', label: 'lamps', min: 0, max: 2, step: 1, default: 0, options: ['dots', 'rgb stripes', 'squares'] },
      { key: 'brightness', label: 'brightness', min: 50, max: 200, step: 1, default: 120, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c0 = tex(uv).rgb;
  float s = max(p_size, 3.0);
  vec2 px = uv * u_size;
  vec2 f = fract(px / s);
  vec3 col = tex((floor(px / s) + 0.5) * s / u_size).rgb;
  // one project pixel in cell units, for soft lamp edges
  float aa = 0.75 / s;
  vec3 res;
  if (p_style < 0.5) {
    float lit = 1.0 - smoothstep(0.38 - aa, 0.38 + aa, length(f - 0.5));
    res = col * lit * 1.25;
  } else if (p_style < 1.5) {
    float third = f.x * 3.0;
    vec3 m = vec3(1.0 - smoothstep(1.0 - aa * 3.0, 1.0 + aa * 3.0, third),
      smoothstep(1.0 - aa * 3.0, 1.0 + aa * 3.0, third) * (1.0 - smoothstep(2.0 - aa * 3.0, 2.0 + aa * 3.0, third)),
      smoothstep(2.0 - aa * 3.0, 2.0 + aa * 3.0, third));
    float gap = smoothstep(0.0, 0.1 + aa, f.y) * (1.0 - smoothstep(0.9 - aa, 1.0, f.y));
    res = col * m * 2.2 * gap;
  } else {
    vec2 q = smoothstep(vec2(0.0), vec2(0.1 + aa), f) * (1.0 - smoothstep(vec2(0.9 - aa), vec2(1.0), f));
    res = col * q.x * q.y * 1.15;
  }
  res *= p_brightness * 0.01;
  return vec4(mix(c0, res, u_amount), 1.0);
}`,
  },
  {
    id: 'hologram',
    name: 'hologram',
    category: 'stylize',
    description: 'a one color projection with scan lines, rows that slip and a flicker',
    posterTime: 0.6,
    params: [
      { key: 'color', label: 'color', min: 0, max: 3, step: 1, default: 0, options: ['cyan', 'green', 'pink', 'amber'] },
      { key: 'lines', label: 'line size', min: 2, max: 12, step: 1, default: 4, unit: 'px' },
      { key: 'jitter', label: 'slipping', min: 0, max: 100, step: 1, default: 40, unit: '%' },
      { key: 'flicker', label: 'flicker', min: 0, max: 100, step: 1, default: 40, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c0 = tex(uv).rgb;
  // now and then a band of rows slips sideways for a moment
  float beat = floor(u_time * 12.0);
  float on = step(0.9, hash21(vec2(floor(uv.y * 14.0), beat) + u_seed * 1.7));
  float slip = (hash21(vec2(floor(uv.y * 90.0), beat) + u_seed) - 0.5) * on;
  vec3 c = tex(uv + vec2(slip * p_jitter * 0.0008 * u_amount, 0.0)).rgb;
  vec3 tintc = p_color < 0.5 ? vec3(0.25, 0.9, 1.0) : p_color < 1.5 ? vec3(0.4, 1.0, 0.55) : p_color < 2.5 ? vec3(1.0, 0.35, 0.8) : vec3(1.0, 0.75, 0.3);
  vec3 res = tintc * (luma(c) * 1.2 + 0.05);
  // scan lines in project pixels. when they get thinner than the real pixels they turn into their average
  float period = max(p_lines, 1.0);
  float lines = 0.75 + 0.25 * sin(uv.y * u_size.y * TAU / period);
  res *= mix(0.75, lines, smoothstep(1.5, 3.0, period * u_res.y / u_size.y));
  // a bright band that travels up
  res += tintc * (1.0 - smoothstep(0.0, 0.08, abs(fract(uv.y + u_time * 0.25) - 0.5))) * 0.12;
  res *= 1.0 - p_flicker * 0.0035 * hash11(floor(u_time * 24.0) + u_seed);
  return vec4(mix(c0, res, u_amount), 1.0);
}`,
  },
  {
    id: 'oil-paint',
    name: 'oil paint',
    category: 'stylize',
    description: 'flat dabs of paint with hard edges between them',
    posterTime: 0.5,
    params: [
      { key: 'radius', label: 'brush', min: 2, max: 16, step: 1, default: 7, unit: 'px' },
      { key: 'saturation', label: 'richer color', min: 0, max: 100, step: 1, default: 30, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c0 = tex(uv).rgb;
  vec2 st = max(p_radius, 1.0) / u_size;
  vec3 best = c0;
  float bestVar = 1000.0;
  // the four corners around the pixel: the calmest one wins, so edges stay hard (kuwahara)
  for (int q = 0; q < 4; q++) {
    vec2 dir = vec2(float(q & 1) * 2.0 - 1.0, float(q >> 1) * 2.0 - 1.0);
    vec3 m = c0;
    vec3 s2 = c0 * c0;
    for (int i = 0; i < 8; i++) {
      int k = i + 1;
      vec3 v = tex(uv + dir * vec2(float(k % 3), float(k / 3)) * 0.5 * st).rgb;
      m += v;
      s2 += v * v;
    }
    m /= 9.0;
    vec3 dv = abs(s2 / 9.0 - m * m);
    float vr = dv.r + dv.g + dv.b;
    if (vr < bestVar) {
      bestVar = vr;
      best = m;
    }
  }
  float l = luma(best);
  best = sat(mix(vec3(l), best, 1.0 + p_saturation * 0.008));
  return vec4(mix(c0, best, u_amount), 1.0);
}`,
  },
];
