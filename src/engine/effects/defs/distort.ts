import type { EffectDef } from '../types';

/** geometry warps: the picture is bent, squeezed or folded. edges stretch (clamp). */
export const DISTORT_EFFECTS: EffectDef[] = [
  {
    id: 'lens',
    name: 'glass lens',
    category: 'distort',
    description: 'round glass lens, clear inside, smeared rainbow blur outside',
    posterTime: 1,
    params: [
      { key: 'radius', label: 'radius', min: 10, max: 70, step: 1, default: 40, unit: '%' },
      { key: 'bulge', label: 'bulge', min: 0, max: 60, step: 1, default: 25, unit: '%' },
      { key: 'blur', label: 'blur', min: 0, max: 100, step: 1, default: 60, unit: '%' },
      { key: 'dispersion', label: 'dispersion', min: 0, max: 100, step: 1, default: 60, unit: '%' },
      { key: 'pulse', label: 'pulse', min: 0, max: 100, step: 1, default: 30, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float asp = aspect();
  vec2 p = (uv - 0.5) * vec2(asp, 1.0);
  float r = length(p);
  // lens radius in frame heights, breathing a little
  float rad = p_radius / 100.0 * (1.0 + 0.06 * (p_pulse / 100.0) * sin(u_time * 3.0));
  rad = max(rad, 0.01);
  float t = r / rad;
  float bulge = p_bulge / 100.0 * u_amount;
  vec2 pb = p;
  if (t < 1.0) {
    // magnify the middle, no change at the rim
    pb = p * (1.0 - bulge * (1.0 - t * t));
  }
  // refraction ring: squeeze the picture right at the rim
  float ring = smoothstep(0.78, 1.0, t) * (1.0 - smoothstep(1.0, 1.1, t));
  pb *= 1.0 + 0.18 * ring * u_amount;
  // outside the glass: radial smear plus per channel scale
  float k = smoothstep(0.98, 1.15, t);
  float blurLen = p_blur / 100.0 * 0.3 * k * u_amount;
  float disp = p_dispersion / 100.0 * 0.08 * k * u_amount;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float f = float(i) / 7.0 - 0.5;
    float s = f * blurLen;
    acc.r += tex((pb * (1.0 + disp + s)) / vec2(asp, 1.0) + 0.5).r;
    acc.g += tex((pb * (1.0 + s)) / vec2(asp, 1.0) + 0.5).g;
    acc.b += tex((pb * (1.0 - disp + s)) / vec2(asp, 1.0) + 0.5).b;
  }
  return vec4(acc / 8.0, 1.0);
}`,
  },
  {
    id: 'pinch',
    name: 'pinch',
    category: 'distort',
    description: 'pincushion squeeze, corners pulled out. negative = fisheye bulge',
    posterTime: 1,
    sync: { param: 'speed', cycles: 0.25 },
    params: [
      { key: 'strength', label: 'strength', min: -100, max: 100, step: 1, default: 55, unit: '%' },
      { key: 'breathe', label: 'breathe', min: 0, max: 100, step: 1, default: 30, unit: '%' },
      { key: 'speed', label: 'speed', min: 0, max: 5, step: 0.1, default: 1, unit: 'hz' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(aspect(), 1.0);
  float k = p_strength / 100.0 * (1.0 + p_breathe / 100.0 * sin(u_time * p_speed * TAU * 0.25)) * u_amount;
  float r2 = dot(p, p);
  // k > 0: pincushion (magnification grows with the radius), k < 0: barrel
  vec2 q = k >= 0.0 ? p / (1.0 + k * r2) : p * (1.0 - k * 0.8 * r2);
  return tex(q / vec2(aspect(), 1.0) + 0.5);
}`,
  },
  {
    id: 'ripple',
    name: 'ripple',
    category: 'distort',
    description: 'water rings with rainbow edges from a wandering center',
    posterTime: 1,
    sync: { param: 'speed', cycles: 1 },
    params: [
      { key: 'amplitude', label: 'amplitude', min: 0, max: 100, step: 1, default: 40, unit: '%' },
      { key: 'rings', label: 'rings', min: 2, max: 30, step: 1, default: 9, unit: 'x' },
      { key: 'speed', label: 'speed', min: 0, max: 5, step: 0.1, default: 1.2, unit: 'hz' },
      { key: 'dispersion', label: 'dispersion', min: 0, max: 100, step: 1, default: 35, unit: '%' },
      { key: 'wander', label: 'wander', min: 0, max: 100, step: 1, default: 40, unit: '%' },
    ],
    glsl: `
vec2 rip_uv(vec2 p, vec2 c, vec2 dir, float d) {
  return (p + dir * d + c) / vec2(aspect(), 1.0) + 0.5;
}

vec4 effect(vec2 uv) {
  vec2 c = vec2(snoise1(u_time * 0.35 + u_seed), snoise1(u_time * 0.35 + u_seed + 41.7)) * 0.3 * (p_wander / 100.0);
  vec2 p = (uv - 0.5) * vec2(aspect(), 1.0) - c;
  float r = length(p);
  vec2 dir = p / max(r, 0.0001);
  float amp = p_amplitude / 100.0 * 0.03 * u_amount;
  // p_rings = rings across the frame height
  float ph = r * p_rings * TAU - u_time * p_speed * TAU;
  float disp = p_dispersion / 100.0;
  float dr = amp * (1.0 + 0.5 * disp) * sin(ph - disp * 1.2);
  float dg = amp * sin(ph);
  float db = amp * (1.0 - 0.5 * disp) * sin(ph + disp * 1.2);
  float cr = tex(rip_uv(p, c, dir, dr)).r;
  float cg = tex(rip_uv(p, c, dir, dg)).g;
  float cb = tex(rip_uv(p, c, dir, db)).b;
  return vec4(cr, cg, cb, 1.0);
}`,
  },
  {
    id: 'wave',
    name: 'wave',
    category: 'distort',
    description: 'wavy flag / heat haze bending in both directions',
    posterTime: 1.5,
    params: [
      { key: 'amplitude', label: 'amplitude', min: 0, max: 100, step: 1, default: 45, unit: '%' },
      { key: 'scale', label: 'scale', min: 0.5, max: 10, step: 0.1, default: 3, unit: 'x' },
      { key: 'speed', label: 'speed', min: 0, max: 5, step: 0.1, default: 1, unit: 'hz' },
      { key: 'turbulence', label: 'turbulence', min: 0, max: 100, step: 1, default: 30, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float asp = aspect();
  float t = u_time * p_speed;
  float a = p_amplitude / 100.0 * 0.06 * u_amount;
  float sc = p_scale;
  float turb = p_turbulence / 100.0;
  vec2 q = vec2(uv.x * asp, uv.y);
  // two sines per axis, each bending along the other axis
  float dx = sin(q.y * sc * PI + t * 1.3) + 0.5 * sin(q.y * sc * 2.6 - t * 0.9 + q.x * 2.0);
  float dy = sin(q.x * sc * PI - t * 1.1) + 0.5 * sin(q.x * sc * 2.4 + t * 0.7 + q.y * 2.0);
  vec2 nz = vec2(fbm(q * sc * 0.7 + vec2(t * 0.3, u_seed)), fbm(q * sc * 0.7 + vec2(31.0, t * 0.3 + u_seed))) - 0.5;
  vec2 d = vec2(dx, dy) * (1.0 - 0.5 * turb) / 1.5 + nz * 2.0 * turb;
  return tex(uv + vec2(d.x / asp, d.y) * a);
}`,
  },
  {
    id: 'swirl',
    name: 'swirl',
    category: 'distort',
    description: 'twirl around the center, strongest in the middle',
    posterTime: 1,
    sync: { param: 'speed', cycles: 0.5 },
    params: [
      { key: 'angle', label: 'angle', min: -360, max: 360, step: 1, default: 120, unit: 'deg' },
      { key: 'radius', label: 'radius', min: 10, max: 150, step: 1, default: 60, unit: '%' },
      { key: 'wobble', label: 'wobble', min: 0, max: 100, step: 1, default: 0, unit: '%' },
      { key: 'speed', label: 'speed', min: 0, max: 5, step: 0.1, default: 0.5, unit: 'hz' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float asp = aspect();
  vec2 p = (uv - 0.5) * vec2(asp, 1.0);
  float r = length(p);
  float rad = max(p_radius / 100.0, 0.01);
  float f = 1.0 - smoothstep(0.0, rad, r);
  float swing = 1.0 + p_wobble / 100.0 * sin(u_time * p_speed * TAU * 0.5);
  float ang = radians(p_angle) * swing * f * f * u_amount;
  vec2 q = rot(p, ang);
  return tex(q / vec2(asp, 1.0) + 0.5);
}`,
  },
  {
    id: 'mirror',
    name: 'kaleidoscope',
    category: 'distort',
    description: 'mirrors the picture into slowly turning wedges',
    posterTime: 1,
    sync: { param: 'rotate', cycles: 0.25 },
    params: [
      { key: 'segments', label: 'segments', min: 2, max: 16, step: 1, default: 6, unit: 'x' },
      { key: 'rotate', label: 'rotate', min: -3, max: 3, step: 0.1, default: 0.3, unit: 'hz' },
      { key: 'zoom', label: 'zoom', min: -50, max: 200, step: 1, default: 0, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float asp = aspect();
  vec2 p = (uv - 0.5) * vec2(asp, 1.0);
  p /= max(1.0 + p_zoom / 100.0, 0.05);
  float r = length(p);
  float n = floor(p_segments + 0.5);
  float seg = TAU / max(n, 2.0);
  float a = atan(p.y, p.x + 0.00001) + u_time * p_rotate * TAU * 0.25;
  // fold the angle into one wedge and mirror it
  a = abs(mod(a, seg) - seg * 0.5);
  vec2 q = r * vec2(cos(a), sin(a));
  vec4 warped = tex(q / vec2(asp, 1.0) + 0.5);
  return mix(tex(uv), warped, u_amount);
}`,
  },
];
