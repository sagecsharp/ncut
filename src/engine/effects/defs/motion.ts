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
  // strength 100% = up to 8% of the frame
  vec2 off = vec2(snoise1(t + u_seed), snoise1(t + u_seed + 57.3)) * 0.08 * (p_strength / 100.0) * u_amount;
  return tex(xform(uv, off, 0.0, 1.0));
}`,
  },
];
