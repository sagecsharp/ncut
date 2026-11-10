import { describe, expect, it } from 'vitest';
import { familyRenders, isGenericFamily } from './fontDetect';

/** fake fonts: width by the first family in the css font, the fallback decides when the family is unknown */
function fake(known: Record<string, number>): (font: string) => number {
  return (font) => {
    const m = /"([^"]+)"/.exec(font);
    if (m && known[m[1]] !== undefined) return known[m[1]];
    return font.includes('monospace') ? 100 : font.includes('serif') ? 80 : 0;
  };
}

describe('fontDetect', () => {
  it('a family with its own widths renders', () => {
    expect(familyRenders('Foo', 400, fake({ Foo: 123 }))).toBe(true);
  });
  it('an unknown family does not render', () => {
    expect(familyRenders('Nope', 400, fake({}))).toBe(false);
  });
  it('a family equal to one fallback still renders through the other pair', () => {
    expect(familyRenders('Mono', 400, fake({ Mono: 100 }))).toBe(true);
  });
  it('generic and empty families always count as there', () => {
    for (const f of ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', '']) {
      expect(isGenericFamily(f)).toBe(true);
      expect(familyRenders(f, 400, fake({}))).toBe(true);
    }
  });
  it('no canvas means it renders', () => {
    expect(familyRenders('Nope', 400, () => null)).toBe(true);
  });
  it('a throwing measure means it renders', () => {
    expect(familyRenders('Nope', 700, () => { throw new Error('x'); })).toBe(true);
  });
});
