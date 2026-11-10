import { describe, expect, it } from 'vitest';
import { evalKeys } from '../../lib/anim';
import type { Easing, Keyframe } from '../../types';
import { MAX_KEYS_PER_PROP, MIN_GAP, repeatKeys, repeatTooBig, reverseKeys } from './keyTools';

const k = (t: number, v: number, ease: Easing = 'linear'): Keyframe => ({ t, v, ease });

describe('repeatKeys, again and again', () => {
  it('a second repeat keeps the jumps of the first: four saw teeth, not two ramps with holds', () => {
    const once = repeatKeys({ x: [k(0, 0), k(1, 10)] }, 2, false);
    const twice = repeatKeys(once, 2, false);
    const keys = twice.x!;
    // every tooth climbs to the peak: just before each quarter the value is close to 10
    for (const q of [0.25, 0.5, 0.75]) {
      expect(evalKeys(keys, q - 0.004)).toBeGreaterThan(9);
      expect(evalKeys(keys, q + 0.004)).toBeLessThan(1);
    }
    expect(evalKeys(keys, 0.125)).toBeGreaterThan(3);
    expect(evalKeys(keys, 0.125)).toBeLessThan(7);
    for (let i = 1; i < keys.length; i++) expect(keys[i]!.t - keys[i - 1]!.t).toBeGreaterThanOrEqual(MIN_GAP - 1e-9);
  });

  it('a property with one key is left alone', () => {
    const out = repeatKeys({ x: [k(0, 0), k(2, 10)], y: [k(1, 5)] }, 2, false);
    expect(out.y).toEqual([k(1, 5)]);
    expect(out.x!.length).toBeGreaterThan(2);
  });

  it('never grows a property past the cap', () => {
    const many: Keyframe[] = Array.from({ length: 130 }, (_, i) => k(i * 0.05, i % 2));
    expect(repeatTooBig({ x: many }, 2)).toBe(true);
    expect(repeatKeys({ x: many }, 2, false).x).toHaveLength(130);
    expect(repeatTooBig({ x: [k(0, 0), k(1, 1)] }, 2)).toBe(false);
    let kf = { x: [k(0, 0), k(1, 1)] };
    for (let i = 0; i < 12; i++) kf = repeatKeys(kf, 2, false) as typeof kf;
    expect(kf.x.length).toBeLessThanOrEqual(MAX_KEYS_PER_PROP);
  });
});

describe('reverseKeys with keys outside the clip', () => {
  it('mirrors inside the clip, so what is visible plays backwards', () => {
    // the right half of a split: 2 s long, keys of the whole old animation at -2 .. 2
    const kf = { x: [k(-2, 0), k(0, 20), k(2, 40)] };
    const out = reverseKeys(kf, 2);
    for (const t of [0, 0.5, 1, 1.5, 2]) expect(evalKeys(out.x!, t)).toBeCloseTo(evalKeys(kf.x, 2 - t), 6);
  });

  it('keys inside the clip mirror in their own span as before', () => {
    const kf = { x: [k(0.5, 0), k(1.5, 10)] };
    expect(reverseKeys(kf, 4).x!.map((q) => [q.t, q.v])).toEqual([
      [0.5, 10],
      [1.5, 0],
    ]);
    expect(reverseKeys(kf).x!.map((q) => q.t)).toEqual([0.5, 1.5]);
  });
});
