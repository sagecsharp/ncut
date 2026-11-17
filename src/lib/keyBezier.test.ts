import { describe, expect, it } from 'vitest';
import type { Easing, KeyHandle, Keyframe } from '../types';
import { applyEasing } from './anim';
import {
  BACK_OUT,
  INFLUENCE_EASY,
  INFLUENCE_MIN,
  SPEED_MAX,
  bezierSpeed,
  bezierValue,
  cleanHandle,
  collapseKeys,
  easeKeys,
  easeSlope,
  handlesOf,
  hasHandles,
  isJoined,
  mergeSameTime,
  mirrorHandles,
  partHandles,
  partSpeed,
  sameHandle,
  sameHandles,
  scaleHandleTimes,
  scaleHandleValues,
  solveBezierX,
  speedAt,
  splitBezierAt,
  tidyHandles,
  toBezier,
  twinHandles,
  withHandles,
  withNamedEase,
} from './keyBezier';

const k = (t: number, v: number, ease: Easing = 'linear', extra: Partial<Keyframe> = {}): Keyframe => ({ t, v, ease, ...extra });
const h = (speed: number, influence: number): KeyHandle => ({ speed, influence });
const NAMED: Easing[] = ['linear', 'ease', 'ease-in', 'ease-out', 'back'];

describe('solveBezierX', () => {
  it('inverts x for 9 x 9 influence pairs and 200 u', () => {
    const infl = [0.001, 0.05, 0.2, 1 / 3, 0.5, 0.7, 0.9, 0.99, 1];
    for (const x1 of infl) {
      for (const i2 of infl) {
        const x2 = 1 - i2;
        const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
        for (let n = 1; n < 200; n++) {
          const u = n / 200;
          const s = solveBezierX(x1, x2, u);
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(1);
          expect(Math.abs(((ax * s + bx) * s + cx) * s - u)).toBeLessThan(1e-9);
        }
      }
    }
  });
  it('is exact at the ends', () => {
    expect(solveBezierX(0.3, 0.6, 0)).toBe(0);
    expect(solveBezierX(0.3, 0.6, -1)).toBe(0);
    expect(solveBezierX(0.3, 0.6, 1)).toBe(1);
    expect(solveBezierX(0.3, 0.6, 2)).toBe(1);
  });
});

describe('twins', () => {
  it('match the five exact eases within 1e-9', () => {
    for (const ease of NAMED) {
      const a = k(2, 10, ease), b = k(6, -30);
      const tw = twinHandles(ease, a, b);
      const ca = k(2, 10, 'bezier', { out: tw.out });
      const cb = k(6, -30, 'linear', { in: tw.in });
      for (let n = 0; n <= 100; n++) {
        const t = 2 + (4 * n) / 100;
        const want = a.v + (b.v - a.v) * applyEasing(ease, (t - a.t) / 4);
        expect(Math.abs(bezierValue(ca, cb, t) - want)).toBeLessThan(1e-9);
      }
    }
  });
  it('give the stored handles for a custom part and the chord for a missing side', () => {
    const a = k(0, 0, 'bezier', { out: h(5, 0.5) }), b = k(2, 4);
    const tw = twinHandles('bezier', a, b);
    expect(tw.out).toEqual(h(5, 0.5));
    expect(tw.in).toEqual(h(2, INFLUENCE_EASY));
  });
  it('partHandles is null for hold, bounce and elastic and has hasHandles', () => {
    for (const e of ['hold', 'bounce', 'elastic'] as Easing[]) {
      expect(partHandles(k(0, 0, e), k(1, 1))).toBeNull();
      expect(hasHandles(e)).toBe(false);
    }
    for (const e of [...NAMED, 'bezier' as Easing]) expect(hasHandles(e)).toBe(true);
    expect(partHandles(k(0, 0, 'back'), k(1, 1))!.out.speed).toBe(BACK_OUT);
  });
});

