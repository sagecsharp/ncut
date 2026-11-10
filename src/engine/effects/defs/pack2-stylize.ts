import type { EffectDef } from '../types';
import { DISC } from './pack2-common';

/**
 * stylize pack. sizes are in project pixels (u_size) or frame heights so the preview and the export
 * match. everything random comes from hashes of the cell, the stepped time and the clip seed.
 */
export const PACK2_STYLIZE_EFFECTS: EffectDef[] = [
  {
    id: 'halftone',
    name: 'halftone',
    category: 'stylize',
    description: 'print dots on a rotated grid: big where it is dark',
    posterTime: 0.5,
    params: [
      { key: 'size', label: 'dot size', min: 3, max: 40, step: 1, default: 10, unit: 'px' },
      { key: 'angle', label: 'angle', min: 0, max: 90, step: 1, default: 45, unit: 'deg' },
      { key: 'style', label: 'style', min: 0, max: 2, step: 1, default: 2, options: ['black on white', 'color on black', 'color on white'] },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c0 = tex(uv).rgb;
  float s = max(p_size, 3.0);
  float ang = radians(p_angle);
  // grid space: project pixels, rotated
  vec2 g = rot((uv - 0.5) * u_size, ang);
  vec2 base = floor(g / s - 0.5);
  float aa = 0.7;
  float best = 0.0;
  vec3 bestCol = vec3(0.0);
  // the four nearest dot centers, so big dots can overlap their neighbours
  for (int i = 0; i < 4; i++) {
    vec2 ctr = (base + vec2(float(i & 1), float(i >> 1)) + 0.5) * s;
    vec2 cuv = rot(ctr, -ang) / u_size + 0.5;
    vec2 e = vec2(s * 0.3) / u_size;
    vec3 col = (tex(cuv).rgb * 2.0 + tex(cuv + e).rgb + tex(cuv - e).rgb + tex(cuv + vec2(e.x, -e.y)).rgb + tex(cuv + vec2(-e.x, e.y)).rgb) / 6.0;
    float l = luma(col);
    float rad = s * 0.72 * sqrt(p_style > 0.5 && p_style < 1.5 ? l : 1.0 - l);
    float cov = 1.0 - smoothstep(rad - aa, rad + aa, length(g - ctr));
    if (cov > best) {
      best = cov;
      bestCol = col;
    }
  }
  vec3 res;
  if (p_style < 0.5) res = vec3(1.0 - best);
  else if (p_style < 1.5) res = bestCol * best;
  else res = mix(vec3(1.0), bestCol, best);
  return vec4(mix(c0, res, u_amount), 1.0);
}`,
  },
  {
    id: 'edges',
    name: 'edges',
    category: 'stylize',
    description: 'finds outlines: draws them alone or over the picture',
    posterTime: 0.5,
    params: [
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 60, unit: '%' },
      { key: 'thickness', label: 'thickness', min: 0.5, max: 4, step: 0.1, default: 1.2, unit: 'px' },
      { key: 'mode', label: 'mode', min: 0, max: 2, step: 1, default: 0, options: ['white on black', 'ink on picture', 'ink on white'] },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  // sobel on the brightness, step size in project pixels
  vec2 e = max(p_thickness, 0.5) / u_size;
  float tl = luma(tex(uv + vec2(-e.x, -e.y)).rgb);
  float tc = luma(tex(uv + vec2(0.0, -e.y)).rgb);
  float tr = luma(tex(uv + vec2(e.x, -e.y)).rgb);
  float ml = luma(tex(uv + vec2(-e.x, 0.0)).rgb);
  float mr = luma(tex(uv + vec2(e.x, 0.0)).rgb);
  float bl = luma(tex(uv + vec2(-e.x, e.y)).rgb);
  float bc = luma(tex(uv + vec2(0.0, e.y)).rgb);
  float br = luma(tex(uv + vec2(e.x, e.y)).rgb);
  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
  // ignore faint noise, the strength sets how fast a line reaches full ink
  float line = sat((length(vec2(gx, gy)) - 0.08) * (2.0 + p_strength * 0.1));
  vec3 res;
  if (p_mode < 0.5) res = vec3(line);
  else if (p_mode < 1.5) res = c * (1.0 - line);
  else res = vec3(1.0 - line);
  return vec4(mix(c, res, u_amount), 1.0);
}`,
  },
  {
    id: 'old-film',
    name: 'old film',
    category: 'stylize',
    description: 'worn film: grain, scratches, dust, flicker, gate wobble and a dark vignette',
    posterTime: 0.5,
    params: [
      { key: 'grain', label: 'grain', min: 0, max: 100, step: 1, default: 40, unit: '%' },
      { key: 'scratches', label: 'scratches', min: 0, max: 100, step: 1, default: 40, unit: '%' },
      { key: 'flicker', label: 'flicker', min: 0, max: 100, step: 1, default: 30, unit: '%' },
      { key: 'vignette', label: 'vignette', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'tone', label: 'tone', min: 0, max: 100, step: 1, default: 50, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float k = u_amount;
  float asp = aspect();
  // film runs at 12 steps per second, everything random changes per step
  float sd = u_seed + floor(u_time * 12.0) * 1.37;
  // gate wobble: the whole frame twitches a tiny bit
  vec2 jt = (vec2(hash11(sd + 2.0), hash11(sd + 5.0)) - 0.5) * 0.006 * k;
  vec3 c = tex(uv + jt).rgb;
  // exposure flicker
  c *= 1.0 + (hash11(sd + 11.0) - 0.5) * 0.4 * p_flicker / 100.0 * k;
  // faded warm tone
  float l = luma(c);
  c = mix(c, l * vec3(1.1, 0.95, 0.75) + 0.02, p_tone / 100.0 * k);
  // grain
  float g = (hash31(vec3(floor(uv * u_size / 1.5), sd)) + hash31(vec3(floor(uv * u_size / 1.5) + 7.0, sd + 1.0))) * 0.5;
  c += (g - 0.5) * 0.5 * p_grain / 100.0 * k;
  // vertical scratches: three slots, each on some of the steps
  float sc = p_scratches / 100.0 * k;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float x = hash11(sd + 20.0 + fi * 7.0);
    float on = step(0.55, hash11(sd + 30.0 + fi * 3.0));
    float wob = (noise1(uv.y * 5.0 + sd + fi * 13.0) - 0.5) * 0.004;
    float line = 1.0 - smoothstep(0.0, 0.0012, abs(uv.x - x - wob));
    float broken = smoothstep(0.3, 0.6, noise1(uv.y * 9.0 + sd * 3.0 + fi * 5.0));
    c += vec3(0.5) * line * on * broken * sc;
  }
  // dust: a few dark or bright specks per step
  vec2 gp = uv * vec2(asp, 1.0) * 22.0;
  vec2 cell = floor(gp);
  float present = step(0.96, hash31(vec3(cell, sd + 50.0)));
  vec2 pos = 0.2 + 0.6 * hash22(cell + sd);
  float speck = 1.0 - smoothstep(0.03, 0.09, length(fract(gp) - pos));
  float dark = step(0.5, hash31(vec3(cell, sd + 70.0)));
  c = mix(c, vec3(dark > 0.5 ? 0.04 : 0.95), speck * present * 0.75 * sc);
  // vignette
  float r = length((uv - 0.5) * vec2(asp, 1.0));
  c *= 1.0 - smoothstep(0.3, 0.95, r) * 0.75 * p_vignette / 100.0 * k;
  return vec4(c, 1.0);
}`,
  },
  {
    id: 'scanlines',
    name: 'scanlines',
    category: 'stylize',
    description: 'thin dark lines across the picture, like a monitor',
    posterTime: 0.5,
    params: [
      { key: 'size', label: 'line size', min: 3, max: 16, step: 1, default: 4, unit: 'px' },
      { key: 'darkness', label: 'darkness', min: 0, max: 100, step: 1, default: 45, unit: '%' },
      { key: 'softness', label: 'softness', min: 0, max: 100, step: 1, default: 40, unit: '%' },
      { key: 'scroll', label: 'scroll', min: -10, max: 10, step: 0.5, default: 0, unit: 'hz' },
      { key: 'direction', label: 'direction', min: 0, max: 1, step: 1, default: 0, options: ['horizontal', 'vertical'] },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float per = max(p_size, 3.0);
  // position across the lines in project pixels. scroll = lines per second
  float y = (p_direction < 0.5 ? uv.y * u_size.y : uv.x * u_size.x) + u_time * p_scroll * per;
  float s = 0.5 + 0.5 * cos(TAU * y / per);
  float band = mix(smoothstep(0.35, 0.65, s), s, p_softness / 100.0);
  float dk = p_darkness / 100.0 * u_amount;
  // a little brightness back, so the picture does not just get darker
  return vec4(c * mix(1.0, band, dk) * (1.0 + 0.2 * dk), 1.0);
}`,
  },
  {
    id: 'dither',
    name: 'dither',
    category: 'stylize',
    description: 'ordered dither down to a few levels: crunchy retro bitmap look',
    posterTime: 0.5,
    params: [
      { key: 'levels', label: 'levels', min: 2, max: 8, step: 1, default: 3, unit: 'x' },
      { key: 'cell', label: 'cell size', min: 1, max: 8, step: 1, default: 2, unit: 'px' },
      { key: 'palette', label: 'palette', min: 0, max: 2, step: 1, default: 0, options: ['color', 'gray', 'green'] },
    ],
    glsl: `
// 8x8 bayer matrix, 0..1, built from the bits of x and x xor y
float bayer8(ivec2 pp) {
  int x = pp.x & 7;
  int y = pp.y & 7;
  int xy = x ^ y;
  int v = ((xy & 1) << 5) | ((y & 1) << 4) | ((xy & 2) << 2) | ((y & 2) << 1) | ((xy & 4) >> 1) | ((y & 4) >> 2);
  return (float(v) + 0.5) / 64.0;
}

vec4 effect(vec2 uv) {
  vec3 base = tex(uv).rgb;
  float cs = max(p_cell, 1.0);
  vec2 cell = floor(uv * u_size / cs);
  vec3 c = tex((cell + 0.5) * cs / u_size).rgb;
  float n = max(floor(p_levels + 0.5), 2.0);
  vec3 src = p_palette < 0.5 ? c : vec3(luma(c));
  vec3 q = floor(src * (n - 1.0) + bayer8(ivec2(cell))) / (n - 1.0);
  if (p_palette > 1.5) q = vec3(0.12, 1.0, 0.3) * q.g;
  return vec4(mix(base, q, u_amount), 1.0);
}`,
  },
  {
    id: 'bloom',
    name: 'bloom',
    category: 'stylize',
    description: 'bright areas bleed a soft glow into their surroundings',
    posterTime: 0.5,
    params: [
      { key: 'threshold', label: 'threshold', min: 0, max: 100, step: 1, default: 65, unit: '%' },
      { key: 'radius', label: 'radius', min: 0.5, max: 15, step: 0.5, default: 4, unit: '%' },
      { key: 'strength', label: 'strength', min: 0, max: 200, step: 1, default: 80, unit: '%' },
    ],
    glsl: `${DISC}
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float asp = aspect();
  float rad = p_radius / 100.0 * u_amount;
  float th = p_threshold / 100.0;
  float rot0 = jitter(uv);
  vec3 acc = vec3(0.0);
  float tot = 0.0;
  for (int i = 0; i < 32; i++) {
    vec2 o = vogel(i, 32, rot0);
    float w = exp(-2.0 * dot(o, o));
    vec3 s = tex(uv + vec2(o.x / asp, o.y) * rad).rgb;
    // only what is brighter than the threshold glows
    float b = sat((luma(s) - th) / max(1.0 - th, 0.05));
    acc += s * b * w;
    tot += w;
  }
  vec3 glow = sat(acc / tot * p_strength / 100.0 * 2.0 * u_amount);
  // screen blend
  return vec4(1.0 - (1.0 - c) * (1.0 - glow), 1.0);
}`,
  },
  {
    id: 'duotone',
    name: 'duotone',
    category: 'stylize',
    description: 'maps the picture onto two colors: one for the shadows, one for the highlights',
    posterTime: 0.5,
    params: [
      { key: 'shadows', label: 'shadows', min: 0, max: 360, step: 1, default: 235, unit: 'deg' },
      { key: 'highlights', label: 'highlights', min: 0, max: 360, step: 1, default: 40, unit: 'deg' },
      { key: 'saturation', label: 'saturation', min: 0, max: 100, step: 1, default: 75, unit: '%' },
      { key: 'contrast', label: 'contrast', min: 50, max: 200, step: 1, default: 100, unit: '%' },
      { key: 'balance', label: 'balance', min: -50, max: 50, step: 1, default: 0, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float sa = p_saturation / 100.0;
  vec3 dk = hsv2rgb(vec3(p_shadows / 360.0, sa, 0.22));
  vec3 lt = hsv2rgb(vec3(p_highlights / 360.0, sa * 0.45, 1.0));
  float t = sat((luma(c) - 0.5 + p_balance / 100.0) * p_contrast / 100.0 * 1.2 + 0.5);
  return vec4(mix(c, mix(dk, lt, t), u_amount), 1.0);
}`,
  },
  {
    id: 'night-vision',
    name: 'night vision',
    category: 'stylize',
    description: 'green light amplifier with noise and a dark goggle ring',
    posterTime: 0.5,
    params: [
      { key: 'gain', label: 'gain', min: 50, max: 400, step: 5, default: 180, unit: '%' },
      { key: 'noise', label: 'noise', min: 0, max: 100, step: 1, default: 40, unit: '%' },
      { key: 'goggles', label: 'goggles', min: 0, max: 100, step: 1, default: 40, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float asp = aspect();
  // amplify: dark scenes come up, bright ones saturate smoothly
  float l = 1.0 - exp(-luma(c) * p_gain / 100.0 * 2.5);
  float tt = floor(u_time * 24.0) + u_seed;
  float n = hash31(vec3(floor(uv * u_size / 2.0), tt));
  l += (n - 0.5) * 0.5 * p_noise / 100.0;
  // faint horizontal lines
  l *= 0.94 + 0.06 * sin(uv.y * u_size.y * PI / 1.5);
  vec3 col = mix(vec3(0.12, 1.0, 0.28) * l, vec3(l), pow(sat(l), 4.0) * 0.5);
  float r = length((uv - 0.5) * vec2(asp, 1.0));
  col *= 1.0 - p_goggles / 100.0 * smoothstep(0.3, 0.65, r);
  return vec4(mix(c, col, u_amount), 1.0);
}`,
  },
  {
    id: 'thermal',
    name: 'thermal',
    category: 'stylize',
    description: 'heat camera look: brightness becomes blue, red, yellow and white',
    posterTime: 0.5,
    params: [
      { key: 'contrast', label: 'contrast', min: 50, max: 300, step: 5, default: 120, unit: '%' },
      { key: 'level', label: 'level', min: -50, max: 50, step: 1, default: 0, unit: '%' },
      { key: 'smoothing', label: 'smoothing', min: 0, max: 100, step: 1, default: 30, unit: '%' },
    ],
    glsl: `
// cold to hot: black, deep blue, purple red, orange, yellow, white
const vec3 TH_C[6] = vec3[6](
  vec3(0.0, 0.0, 0.04), vec3(0.15, 0.0, 0.55), vec3(0.8, 0.1, 0.25),
  vec3(1.0, 0.5, 0.0), vec3(1.0, 0.95, 0.25), vec3(1.0, 1.0, 1.0));

vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  // soften a little first, heat cameras are low resolution. radius in project pixels
  vec2 e = p_smoothing / 100.0 * 6.0 / u_size;
  float l = (luma(c) * 2.0 + luma(tex(uv + vec2(e.x, 0.0)).rgb) + luma(tex(uv - vec2(e.x, 0.0)).rgb)
    + luma(tex(uv + vec2(0.0, e.y)).rgb) + luma(tex(uv - vec2(0.0, e.y)).rgb)) / 6.0;
  float t = sat((l - 0.5 + p_level / 100.0) * p_contrast / 100.0 * 1.3 + 0.5);
  float x = t * 5.0;
  int i = int(min(floor(x), 4.0));
  vec3 heat = mix(TH_C[i], TH_C[i + 1], x - float(i));
  return vec4(mix(c, heat, u_amount), 1.0);
}`,
  },
];
