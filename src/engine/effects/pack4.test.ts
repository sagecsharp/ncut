import { describe, expect, it } from 'vitest';
import { EFFECTS, getEffect } from './registry';

const PACK4: [string, string][] = [
  ['color-pop', 'color'],
  ['teal-orange', 'color'],
  ['glass', 'distort'],
  ['prism', 'distort'],
  ['letterbox', 'stylize'],
  ['neon-edges', 'stylize'],
  ['emboss', 'stylize'],
  ['sketch', 'stylize'],
  ['led-screen', 'stylize'],
  ['hologram', 'stylize'],
  ['oil-paint', 'stylize'],
];

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

describe('pack 4', () => {
  it('registers every effect exactly once, in its category', () => {
    for (const [id, cat] of PACK4) {
      expect(EFFECTS.filter((e) => e.id === id), id).toHaveLength(1);
      expect(getEffect(id)!.category, id).toBe(cat);
    }
  });

  it('none of the pack is temporal and each has 2 to 4 params', () => {
    for (const [id] of PACK4) {
      const def = getEffect(id)!;
      expect(def.temporal, id).toBeUndefined();
      expect(def.params.length, id).toBeGreaterThanOrEqual(2);
      expect(def.params.length, id).toBeLessThanOrEqual(4);
    }
  });

  it('oil paint reads the pixel once and 8 more per corner (33 reads, the budget is about 32)', () => {
    const code = strip(getEffect('oil-paint')!.glsl);
    expect(code.match(/tex\(/g)).toHaveLength(2);
    expect(code).toContain('q < 4');
    expect(code).toContain('i < 8');
  });

  it('the distortions only move pixels (on a clip they run on its alpha too)', () => {
    // nothing may be added to the color: a transparent pixel must stay transparent
    for (const id of ['glass', 'prism']) {
      const code = strip(getEffect(id)!.glsl);
      expect(code, id).not.toMatch(/\+\s*vec3\(/);
    }
  });

  it('letterbox does nothing when the frame is already wider than the ratio', () => {
    // the glsl: open = clamp(aspect / ratio, 0, 1), bar = (1 - open) / 2
    const bar = (aspect: number, ratio: number) => (1 - Math.min(1, Math.max(0, aspect / ratio))) / 2;
    expect(bar(2.5, 2.39)).toBe(0);
    expect(bar(16 / 9, 2.39)).toBeCloseTo(0.128, 3);
    expect(bar(9 / 16, 1)).toBeCloseTo(0.21875, 5);
  });
});
