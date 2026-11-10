/**
 * blur effects. two kinds:
 *  - temporal (motion blur, echo): the frame renderer draws the layers below at several moments and
 *    blends them, so anything that moves smears along its real path: keyframed clips, camera moves,
 *    shakes, 3d. their glsl only draws the effects tab thumbnail.
 *  - plain shader blurs (directional, zoom, spin): smear the finished picture in a fixed pattern.
 */
import type { EffectDef, TemporalSample } from '../types';

export const BLUR_EFFECTS: EffectDef[] = [
  {
    id: 'motion-blur',
    name: 'motion blur',
    category: 'blur',
    description: 'real motion blur for everything that moves below it: keyframes, camera moves, shakes',
    posterTime: 1,
    params: [
      { key: 'shutter', label: 'shutter', min: 0, max: 1440, step: 5, default: 270, unit: 'deg' },
      { key: 'samples', label: 'samples', min: 2, max: 32, step: 1, default: 12 },
      { key: 'mode', label: 'mode', min: 0, max: 2, step: 1, default: 0, options: ['centered', 'trail behind', 'lead ahead'] },
    ],
    // 360 deg = the shutter stays open for one whole frame of the project frame rate
    temporal(params, amount, fps, quality): TemporalSample[] {
      const open = ((params.shutter ?? 270) / 360 / Math.max(1, fps)) * amount;
      const n = Math.max(2, Math.round((params.samples ?? 12) * quality));
      if (!(open > 1e-5)) return [];
      const mode = Math.round(params.mode ?? 0);
      const out: TemporalSample[] = [];
      for (let i = 0; i < n; i++) {
        const f = i / (n - 1);
        const offset = mode === 1 ? -open * f : mode === 2 ? open * f : open * (f - 0.5);
        out.push({ offset, weight: 1 });
      }
      return out;
    },
    glsl: `
vec4 effect(vec2 uv) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    float t = float(i) / 15.0 - 0.5;
    acc += tex(uv + vec2(0.07 * t * u_amount, 0.0)).rgb;
  }
  return vec4(acc / 16.0, 1.0);
}`,
  },
  {
    id: 'echo',
    name: 'echo trails',
    category: 'blur',
    description: 'ghost copies of the last moments trail behind everything that moves',
    posterTime: 1,
    params: [
      { key: 'count', label: 'copies', min: 2, max: 12, step: 1, default: 5 },
      { key: 'spacing', label: 'spacing', min: 0.02, max: 0.5, step: 0.01, default: 0.08, unit: 's' },
      { key: 'decay', label: 'fade', min: 10, max: 100, step: 1, default: 60, unit: '%' },
      { key: 'direction', label: 'direction', min: 0, max: 1, step: 1, default: 0, options: ['behind', 'ahead'] },
    ],
    temporal(params, amount): TemporalSample[] {
      const n = Math.max(2, Math.round(params.count ?? 5));
      const gap = Math.max(0.005, params.spacing ?? 0.08);
      const decay = Math.min(1, Math.max(0.05, (params.decay ?? 60) / 100));
      const sign = Math.round(params.direction ?? 0) === 1 ? 1 : -1;
      // the oldest copy first so the current moment is blended last
      const out: TemporalSample[] = [];
      for (let i = n - 1; i >= 1; i--) out.push({ offset: sign * gap * i, weight: Math.pow(decay, i) * amount });
      out.push({ offset: 0, weight: 1 });
      return out;
    },
    glsl: `
vec4 effect(vec2 uv) {
  vec3 acc = vec3(0.0);
  float total = 0.0;
  float w = 1.0;
  for (int i = 0; i < 5; i++) {
    acc += tex(uv + vec2(0.045, 0.03) * float(i) * u_amount).rgb * w;
    total += w;
    w *= 0.55;
  }
  return vec4(acc / total, 1.0);
}`,
  },
  {
    id: 'directional-blur',
    name: 'directional blur',
    category: 'blur',
    description: 'smears the picture along one direction, like a fast pan',
    posterTime: 1,
    params: [
      { key: 'distance', label: 'length', min: 0, max: 40, step: 0.5, default: 10, unit: '%' },
      { key: 'angle', label: 'angle', min: -180, max: 180, step: 1, default: 0, unit: 'deg' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float len = p_distance * 0.01 * u_amount;
  float ang = radians(p_angle);
  vec2 dir = vec2(cos(ang), sin(ang)) * len;
  dir.x /= aspect();
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 28; i++) {
    float t = float(i) / 27.0 - 0.5;
    acc += tex(uv + dir * t).rgb;
  }
  return vec4(acc / 28.0, 1.0);
}`,
  },
  {
    id: 'zoom-blur',
    name: 'zoom blur',
    category: 'blur',
    description: 'streaks rushing out from a point, like a crash zoom',
    posterTime: 1,
    params: [
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 40, unit: '%' },
      { key: 'centerX', label: 'center x', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'centerY', label: 'center y', min: 0, max: 100, step: 1, default: 50, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec2 c = vec2(p_centerX, p_centerY) * 0.01;
  float s = p_strength * 0.01 * u_amount;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 28; i++) {
    float t = float(i) / 27.0;
    acc += tex(c + (uv - c) * (1.0 - s * t * 0.5)).rgb;
  }
  return vec4(acc / 28.0, 1.0);
}`,
  },
  {
    id: 'spin-blur',
    name: 'spin blur',
    category: 'blur',
    description: 'smears the picture around a point, like a spinning wheel',
    posterTime: 1,
    params: [
      { key: 'angle', label: 'angle', min: 0, max: 120, step: 1, default: 14, unit: 'deg' },
      { key: 'centerX', label: 'center x', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'centerY', label: 'center y', min: 0, max: 100, step: 1, default: 50, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec2 c = vec2(p_centerX, p_centerY) * 0.01;
  float ang = radians(p_angle) * u_amount;
  vec2 q = uv - c;
  q.x *= aspect();
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 28; i++) {
    float t = float(i) / 27.0 - 0.5;
    vec2 r = rot(q, ang * t);
    r.x /= aspect();
    acc += tex(c + r).rgb;
  }
  return vec4(acc / 28.0, 1.0);
}`,
  },
];
