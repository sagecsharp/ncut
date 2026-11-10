import type { EffectDef } from '../types';

/** looks: lens and screen artifacts, noise, blur and degraded video. */
export const STYLIZE_EFFECTS: EffectDef[] = [
  {
    id: 'rgb-split',
    name: 'rgb split',
    category: 'stylize',
    description: 'chromatic aberration, red and blue pulled apart',
    posterTime: 1,
    params: [
      { key: 'amount', label: 'amount', min: 0, max: 100, step: 1, default: 30, unit: '%' },
      { key: 'angle', label: 'angle', min: -180, max: 180, step: 1, default: 0, unit: 'deg' },
      { key: 'radial', label: 'radial', min: 0, max: 100, step: 1, default: 0, unit: '%' },
      { key: 'jitter', label: 'jitter', min: 0, max: 100, step: 1, default: 20, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float asp = aspect();
  vec2 p = (uv - 0.5) * vec2(asp, 1.0);
  float a = radians(p_angle);
  vec2 dir = vec2(cos(a), sin(a));
  // radial 100: offset points away from the center and grows with the distance
  vec2 offDir = mix(dir, p * 2.0, p_radial / 100.0);
  float wob = 1.0 + p_jitter / 100.0 * (hash11(floor(u_time * 20.0) + u_seed) * 2.0 - 1.0);
  float mag = p_amount / 100.0 * 0.05 * wob * u_amount;
  vec2 off = offDir * mag / vec2(asp, 1.0);
  float cr = tex(uv + off).r;
  float cg = tex(uv).g;
  float cb = tex(uv - off).b;
  return vec4(cr, cg, cb, 1.0);
}`,
  },
  {
    id: 'blur',
    name: 'blur',
    category: 'stylize',
    description: 'soft defocus blur, optionally only at the edges',
    posterTime: 1,
    params: [
      { key: 'radius', label: 'radius', min: 0, max: 6, step: 0.1, default: 1.2, unit: '%' },
      { key: 'edgeOnly', label: 'edge only', min: 0, max: 100, step: 1, default: 0, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float asp = aspect();
  vec2 p = (uv - 0.5) * vec2(asp, 1.0);
  // 0 = same blur everywhere, 100 = sharp middle, blurred edges
  float edge = mix(1.0, smoothstep(0.15, 0.75, length(p)), p_edgeOnly / 100.0);
  float rad = p_radius / 100.0 * u_amount * edge;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 28; i++) {
    float fi = float(i);
    float rr = sqrt((fi + 0.5) / 28.0);
    float th = fi * 2.39996323;
    vec2 o = vec2(cos(th), sin(th)) * rr * rad;
    acc += tex(uv + vec2(o.x / asp, o.y)).rgb;
  }
  return vec4(acc / 28.0, 1.0);
}`,
  },
  {
    id: 'crt',
    name: 'crt',
    category: 'stylize',
    description: 'old tube tv: sharpening halos, color bleed, scanlines',
    posterTime: 1,
    params: [
      { key: 'sharpen', label: 'sharpen', min: 0, max: 100, step: 1, default: 70, unit: '%' },
      { key: 'bleed', label: 'bleed', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'scanlines', label: 'scanlines', min: 0, max: 100, step: 1, default: 40, unit: '%' },
      { key: 'tint', label: 'tint', min: 0, max: 100, step: 1, default: 40, unit: '%' },
      { key: 'curve', label: 'curve', min: 0, max: 100, step: 1, default: 0, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec2 uv0 = uv;
  float k = u_amount;
  // barrel curved screen, black outside the tube
  float curve = p_curve / 100.0 * k;
  vec2 pc = uv0 * 2.0 - 1.0;
  pc *= 1.0 + curve * 0.25 * vec2(pc.y * pc.y, pc.x * pc.x);
  uv = pc * 0.5 + 0.5;
  float mask = (1.0 - smoothstep(1.0, 1.02, abs(pc.x))) * (1.0 - smoothstep(1.0, 1.02, abs(pc.y)));

  // horizontal sharpening: unsharp mask with a 5 tap blur, 2 project pixels per step
  float w = 2.0 / u_size.x;
  vec3 c = tex(uv).rgb;
  vec3 bl = tex(uv - vec2(2.0 * w, 0.0)).rgb
          + 4.0 * tex(uv - vec2(w, 0.0)).rgb
          + 6.0 * c
          + 4.0 * tex(uv + vec2(w, 0.0)).rgb
          + tex(uv + vec2(2.0 * w, 0.0)).rgb;
  bl /= 16.0;
  float sh = p_sharpen / 100.0 * k * 3.0;
  vec3 col = c + (c - bl) * sh;

  // chroma smeared sideways
  float bw = 2.0 / u_size.x;
  vec3 cs = vec3(0.0);
  for (int i = 0; i < 7; i++) {
    cs += tex(uv + vec2((float(i) - 3.0) * bw, 0.0)).rgb;
  }
  cs /= 7.0;
  vec3 chr = cs - vec3(luma(cs));
  vec3 chr0 = c - vec3(luma(c));
  col += (chr - chr0) * sat(p_bleed / 100.0) * k;

  // green yellow cast
  col *= mix(vec3(1.0), vec3(0.93, 1.05, 0.82), p_tint / 100.0 * k);

  // fine scanlines, 3 project pixels per period
  float sl = 0.5 + 0.5 * sin(uv0.y * u_size.y * TAU / 3.0);
  col *= 1.0 - p_scanlines / 100.0 * k * 0.35 * sl;

  return vec4(col * mask, 1.0);
}`,
  },
  {
    id: 'glitch',
    name: 'glitch',
    category: 'stylize',
    description: 'torn horizontal bands, smear, rgb split, crushed contrast',
    posterTime: 0.3,
    sync: { param: 'rate', cycles: 1 },
    params: [
      { key: 'intensity', label: 'intensity', min: 0, max: 100, step: 1, default: 70, unit: '%' },
      { key: 'bands', label: 'bands', min: 2, max: 40, step: 1, default: 12, unit: 'x' },
      { key: 'split', label: 'split', min: 0, max: 100, step: 1, default: 60, unit: '%' },
      { key: 'rate', label: 'rate', min: 1, max: 60, step: 1, default: 24, unit: 'hz' },
      { key: 'contrast', label: 'contrast', min: 0, max: 100, step: 1, default: 60, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float k = p_intensity / 100.0 * u_amount;
  float tt = floor(u_time * p_rate) + u_seed;
  float n = max(p_bands, 1.0);
  // bands of uneven placement that change every step
  float fy = uv.y + (hash11(tt * 1.7) - 0.5) / n;
  float seg = floor(fy * n);
  float r1 = hash21(vec2(seg, tt));
  float r2 = hash21(vec2(seg + 31.0, tt + 7.0));
  float on = step(0.35, r1);
  float shift = (r2 * 2.0 - 1.0) * 0.3 * k * on;
  float smear = hash21(vec2(seg + 77.0, tt)) * 0.12 * k * on;
  // thin tears
  float seg2 = floor(uv.y * n * 5.0);
  float t2 = step(0.8, hash21(vec2(seg2, tt + 3.0)));
  shift += (hash21(vec2(seg2 + 5.0, tt)) * 2.0 - 1.0) * 0.15 * k * t2;
  float sp = p_split / 100.0 * 0.05 * u_amount * (0.5 + r1);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float f = float(i) / 2.0;
    float x = uv.x + shift - smear * f;
    acc.r += tex(vec2(x + sp, uv.y)).r;
    acc.g += tex(vec2(x, uv.y)).g;
    acc.b += tex(vec2(x - sp, uv.y)).b;
  }
  acc /= 3.0;
  // crush to near white / near black
  float cf = 1.0 + p_contrast / 100.0 * 3.0 * u_amount;
  vec3 col = (acc - 0.5) * cf + 0.5;
  col *= 1.0 + (hash11(tt + 9.0) - 0.5) * 0.3 * k;
  return vec4(col, 1.0);
}`,
  },
  {
    id: 'vhs',
    name: 'vhs',
    category: 'stylize',
    description: 'worn tape: color noise streaks, wobble, tracking line',
    posterTime: 1,
    params: [
      { key: 'noise', label: 'noise', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'wobble', label: 'wobble', min: 0, max: 100, step: 1, default: 40, unit: '%' },
      { key: 'bleed', label: 'bleed', min: 0, max: 100, step: 1, default: 60, unit: '%' },
      { key: 'tracking', label: 'tracking', min: 0, max: 100, step: 1, default: 50, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float k = u_amount;
  float tt = floor(u_time * 20.0) + u_seed;
  // lines 2 project pixels tall
  float line = floor(uv.y * u_size.y / 2.0);
  float lh = hash21(vec2(line, tt));

  // tracking line drifting up, only some of the time
  float ty = fract(hash11(u_seed) - u_time * 0.2);
  float td = abs(uv.y - ty);
  float tl = (1.0 - smoothstep(0.0, 0.03, td)) * smoothstep(0.4, 0.6, noise1(u_time * 0.5 + u_seed));
  float trk = p_tracking / 100.0 * k;

  // horizontal wobble per line plus a slow bend
  float wob = p_wobble / 100.0 * k;
  float dx = (lh - 0.5) * 0.006 * wob + snoise1(uv.y * 6.0 + u_time * 2.0) * 0.003 * wob;
  dx += tl * trk * 0.02 * (lh - 0.3);
  vec2 q = vec2(uv.x + dx, uv.y);

  vec3 c0 = tex(q).rgb;
  // chroma bleed to the side
  float bw = 2.5 / u_size.x;
  vec3 cs = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    cs += tex(q + vec2((float(i) - 2.0) * bw, 0.0)).rgb;
  }
  cs /= 5.0;
  vec3 col = mix(c0, vec3(luma(c0)) + (cs - vec3(luma(cs))), sat(p_bleed / 100.0) * k);

  // slightly washed out
  col = mix(col, vec3(luma(col)), 0.25 * k);

  // faint colored streaks, only on some lines
  float nk = p_noise / 100.0 * k;
  float lineOn = smoothstep(0.55, 0.8, lh);
  vec3 nc = vec3(
    noise1(uv.x * 25.0 + lh * 91.0),
    noise1(uv.x * 25.0 + lh * 47.0 + 13.0),
    noise1(uv.x * 25.0 + lh * 23.0 + 29.0)
  ) - 0.5;
  col += nc * 0.6 * nk * lineOn + (lh - 0.5) * 0.06 * nk;

  // brighter tracking line
  col += tl * trk * 0.35;
  return vec4(col, 1.0);
}`,
  },
  {
    id: 'static',
    name: 'tv static',
    category: 'stylize',
    description: 'signal lost: colored noise dashes, optional shrink to a tube',
    posterTime: 0.5,
    sync: { param: 'rate', cycles: 1 },
    params: [
      { key: 'mix', label: 'mix', min: 0, max: 100, step: 1, default: 100, unit: '%' },
      { key: 'grain', label: 'grain', min: 1, max: 20, step: 0.5, default: 3, unit: 'px' },
      { key: 'color', label: 'color', min: 0, max: 100, step: 1, default: 100, unit: '%' },
      { key: 'tube', label: 'tube', min: 0, max: 100, step: 1, default: 0, unit: '%' },
      { key: 'rate', label: 'rate', min: 1, max: 60, step: 1, default: 24, unit: 'hz' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float tube = p_tube / 100.0 * u_amount;
  // shrink the whole picture toward the middle when the tube is on
  float sc = mix(1.0, 0.72, tube);
  vec2 uvT = (uv - 0.5) / sc + 0.5;

  float tt = floor(u_time * p_rate) + u_seed;
  float g = max(p_grain, 1.0);
  // dashes are 4x wider than tall, each row is offset a bit
  float row = floor(uvT.y * u_size.y / g);
  float colx = floor(uvT.x * u_size.x / (g * 4.0) + hash11(row + tt * 3.7) * 9.0);
  vec2 cell = vec2(colx, row);
  float h = hash31(vec3(cell, tt));
  float h2 = hash31(vec3(cell + 11.0, tt));
  vec3 rainbow = hsv2rgb(vec3(h, 0.85, 0.5 + 0.5 * h2));
  vec3 gray = vec3(0.15 + 0.85 * h2);
  vec3 stat = mix(gray, rainbow, p_color / 100.0);

  float m = p_mix / 100.0 * u_amount;
  vec3 col = mix(tex(uvT).rgb, stat, m);

  // rounded tube with bowed sides
  vec2 pc = (uvT - 0.5) * 2.0;
  vec2 q = abs(pc) * vec2(1.0 + 0.12 * tube * pc.y * pc.y, 1.0 + 0.12 * tube * pc.x * pc.x);
  float rr = mix(0.001, 0.3, tube);
  float sdf = length(max(q - (1.0 - rr), 0.0)) - rr;
  float mask = 1.0 - smoothstep(0.0, 0.03, sdf);
  return vec4(col * mask, 1.0);
}`,
  },
  {
    id: 'pixelate',
    name: 'pixelate',
    category: 'stylize',
    description: 'mosaic of flat color blocks',
    posterTime: 1,
    params: [
      { key: 'size', label: 'size', min: 2, max: 200, step: 1, default: 24, unit: 'px' },
      { key: 'shape', label: 'shape', min: 0, max: 100, step: 1, default: 0, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  if (u_amount < 0.001) return tex(uv);
  // block size grows from 1 project pixel with the amount
  float s = mix(1.0, p_size, u_amount);
  float wf = 1.0 + p_shape / 100.0 * 3.0;
  vec2 block = vec2(s * wf, s) / u_size;
  vec2 cuv = (floor(uv / block) + 0.5) * block;
  return tex(cuv);
}`,
  },
  {
    id: 'grain',
    name: 'film grain',
    category: 'stylize',
    description: 'fine monochrome film grain with a little flicker',
    posterTime: 1,
    params: [
      { key: 'amount', label: 'amount', min: 0, max: 100, step: 1, default: 35, unit: '%' },
      { key: 'size', label: 'size', min: 1, max: 6, step: 0.1, default: 1.5, unit: 'px' },
      { key: 'flicker', label: 'flicker', min: 0, max: 100, step: 1, default: 30, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec4 c = tex(uv);
  float tt = floor(u_time * 24.0) + u_seed;
  vec2 cell = floor(uv * u_size / max(p_size, 1.0));
  // average of three hashes = softer, more gaussian grain
  float n = (hash31(vec3(cell, tt)) + hash31(vec3(cell + 13.0, tt + 1.0)) + hash31(vec3(cell + 29.0, tt + 2.0))) / 3.0;
  float l = luma(c.rgb);
  float midtone = mix(0.35, 1.0, 4.0 * l * (1.0 - l));
  vec3 col = c.rgb + (n - 0.5) * 1.2 * p_amount / 100.0 * u_amount * midtone;
  col *= 1.0 + (hash11(tt * 1.3) - 0.5) * 0.2 * p_flicker / 100.0 * u_amount;
  return vec4(col, 1.0);
}`,
  },
];