describe('speed', () => {
  it('at the keys equals the handles', () => {
    const a = k(0, 0, 'bezier', { out: h(3, 0.4) }), b = k(2, 5, 'linear', { in: h(-1.5, 0.25) });
    expect(Math.abs(bezierSpeed(a, b, 0) - 3)).toBeLessThan(1e-6);
    expect(Math.abs(bezierSpeed(a, b, 2) - -1.5)).toBeLessThan(1e-6);
    expect(Math.abs(speedAt([a, b], 0) - 3)).toBeLessThan(1e-6);
    expect(Math.abs(speedAt([a, b], 2) - -1.5)).toBeLessThan(1e-6);
  });
  it('speedAt is 0 under two keys, outside the keys and on a part of no length', () => {
    expect(speedAt([], 0)).toBe(0);
    expect(speedAt([k(0, 1)], 0)).toBe(0);
    expect(speedAt([k(0, 0), k(1, 1)], -1)).toBe(0);
    expect(speedAt([k(0, 0), k(1, 1)], 2)).toBe(0);
    expect(speedAt([k(0, 0), k(0.00005, 1)], 0)).toBe(0);
  });
  it('speedAt is 0 where a custom part is clamped to a range', () => {
    const a = k(0, 0, 'bezier', { out: h(40, 1) }), b = k(1, 1, 'linear', { in: h(-40, 1) });
    const keys = [a, b];
    expect(speedAt(keys, 0.5)).not.toBe(0);
    expect(speedAt(keys, 0.5, { lo: 0, hi: 1 })).toBe(0);
  });
  it('easeSlope matches a finite difference', () => {
    const eases: Easing[] = ['linear', 'ease', 'ease-in', 'ease-out', 'back', 'bounce', 'elastic', 'hold'];
    for (const e of eases) {
      for (let n = 1; n < 100; n++) {
        const u = n / 100;
        const d = 1e-6;
        // skip the jumps of bounce and the hold step
        const lo = applyEasing(e, u - d), hi = applyEasing(e, u + d);
        if (Math.abs(hi - lo) > 0.5) continue;
        const fd = (hi - lo) / (2 * d);
        expect(Math.abs(easeSlope(e, u) - fd)).toBeLessThan(1e-4 * Math.max(1, Math.abs(fd)));
      }
    }
    expect(easeSlope('bezier', 0.3)).toBe(1);
  });
  it('partSpeed is the chord times the slope for a named ease', () => {
    const a = k(0, 0, 'ease'), b = k(2, 4);
    expect(partSpeed(a, b, 1)).toBeCloseTo(2 * 1.5, 12);
  });
});

describe('splitBezierAt', () => {
  it('keeps the line within the solver tolerance', () => {
    const keys = [k(0, 0, 'bezier', { out: h(4, 0.6) }), k(3, 5, 'linear', { in: h(-2, 0.35) })];
    const split = splitBezierAt(keys, 1.1)!;
    expect(split).toHaveLength(3);
    expect(split[1]!.t).toBe(1.1);
    expect(split[1]!.ease).toBe('bezier');
    for (let n = 0; n <= 300; n++) {
      const t = (3 * n) / 300;
      const old = bezierValue(keys[0]!, keys[1]!, t);
      const j = t < 1.1 ? 0 : 1;
      expect(Math.abs(bezierValue(split[j]!, split[j + 1]!, t) - old)).toBeLessThan(5e-8);
    }
  });
  it('is null for a named part, near a key and outside', () => {
    expect(splitBezierAt([k(0, 0), k(1, 1)], 0.5)).toBeNull();
    const c = [k(0, 0, 'bezier'), k(1, 1)];
    expect(splitBezierAt(c, 0.00005)).toBeNull();
    expect(splitBezierAt(c, 0.99995)).toBeNull();
    expect(splitBezierAt(c, 2)).toBeNull();
    expect(splitBezierAt(c, 0.5)).not.toBeNull();
  });
});

