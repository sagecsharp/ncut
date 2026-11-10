import { describe, expect, it } from 'vitest';
import { EASINGS, evalKeys } from '../../lib/anim';
import type { Easing, Keyframe, Keyframes } from '../../types';
import { MAX_WIGGLE_KEYS, MIN_GAP, fitKeys, hash01, keySpan, mirrorEase, normalizeKeys, repeatKeys, reverseKeys, shiftKeys, wiggleKeys } from './keyTools';

const k = (t: number, v: number, ease: Easing = 'linear'): Keyframe => ({ t, v, ease });

function spaced(keys: Keyframe[]): boolean {
  for (let i = 1; i < keys.length; i++) if (keys[i]!.t - keys[i - 1]!.t < MIN_GAP - 1e-9) return false;
  return true;
}

describe('normalizeKeys', () => {
  it('sorts and merges keys closer than 1 ms, later wins', () => {
    const out = normalizeKeys([k(2, 5), k(1, 1), k(1.0004, 9)]);
    expect(out.map((x) => x.t)).toEqual([1.0004, 2]);
    expect(out[0]!.v).toBe(9);
  });
  it('keeps keys exactly 1 ms apart', () => {
    expect(normalizeKeys([k(1, 0), k(1.001, 1)])).toHaveLength(2);
  });
});

describe('reverseKeys', () => {
  it('mirrors times inside the span of all keys', () => {
    const kf: Keyframes = { x: [k(1, 0), k(3, 10)], y: [k(2, 5), k(4, 7)] };
    const r = reverseKeys(kf);
    expect(r.x!.map((q) => q.t)).toEqual([2, 4]);
    expect(r.y!.map((q) => q.t)).toEqual([1, 3]);
    expect(r.x!.map((q) => q.v)).toEqual([10, 0]);
  });
  it('does not mutate', () => {
    const kf: Keyframes = { x: [k(0, 0, 'ease-in'), k(1, 1)] };
    const copy = structuredClone(kf);
    reverseKeys(kf);
    expect(kf).toEqual(copy);
  });
  it('reversing twice gives back the original', () => {
    const kf: Keyframes = { x: [k(0.5, 0, 'ease-in'), k(1.5, 4, 'back'), k(3, 2, 'ease-out'), k(4, 9, 'bounce')] };
    const back = reverseKeys(reverseKeys(kf));
    expect(back.x!.map((q) => q.t.toFixed(9))).toEqual(kf.x!.map((q) => q.t.toFixed(9)));
    expect(back.x!.map((q) => q.v)).toEqual(kf.x!.map((q) => q.v));
    // the ease of the last key is unused, the rest must come back
    expect(back.x!.slice(0, -1).map((q) => q.ease)).toEqual(kf.x!.slice(0, -1).map((q) => q.ease));
  });
  it('plays the same values backwards for the symmetric eases', () => {
    for (const ease of ['linear', 'ease', 'ease-in', 'ease-out'] as Easing[]) {
      const orig = [k(1, 2, ease), k(2.5, 8, ease), k(4, -3, ease), k(5, 1, ease)];
      const rev = reverseKeys({ p: orig }).p!;
      for (let i = 0; i <= 80; i++) {
        const t = 1 + (4 * i) / 80;
        expect(evalKeys(rev, 6 - t)).toBeCloseTo(evalKeys(orig, t), 9);
      }
    }
  });
  it('mixed symmetric eases per segment still mirror exactly', () => {
    const orig = [k(0, 0, 'ease-in'), k(1, 5, 'ease'), k(2, 1, 'ease-out'), k(3, 4)];
    const rev = reverseKeys({ p: orig }).p!;
    for (let i = 0; i <= 60; i++) {
      const t = (3 * i) / 60;
      expect(evalKeys(rev, 3 - t)).toBeCloseTo(evalKeys(orig, t), 9);
    }
  });
  it('every ease kind: the ease travels with its segment and endpoints match', () => {
    for (const { id } of EASINGS) {
      const orig = [k(1, 0, id), k(3, 10, 'linear')];
      const rev = reverseKeys({ p: orig }).p!;
      expect(rev[0]!.ease).toBe(mirrorEase(id));
      expect(evalKeys(rev, 1)).toBe(10);
      expect(evalKeys(rev, 3)).toBe(0);
      expect(spaced(rev)).toBe(true);
    }
  });
  it('single key moves to the mirrored time; empty input gives empty', () => {
    expect(reverseKeys({ x: [k(2, 1)], y: [k(0, 0), k(4, 4)] }).x![0]!.t).toBe(2);
    expect(reverseKeys({})).toEqual({});
    expect(reverseKeys({ x: [] })).toEqual({});
  });
});

describe('fitKeys', () => {
  it('scales first..last onto from..to', () => {
    const r = fitKeys({ x: [k(1, 0), k(2, 1), k(3, 2)], y: [k(1, 0), k(3, 5)] }, 0, 10);
    expect(r.x!.map((q) => q.t)).toEqual([0, 5, 10]);
    expect(r.y!.map((q) => q.t)).toEqual([0, 10]);
  });
  it('a single key moves to from', () => {
    expect(fitKeys({ x: [k(2, 1)] }, 3, 9).x![0]!.t).toBe(3);
  });
  it('keeps values and eases', () => {
    const r = fitKeys({ x: [k(1, 7, 'back'), k(2, 8)] }, 0, 1);
    expect(r.x![0]).toEqual({ t: 0, v: 7, ease: 'back' });
  });
  it('keys collapse safely into a tiny span', () => {
    const r = fitKeys({ x: [k(0, 0), k(1, 1), k(2, 2)] }, 0, 0.0005);
    expect(spaced(r.x!)).toBe(true);
  });
});

