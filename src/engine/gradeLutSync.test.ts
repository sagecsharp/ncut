import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GRADE_GLSL } from './grade';
import { GRADE_LUT_GLSL } from './gradeLut';

const LUT_SRC = readFileSync(new URL('./gradeLut.ts', import.meta.url), 'utf8');
const GRADE_SRC = readFileSync(new URL('./grade.ts', import.meta.url), 'utf8');
/** the typescript side of the lut: lutColor */
const LUT_MIRROR = LUT_SRC.slice(LUT_SRC.indexOf('export function lutColor'));
/** the typescript side of the grade with its lut: gradeLutColor, up to the next function */
const FROM_GRADE_LUT = GRADE_SRC.slice(GRADE_SRC.indexOf('export function gradeLutColor'));
const GRADE_LUT_MIRROR = FROM_GRADE_LUT.slice(0, FROM_GRADE_LUT.indexOf('\n}\n') + 3);

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
const inOrder = (text: string, marks: string[]): boolean => {
  let at = -1;
  for (const m of marks) {
    const i = text.indexOf(m, at + 1);
    if (i <= at) return false;
    at = i;
  }
  return true;
};
const STAGES = ['// la tv scale in', '// lb 1d table', '// lc 3d table', '// ld tv scale out', '// le mix'];

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

describe('the lut glsl and its mirror', () => {
  it('la to le once and in order in glsl and mirror', () => {
    expect(inOrder(GRADE_LUT_GLSL, STAGES)).toBe(true);
    expect(inOrder(LUT_MIRROR, STAGES)).toBe(true);
    for (const m of STAGES) {
      expect(GRADE_LUT_GLSL.split(m).length, m).toBe(2);
      expect(LUT_MIRROR.split(m).length, m).toBe(2);
    }
  });

  it('l1, gradeApply, l2 and l1, gradeColor, l2 in order', () => {
    expect(inOrder(GRADE_LUT_GLSL, ['// l1 lut first', 'c = gradeApply(c);', '// l2 lut last'])).toBe(true);
    expect(inOrder(GRADE_LUT_MIRROR, ['// l1 lut first', 'c = gradeColor(c, d);', '// l2 lut last'])).toBe(true);
    for (const m of ['// l1 lut first', '// l2 lut last']) {
      expect(GRADE_LUT_GLSL.split(m).length, m).toBe(2);
      expect(GRADE_LUT_MIRROR.split(m).length, m).toBe(2);
    }
    expect(GRADE_LUT_GLSL.split('vec3 gradeLutApply(vec3 c)').length).toBe(2);
  });

  it('globals start with g, G_ or u_g', () => {
    const code = stripComments(GRADE_LUT_GLSL);
    const names: string[] = [];
    for (const m of code.matchAll(/^(?:uniform\s+(?:highp\s+)?\w+|const\s+\w+|float|vec[234]|ivec[234]|uint|int|void)\s+(\w+)/gm)) names.push(m[1]!);
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) expect(n, n).toMatch(/^(g[a-zA-Z]|G_|u_g)/);
  });

  it('texelFetch only', () => {
    const code = stripComments(GRADE_LUT_GLSL);
    expect(code).not.toMatch(/\btexture\s*\(/);
    expect(code).not.toMatch(/\btexture(?:Lod|Offset|Grad)\s*\(/);
    expect(code).toContain('texelFetch(u_gLut1,');
    expect(code).toContain('texelFetch(u_gLut3,');
    // each sampler is declared once and read once (gLut3At, gLut1At)
    expect(code.match(/\bu_gLut3\b/g)!.length).toBe(2);
    expect(code.match(/\bu_gLut1\b/g)!.length).toBe(2);
  });

  it('no gl_FragCoord, discard, PI or TAU', () => {
    const code = stripComments(GRADE_LUT_GLSL);
    expect(code).not.toContain('gl_FragCoord');
    expect(code).not.toContain('discard');
    expect(code).not.toMatch(/\bPI\b/);
    expect(code).not.toMatch(/\bTAU\b/);
    expect(code).not.toMatch(/fract\s*\(\s*sin/);
  });

  it('GRADE_GLSL is untouched', () => {
    expect(fnv1a(GRADE_GLSL)).toBe('3db86a38');
  });
});