describe('easeKeys', () => {
it('easy on two equal keys still gives ease', () => {    const r = easeKeys([k(0, 5), k(1, 5)], [0, 1], 'easy');    expect(r.keys[0]!.ease).toBe('ease');  });
  it('easy on two linear keys gives exactly ease', () => {
    const r = easeKeys([k(0, 0), k(1, 10)], [0, 1], 'easy');
    expect(r.keys).toEqual([k(0, 0, 'ease'), k(1, 10)]);
    expect(r.holds).toBe(0);
  });
  it('into only eases the side arriving, outOf the side leaving', () => {
    const keys = [k(0, 0), k(1, 10), k(2, 0)];
    const into = easeKeys(keys, [1], 'into').keys;
    expect(into[0]!.ease).toBe('bezier');
    expect(into[1]!.in).toEqual(h(0, INFLUENCE_EASY));
    expect(into[1]!.ease).toBe('linear');
    const out = easeKeys(keys, [1], 'outOf').keys;
    expect(out[0]!.ease).toBe('linear');
    expect(out[1]!.ease).toBe('bezier');
    expect(out[1]!.out).toEqual(h(0, INFLUENCE_EASY));
  });
  it('keeps a hold and counts the picked keys that had one', () => {
    const keys = [k(0, 0, 'hold'), k(1, 10), k(2, 0)];
    const r = easeKeys(keys, [0, 1], 'easy');
    expect(r.holds).toBe(2);
    expect(r.keys[0]!.ease).toBe('hold');
    const none = easeKeys([k(0, 0, 'hold'), k(1, 1)], [0], 'easy');
    expect(none.holds).toBe(1);
    expect(none.keys).toEqual([k(0, 0, 'hold'), k(1, 1)]);
  });
  it('far ends keep their shape', () => {
    const keys = [k(0, 0, 'ease'), k(1, 10, 'linear'), k(2, 0)];
    const r = easeKeys(keys, [1], 'outOf').keys;
    expect(r[0]!.ease).toBe('ease');
    expect(r[1]!.ease).toBe('bezier');
  });
});

describe('mirror, scale and merge', () => {
  it('mirrorHandles swaps and negates exactly', () => {
    const key = k(1, 2, 'bezier', { in: h(3, 0.2), out: h(-4, 0.7) });
    const m = mirrorHandles(key);
    expect(m.in).toEqual(h(4, 0.7));
    expect(m.out).toEqual(h(-3, 0.2));
    expect(mirrorHandles(m)).toEqual(key);
    const zero = mirrorHandles(k(0, 0, 'bezier', { out: h(0, 0.5) }));
    expect(Object.is(zero.in!.speed, 0)).toBe(true);
    expect(zero.out).toBeUndefined();
    const bare = k(0, 0);
    expect(mirrorHandles(bare)).toBe(bare);
  });
  it('scaleHandleTimes divides speeds, scaleHandleValues multiplies them', () => {
    const key = k(1, 2, 'bezier', { in: h(4, 0.2), out: h(-8, 0.7) });
    expect(scaleHandleTimes(key, 2).in).toEqual(h(2, 0.2));
    expect(scaleHandleTimes(key, 2).out).toEqual(h(-4, 0.7));
    expect(scaleHandleValues(key, 0.5).out).toEqual(h(-4, 0.7));
    expect(scaleHandleTimes(key, 0)).toBe(key);
    expect(scaleHandleTimes(key, Number.NaN)).toBe(key);
    const bare = k(0, 0);
    expect(scaleHandleTimes(bare, 3)).toBe(bare);
    expect(scaleHandleValues(bare, 3)).toBe(bare);
  });
  it('handlesOf spreads only the handles', () => {
    expect(handlesOf(k(0, 0))).toEqual({});
    expect(handlesOf(k(0, 0, 'bezier', { out: h(1, 0.5) }))).toEqual({ out: h(1, 0.5) });
  });
  it('mergeSameTime keeps the earlier in and the later v, ease and out', () => {
    const early = k(1, 1, 'bezier', { in: h(1, 0.3), out: h(9, 0.9) });
    const late = k(1, 5, 'ease', { in: h(7, 0.7), out: h(2, 0.2) });
    expect(mergeSameTime(early, late)).toEqual({ t: 1, v: 5, ease: 'ease', in: h(1, 0.3), out: h(2, 0.2) });
    expect(mergeSameTime(k(1, 1), k(1, 2, 'linear', { in: h(7, 0.7) }))).toEqual(k(1, 2));
  });
  it('sameHandle and sameHandles compare by value', () => {
    expect(sameHandle(undefined, undefined)).toBe(true);
    expect(sameHandle(h(1, 0.5), undefined)).toBe(false);
    expect(sameHandle(h(1, 0.5), h(1, 0.5))).toBe(true);
    expect(sameHandle(h(1, 0.5), h(1, 0.6))).toBe(false);
    expect(sameHandles(k(0, 0), k(1, 1))).toBe(true);
    expect(sameHandles(k(0, 0, 'bezier', { out: h(1, 0.5) }), k(0, 0))).toBe(false);
  });
});

