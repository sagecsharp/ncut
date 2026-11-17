import { describe, expect, it } from 'vitest';
import type { ClipGrade, GradeCurves } from '../types';
import { GRADE_KEYS, normalizeGrade, sameGrade } from '../lib/gradeData';
import { hueOf } from '../lib/gradeMath';
import type { Rgb3 } from '../lib/gradeMath';
import { DEMO_GRADE, bakeCurves, ditherAt, gradeColor, gradeData, gradeSignature } from './grade';
import type { GradeData } from './grade';

const KR = 0.2126;
const KG = 0.7152;
const KB = 0.0722;
const luma = (c: Rgb3): number => KR * c[0] + KG * c[1] + KB * c[2];
const near = (a: Rgb3, b: Rgb3, digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));

/** 9 x 9 x 9 colors: every level k / 8 on each channel */
const GRID: Rgb3[] = [];
for (let r = 0; r <= 8; r++) for (let g = 0; g <= 8; g++) for (let b = 0; b <= 8; b++) GRID.push([r / 8, g / 8, b / 8]);

/** a grade data with every stage on and a neutral table: the identity */
function neutralData(): GradeData {
  const table = new Float32Array(256 * 7);
  for (let i = 0; i < 256; i++) {
    for (let row = 0; row < 4; row++) table[row * 256 + i] = i / 255;
    table[4 * 256 + i] = 1;
    table[5 * 256 + i] = 0;
    table[6 * 256 + i] = 1;
  }
  return { lift: [0, 0, 0], gain: [1, 1, 1], gamma: [1, 1, 1], offset: [0, 0, 0], on: [1, 1, 1, 1], tone: [1, 1, 1, 1], table, key: 'neutral' };
}

const data = (g: ClipGrade): GradeData => gradeData(g)!;
let seed = 12345;
const rand = (): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};

