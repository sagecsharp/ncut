import type { EffectDef } from '../types';
import { DISC } from './pack2-common';

/**
 * blur pack. one pass each, so the kernels are 2d spirals of 24..32 taps with a per pixel rotation
 * (static noise instead of visible rings). radii are a share of the frame height.
 */
export const PACK2_BLUR_EFFECTS: EffectDef[] = [
  {
    id: 'gaussian-blur',
    name: 'gaussian blur',
    category: 'blur',
    description: 'smooth even blur, the classic soft focus',
    posterTime: 0.5,
    params: [{ key: 'radius', label: 'radius', min: 0, max: 10, step: 0.1, default: 1.5, unit: '%' }],
    glsl: `${DISC}
vec4 effect(vec2 uv) {
  float asp = aspect();
  float rad = p_radius / 100.0 * u_amount;
  float rot0 = jitter(uv);
  vec3 acc = vec3(0.0);
  float tot = 0.0;
  for (int i = 0; i < 32; i++) {
    vec2 o = vogel(i, 32, rot0);
    // the disc edge sits at about 2.5 sigma
    float w = exp(-3.0 * dot(o, o));
    acc += tex(uv + vec2(o.x / asp, o.y) * rad).rgb * w;
    tot += w;
  }
  return vec4(acc / tot, 1.0);
}`,
  },
  {
    id: 'tilt-shift',
    name: 'tilt shift',
    category: 'blur',
    description: 'keeps one band sharp and blurs the rest, like a miniature',
    posterTime: 0.5,
    params: [
      { key: 'position', label: 'position', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'width', label: 'width', min: 0, max: 100, step: 1, default: 20, unit: '%' },
      { key: 'blur', label: 'blur', min: 0, max: 10, step: 0.1, default: 3, unit: '%' },
      { key: 'angle', label: 'angle', min: -90, max: 90, step: 1, default: 0, unit: 'deg' },
    ],
    glsl: `${DISC}
vec4 effect(vec2 uv) {
  float asp = aspect();
  vec2 p = (uv - 0.5) * vec2(asp, 1.0);
  float a = radians(p_angle);
  // distance from the middle of the sharp band, measured across it (frame heights)
  float d = dot(p - vec2(0.0, p_position / 100.0 - 0.5), vec2(sin(a), cos(a)));
  float hw = p_width / 100.0 * 0.5;
  float m = smoothstep(0.0, 0.3, max(abs(d) - hw, 0.0));
  float rad = p_blur / 100.0 * m * u_amount;
  float rot0 = jitter(uv);
  vec3 acc = vec3(0.0);
  float tot = 0.0;
  for (int i = 0; i < 24; i++) {
    vec2 o = vogel(i, 24, rot0);
    float w = exp(-3.0 * dot(o, o));
    acc += tex(uv + vec2(o.x / asp, o.y) * rad).rgb * w;
    tot += w;
  }
  vec3 col = acc / tot;
  // miniatures look a little more saturated
  col = mix(col, mix(vec3(luma(col)), col, 1.25), m * u_amount);
  return vec4(col, 1.0);
}`,
  },
  {
    id: 'lens-blur',
    name: 'lens blur',
    category: 'blur',
    description: 'out of focus blur with flat disc shaped bokeh and glowing highlights',
    posterTime: 0.5,
    params: [
      { key: 'radius', label: 'radius', min: 0, max: 10, step: 0.1, default: 2.5, unit: '%' },
      { key: 'highlights', label: 'highlights', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'shape', label: 'shape', min: 0, max: 1, step: 1, default: 0, options: ['round', 'hexagon'] },
    ],
    glsl: `${DISC}
vec4 effect(vec2 uv) {
  float asp = aspect();
  float rad = p_radius / 100.0 * u_amount;
  float hl = p_highlights / 100.0 * 8.0;
  float rot0 = jitter(uv);
  vec3 acc = vec3(0.0);
  float tot = 0.0;
  for (int i = 0; i < 32; i++) {
    vec2 o = vogel(i, 32, rot0);
    if (p_shape > 0.5) {
      // squeeze the disc into a hexagon: the edge of the hexagon in this direction
      float ang = atan(o.y, o.x);
      o *= 0.866025 / cos(mod(ang, PI / 3.0) - PI / 6.0);
    }
    vec3 s = tex(uv + vec2(o.x / asp, o.y) * rad).rgb;
    float l = luma(s);
    // bright points count more, so they bloom into discs
    float w = 1.0 + hl * l * l * l;
    acc += s * w;
    tot += w;
  }
  return vec4(acc / tot, 1.0);
}`,
  },
  {
    id: 'sharpen',
    name: 'sharpen',
    category: 'blur',
    description: 'unsharp mask: brings out fine detail and edges',
    posterTime: 0.5,
    params: [
      { key: 'strength', label: 'strength', min: 0, max: 200, step: 1, default: 80, unit: '%' },
      { key: 'radius', label: 'radius', min: 0.5, max: 4, step: 0.1, default: 1.5, unit: 'px' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  // radius in project pixels
  vec2 e = max(p_radius, 0.5) / u_size;
  vec3 c = tex(uv).rgb;
  vec3 bl = c * 4.0
    + (tex(uv + vec2(e.x, 0.0)).rgb + tex(uv - vec2(e.x, 0.0)).rgb + tex(uv + vec2(0.0, e.y)).rgb + tex(uv - vec2(0.0, e.y)).rgb) * 2.0
    + tex(uv + e).rgb + tex(uv - e).rgb + tex(uv + vec2(e.x, -e.y)).rgb + tex(uv + vec2(-e.x, e.y)).rgb;
  bl /= 16.0;
  // limit the detail that is added so hard edges do not get thick halos
  vec3 detail = clamp(c - bl, -0.3, 0.3);
  return vec4(c + detail * p_strength / 100.0 * 1.5 * u_amount, 1.0);
}`,
  },
];
