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
    id: 'shake-hop',
    name: 'hop shake',
    category: 'motion',
    description: 'the picture jumps between the corners and the middle, each spot held for a moment',
    posterTime: 0.02,
    sync: { param: 'speed', cycles: 1 },
    params: [
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 25, unit: '%' },
      { key: 'speed', label: 'speed', min: 1, max: 30, step: 0.5, default: 20, unit: 'hz' },
    ],
    glsl: `
// where the picture sits during hop n. the hops go round the corners: top right, bottom right, bottom left,
// top left, the middle, then back the other way and the middle again (a loop of 10)
vec2 sh_hop(float n) {
  float k = mod(n, 10.0);
  float i = k < 4.5 ? k : 8.0 - k;
  if (i > 3.5 || i < -0.5) return vec2(0.0);
  return vec2(i < 1.5 ? 1.0 : -1.0, (i > 0.5 && i < 2.5) ? 1.0 : -1.0);
}

vec4 effect(vec2 uv) {
  // strength 100% = up to 8% of the frame
  float amt = 0.08 * (p_strength / 100.0) * u_amount;
  // a spot is held, then the picture jumps to the next one. the small push keeps a frame that falls right on
  // a hop from landing on the hop before it
  vec2 off = sh_hop(floor(u_time * p_speed + 0.002) + floor(u_seed)) * amt;
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
    id: 'tilt-swing',
    name: 'swing',
    category: 'motion',
    description: 'the picture swings left and right around the center and rests a moment at each side',
    posterTime: 0.45,
    sync: { param: 'speed', cycles: 1 },
    params: [
      { key: 'angle', label: 'angle', min: 0, max: 30, step: 0.5, default: 6, unit: 'deg' },
      { key: 'speed', label: 'speed', min: 0.1, max: 10, step: 0.05, default: 0.55, unit: 'hz' },
      { key: 'sway', label: 'sway', min: 0, max: 20, step: 0.5, default: 2, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float t = u_time * p_speed;
  float s = sin(t * TAU);
  // a swing that rests at both ends before it comes back, instead of a plain sine
  float swing = s * sqrt(1.18 / (s * s + 0.18));
  float wob = swing * 0.85 + snoise1(t * 1.3 + u_seed) * 0.25;
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
    id: 'zoom-punch',
    name: 'zoom punch',
    category: 'motion',
    description: 'the picture punches in on a beat, stays a moment and eases back, the twist changes side every time',
    posterTime: 0.35,
    sync: { param: 'rate', cycles: 1 },
    params: [
      { key: 'zoom', label: 'zoom', min: -50, max: 100, step: 1, default: 28, unit: '%' },
      { key: 'rate', label: 'rate', min: 0.2, max: 8, step: 0.05, default: 1.05, unit: 'hz' },
      { key: 'twist', label: 'twist', min: -20, max: 20, step: 0.5, default: 5, unit: 'deg' },
      { key: 'sharpness', label: 'sharpness', min: 0, max: 100, step: 1, default: 30, unit: '%' },
      { key: 'hold', label: 'hold', min: 0, max: 100, step: 1, default: 45, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float beat = u_time * p_rate;
  // position inside the current punch, 0..1
  float ph = fract(beat);
  float n = floor(beat) + floor(u_seed);
  float s = p_sharpness / 100.0;
  // a punch eases up, stays there and eases back. sharper = quicker in and out
  float up = mix(0.30, 0.03, s);
  float hold = p_hold / 100.0 * 0.6;
  float down = min(mix(0.45, 0.10, s), 1.0 - up - hold);
  float env = smoothstep(0.0, up, ph) * (1.0 - smoothstep(up + hold, up + hold + down, ph));
  // a small pull back right before the next punch
  float dip = smoothstep(0.86, 0.95, ph) * (1.0 - smoothstep(0.95, 1.0, ph));
  float zm = 1.0 + p_zoom / 100.0 * (env - 0.08 * dip) * u_amount;
  // the twist changes side with every punch and is never quite the same size
  float side = mod(n, 2.0) < 0.5 ? 1.0 : -1.0;
  float ang = radians(p_twist) * side * (0.6 + 0.4 * hash11(n + 3.7)) * env * u_amount;
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
    id: 'whip-spin',
    name: 'spin whip',
    category: 'motion',
    description: 'a whole turn with a zoom: a small wind up, a fast blurred spin, a long ease out and a flash',
    posterTime: 1,
    params: [
      { key: 'turns', label: 'turns', min: 0, max: 2, step: 1, default: 1, options: ['no turn', 'one turn', 'two turns'] },
      { key: 'zoom', label: 'zoom', min: 0, max: 200, step: 1, default: 24, unit: '%' },
      { key: 'blur', label: 'blur', min: 0, max: 100, step: 1, default: 60, unit: '%' },
      { key: 'flash', label: 'flash', min: 0, max: 100, step: 1, default: 30, unit: '%' },
    ],
    glsl: `
// how much of the turn is done at p (0..1 through the clip): a small wind up the other way, the fast part,
// a long ease out, and a little swing back once it has landed
float wh_turn(float p) {
  float wind = p < 0.225 ? -0.0078 * sin(PI * pow(p / 0.225, 1.3)) : 0.0;
  float fast = 0.78 * smoothstep(0.25, 0.37, p);
  // the tail lands exactly on the whole turn at p = 0.7
  float tail = 0.22 * (1.0 - exp(-4.25 * sat((p - 0.36) / 0.34))) / 0.9857;
  float back = p > 0.72 ? -0.0055 * sin(PI * (p - 0.72) / 0.28) : 0.0;
  return wind + fast + tail + back;
}

// the zoom through the clip, 0..1: a little with the wind up, all of it at the end of the fast part, then back
float wh_zoom(float p) {
  float z = 0.14 * smoothstep(0.12, 0.17, p) + 0.86 * smoothstep(0.26, 0.39, p);
  z *= 1.0 - 0.68 * smoothstep(0.40, 0.48, p);
  return z * (1.0 - smoothstep(0.48, 0.74, p));
}

vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float p = clamp(u_time / max(u_duration, 0.001), 0.0, 1.0);
  float turn = TAU * p_turns;
  float zoom = p_zoom / 100.0;
  // the blur follows the real speed of the move: the arc and the zoom travelled around this moment
  float d = 0.012;
  float a = min(p + d, 1.0);
  float b = max(p - d, 0.0);
  float shut = p_blur / 100.0 * 0.7;
  float arc = turn * (wh_turn(a) - wh_turn(b)) * shut;
  float dz = zoom * (wh_zoom(a) - wh_zoom(b)) * shut;
  // the wind up goes one way, the turn the other
  float ang = -turn * wh_turn(p);
  float zm = 1.0 + zoom * wh_zoom(p);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 24; i++) {
    float f = float(i) / 23.0 - 0.5;
    acc += tex(xform(uv, vec2(0.0), ang + f * arc, zm + f * dz)).rgb;
  }
  vec3 col = acc / 24.0;
  // exposure flash: up fast while the spin starts, then a long straight fall
  float fl = p < 0.32 ? sat((p - 0.235) / 0.085) : sat(1.0 - (p - 0.32) / 0.385);
  // a slightly warm light
  col += p_flash / 100.0 * fl * vec3(1.0, 0.99, 0.86);
  // a turn cannot be half done: the strength fades the whole move in and out
  return vec4(mix(c, col, u_amount), 1.0);
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
