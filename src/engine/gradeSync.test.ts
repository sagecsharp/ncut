import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CB_DIV, CR_DIV, HUE_RED, KB, KG, KR, TAU } from '../lib/gradeMath';
import { GRADE_GLSL } from './grade';

const SRC = readFileSync(new URL('./grade.ts', import.meta.url), 'utf8');
/** the typescript side: gradeColor and ditherAt */
const MIRROR = SRC.slice(SRC.indexOf('export function gradeColor'));

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
const STAGES = ['// g1 wheels', '// g2 tone curves', '// g3 color curves', '// g4 dither'];

describe('grade.ts, glsl and its mirror', () => {
  it('g1 to g4 in order in glsl and mirror', () => {
    expect(inOrder(GRADE_GLSL, STAGES)).toBe(true);
    expect(inOrder(MIRROR, STAGES)).toBe(true);
    for (const m of STAGES) {
      expect(GRADE_GLSL.split(m).length, m).toBe(2);
      expect(MIRROR.split(m).length, m).toBe(2);
    }
  });

  it("printed constants are gradeMath's", () => {
    const f6 = (x: number): string => String(Number(x.toFixed(6)));
    const f8 = (x: number): string => String(Number(x.toFixed(8)));
    expect(GRADE_GLSL).toContain(`const vec3 G_LUMA = vec3(${f6(KR)}, ${f6(KG)}, ${f6(KB)});`);
    expect(GRADE_GLSL).toContain(`(c.b - y) / ${f6(CB_DIV)}`);
    expect(GRADE_GLSL).toContain(`(c.r - y) / ${f6(CR_DIV)}`);
    expect(GRADE_GLSL).toContain(`atan(q.y, q.x) - ${f8(HUE_RED)}`);
    expect(GRADE_GLSL).toContain(`/ ${f8(TAU)});`);
    expect(GRADE_GLSL).toContain(`float t = gHueRow(5, h) * ${f8(TAU)};`);
    // the template prints them from the constants, the mirror reads the same constants
    expect(SRC).toContain('const C_KR = P6(KR);');
    expect(SRC).toContain('const C_KG = P6(KG);');
    expect(SRC).toContain('const C_KB = P6(KB);');
    expect(SRC).toContain('const C_CB = P6(CB_DIV);');
    expect(SRC).toContain('const C_CR = P6(CR_DIV);');
    expect(SRC).toContain('const C_HUE = P8(HUE_RED);');
    expect(SRC).toContain('const C_TAU = P8(TAU);');
    expect(SRC).toContain('const P6 = (x: number): number => Number(x.toFixed(6));');
    expect(SRC).toContain('const P8 = (x: number): number => Number(x.toFixed(8));');
    for (const name of ['C_KR', 'C_KG', 'C_KB', 'C_CB', 'C_CR', 'C_HUE', 'C_TAU']) expect(MIRROR, name).toContain(name);
    expect(MIRROR).not.toMatch(/\bMath\.PI\b|\b0\.2126\b|\b0\.7152\b/);
  });

  it('globals start with g, G_ or u_g', () => {
    const code = stripComments(GRADE_GLSL);
    const names: string[] = [];
    // global declarations sit at the start of a line: uniforms, consts and functions
    for (const m of code.matchAll(/^(?:uniform\s+(?:highp\s+)?\w+|const\s+\w+|float|vec[234]|uint|int|void)\s+(\w+)/gm)) names.push(m[1]!);
    expect(names.length).toBeGreaterThan(8);
    for (const n of names) expect(n, n).toMatch(/^(g[a-zA-Z]|G_|u_g)/);
  });

  it('no gl_FragCoord, fract(sin, discard, PI or TAU; int is highp', () => {
    const code = stripComments(GRADE_GLSL);
    expect(code).not.toContain('gl_FragCoord');
    expect(code).not.toMatch(/fract\s*\(\s*sin/);
    expect(code).not.toContain('discard');
    expect(code).not.toMatch(/\bPI\b/);
    expect(code).not.toMatch(/\bTAU\b/);
    expect(GRADE_GLSL).toContain('precision highp int;');
  });
});
