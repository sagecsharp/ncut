import { describe, expect, it } from 'vitest';
import { createShrinker, halvings, shrunkSize, sourceOf } from './shrink';

const at = (m: readonly number[], x: number, y: number): [number, number] => [m[0]! * x + m[1]! * y + m[2]!, m[3]! * x + m[4]! * y + m[5]!];

describe('shrunkSize', () => {
  it('scales to a height', () => {
    expect(shrunkSize(3840, 2160, 0, { height: 48 })).toEqual({ width: 85, height: 48 });
    expect(shrunkSize(1920, 1080, 180, { height: 96 })).toEqual({ width: 171, height: 96 });
  });
  it('scales to a width', () => {
    expect(shrunkSize(1920, 1080, 0, { width: 320 })).toEqual({ width: 320, height: 180 });
    expect(shrunkSize(640, 480, 0, { width: 320 })).toEqual({ width: 320, height: 240 });
  });
  it('swaps the sides of a turned file', () => {
    expect(shrunkSize(1920, 1080, 90, { height: 48 })).toEqual({ width: 27, height: 48 });
    expect(shrunkSize(1920, 1080, 270, { width: 320 })).toEqual({ width: 320, height: 569 });
  });
  it('takes both sides as given and never gives 0', () => {
    expect(shrunkSize(1920, 1080, 0, { width: 10, height: 20 })).toEqual({ width: 10, height: 20 });
    expect(shrunkSize(4000, 10, 0, { width: 20 })).toEqual({ width: 20, height: 1 });
    expect(shrunkSize(0, 0, 0, { height: 48 })).toEqual({ width: 85, height: 48 });
    expect(shrunkSize(1920, 1080, 0, {})).toEqual({ width: 1920, height: 1080 });
  });
});

describe('sourceOf', () => {
  it('is the frame itself without a turn', () => {
    const m = sourceOf(0, false);
    expect(at(m, 0, 0)).toEqual([0, 0]);
    expect(at(m, 1, 0)).toEqual([1, 0]);
    expect(at(m, 0.25, 0.75)).toEqual([0.25, 0.75]);
  });
  it('undoes a quarter turn clockwise: the top right of the picture is the top left of the frame', () => {
    const m = sourceOf(90, false);
    expect(at(m, 1, 0)).toEqual([0, 0]);
    expect(at(m, 1, 1)).toEqual([1, 0]);
    expect(at(m, 0, 1)).toEqual([1, 1]);
    expect(at(m, 0, 0)).toEqual([0, 1]);
  });
  it('undoes a half turn', () => {
    const m = sourceOf(180, false);
    expect(at(m, 1, 1)).toEqual([0, 0]);
    expect(at(m, 0, 0)).toEqual([1, 1]);
    expect(at(m, 0.25, 0.75)).toEqual([0.75, 0.25]);
  });
  it('undoes three quarters: the bottom left of the picture is the top left of the frame', () => {
    const m = sourceOf(270, false);
    expect(at(m, 0, 1)).toEqual([0, 0]);
    expect(at(m, 0, 0)).toEqual([1, 0]);
    expect(at(m, 1, 0)).toEqual([1, 1]);
    expect(at(m, 1, 1)).toEqual([0, 1]);
  });
  it('undoes the mirror first', () => {
    expect(at(sourceOf(0, true), 0, 0)).toEqual([1, 0]);
    expect(at(sourceOf(0, true), 1, 1)).toEqual([0, 1]);
    // mirrored after a quarter turn: the top LEFT of the picture is the top left of the frame
    expect(at(sourceOf(90, true), 0, 0)).toEqual([0, 0]);
    expect(at(sourceOf(90, true), 0, 1)).toEqual([1, 0]);
    expect(at(sourceOf(180, true), 0, 1)).toEqual([0, 0]);
    expect(at(sourceOf(270, true), 1, 1)).toEqual([0, 0]);
  });
  it('stays inside the frame and treats other numbers like no turn', () => {
    for (const r of [0, 90, 180, 270, 360, -90, 45]) {
      for (const f of [false, true]) {
        const m = sourceOf(r, f);
        for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]] as const) {
          const [u, v] = at(m, x, y);
          expect(u).toBeGreaterThanOrEqual(0);
          expect(u).toBeLessThanOrEqual(1);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(sourceOf(-90, false)).toEqual(sourceOf(270, false));
    expect(sourceOf(360, false)).toEqual(sourceOf(0, false));
  });
});

describe('createShrinker', () => {
  it('says no where there is no canvas (node): the caller takes the slow way', () => {
    expect(createShrinker(85, 48, 0, false)).toBeNull();
  });
});

describe('halvings', () => {
  it('is 0 while the target is at least half the frame', () => {
    expect(halvings(1920, 1080, 1920, 1080)).toBe(0);
    expect(halvings(1920, 1080, 960, 540)).toBe(0);
    expect(halvings(1920, 1080, 1000, 600)).toBe(0);
    expect(halvings(1920, 1080, 900, 1000)).toBe(0); // one side is not smaller than half
  });
  it('counts the powers of two that fit', () => {
    expect(halvings(1920, 1080, 85, 48)).toBe(4); // 22.5 times smaller: first step at 1360 x 768
    expect(halvings(3840, 2160, 85, 48)).toBe(5);
    expect(halvings(3840, 2160, 320, 180)).toBe(3);
    expect(halvings(1080, 1920, 27, 48)).toBe(5);
    expect(halvings(1920, 1080, 959, 539)).toBe(1);
  });
  it('keeps the first step smaller than the frame', () => {
    for (const [sw, sh, w, h] of [[1920, 1080, 85, 48], [3840, 2160, 85, 48], [7680, 4320, 171, 96], [640, 360, 27, 15]] as const) {
      const n = halvings(sw, sh, w, h);
      expect(w * 2 ** n).toBeLessThanOrEqual(sw);
      expect(h * 2 ** n).toBeLessThanOrEqual(sh);
      expect(w * 2 ** (n + 1) > sw || h * 2 ** (n + 1) > sh).toBe(true);
    }
  });
  it('stays inside the biggest texture', () => {
    expect(halvings(7680, 4320, 320, 180, 2048)).toBe(2);
    expect(halvings(7680, 4320, 320, 180, 100)).toBe(0);
  });
  it('gives 0 for broken sizes', () => {
    expect(halvings(0, 0, 85, 48)).toBe(0);
    expect(halvings(1920, 1080, 0, 0)).toBe(0);
    expect(halvings(Number.NaN, 1080, 85, 48)).toBe(0);
  });
});