describe('gradeData', () => {
  it('gradeData is null for missing, empty, zero or off', () => {
    expect(gradeData(undefined)).toBeNull();
    expect(gradeData(null)).toBeNull();
    expect(gradeData({})).toBeNull();
    expect(gradeData({ liftR: 0, gainY: 0, curves: {} })).toBeNull();
    expect(gradeData({ liftR: 1e-5 })).toBeNull();
    expect(gradeData({ liftR: 0.5, off: true })).toBeNull();
    expect(gradeData({ curves: { y: [[0, 0], [1, 1]] } })).toBeNull();
    expect(gradeData({ curves: { hueSat: [[0.2, 0.5]] }, off: true })).toBeNull();
    expect(gradeData({ liftR: 0.5 })).not.toBeNull();
  });

  it('neutral wheels: lift 0, gain 1, gamma exactly 1, offset 0', () => {
    const curved = data({ curves: { y: [[0, 0], [0.5, 0.6], [1, 1]] } });
    expect(curved.lift).toEqual([0, 0, 0]);
    expect(curved.gain).toEqual([1, 1, 1]);
    expect(curved.gamma).toEqual([1, 1, 1]);
    expect(curved.offset).toEqual([0, 0, 0]);
    expect(curved.on[0]).toBe(0);
    const d = data({ liftR: 0.2 });
    expect(d.gain).toEqual([1, 1, 1]);
    for (const e of d.gamma) expect(e).toBe(1);
    expect(d.offset).toEqual([0, 0, 0]);
    expect(d.lift).toEqual([0.1, 0, 0]);
    expect(d.on[0]).toBe(1);
  });

  it('wheels add the level to each channel', () => {
    const d = data({ liftY: 0.2, liftR: 0.1, gainB: -0.5, gainY: 0.25, gammaG: 1, offsetY: -0.4 });
    expect(d.lift[0]).toBeCloseTo(0.15, 9);
    expect(d.lift[1]).toBeCloseTo(0.1, 9);
    expect(d.gain[0]).toBeCloseTo(1.25, 9);
    expect(d.gain[2]).toBeCloseTo(0.75, 9);
    expect(d.gamma[1]).toBeCloseTo(0.5, 9);
    expect(d.offset[2]).toBeCloseTo(-0.2, 9);
    expect(data({ gainY: -1, gainR: -1 }).gain[0]).toBe(0);
  });

  it('neutral is the identity on a 9 x 9 x 9 grid', () => {
    const d = neutralData();
    for (const c of GRID) near(gradeColor(c, d), c, 5);
  });

  it('black to lift, white to gain', () => {
    for (const gammaY of [-1, -0.5, 0, 0.5, 1]) {
      const d = data({ liftY: 0.2, gainY: -0.3, gammaY });
      near(gradeColor([0, 0, 0], d), [0.1, 0.1, 0.1], 3);
      near(gradeColor([1, 1, 1], d), [0.7, 0.7, 0.7], 6);
    }
    near(gradeColor([0, 0, 0], data({ liftR: 0.4, liftB: -0.2 })), [0.2, 0, 0], 6);
    near(gradeColor([1, 1, 1], data({ gainR: 0.5 })), [1, 1, 1], 6);
  });

  it('gamma level +1 takes 0.25 to 0.5', () => {
    near(gradeColor([0.25, 0.25, 0.25], data({ gammaY: 1 })), [0.5, 0.5, 0.5], 9);
    near(gradeColor([0.5, 0.5, 0.5], data({ gammaY: -1 })), [0.25, 0.25, 0.25], 9);
  });

  it('extremes stay in 0..1, no NaN', () => {
    const curves: GradeCurves = {
      y: [[0, 0.3], [0.5, 0.9], [1, 0.2]],
      r: [[0, 1], [1, 0]],
      hueSat: [[0, 1], [0.3, 0], [0.6, 1]],
      hueHue: [[0, 0], [0.5, 1]],
      lumaSat: [[0, 1], [1, 1]],
    };
    const grades: ClipGrade[] = [];
    for (let n = 0; n < 40; n++) {
      const g: ClipGrade = {};
      for (const k of GRADE_KEYS) g[k] = rand() < 0.5 ? (rand() < 0.5 ? 1 : -1) : rand() * 2 - 1;
      if (n % 2 === 0) g.curves = curves;
      grades.push(g);
    }
    for (const g of grades) {
      const d = gradeData(g);
      if (!d) continue;
      for (const c of GRID) {
        const out = gradeColor(c, d);
        for (const v of out) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('keeps the same data for the same grade and holds the curves table', () => {
    const g: ClipGrade = { liftR: 0.1, curves: { y: [[0, 0], [0.5, 0.6], [1, 1]] } };
    const a = data(g);
    const b = data({ ...g });
    expect(b.table).toBe(a.table);
    expect(b.key).toBe(a.key);
    expect(a.table!.length).toBe(256 * 7);
    expect(a.on).toEqual([1, 1, 0, 1]);
    expect(a.tone).toEqual([1, 0, 0, 0]);
  });

  it('DEMO_GRADE is clean and active', () => {
    expect(sameGrade(DEMO_GRADE, normalizeGrade(DEMO_GRADE))).toBe(true);
    expect(JSON.stringify(normalizeGrade(DEMO_GRADE))).toBe(JSON.stringify(DEMO_GRADE));
    const d = data(DEMO_GRADE);
    expect(d.on).toEqual([1, 1, 0, 1]);
    expect(d.lift[2]).toBeGreaterThan(d.lift[0]);
    expect(d.gain[0]).toBeGreaterThan(d.gain[2]);
  });
});

describe('bakeCurves', () => {
  it('is null for missing and neutral lists', () => {
    expect(bakeCurves(undefined)).toBeNull();
    expect(bakeCurves({})).toBeNull();
    expect(bakeCurves({ y: [[0, 0], [1, 1]], hueSat: [[0.2, 0.5]] })).toBeNull();
  });

  it('neutral rows are exact', () => {
    const bake = bakeCurves({ r: [[0, 0], [0.5, 0.7], [1, 1]] })!;
    const t = bake.table;
    for (let i = 0; i < 256; i++) {
      for (const row of [0, 2, 3]) expect(t[row * 256 + i]).toBe(Math.fround(i / 255));
      expect(t[4 * 256 + i]).toBe(1);
      expect(t[5 * 256 + i]).toBe(0);
      expect(t[6 * 256 + i]).toBe(1);
    }
  });

  it('tone rows are monotone', () => {
    const bake = bakeCurves({
      y: [[0, 0], [0.25, 0.1], [0.75, 0.9], [1, 1]],
      g: [[0, 0.1], [0.4, 0.5], [0.6, 0.5], [1, 0.9]],
    })!;
    for (const row of [0, 2]) {
      for (let i = 1; i < 256; i++) expect(bake.table[row * 256 + i]!).toBeGreaterThanOrEqual(bake.table[row * 256 + i - 1]!);
    }
    for (let i = 0; i < 256; i++) for (const row of [0, 2]) {
      const v = bake.table[row * 256 + i]!;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the ranges of the color rows', () => {
    const bake = bakeCurves({ hueSat: [[0, 1], [0.5, 0]], hueHue: [[0, 1], [0.5, 0]], lumaSat: [[0, 1], [1, 0]] })!;
    for (let i = 0; i < 256; i++) {
      expect(bake.table[4 * 256 + i]!).toBeGreaterThanOrEqual(0);
      expect(bake.table[4 * 256 + i]!).toBeLessThanOrEqual(2);
      expect(Math.abs(bake.table[5 * 256 + i]!)).toBeLessThanOrEqual(0.5);
      expect(bake.table[6 * 256 + i]!).toBeLessThanOrEqual(2);
    }
    expect(bake.table[4 * 256]).toBe(2);
    expect(bake.table[6 * 256]).toBe(2);
  });

  it('hue rows join across 0 and 1', () => {
    const bake = bakeCurves({ hueSat: [[0.1, 0.9], [0.5, 0.1]], hueHue: [[0.2, 0.8], [0.7, 0.3]] })!;
    for (const row of [4, 5]) {
      const t = bake.table;
      const step = Math.max(...Array.from({ length: 255 }, (_, i) => Math.abs(t[row * 256 + i + 1]! - t[row * 256 + i]!)));
      expect(Math.abs(t[row * 256]! - t[row * 256 + 255]!)).toBeLessThanOrEqual(step + 1e-6);
    }
  });

  it('a red list sets only tone.y', () => {
    const bake = bakeCurves({ r: [[0, 0], [0.5, 0.7], [1, 1]] })!;
    expect(bake.tone).toEqual([0, 1, 0, 0]);
    expect(bake.color).toBe(false);
    const d = data({ curves: { r: [[0, 0], [0.5, 0.7], [1, 1]] } });
    expect(d.on).toEqual([0, 1, 0, 1]);
    expect(d.tone).toEqual([0, 1, 0, 0]);
    expect(bakeCurves({ b: [[0, 0.2], [1, 1]] })!.tone).toEqual([0, 0, 0, 1]);
    expect(bakeCurves({ lumaSat: [[0, 1], [1, 0.2]] })!.color).toBe(true);
  });

  it('the bake cache keeps 16', () => {
    const mk = (i: number): GradeCurves => ({ y: [[0, 0], [0.5, 0.3 + i * 0.01], [1, 1]] });
    const first = Array.from({ length: 16 }, (_, i) => bakeCurves(mk(i))!.table);
    // a hit gives the same table, and moves it to the newest end
    expect(bakeCurves(mk(0))!.table).toBe(first[0]);
    // a 17th pushes the oldest out: 1, not 0
    bakeCurves(mk(16));
    expect(bakeCurves(mk(0))!.table).toBe(first[0]);
    expect(bakeCurves(mk(1))!.table).not.toBe(first[1]);
    expect(bakeCurves(mk(15))!.table).toBe(first[15]);
  });
});

describe('gradeColor curves', () => {
  it('hue vs sat 0 grays to luma', () => {
    const d = data({ curves: { hueSat: [[0, 0], [0.5, 0]] } });
    for (const c of [[0.8, 0.3, 0.2], [0.1, 0.6, 0.9], [0.5, 0.5, 0.2]] as Rgb3[]) {
      const l = luma(c);
      near(gradeColor(c, d), [l, l, l], 6);
    }
    near(gradeColor([0.4, 0.4, 0.4], d), [0.4, 0.4, 0.4], 6);
  });

  it('hue vs hue 0.5 + 1/6 turns red toward yellow', () => {
    const d = data({ curves: { hueHue: [[0, 0.5 + 1 / 6], [0.5, 0.5 + 1 / 6]] } });
    const c: Rgb3 = [0.5, 0.3, 0.3];
    const out = gradeColor(c, d);
    const h0 = hueOf(...c);
    const h1 = hueOf(...out);
    expect(h1 - h0).toBeCloseTo(1 / 6, 3);
    expect(out[1]).toBeGreaterThan(out[2]);
    expect(luma(out)).toBeCloseTo(luma(c), 6);
  });

  it('color curves keep luma', () => {
    const d = data({ curves: { hueSat: [[0, 0.4], [0.3, 0.1], [0.6, 0.5]], lumaSat: [[0, 0.5], [1, 0.25]] } });
    for (let n = 0; n < 60; n++) {
      const c: Rgb3 = [rand(), rand(), rand()];
      expect(luma(gradeColor(c, d))).toBeCloseTo(luma(c), 6);
    }
  });

  it('tone curves move luma and one channel', () => {
    const luma1 = gradeColor([0.5, 0.5, 0.5], data({ curves: { y: [[0, 0], [0.5, 0.7], [1, 1]] } }));
    expect(luma1[0]).toBeCloseTo(0.7, 3);
    const red = gradeColor([0.5, 0.5, 0.5], data({ curves: { r: [[0, 0], [0.5, 0.7], [1, 1]] } }));
    expect(red[0]).toBeCloseTo(0.7, 3);
    expect(red[1]).toBe(0.5);
    expect(red[2]).toBe(0.5);
  });
});

describe('ditherAt', () => {
  it('ditherAt is fixed and under half a level', () => {
    expect(ditherAt(3, 5)).toBe(ditherAt(3, 5));
    expect(ditherAt(0, 0)).toBe(ditherAt(0, 0));
    let lo = 1;
    let hi = -1;
    let sum = 0;
    let moved = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const d = ditherAt(x, y);
        expect(Math.abs(d)).toBeLessThan(0.5 / 255);
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
        sum += d;
        if (d !== ditherAt(x + 1, y)) moved++;
      }
    }
    expect(lo).toBeLessThan(-0.3 / 255);
    expect(hi).toBeGreaterThan(0.3 / 255);
    expect(Math.abs(sum / 4096)).toBeLessThan(0.05 / 255);
    expect(moved).toBeGreaterThan(4000);
  });

  it('never changes an exact 8 bit level', () => {
    for (let k = 0; k <= 255; k++) {
      for (const [x, y] of [[0, 0], [17, 3], [1919, 1079], [3839, 2159], [255, 255]] as const) {
        const v = Math.min(1, Math.max(0, k / 255 + ditherAt(x, y)));
        expect(Math.round(255 * v)).toBe(k);
      }
    }
  });

  it('reads the pixel as x + y * 65536', () => {
    expect(ditherAt(1, 0)).not.toBe(ditherAt(0, 1));
    expect(ditherAt(5, 2)).toBe(ditherAt(5, 2));
  });
});

describe('gradeSignature', () => {
  it('gradeSignature follows every number and list', () => {
    expect(gradeSignature(undefined)).toBe('');
    expect(gradeSignature({})).toBe('');
    expect(gradeSignature({ liftR: 0.3, off: true })).toBe('');
    expect(gradeSignature({ curves: { y: [[0, 0], [1, 1]] } })).toBe('');
    const base: ClipGrade = { liftR: 0.3, curves: { y: [[0, 0], [0.5, 0.6], [1, 1]] } };
    const sig = gradeSignature(base);
    expect(sig).not.toBe('');
    expect(gradeSignature({ ...base })).toBe(sig);
    const sigs = new Set<string>([sig]);
    for (const k of GRADE_KEYS) sigs.add(gradeSignature({ ...base, [k]: 0.123 }));
    expect(sigs.size).toBe(1 + GRADE_KEYS.length);
    const lists: GradeCurves[] = [
      { y: [[0, 0], [0.5, 0.61], [1, 1]] },
      { y: [[0, 0], [0.5, 0.6], [1, 1]], r: [[0, 0], [0.5, 0.6], [1, 1]] },
      { y: [[0, 0], [0.5, 0.6], [1, 1]], g: [[0, 0.1], [1, 1]] },
      { y: [[0, 0], [0.5, 0.6], [1, 1]], b: [[0, 0], [1, 0.9]] },
      { y: [[0, 0], [0.5, 0.6], [1, 1]], hueSat: [[0.1, 0.4]] },
      { y: [[0, 0], [0.5, 0.6], [1, 1]], hueHue: [[0.1, 0.4]] },
      { y: [[0, 0], [0.5, 0.6], [1, 1]], lumaSat: [[0.1, 0.4], [0.9, 0.6]] },
    ];
    for (const curves of lists) sigs.add(gradeSignature({ liftR: 0.3, curves }));
    expect(sigs.size).toBe(1 + GRADE_KEYS.length + lists.length);
  });

  it('reads a wheel number under the eps as zero and a neutral list as none', () => {
    expect(gradeSignature({ liftR: 0.3, liftG: 1e-6 })).toBe(gradeSignature({ liftR: 0.3 }));
    expect(gradeSignature({ liftR: 0.3, curves: { y: [[0, 0], [1, 1]] } })).toBe(gradeSignature({ liftR: 0.3 }));
  });
});

describe('gamma on black', () => {
  it('black stays black at the strongest mids', () => {
    const d = { ...neutralData(), gamma: [0.25, 0.25, 0.25] as [number, number, number] };
    expect(gradeColor([0, 0, 0], d)).toEqual([0, 0, 0]);
    expect(gradeColor([1, 1, 1], d)).toEqual([1, 1, 1]);
  });
});