describe('collapseKeys and joins', () => {
  it('names a twin back for each of the five eases', () => {
    for (const ease of NAMED) {
      const a = k(0, 3, ease), b = k(2, 9);
      const tw = twinHandles(ease, a, b);
      const out = collapseKeys([k(0, 3, 'bezier', { out: tw.out }), k(2, 9, 'linear', { in: tw.in })]);
      expect(out[0]!.ease).toBe(ease);
      expect('out' in out[0]!).toBe(false);
      expect('in' in out[1]!).toBe(false);
    }
  });
  it('leaves a real custom part alone', () => {
    const keys = [k(0, 0, 'bezier', { out: h(2, 0.5) }), k(1, 1, 'linear', { in: h(0, 0.33) })];
    expect(collapseKeys(keys)[0]!.ease).toBe('bezier');
  });
  it('isJoined compares the speeds in and out of a middle key', () => {
    const keys = [k(0, 0, 'bezier', { out: h(1, 0.4) }), k(1, 1, 'bezier', { in: h(2, 0.4), out: h(2, 0.4) }), k(2, 0)];
    expect(isJoined(keys, 1)).toBe(true);
    const apart = [keys[0]!, { ...keys[1]!, out: h(3, 0.4) }, keys[2]!];
    expect(isJoined(apart, 1)).toBe(false);
    expect(isJoined(keys, 0)).toBe(false);
    expect(isJoined(keys, 2)).toBe(false);
    expect(isJoined([k(0, 0, 'hold'), k(1, 1), k(2, 2)], 1)).toBe(false);
  });
});