describe('shiftKeys', () => {
  const kf: Keyframes = { x: [k(1, 0), k(2, 1)], y: [k(1.5, 3)] };
  it('moves everything by dt', () => {
    const r = shiftKeys(kf, 0.5, 0, 10);
    expect(r.x!.map((q) => q.t)).toEqual([1.5, 2.5]);
    expect(r.y![0]!.t).toBe(2);
  });
  it('stops as a block at max and at min, not squashed', () => {
    const r = shiftKeys(kf, 100, 0, 5);
    expect(r.x!.map((q) => q.t)).toEqual([4, 5]);
    expect(r.y![0]!.t).toBe(4.5);
    const l = shiftKeys(kf, -100, 0, 5);
    expect(l.x!.map((q) => q.t)).toEqual([0, 1]);
    expect(l.y![0]!.t).toBe(0.5);
  });
});

describe('repeatKeys', () => {
  it('repeats the pattern twice inside the same span', () => {
    const kf: Keyframes = { x: [k(0, 0), k(2, 10)] };
    const r = repeatKeys(kf, 2, false).x!;
    expect(keySpan({ x: r })).toEqual({ lo: 0, hi: 2 });
    expect(evalKeys(r, 0.25)).toBeCloseTo(evalKeys(kf.x!, 0.5), 1);
    expect(evalKeys(r, 0.75)).toBeCloseTo(evalKeys(kf.x!, 1.5), 1);
    expect(evalKeys(r, 1.25)).toBeCloseTo(evalKeys(kf.x!, 0.5), 2);
  });
  it('jumps back at the seam within 1 ms', () => {
    const r = repeatKeys({ x: [k(0, 0), k(2, 10)] }, 2, false).x!;
    expect(spaced(r)).toBe(true);
    expect(evalKeys(r, 1 - 0.002)).toBeGreaterThan(9.9);
    expect(evalKeys(r, 1 + 0.001)).toBeLessThan(0.5);
  });
  it('no jump key when the pattern already loops', () => {
    const r = repeatKeys({ x: [k(0, 5), k(1, 9), k(2, 5)] }, 2, false).x!;
    expect(r.map((q) => q.v)).toEqual([5, 9, 5, 9, 5]);
  });
  it('ping pong has no jump at the seams', () => {
    const r = repeatKeys({ x: [k(0, 0), k(2, 10)] }, 2, true).x!;
    expect(evalKeys(r, 1)).toBe(10);
    expect(evalKeys(r, 0.999)).toBeCloseTo(9.99, 1);
    expect(evalKeys(r, 1.001)).toBeCloseTo(9.99, 1);
    expect(evalKeys(r, 2)).toBe(0);
    expect(spaced(r)).toBe(true);
  });
  it('three passes of ping pong end where they should', () => {
    const r = repeatKeys({ x: [k(0, 0), k(3, 6)] }, 3, true).x!;
    expect(evalKeys(r, 3)).toBe(6);
    expect(evalKeys(r, 1)).toBe(6);
    expect(evalKeys(r, 2)).toBe(0);
  });
  it('times < 2 changes nothing; input is not mutated', () => {
    const kf: Keyframes = { x: [k(0, 0), k(2, 10)] };
    const copy = structuredClone(kf);
    expect(repeatKeys(kf, 1, false)).toEqual(kf);
    repeatKeys(kf, 3, true);
    expect(kf).toEqual(copy);
  });
  it('a property that does not span everything stays valid', () => {
    const r = repeatKeys({ x: [k(0, 0), k(4, 1)], y: [k(1, 3), k(2, 8)] }, 2, false);
    expect(spaced(r.y!)).toBe(true);
    expect(spaced(r.x!)).toBe(true);
  });
});

describe('wiggleKeys', () => {
  const opts = { amount: 10, perSecond: 4, from: 0, to: 5, seed: 7 };
  it('is deterministic per seed and differs between seeds', () => {
    expect(wiggleKeys(3, opts)).toEqual(wiggleKeys(3, opts));
    expect(wiggleKeys(3, opts)).not.toEqual(wiggleKeys(3, { ...opts, seed: 8 }));
  });
  it('starts and ends at rest, stays within amount, uses smooth ease', () => {
    const r = wiggleKeys(3, opts);
    expect(r).toHaveLength(21);
    expect(r[0]).toEqual({ t: 0, v: 3, ease: 'ease' });
    expect(r[r.length - 1]).toEqual({ t: 5, v: 3, ease: 'ease' });
    for (const q of r) {
      expect(Math.abs(q.v - 3)).toBeLessThanOrEqual(10 + 1e-9);
      expect(q.ease).toBe('ease');
    }
    expect(r.some((q) => q.v !== 3)).toBe(true);
    expect(spaced(r)).toBe(true);
  });
  it('caps the key count', () => {
    expect(wiggleKeys(0, { ...opts, perSecond: 12, to: 1000 }).length).toBeLessThanOrEqual(MAX_WIGGLE_KEYS);
  });
  it('degenerate span gives one key', () => {
    expect(wiggleKeys(2, { ...opts, from: 1, to: 1 })).toEqual([{ t: 1, v: 2, ease: 'ease' }]);
  });
  it('hash stays in 0..1', () => {
    for (let i = 0; i < 500; i++) {
      const h = hash01(i * 31, i);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });
});
