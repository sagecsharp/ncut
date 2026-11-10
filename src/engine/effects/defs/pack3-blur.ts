import type { EffectDef } from '../types';
import { DISC } from './pack2-common';

/**
 * blur pack 3. tilt shift, lens blur, gaussian, directional, zoom and spin blur already exist, so
 * this only adds the two that were missing. both mix with the untouched pixel by the amount, so
 * amount 0 returns the picture bit for bit.
 */
export const PACK3_BLUR_EFFECTS: EffectDef[] = [
  {
    id: 'soft-focus',
    name: 'soft focus',
    category: 'blur',
    description: 'the sharp picture mixed with a wide blur of itself, dreamy and glowing',
    posterTime: 0.5,
    params: [
      { key: 'radius', label: 'radius', min: 0, max: 15, step: 0.1, default: 4, unit: '%' },
      { key: 'softness', label: 'softness', min: 0, max: 100, step: 1, default: 55, unit: '%' },
      { key: 'glow', label: 'glow', min: 0, max: 100, step: 1, default: 50, unit: '%' },
    ],
    glsl: `${DISC}
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float asp = aspect();
  float rad = p_radius * 0.01;
  float rot0 = jitter(uv);
  vec3 acc = vec3(0.0);
  float tot = 0.0;
  for (int i = 0; i < 30; i++) {
    vec2 o = vogel(i, 30, rot0);
    float w = exp(-2.0 * dot(o, o));
    acc += tex(uv + vec2(o.x / asp, o.y) * rad).rgb * w;
    tot += w;
  }
  vec3 b = acc / tot;
  // the picture melts into the blur, and the bright parts of the blur glow on top (screen)
  vec3 soft = mix(c, b, p_softness * 0.01);
  vec3 glowc = b * b * (p_glow * 0.01) * 0.9;
  soft = 1.0 - (1.0 - soft) * (1.0 - clamp(glowc, 0.0, 1.0));
  return vec4(mix(c, soft, u_amount), 1.0);
}`,
  },
  {
    id: 'rgb-trail',
    name: 'rgb trail',
    category: 'blur',
    description: 'a one sided smear where red, green and blue trail by different lengths',
    posterTime: 1,
    params: [
      { key: 'distance', label: 'length', min: 0, max: 40, step: 0.5, default: 12, unit: '%' },
      { key: 'angle', label: 'angle', min: -180, max: 180, step: 1, default: 0, unit: 'deg' },
      { key: 'spread', label: 'spread', min: 0, max: 100, step: 1, default: 70, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float ang = radians(p_angle);
  vec2 dir = vec2(cos(ang), sin(ang)) * (p_distance * 0.01);
  dir.x /= aspect();
  float s = p_spread * 0.01;
  // a static per pixel offset hides the steps of the 10 taps
  float jit = hash21(floor(uv * u_size));
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 10; i++) {
    float t = (float(i) + jit) / 10.0;
    acc.r += tex(uv - dir * t).r;
    acc.g += tex(uv - dir * t * (1.0 - 0.5 * s)).g;
    acc.b += tex(uv - dir * t * (1.0 - s)).b;
  }
  return vec4(mix(c, acc / 10.0, u_amount), 1.0);
}`,
  },
];
