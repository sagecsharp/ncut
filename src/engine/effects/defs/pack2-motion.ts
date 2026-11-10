import type { EffectDef, TemporalSample } from '../types';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * frame blend: a soft average of the frames around the current one. samples sit evenly across
 * (frames - 1) * spread project frames, centered on the current moment, the middle ones count most.
 * the spread shrinks with the amount so a fade in/out is continuous. the number of samples drops in
 * the preview but the covered span stays the same.
 */
export function frameBlendSamples(params: Record<string, number>, amount: number, fps: number, quality: number): TemporalSample[] {
  const frames = clamp(Math.round(params.frames ?? 4), 2, 8);
  const spread = clamp(params.spread ?? 1, 0.25, 4);
  const span = ((frames - 1) * spread * clamp(amount, 0, 1)) / Math.max(1, fps);
  if (!(span > 1e-5)) return [];
  const n = Math.max(2, Math.round(frames * clamp(quality, 0.25, 1)));
  const out: TemporalSample[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1; // -1..1
    out.push({ offset: x * span * 0.5, weight: 0.35 + 0.65 * (1 - x * x) });
  }
  return out;
}

/**
 * strobe: the picture holds still for `hold` project frames, then jumps (posterized time). the held
 * moment is the first frame of the group the current frame is in, groups are counted from project
 * time 0. needs the project time of the frame: without it there are no samples (the effect does nothing).
 * the renderer wants at least two samples, so the one held moment is returned twice.
 */
export function strobeSamples(params: Record<string, number>, amount: number, fps: number, time: number | undefined): TemporalSample[] {
  if (time === undefined || !Number.isFinite(time)) return [];
  const hold = clamp(Math.round(params.hold ?? 6), 2, 30);
  const f = Math.max(1, fps);
  const frame = Math.floor(Math.max(0, time) * f + 1e-4);
  const held = Math.floor(frame / hold) * hold;
  // seconds back to the held frame, scaled by the amount so a fade in/out is continuous
  const offset = ((held - frame) / f) * clamp(amount, 0, 1);
  if (!(Math.abs(offset) > 1e-6)) return [];
  return [
    { offset, weight: 1 },
    { offset, weight: 1 },
  ];
}

/**
 * motion pack. frame blend and strobe are temporal: the renderer draws the layers below at other
 * moments (their glsl only paints the effects tab thumbnail). speed lines is a plain shader.
 */
export const PACK2_MOTION_EFFECTS: EffectDef[] = [
  {
    id: 'frame-blend',
    name: 'frame blend',
    category: 'motion',
    description: 'soft average of the frames around this one: smooths video and motion',
    posterTime: 1,
    params: [
      { key: 'frames', label: 'frames', min: 2, max: 8, step: 1, default: 4, unit: 'x' },
      { key: 'spread', label: 'spread', min: 0.25, max: 4, step: 0.25, default: 1, unit: 'x' },
    ],
    temporal: (params, amount, fps, quality) => frameBlendSamples(params, amount, fps, quality),
    glsl: `
vec4 effect(vec2 uv) {
  // thumbnail only: a few ghosts side by side
  float len = (p_frames - 1.0) * p_spread * 0.006 * u_amount;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float t = float(i) / 7.0 - 0.5;
    acc += tex(uv + vec2(len * t, 0.0)).rgb;
  }
  return vec4(acc / 8.0, 1.0);
}`,
  },
  {
    id: 'strobe',
    name: 'strobe',
    category: 'motion',
    description: 'holds the picture for a few frames, then jumps: stuttering time',
    posterTime: 0.5,
    params: [{ key: 'hold', label: 'hold', min: 2, max: 30, step: 1, default: 6, unit: 'x' }],
    temporal: (params, amount, fps, _quality, time) => strobeSamples(params, amount, fps, time),
    glsl: `
vec4 effect(vec2 uv) {
  // thumbnail only: the picture jumps sideways in steps
  float st = floor(u_time * 30.0 / max(p_hold, 2.0));
  float j = (hash11(st + u_seed) - 0.5) * 0.06 * u_amount;
  return tex(uv + vec2(j, 0.0));
}`,
  },
  {
    id: 'speed-lines',
    name: 'speed lines',
    category: 'motion',
    description: 'anime style streaks rushing out from a point, redrawn in steps',
    posterTime: 0.4,
    params: [
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 70, unit: '%' },
      { key: 'density', label: 'density', min: 8, max: 300, step: 1, default: 90, unit: 'x' },
      { key: 'clear', label: 'clear', min: 0, max: 90, step: 1, default: 35, unit: '%' },
      { key: 'speed', label: 'speed', min: 0, max: 30, step: 1, default: 12, unit: 'hz' },
      { key: 'color', label: 'color', min: 0, max: 1, step: 1, default: 0, options: ['white', 'black'] },
      { key: 'centerX', label: 'center x', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'centerY', label: 'center y', min: 0, max: 100, step: 1, default: 50, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float asp = aspect();
  vec2 p = (uv - vec2(p_centerX, p_centerY) * 0.01) * vec2(asp, 1.0);
  // distance from the center, 1 = the corner of a centered frame
  float rn = length(p) / (0.5 * length(vec2(asp, 1.0)));
  float n = max(floor(p_density + 0.5), 8.0);
  // angle as a streak coordinate. n is a whole number so the wrap at +-pi has no seam
  float x = (atan(p.y, p.x + 0.00001) / TAU + 0.5) * n;
  float cell = mod(floor(x), n);
  float f = fract(x);
  float tt = floor(u_time * p_speed) + u_seed;
  float h1 = hash21(vec2(cell, tt));
  float h2 = hash21(vec2(cell + 41.0, tt + 3.0));
  float h3 = hash21(vec2(cell + 83.0, tt + 7.0));
  // some cells stay empty, the others get a streak of random width and random start
  float present = step(0.4, h1);
  float w = mix(0.1, 0.55, h2 * h2);
  float line = 1.0 - smoothstep(w * 0.5, w, abs(f - 0.5) * 2.0);
  float clr = p_clear / 100.0;
  float reach = smoothstep(clr + h3 * 0.25, clr + h3 * 0.25 + 0.2, rn);
  float k = line * present * reach * p_strength / 100.0 * u_amount;
  vec3 ink = vec3(p_color < 0.5 ? 1.0 : 0.0);
  return vec4(mix(c, ink, k), 1.0);
}`,
  },
];
