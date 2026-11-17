import { GRADE_GLSL } from '../../grade';
import type { GradeData } from '../../grade';
import { GRADE_LUT_GLSL } from '../../gradeLut';
import type { EffectDef } from '../types';

/** the effect function, once: the grade runs `apply` (gradeApply, or gradeLutApply with a lut) */
const body = (apply: string): string => `
vec4 effect(vec2 uv) {
  vec3 s = tex(uv).rgb;
  vec3 c = mix(s, ${apply}(clamp(s, 0.0, 1.0)), u_amount);
  return vec4(gDither(c, floor(uv * u_res)), 1.0);
}`;

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
    glsl: `${GRADE_GLSL}${body('gradeApply')}`,
  },
];

/** the same effect with the lut chunk, built on the first live lut. it is not in the registry (GRADE_DEFS) */
export const GRADE_LUT_DEF: EffectDef = { ...GRADE_DEFS[0]!, id: 'grade-lut', glsl: `${GRADE_GLSL}${GRADE_LUT_GLSL}${body('gradeLutApply')}` };

/** the effect def a grade pass runs: the lut one only when the grade has a live lut, else the registered grade */
export function gradeDefFor(d: GradeData | null): EffectDef {
  return d?.lut ? GRADE_LUT_DEF : GRADE_DEFS[0]!;
}
