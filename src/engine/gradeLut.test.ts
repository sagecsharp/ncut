import { describe, expect, it } from 'vitest';
import type { LutTable } from '../lib/cube';
import type { Rgb3 } from '../lib/gradeMath';
import type { ClipGrade } from '../types';
import { lutBindOf, lutColor, lutUniforms, withoutLut } from './gradeLut';
import type { GradeData } from './grade';
import type { LutBind } from './gradeLut';
import { withLuts } from './lutScope';

const near = (a: Rgb3, b: Rgb3, digits = 5) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));

/** a 3d table made by hand: the function of the lattice color, red fastest */
function table3(n: number, f: (c: Rgb3) => Rgb3, extra: Partial<LutTable> = {}): LutTable {
  const data3 = new Float32Array(n * n * n * 3);
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) data3.set(f([r / (n - 1), g / (n - 1), b / (n - 1)]), ((b * n + g) * n + r) * 3);
    }
  }
  return { title: '', size3: n, data3, min3: [0, 0, 0], max3: [1, 1, 1], size1: 0, data1: new Float32Array(0), min1: [0, 0, 0], max1: [1, 1, 1], identity: false, key: 't3', ...extra };
}

/** a 1d table made by hand: one function per channel */
function table1(n: number, f: (x: number, ch: number) => number, extra: Partial<LutTable> = {}): LutTable {
  const data1 = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let ch = 0; ch < 3; ch++) data1[i * 3 + ch] = f(i / (n - 1), ch);
  return { title: '', size3: 0, data3: new Float32Array(0), min3: [0, 0, 0], max3: [1, 1, 1], size1: n, data1, min1: [0, 0, 0], max1: [1, 1, 1], identity: false, key: 't1', ...extra };
}

const bind = (table: LutTable, over: Partial<LutBind> = {}): LutBind => ({ table, mix: 1, last: false, tv: false, ...over });
const same = (c: Rgb3): Rgb3 => c;
const film = (c: Rgb3): Rgb3 => [c[0] ** 0.8, 0.95 * c[1] + 0.03, c[2] ** 1.2];

let seed = 777;
const rand = (): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const randomColor = (): Rgb3 => [rand(), rand(), rand()];

