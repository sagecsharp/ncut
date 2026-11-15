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
    alpha: 'moves',
    description: 'the sharp picture mixed with a wide blur of itself, dreamy and glowing',
    posterTime: 0.5,
    params: [
      { key: 'radius', label: 'radius', min: 0, max: 15, step: 0.1, default: 4, unit: '%' },
      { key: 'softness', label: 'softness', min: 0, max: 100, step: 1, default: 55, unit: '%' },
      { key: 'glow', label: 'glow', min: 0, max: 100, step: 1, default: 50, unit: '%' },
    ],
    glsl: `${DISC}
vec4 effect(vec2 uv) {
  vec4 c = tex(uv);
  float asp = aspect();
  float rad = p_radius * 0.01;
  float rot0 = jitter(uv);
  vec4 acc = vec4(0.0);
  float tot = 0.0;
  for (int i = 0; i < 30; i++) {
    vec2 o = vogel(i, 30, rot0);
    float w = exp(-2.0 * dot(o, o));
    acc += tex(uv + vec2(o.x / asp, o.y) * rad) * w;
    tot += w;
  }
  vec4 b = acc / tot;
  // the picture melts into the blur, and the bright parts of the blur glow on top (screen)
  vec4 soft = mix(c, b, p_softness * 0.01);
  // the glow is light: the straight colour of the blur times the light it gives
  vec3 glowc = clamp(unpm(b) * b.rgb * (p_glow * 0.01) * 0.9, 0.0, 1.0);
  soft.rgb = 1.0 - (1.0 - soft.rgb) * (1.0 - glowc);
  // the glow reaches past the outline as far as it is bright
  soft.a = 1.0 - (1.0 - soft.a) * (1.0 - max(glowc.r, max(glowc.g, glowc.b)));
  return mix(c, soft, u_amount);
}`,
  },
  {
    id: 'rgb-trail',
    name: 'rgb trail',
    category: 'blur',
    alpha: 'moves',
    description: 'a one sided smear where red, green and blue trail by different lengths',
    posterTime: 1,
    params: [
      { key: 'distance', label: 'length', min: 0, max: 40, step: 0.5, default: 12, unit: '%' },
      { key: 'angle', label: 'angle', min: -180, max: 180, step: 1, default: 0, unit: 'deg' },
      { key: 'spread', label: 'spread', min: 0, max: 100, step: 1, default: 70, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec4 c = tex(uv);
  float ang = radians(p_angle);
  vec2 dir = vec2(cos(ang), sin(ang)) * (p_distance * 0.01);
  dir.x /= aspect();
  float s = p_spread * 0.01;
  // a static per pixel offset hides the steps of the 10 taps
  float jit = hash21(floor(uv * u_size));
  vec4 sumR = vec4(0.0);
  vec4 sumG = vec4(0.0);
  vec4 sumB = vec4(0.0);
  for (int i = 0; i < 10; i++) {
    float t = (float(i) + jit) / 10.0;
    sumR += tex(uv - dir * t);
    sumG += tex(uv - dir * t * (1.0 - 0.5 * s));
    sumB += tex(uv - dir * t * (1.0 - s));
  }
  // each colour trails on its own, the outline is where any of them is
  return mix(c, pick3(sumR, sumG, sumB) / 10.0, u_amount);
}`,
  },
];
