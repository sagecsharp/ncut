import type { EffectDef } from '../types';

/** camera style moves: the whole picture is shifted / rotated / zoomed, edges stretch (clamp). */
export const MOTION_EFFECTS: EffectDef[] = [
  {
    id: 'shake',
    name: 'shake',
    category: 'motion',
    description: 'handheld camera shake, random left / right / up / down',
    posterTime: 0.4,
    params: [
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 30, unit: '%' },
      { key: 'speed', label: 'speed', min: 1, max: 30, step: 0.5, default: 12, unit: 'hz' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float t = u_time * p_speed;
  // strength 100% = up to 8% of the frame, a bit less vertical than horizontal
  vec2 off = vec2(snoise1(t + u_seed), 0.7 * snoise1(t + u_seed + 57.3)) * 0.08 * (p_strength / 100.0) * u_amount;
  return tex(xform(uv, off, 0.0, 1.0));
}`,
  },
  {
    id: 'tilt',
    name: 'tilt',
    category: 'motion',
    description: 'rotation wobble around the center with a small sideways sway',
    posterTime: 0.4,
    sync: { param: 'speed', cycles: 1 },
    params: [
      { key: 'angle', label: 'angle', min: 0, max: 30, step: 0.5, default: 8, unit: 'deg' },
      { key: 'speed', label: 'speed', min: 0.2, max: 10, step: 0.1, default: 2.5, unit: 'hz' },
      { key: 'sway', label: 'sway', min: 0, max: 20, step: 0.5, default: 3, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float t = u_time * p_speed;
  // main swing both ways plus a little random variation
  float wob = sin(t * TAU) * 0.8 + snoise1(t * 1.3 + u_seed) * 0.35;
  float ang = radians(p_angle) * wob * u_amount;
  // sideways shift follows the swing
  vec2 off = vec2(wob * p_sway / 100.0 * u_amount, 0.0);
  return tex(xform(uv, off, ang, 1.0));
}`,
  },
  {
    id: 'zoom-pulse',
    name: 'zoom pulse',
    category: 'motion',
    description: 'the picture punches in or out on a beat and eases back',
    posterTime: 0.15,
    sync: { param: 'rate', cycles: 1 },
    params: [
      { key: 'zoom', label: 'zoom', min: -50, max: 100, step: 1, default: 30, unit: '%' },
      { key: 'rate', label: 'rate', min: 0.2, max: 8, step: 0.1, default: 1.5, unit: 'hz' },
      { key: 'twist', label: 'twist', min: -20, max: 20, step: 0.5, default: 4, unit: 'deg' },
      { key: 'sharpness', label: 'sharpness', min: 0, max: 100, step: 1, default: 60, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  // position inside the current pulse, 0..1
  float ph = fract(u_time * p_rate);
  // fast attack (share of the pulse), then exponential ease back
  float attack = mix(0.25, 0.015, p_sharpness / 100.0);
  float rise = smoothstep(0.0, attack, ph);
  float fall = max((exp(-5.0 * ph) - 0.0067) / 0.9933, 0.0);
  float env = rise * fall;
  float zm = 1.0 + p_zoom / 100.0 * env * u_amount;
  float ang = radians(p_twist) * env * u_amount;
  return tex(xform(uv, vec2(0.0), ang, zm));
}`,
  },
  {
    id: 'whip',
    name: 'whip',
    category: 'motion',
    description: 'spin and zoom whip with a white flash at the peak',
    posterTime: 1.5,
    params: [
      { key: 'spin', label: 'spin', min: 0, max: 360, step: 5, default: 120, unit: 'deg' },
      { key: 'zoom', label: 'zoom', min: 0, max: 200, step: 5, default: 80, unit: '%' },
      { key: 'blur', label: 'blur', min: 0, max: 100, step: 1, default: 60, unit: '%' },
      { key: 'flash', label: 'flash', min: 0, max: 100, step: 1, default: 85, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  // progress through the clip, peak in the middle
  float prog = clamp(u_time / max(u_duration, 0.001), 0.0, 1.0);
  float s = sin(PI * prog);
  float bump = pow(s, 3.0);
  float peak = pow(s, 8.0);
  float spin = radians(p_spin) * bump * u_amount;
  float zm = p_zoom / 100.0 * bump * u_amount;
  float span = p_blur / 100.0;
  // taps along a combined rotation + zoom path around the center
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 24; i++) {
    float f = float(i) / 23.0 - 0.5;
    float a = spin * (1.0 + f * span * 2.0);
    float z = (1.0 + zm) * exp(f * span * zm * 2.0);
    acc += tex(xform(uv, vec2(0.0), a, z)).rgb;
  }
  vec3 col = acc / 24.0;
  // white exposure flash at the peak
  col = mix(col, vec3(1.0), sat(p_flash / 100.0 * peak * u_amount));
  return vec4(col, 1.0);
}`,
  },
  {
    id: 'drift',
    name: 'drift',
    category: 'motion',
    description: 'slow floating camera: small move, slight rotation, breathing zoom',
    posterTime: 1.0,
    params: [
      { key: 'move', label: 'move', min: 0, max: 20, step: 0.5, default: 4, unit: '%' },
      { key: 'rotate', label: 'rotate', min: 0, max: 20, step: 0.5, default: 6, unit: 'deg' },
      { key: 'zoom', label: 'zoom', min: 0, max: 30, step: 0.5, default: 5, unit: '%' },
      { key: 'speed', label: 'speed', min: 0.05, max: 3, step: 0.05, default: 0.4, unit: 'hz' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float t = u_time * p_speed + u_seed;
  vec2 off = vec2(snoise1(t), snoise1(t + 31.7)) * p_move / 100.0 * u_amount;
  float ang = radians(p_rotate) * snoise1(t * 0.8 + 11.3) * u_amount;
  // breathing zoom
  float zm = 1.0 + p_zoom / 100.0 * (0.5 + 0.5 * sin(t * PI)) * u_amount;
  return tex(xform(uv, off, ang, zm));
}`,
  },
];