describe('stored form', () => {
  it('cleanHandle gives the same object when clean and a clamped copy when not', () => {
    const ok = h(5, 0.5);
    expect(cleanHandle(ok)).toBe(ok);
    expect(cleanHandle(h(5, 5))).toEqual(h(5, 1));
    expect(cleanHandle(h(5, 0))).toEqual(h(5, INFLUENCE_MIN));
    expect(cleanHandle(h(1e12, 0.5))).toEqual(h(SPEED_MAX, 0.5));
    expect(cleanHandle(h(-1e12, 0.5))).toEqual(h(-SPEED_MAX, 0.5));
    expect(cleanHandle({ speed: 1, influence: 0.5, extra: 1 })).toEqual(h(1, 0.5));
  });
  it('cleanHandle drops junk', () => {
    for (const junk of [null, undefined, 4, 'x', {}, { speed: 1 }, { speed: Number.NaN, influence: 0.5 }, { speed: 1, influence: Infinity }, { speed: '1', influence: 0.5 }]) {
      expect(cleanHandle(junk)).toBeUndefined();
    }
  });
  it('tidyHandles keeps out only on a custom key with a next and in only after a custom key', () => {
    const keys = [k(0, 0, 'linear', { out: h(1, 0.5) }), k(1, 1, 'bezier', { in: h(1, 0.5), out: h(1, 0.5) }), k(2, 2, 'bezier', { in: h(1, 0.5), out: h(1, 0.5) })];
    const t = tidyHandles(keys);
    expect('out' in t[0]!).toBe(false);
    expect('in' in t[1]!).toBe(false);
    expect(t[1]!.out).toEqual(h(1, 0.5));
    expect(t[2]!.in).toEqual(h(1, 0.5));
    expect('out' in t[2]!).toBe(false);
  });
  it('tidyHandles gives the same array when clean and never writes undefined', () => {
    const clean = [k(0, 0), k(1, 1, 'ease')];
    expect(tidyHandles(clean)).toBe(clean);
    const dirty = [{ ...k(0, 0), in: undefined } as Keyframe, k(1, 1)];
    const t = tidyHandles(dirty);
    expect('in' in t[0]!).toBe(false);
    const junk = [k(0, 0, 'bezier', { out: { speed: Number.NaN, influence: 0.5 } }), k(1, 1)];
    expect('out' in tidyHandles(junk)[0]!).toBe(false);
    expect(Object.keys(tidyHandles([k(0, 0, 'bezier', { out: h(1, 2) }), k(1, 1, 'linear', { in: h(1, 0.5) })])[0]!)).toEqual(['t', 'v', 'ease', 'out']);
  });
  it('toBezier makes the twin of a named part and leaves a custom one and the last key', () => {
    const keys = [k(0, 0, 'ease-in'), k(2, 4)];
    const r = toBezier(keys, 0);
    expect(r[0]!.ease).toBe('bezier');
    expect(r[0]!.out).toEqual(h(0, INFLUENCE_EASY));
    expect(r[1]!.in).toEqual(h(6, INFLUENCE_EASY));
    expect(toBezier(r, 0)).toBe(r);
    expect(toBezier(keys, 1)).toBe(keys);
    expect(keys[0]!.ease).toBe('ease-in');
  });
  it('withHandles sets, replaces and removes a side', () => {
    const keys = [k(0, 0), k(1, 1), k(2, 0)];
    const r = withHandles(keys, 1, { out: h(2, 0.5), in: h(2, 0.4) });
    expect(r[0]!.ease).toBe('bezier');
    expect(r[1]!.ease).toBe('bezier');
    expect(r[1]!.in).toEqual(h(2, 0.4));
    expect(r[1]!.out).toEqual(h(2, 0.5));
    const gone = withHandles(r, 1, { out: null });
    expect('out' in gone[1]!).toBe(false);
    const clamped = withHandles(keys, 0, { out: h(1, 9) });
    expect(clamped[0]!.out).toEqual(h(1, 1));
    // the last key has no out and the first no in
    expect(withHandles(keys, 2, { out: h(1, 0.5) })).toEqual(keys);
    expect(withHandles(keys, 0, { in: h(1, 0.5) })).toEqual(keys);
  });
  it('withNamedEase sets a name and drops the handles, bezier turns into the twin', () => {
    const keys = [k(0, 0, 'bezier', { out: h(5, 0.5) }), k(1, 1, 'linear', { in: h(5, 0.5) })];
    const named = withNamedEase(keys, 0, 'ease-in');
    expect(named).toEqual([k(0, 0, 'ease-in'), k(1, 1)]);
    const lin = withNamedEase([k(0, 0), k(2, 4)], 0, 'bezier');
    expect(lin[0]!.ease).toBe('bezier');
    expect(lin[0]!.out).toEqual(h(2, INFLUENCE_EASY));
    expect(withNamedEase([k(0, 0), k(1, 1)], 1, 'bezier')[1]!.ease).toBe('bezier');
    expect('out' in withNamedEase([k(0, 0), k(1, 1)], 1, 'bezier')[1]!).toBe(false);
  });
});

describe('junk never gives NaN', () => {
  it('bezierValue and bezierSpeed with broken handles', () => {
    const bad = [h(Number.NaN, 0.5), h(Infinity, 0.5), h(1, Number.NaN), h(1e300, 0), h(-1e300, 5)];
    for (const o of bad) {
      for (const i of bad) {
        const a = k(0, 0, 'bezier', { out: o }), b = k(1, 1, 'linear', { in: i });
        for (let n = 0; n <= 20; n++) {
          const t = n / 20;
          expect(Number.isFinite(bezierValue(a, b, t))).toBe(true);
          expect(Number.isFinite(bezierSpeed(a, b, t))).toBe(true);
          expect(Number.isFinite(partSpeed(a, b, t))).toBe(true);
        }
      }
    }
  });
  it('both influences at 1 still solve and stay finite', () => {
    const a = k(0, 0, 'bezier', { out: h(3, 1) }), b = k(1, 1, 'linear', { in: h(3, 1) });
    for (let n = 0; n <= 100; n++) {
      expect(Number.isFinite(bezierValue(a, b, n / 100))).toBe(true);
      expect(Number.isFinite(bezierSpeed(a, b, n / 100))).toBe(true);
    }
  });
  it('twins of a part of no length stay finite', () => {
    const tw = twinHandles('linear', k(1, 0), k(1, 5));
    expect(Number.isFinite(tw.out.speed)).toBe(true);
  });
});