describe('lutColor', () => {
  it('identity gives the color back', () => {
    for (const n of [2, 5, 17]) {
      const b = bind(table3(n, same));
      for (let i = 0; i < 200; i++) {
        const c = randomColor();
        near(lutColor(c, b), c, 5);
      }
    }
    const b1 = bind(table1(9, (x) => x));
    for (let i = 0; i < 50; i++) {
      const c = randomColor();
      near(lutColor(c, b1), c, 5);
    }
  });

  it('lattice points are exact', () => {
    const n = 5;
    const b = bind(table3(n, film));
    for (let r = 0; r < n; r++) {
      for (let g = 0; g < n; g++) {
        for (let k = 0; k < n; k++) {
          const c: Rgb3 = [r / (n - 1), g / (n - 1), k / (n - 1)];
          near(lutColor(c, b), film(c), 5);
        }
      }
    }
  });

  it('gray stays on the diagonal', () => {
    // the same curve on all three channels, so the lattice diagonal is gray
    const b = bind(table3(9, (c) => [c[0] ** 0.7, c[1] ** 0.7, c[2] ** 0.7]));
    for (let i = 0; i <= 40; i++) {
      const v = i / 40;
      const out = lutColor([v, v, v], b);
      expect(out[1]).toBeCloseTo(out[0], 6);
      expect(out[2]).toBeCloseTo(out[0], 6);
    }
  });

  it('linear along an edge', () => {
    const n = 5;
    const f = (c: Rgb3): Rgb3 => [c[0] * c[0], c[1], c[2]];
    const b = bind(table3(n, f));
    // along red between the lattice points 0.25 and 0.5, green and blue on the lattice
    const t = 0.2;
    const red = 0.25 + t * 0.25;
    const want = 0.0625 + t * (0.25 - 0.0625);
    near(lutColor([red, 0.5, 0.25], b), [want, 0.5, 0.25], 5);
    // along blue
    near(lutColor([0.5, 0.25, 0.3], b), [0.25, 0.25, 0.3], 5);
  });

  it('no seam between tetrahedra', () => {
    const n = 4;
    // a table with no pattern at all
    const data = Array.from({ length: n * n * n }, () => randomColor());
    let at = 0;
    const b = bind(table3(n, () => data[at++]!));
    const e = 1e-7;
    for (let i = 0; i < 60; i++) {
      const base = rand() * 0.6 + 0.05;
      const q = rand() * 0.3;
      // the six walls where two fractions are equal (inside one cell, around cell origin 1/3 steps)
      const cells: Rgb3[] = [
        [base, base, q + 0.05],
        [base, q + 0.05, base],
        [q + 0.05, base, base],
        [base, q + 0.05, q + 0.05],
        [q + 0.05, base, q + 0.05],
        [q + 0.05, q + 0.05, base],
      ];
      for (const c of cells) {
        for (let k = 0; k < 3; k++) {
          const hi = [...c] as Rgb3;
          const lo = [...c] as Rgb3;
          hi[k] = c[k]! + e;
          lo[k] = c[k]! - e;
          const a = lutColor(hi, b);
          const z = lutColor(lo, b);
          for (let j = 0; j < 3; j++) expect(Math.abs(a[j]! - z[j]!)).toBeLessThan(1e-4);
        }
      }
    }
  });

  it('two points per side', () => {
    const f = (c: Rgb3): Rgb3 => [c[0] * 0.5 + 0.1, c[1] * 0.25, 1 - c[2]];
    const b = bind(table3(2, f));
    near(lutColor([0, 0, 0], b), f([0, 0, 0]));
    near(lutColor([1, 1, 1], b), f([1, 1, 1]));
    near(lutColor([1, 0, 1], b), f([1, 0, 1]));
    near(lutColor([0.4, 0.6, 0.2], b), f([0.4, 0.6, 0.2]));
  });

  it('1d per channel', () => {
    const b = bind(table1(33, (x, ch) => (ch === 0 ? x * x : ch === 1 ? 1 - x : Math.sqrt(x))));
    // the lattice points are exact, between them it is straight
    near(lutColor([0.5, 0.5, 0.25], b), [0.25, 0.5, 0.5], 5);
    const x = 0.3;
    const i = Math.floor(x * 32);
    const k = x * 32 - i;
    const lerp = (a: number, c: number) => a + (c - a) * k;
    near(lutColor([x, x, x], b), [lerp((i / 32) ** 2, ((i + 1) / 32) ** 2), lerp(1 - i / 32, 1 - (i + 1) / 32), lerp(Math.sqrt(i / 32), Math.sqrt((i + 1) / 32))], 5);
    // more than one row of 256
    const big = bind(table1(600, (x2, ch) => (ch === 0 ? x2 : ch === 1 ? x2 * 0.5 : 1 - x2)));
    near(lutColor([0.7, 0.7, 0.7], big), [0.7, 0.35, 0.3], 5);
  });

  it('1d before 3d', () => {
    const one = table1(17, (x, ch) => (ch === 0 ? Math.min(1, x * 1.3) : x * 0.9));
    const three = table3(9, film);
    const both: LutTable = { ...three, size1: one.size1, data1: one.data1, min1: one.min1, max1: one.max1, key: 'both' };
    for (let i = 0; i < 50; i++) {
      const c = randomColor();
      near(lutColor(c, bind(both)), lutColor(lutColor(c, bind(one)), bind(three)), 6);
    }
  });

  it('the domain moves the lookup', () => {
    const f = (c: Rgb3): Rgb3 => [c[0], c[1] * c[1], c[2]];
    const plain = table3(9, f);
    // the same data over the domain 0.2 to 0.8 on every channel
    const moved: LutTable = { ...plain, min3: [0.2, 0.2, 0.2], max3: [0.8, 0.8, 0.8], key: 'moved' };
    // 0.5 sits at the middle of the moved table, 0.8 at its end, below 0.2 it clamps to the first point
    near(lutColor([0.5, 0.5, 0.5], bind(moved)), f([0.5, 0.5, 0.5]), 5);
    near(lutColor([0.8, 0.8, 0.8], bind(moved)), f([1, 1, 1]), 5);
    near(lutColor([0.1, 0.1, 0.1], bind(moved)), f([0, 0, 0]), 5);
    const one = table1(9, (x) => x * x);
    const oneMoved: LutTable = { ...one, min1: [0.2, 0.2, 0.2], max1: [0.8, 0.8, 0.8], key: 'oneMoved' };
    near(lutColor([0.5, 0.5, 0.5], bind(oneMoved)), [0.25, 0.25, 0.25], 5);
  });

  it('tv scale in and out keeps identity', () => {
    const b = bind(table3(5, same), { tv: true });
    for (let i = 0; i < 100; i++) {
      const c = randomColor();
      near(lutColor(c, b), c, 5);
    }
    // a table made for 16 to 235 sees 16 to 235 where the picture has 0 to 255
    const dark = table3(2, (c) => [c[0] * 0.5, c[1] * 0.5, c[2] * 0.5]);
    const a = lutColor([0, 0, 0], bind(dark, { tv: true }));
    const lo = (16 / 255) * 0.5;
    expect(a[0]).toBeCloseTo(Math.max(0, (lo * 255 - 16) / 219), 5);
  });

  it('mix 0.5 is halfway', () => {
    const t = table3(9, film);
    for (let i = 0; i < 30; i++) {
      const c = randomColor();
      const full = lutColor(c, bind(t));
      const half = lutColor(c, bind(t, { mix: 0.5 }));
      near(half, [(c[0] + full[0]) / 2, (c[1] + full[1]) / 2, (c[2] + full[2]) / 2], 6);
    }
    near(lutColor([0.3, 0.4, 0.5], bind(t, { mix: 0 })), [0.3, 0.4, 0.5], 6);
  });

  it('input is clamped', () => {
    const b = bind(table3(9, film));
    near(lutColor([2, -1, 0.5], b), lutColor([1, 0, 0.5], b), 6);
    near(lutColor([-3, 7, 1.5], b), lutColor([0, 1, 1], b), 6);
    const out = lutColor([5, 5, 5], bind(table3(5, (c) => [c[0] * 3, c[1] * 3, c[2] * 3])));
    expect(out).toEqual([1, 1, 1]);
  });
});

