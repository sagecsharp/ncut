import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIR = 'src/features/properties';
const BANNED = [/\brange\b/, /\blevels?\b/, /\bassets?\b/, /\bcurve\b/, /\binput lut\b/];

/** the source without block comments and without // comments (a // after a colon is part of a url) */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** every string literal of the code: '...', "..." and `...` (a template without its ${} parts) */
function literals(src: string): string[] {
  const out: string[] = [];
  for (const m of strip(src).matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
    out.push((m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' '));
  }
  // the text runs between jsx tags
  for (const m of strip(src).matchAll(/>([^<>{}]+)</g)) {
    const t = m[1]!.trim();
    if (t) out.push(t);
  }
  return out;
}

describe('lut words', () => {
  it('lut ui strings never say range, level, asset or curve', () => {
    const files: [string, boolean][] = [
      ['GradeLut.tsx', false],
      ['lutActions.ts', false],
      ['lutPlan.ts', false],
      ['lutSave.ts', false],
      // the grade sections have older words of their own: only what names the lut
      ['GradeSection.tsx', true],
      ['MultiGradeSection.tsx', true],
    ];
    let read = 0;
    const bad: string[] = [];
    for (const [name, onlyLut] of files) {
      for (const text of literals(readFileSync(`${DIR}/${name}`, 'utf8'))) {
        const low = text.toLowerCase();
        if (onlyLut && !low.includes('lut') && !low.includes('.cube')) continue;
        read++;
        for (const re of BANNED) if (re.test(low)) bad.push(`${name}: "${text}" matches ${re}`);
      }
    }
    expect(read).toBeGreaterThan(20);
    expect(bad).toEqual([]);
  });
});
