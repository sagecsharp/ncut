import type { EffectDef } from '../types';
import { DISC } from './pack2-common';

/**
 * distort pack. kaleidoscope already exists (id "mirror"), so it is not repeated here.
 * every warp is aspect corrected and either cross fades with the untouched picture or scales its
 * offsets by the amount, so fades never pop.
 */
export const PACK2_DISTORT_EFFECTS: EffectDef[] = [
  {
    id: 'fisheye',
    name: 'fisheye',
    category: 'distort',
    description: 'wide angle bulge: the middle swells, the edges squash, nothing stretches past the frame',
    posterTime: 0.5,
    params: [
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 60, unit: '%' },
      { key: 'fit', label: 'fit', min: 0, max: 100, step: 1, default: 100, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float asp = aspect();
  vec2 p = (uv - 0.5) * vec2(asp, 1.0);
  // d = 1 at the corners of the frame
  float rc = 0.5 * length(vec2(asp, 1.0));
  vec2 d = p / rc;
  float s = p_strength / 100.0 * 1.5 * u_amount;
  // source position: swells the middle. dividing by (1 + s * fit) keeps the corners where they are,
  // so with fit 100 the picture never samples outside the frame
  vec2 q = d * (1.0 + s * dot(d, d)) / (1.0 + s * p_fit / 100.0);
  return tex(q * rc / vec2(asp, 1.0) + 0.5);
}`,
  },
  {
    id: 'tunnel',
    name: 'tunnel',
    category: 'distort',
    description: 'the picture wraps into a tunnel that you fly through',
    posterTime: 1,
    params: [
      { key: 'repeats', label: 'repeats', min: 1, max: 6, step: 1, default: 2, unit: 'x' },
      { key: 'depth', label: 'depth', min: 0.2, max: 3, step: 0.1, default: 1, unit: 'x' },
      { key: 'speed', label: 'speed', min: -3, max: 3, step: 0.1, default: 0.5, unit: 'hz' },
      { key: 'spin', label: 'spin', min: -2, max: 2, step: 0.1, default: 0.1, unit: 'hz' },
      { key: 'fog', label: 'fog', min: 0, max: 100, step: 1, default: 60, unit: '%' },
    ],
    glsl: `${DISC}
vec4 effect(vec2 uv) {
  float asp = aspect();
  vec2 p = (uv - 0.5) * vec2(asp, 1.0);
  float r = length(p);
  float a = atan(p.y, p.x + 0.00001);
  // an even number of mirrored lobes around the circle, so the wrap at +-pi has no seam
  float lobes = 2.0 * floor(p_repeats + 0.5);
  float u = a / TAU * lobes + u_time * p_spin;
  float v = p_depth * 0.25 / max(r, 0.02) + u_time * p_speed;
  vec3 t = tex(vec2(mir(u), mir(v))).rgb;
  // far away (the middle) fades to black
  t *= mix(1.0, smoothstep(0.0, 0.3, r), p_fog / 100.0);
  return vec4(mix(tex(uv).rgb, t, u_amount), 1.0);
}`,
  },
  {
    id: 'stretch',
    name: 'stretch',
    category: 'distort',
    description: 'scales the picture wider or taller from the center',
    posterTime: 0.5,
    params: [
      { key: 'scaleX', label: 'scale x', min: 25, max: 400, step: 1, default: 150, unit: '%' },
      { key: 'scaleY', label: 'scale y', min: 25, max: 400, step: 1, default: 100, unit: '%' },
      { key: 'edges', label: 'edges', min: 0, max: 2, step: 1, default: 0, options: ['repeat edge', 'mirror', 'black'] },
    ],
    glsl: `${DISC}
vec4 effect(vec2 uv) {
  vec2 sc = mix(vec2(1.0), vec2(p_scaleX, p_scaleY) / 100.0, u_amount);
  vec2 q = (uv - 0.5) / max(sc, 0.01) + 0.5;
  if (p_edges > 1.5) {
    vec2 inside = step(vec2(0.0), q) * step(q, vec2(1.0));
    return vec4(tex(q).rgb * inside.x * inside.y, 1.0);
  }
  if (p_edges > 0.5) q = vec2(mir(q.x), mir(q.y));
  return tex(q);
}`,
  },
  {
    id: 'tile',
    name: 'tile',
    category: 'distort',
    description: 'repeats the whole picture in a grid, optionally mirrored',
    posterTime: 0.5,
    params: [
      { key: 'columns', label: 'columns', min: 1, max: 12, step: 1, default: 2, unit: 'x' },
      { key: 'rows', label: 'rows', min: 1, max: 12, step: 1, default: 2, unit: 'x' },
      { key: 'mirror', label: 'mirror', min: 0, max: 1, step: 1, default: 1, options: ['off', 'on'] },
      { key: 'scroll', label: 'scroll', min: -2, max: 2, step: 0.1, default: 0, unit: 'hz' },
    ],
    glsl: `${DISC}
vec4 effect(vec2 uv) {
  vec2 n = vec2(max(floor(p_columns + 0.5), 1.0), max(floor(p_rows + 0.5), 1.0));
  vec2 g = uv * n + vec2(u_time * p_scroll, 0.0);
  vec2 q = p_mirror > 0.5 ? vec2(mir(g.x), mir(g.y)) : fract(g);
  // cross fade, so the grid appears smoothly
  return vec4(mix(tex(uv).rgb, tex(q).rgb, u_amount), 1.0);
}`,
  },
  {
    id: 'heat-haze',
    name: 'heat haze',
    category: 'distort',
    description: 'small rising shimmer, like air over hot ground',
    posterTime: 1,
    params: [
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 30, unit: '%' },
      { key: 'scale', label: 'scale', min: 1, max: 20, step: 0.5, default: 6, unit: 'x' },
      { key: 'speed', label: 'speed', min: 0, max: 4, step: 0.1, default: 1, unit: 'hz' },
      { key: 'ground', label: 'ground', min: 0, max: 100, step: 1, default: 40, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  float asp = aspect();
  vec2 q = vec2(uv.x * asp, uv.y) * p_scale;
  float t = u_time * p_speed;
  // the pattern slides up over time (we sample further down the pattern as time goes on)
  vec2 n = vec2(fbm(q + vec2(u_seed, t * 1.5)), fbm(q + vec2(17.3 + u_seed, t * 1.5 + 5.1))) - 0.5;
  // ground 100: no shimmer at the top, full at the bottom
  float k = mix(1.0, uv.y * 1.6, p_ground / 100.0);
  vec2 off = n * 2.0 * p_strength / 100.0 * 0.012 * k * u_amount;
  return tex(uv + vec2(off.x / asp, off.y));
}`,
  },
];