describe('lutUniforms', () => {
  it('a 3d table', () => {
    const t = table3(17, same, { min3: [0, 0.1, 0.2], max3: [1, 0.9, 0.7] });
    const u = lutUniforms(bind(t, { mix: 0.25, last: true }));
    expect(u.lut).toEqual([0.25, 1, 0, 1]);
    expect(u.n).toEqual([17, 0, 0, 0]);
    expect(u.min3).toEqual([0, 0.1, 0.2]);
    expect(u.span3[0]).toBeCloseTo(16, 6);
    expect(u.span3[1]).toBeCloseTo(16 / 0.8, 6);
    expect(u.span3[2]).toBeCloseTo(16 / 0.5, 6);
    expect(u.min1).toEqual([0, 0, 0]);
    expect(u.span1).toEqual([0, 0, 0]);
  });
  it('a 1d table', () => {
    const t = table1(65, (x) => x, { min1: [0.1, 0.1, 0.1], max1: [0.9, 0.9, 0.9] });
    const u = lutUniforms(bind(t, { tv: true }));
    expect(u.lut).toEqual([1, 0, 1, 0]);
    expect(u.n).toEqual([0, 65, 1, 0]);
    expect(u.min3).toEqual([0, 0, 0]);
    expect(u.span3).toEqual([0, 0, 0]);
    expect(u.min1).toEqual([0.1, 0.1, 0.1]);
    expect(u.span1[0]).toBeCloseTo(64 / 0.8, 6);
  });
  it('both parts', () => {
    const one = table1(9, (x) => x);
    const t: LutTable = { ...table3(5, same), size1: one.size1, data1: one.data1, key: 'b' };
    const u = lutUniforms(bind(t));
    expect(u.lut[3]).toBe(1);
    expect(u.n).toEqual([5, 9, 1, 0]);
    expect(u.span3).toEqual([4, 4, 4]);
    expect(u.span1).toEqual([8, 8, 8]);
  });
});

describe('lutBindOf', () => {
  const table = table3(5, film, { key: 'film' });
  const grade = (over: Partial<NonNullable<ClipGrade['lut']>> = {}, g: ClipGrade = {}): ClipGrade => ({ ...g, lut: { media: 'm', ...over } });
  const lookup = (id: string) => (id === 'm' ? table : null);

  it('lutBindOf is null for mix 0, off, identity, no table, no scope', () => {
    expect(withLuts(lookup, () => lutBindOf(grade()))).toEqual({ table, mix: 1, last: false, tv: false });
    expect(withLuts(lookup, () => lutBindOf(grade({ mix: 0.5, last: true, tv: true })))).toEqual({ table, mix: 0.5, last: true, tv: true });
    // mix 0 and under the eps
    expect(withLuts(lookup, () => lutBindOf(grade({ mix: 0 })))).toBeNull();
    expect(withLuts(lookup, () => lutBindOf(grade({ mix: 1e-6 })))).toBeNull();
    // off, missing, no lut
    expect(withLuts(lookup, () => lutBindOf(grade({}, { off: true })))).toBeNull();
    expect(withLuts(lookup, () => lutBindOf(null))).toBeNull();
    expect(withLuts(lookup, () => lutBindOf(undefined))).toBeNull();
    expect(withLuts(lookup, () => lutBindOf({ liftR: 0.3 }))).toBeNull();
    // a media that is not there, a table that is not loaded
    expect(withLuts(lookup, () => lutBindOf(grade({ media: 'other' })))).toBeNull();
    // an identity table, a table with no part
    expect(withLuts(() => ({ ...table, identity: true }), () => lutBindOf(grade()))).toBeNull();
    expect(withLuts(() => ({ ...table, size3: 0, size1: 0 }), () => lutBindOf(grade()))).toBeNull();
    // no scope
    expect(lutBindOf(grade())).toBeNull();
  });
});

describe('withoutLut', () => {
  const lut = bind(table3(2, same));
  const data = (on: GradeData['on'], withLut: boolean): GradeData => ({
    lift: [0, 0, 0],
    gain: [1, 1, 1],
    gamma: [1, 1, 1],
    offset: [0, 0, 0],
    on,
    tone: [0, 0, 0, 0],
    table: null,
    key: '',
    ...(withLut ? { lut } : {}),
  });
  it('takes the lut key off and keeps the rest', () => {
    const out = withoutLut(data([1, 0, 0, 1], true));
    expect(out).toStrictEqual(data([1, 0, 0, 1], false));
    expect('lut' in out!).toBe(false);
  });
  it('is null for a lut only grade', () => {
    expect(withoutLut(data([0, 0, 0, 1], true))).toBeNull();
  });
});
