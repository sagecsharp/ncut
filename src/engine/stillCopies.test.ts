import { describe, expect, it } from 'vitest';
import { StillCopies, keptStep } from './stillCopies';

interface Cv {
  width: number;
  height: number;
  tag: string;
}
const cv = (w: number, h: number, tag = ''): Cv => ({ width: w, height: h, tag });

describe('StillCopies', () => {
  it('hits only on the same picture key, settings and asked size', () => {
    const c = new StillCopies<Cv>(8, 1e9);
    c.set('a', { srcKey: 'k', sig: 's', w: 10, h: 10, canvas: cv(10, 10), key: 'x' });
    expect(c.hit('a', 'k', 's', 10, 10)?.key).toBe('x');
    expect(c.hit('a', 'k2', 's', 10, 10)).toBeUndefined();
    expect(c.hit('a', 'k', 's2', 10, 10)).toBeUndefined();
    expect(c.hit('a', 'k', 's', 11, 10)).toBeUndefined();
    expect(c.hit('a', 'k', 's', 10, 11)).toBeUndefined();
    expect(c.hit('b', 'k', 's', 10, 10)).toBeUndefined();
  });
  it('gives the canvas of an evicted entry back (zero size), oldest used first', () => {
    const c = new StillCopies<Cv>(2, 1e9);
    const a = cv(4, 4);
    const b = cv(4, 4);
    const d = cv(4, 4);
    c.set('a', { srcKey: 'k', sig: '', w: 1, h: 1, canvas: a, key: 'a' });
    c.set('b', { srcKey: 'k', sig: '', w: 1, h: 1, canvas: b, key: 'b' });
    // touching a makes b the oldest
    expect(c.hit('a', 'k', '', 1, 1)).toBeDefined();
    c.set('d', { srcKey: 'k', sig: '', w: 1, h: 1, canvas: d, key: 'd' });
    expect(c.size).toBe(2);
    expect(b.width).toBe(0);
    expect(b.height).toBe(0);
    expect(a.width).toBe(4);
    expect(d.width).toBe(4);
  });
  it('keeps to the pixel budget but never drops the entry just put in', () => {
    const c = new StillCopies<Cv>(10, 100);
    const a = cv(8, 8);
    const big = cv(20, 20);
    c.set('a', { srcKey: 'k', sig: '', w: 1, h: 1, canvas: a, key: 'a' });
    c.set('big', { srcKey: 'k', sig: '', w: 1, h: 1, canvas: big, key: 'big' });
    expect(a.width).toBe(0);
    expect(c.size).toBe(1);
    expect(big.width).toBe(20);
    expect(c.totalPixels).toBe(400);
  });
  it('replacing a slot gives the old canvas back unless the new entry reuses it', () => {
    const c = new StillCopies<Cv>(4, 1e9);
    const a = cv(5, 5);
    const b = cv(6, 6);
    c.set('s', { srcKey: 'k', sig: '', w: 1, h: 1, canvas: a, key: '1' });
    c.set('s', { srcKey: 'k2', sig: '', w: 1, h: 1, canvas: a, key: '2' });
    expect(a.width).toBe(5);
    expect(c.totalPixels).toBe(25);
    c.set('s', { srcKey: 'k3', sig: '', w: 1, h: 1, canvas: b, key: '3' });
    expect(a.width).toBe(0);
    expect(b.width).toBe(6);
    expect(c.totalPixels).toBe(36);
  });
  it('dropPrefix / dropWhere / clear release canvases and the pixel count', () => {
    const c = new StillCopies<Cv>(9, 1e9);
    const list = ['default|a|look', 'default|b|mask', 'export|a|look'].map((s) => {
      const canvas = cv(3, 3);
      c.set(s, { srcKey: 'k', sig: '', w: 1, h: 1, canvas, key: s });
      return canvas;
    });
    c.dropPrefix('default|');
    expect(list.map((x) => x.width)).toEqual([0, 0, 3]);
    expect(c.size).toBe(1);
    c.dropWhere((s) => s.startsWith('export'));
    expect(c.size).toBe(0);
    expect(c.totalPixels).toBe(0);
    c.set('x', { srcKey: 'k', sig: '', w: 1, h: 1, canvas: cv(2, 2), key: 'x' });
    c.clear();
    expect(c.size).toBe(0);
    expect(c.totalPixels).toBe(0);
  });
});

describe('keptStep', () => {
  const picture = { width: 100, height: 50, tag: 'picture' };
  function setup() {
    const cache = new StillCopies<Cv>(8, 1e9);
    let runs = 0;
    let copies = 0;
    let serial = 0;
    const make = (result: Cv | typeof picture) => (key = 'src', sig = 's', w = 100, h = 50) =>
      keptStep<Cv, Cv>(
        cache,
        'slot',
        key,
        sig,
        w,
        h,
        picture,
        () => {
          runs++;
          return result as Cv;
        },
        (out, reuse) => {
          copies++;
          return reuse ?? cv(out.width, out.height, 'copy');
        },
        () => `n${++serial}`,
      );
    return { cache, make, runs: () => runs, copies: () => copies };
  }
  it('a miss runs the step once and keeps a copy of the result at the result own size, later calls hit', () => {
    const t = setup();
    // the looker caps at 4096: the result is smaller than the size it was asked at, the copy has the result size
    const step = t.make(cv(40, 20, 'looker'));
    const first = step();
    expect(first.image).not.toBe(picture);
    expect((first.image as Cv).width).toBe(40);
    expect((first.image as Cv).height).toBe(20);
    expect((first.image as Cv).tag).toBe('copy');
    expect(first.key).toBe('n1');
    const again = step();
    expect(again.image).toBe(first.image);
    expect(again.key).toBe('n1');
    expect(t.runs()).toBe(1);
    expect(t.copies()).toBe(1);
  });
  it('a changed source key, setting or size runs again with a new key, reusing the canvas of the same size', () => {
    const t = setup();
    const step = t.make(cv(40, 20));
    const a = step('src', 's');
    const b = step('src', 's2');
    expect(t.runs()).toBe(2);
    expect(b.key).not.toBe(a.key);
    expect(b.image).toBe(a.image);
    step('src2', 's2');
    expect(t.runs()).toBe(3);
    step('src2', 's2', 101, 50);
    expect(t.runs()).toBe(4);
  });
  it('a step that returns the picture itself keeps no copy and passes the source key on', () => {
    const t = setup();
    const r = keptStep<Cv, Cv>(t.cache, 'slot', 'src', 's', 1, 1, picture, () => picture, () => cv(1, 1), () => 'x');
    expect(r.image).toBe(picture);
    expect(r.key).toBe('src');
    expect(t.cache.size).toBe(0);
  });
  it('no canvas to copy into: the direct result without a key', () => {
    const cache = new StillCopies<Cv>(8, 1e9);
    const out = cv(5, 5, 'direct');
    const r = keptStep<Cv, Cv>(cache, 'slot', 'src', 's', 1, 1, picture, () => out, () => null, () => 'x');
    expect(r.image).toBe(out);
    expect(r.key).toBeUndefined();
    expect(cache.size).toBe(0);
  });
  it('an empty result is not kept', () => {
    const cache = new StillCopies<Cv>(8, 1e9);
    const out = cv(0, 0);
    const r = keptStep<Cv, Cv>(cache, 'slot', 'src', 's', 1, 1, picture, () => out, () => cv(1, 1), () => 'x');
    expect(r.image).toBe(out);
    expect(r.key).toBeUndefined();
  });
});
