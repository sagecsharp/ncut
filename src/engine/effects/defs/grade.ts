import { GRADE_GLSL } from '../../grade';
import type { EffectDef } from '../types';

/**
 * the grade as an effect clip: the same chunk as the clip look (engine/grade.ts), run over everything below or over one
 * target clip. the wheel numbers and curves are the clip's own (EffectClip.grade), set in its look tab, so it has no params.
 * with no grade bound u_gOn is 0 and the effect is the identity.
 */
export const GRADE_DEFS: EffectDef[] = [
  {
    id: 'grade',
    name: 'grade',
    category: 'color',
    posterTime: 0.5,
    params: [],
    description: 'color wheels and curves over everything below. set them in its look tab',
    glsl: `${GRADE_GLSL}
vec4 effect(vec2 uv) {
  vec3 s = tex(uv).rgb;
  vec3 c = mix(s, gradeApply(clamp(s, 0.0, 1.0)), u_amount);
  return vec4(gDither(c, floor(uv * u_res)), 1.0);
}`,
  },
];
