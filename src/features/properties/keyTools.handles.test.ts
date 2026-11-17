import { describe, expect, it } from 'vitest';
import { evalKeys } from '../../lib/anim';
import type { Keyframe } from '../../types';
import { fitKeys, normalizeKeys, repeatKeys, reverseKeys, wiggleOnto } from './keyTools';

/** a custom curve over 4 s: two custom parts and a straight one, handles that are not the twin of any named ease */
const curve = (): Keyframe[] => [
  { t: 0, v: 0, ease: 'bezier', out: { speed: 50, influence: 0.4 } },
  { t: 2, v: 100, ease: 'bezier', in: { speed: 20, influence: 0.3 }, out: { speed: -30, influence: 0.5 } },
  { t: 4, v: 40, ease: 'linear', in: { speed: -10, influence: 0.35 } },
];

const samples = (from: number, to: number, n = 200): number[] => Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 0.5)) / n);

describe('key tools keep custom curves', () => {
  it('fitKeys scales speeds', () => {
    const out = fitKeys({ x: curve() }, 0, 8).x!;
    expect(out.map((k) => k.t)).toEqual([0, 4, 8]);
    expect(out[0]!.out).toEqual({ speed: 25, influence: 0.4 });
    expect(out[1]!.in).toEqual({ speed: 10, influence: 0.3 });
    expect(out[1]!.out).toEqual({ speed: -15, influence: 0.5 });
    expect(out[2]!.in).toEqual({ speed: -5, influence: 0.35 });
    for (const t of samples(0, 8)) expect(evalKeys(out, t)).toBeCloseTo(evalKeys(curve(), t / 2), 7);
    // a squeeze the other way multiplies them
    const quick = fitKeys({ x: curve() }, 1, 3).x!;
    expect(quick[0]!.out!.speed).toBeCloseTo(100, 7);
    for (const t of samples(1, 3)) expect(evalKeys(quick, t)).toBeCloseTo(evalKeys(curve(), (t - 1) * 2), 7);
  });

  it('repeatKeys multiplies speeds and mirrors flips', () => {
    const plain = repeatKeys({ x: curve() }, 2, false).x!;
    expect(plain[0]!.out!.speed).toBeCloseTo(100, 7);
    // the last key of a pass steps 1 ms back to make room for the jump, so only the first part of it is exact
    for (const t of samples(0, 1, 100)) expect(evalKeys(plain, t)).toBeCloseTo(evalKeys(curve(), t * 2), 7);
    for (const t of samples(2, 3.99, 100)) expect(evalKeys(plain, t)).toBeCloseTo(evalKeys(curve(), (t - 2) * 2), 7);
    const ping = repeatKeys({ x: curve() }, 2, true).x!;
    for (const t of samples(0, 1.99, 100)) expect(evalKeys(ping, t)).toBeCloseTo(evalKeys(curve(), t * 2), 7);
    // the second pass plays backwards: time 2 + u shows what the curve shows at 4 - 2u
    for (const t of samples(2.001, 3.99, 100)) expect(evalKeys(ping, t)).toBeCloseTo(evalKeys(curve(), 8 - t * 2), 7);
  });

  it('reverseKeys mirrors custom parts exactly', () => {
    const out = reverseKeys({ x: curve() }).x!;
    expect(out.map((k) => k.t)).toEqual([0, 2, 4]);
    expect(out[0]!.ease).toBe('bezier');
    expect(out[0]!.out).toEqual({ speed: 10, influence: 0.35 });
    expect(out[1]!.ease).toBe('bezier');
    expect(out[1]!.in).toEqual({ speed: 30, influence: 0.5 });
    expect(out[1]!.out).toEqual({ speed: -20, influence: 0.3 });
    expect(out[2]!.in).toEqual({ speed: -50, influence: 0.4 });
    for (const t of samples(0, 4)) expect(evalKeys(out, t)).toBeCloseTo(evalKeys(curve(), 4 - t), 7);
  });

  it('wiggleOnto splits custom parts before shaking', () => {
    const still = [0, 0.5, 1.3, 2.5, 3.2, 4].map((t): Keyframe => ({ t, v: 0, ease: 'ease' }));
    const out = wiggleOnto(curve(), still, 4)!;
    expect(out.map((k) => k.t)).toEqual([0, 0.5, 1.3, 2, 2.5, 3.2, 4]);
    // without a shake the curve is the old one
    for (const t of samples(0, 4)) expect(evalKeys(out, t)).toBeCloseTo(evalKeys(curve(), t), 6);
    // the keys inside the two custom parts are custom keys with handles
    for (const i of [1, 2, 4]) {
      expect(out[i]!.ease).toBe('bezier');
      expect(out[i]!.in).toBeDefined();
      expect(out[i]!.out).toBeDefined();
    }
    // a shake moves the split keys by its value at their time
    const shaken = [0, 0.5, 1.3, 2.5, 3.2, 4].map((t): Keyframe => ({ t, v: t === 0.5 ? 7 : t === 1.3 ? -4 : 0, ease: 'ease' }));
    const moved = wiggleOnto(curve(), shaken, 4)!;
    expect(moved[1]!.v).toBeCloseTo(evalKeys(curve(), 0.5) + 7, 7);
    expect(moved[2]!.v).toBeCloseTo(evalKeys(curve(), 1.3) - 4, 7);
  });

  it('wiggleOnto turns a last custom key smooth when keys come after it', () => {
    const old: Keyframe[] = [
      { t: 0, v: 0, ease: 'bezier', out: { speed: 30, influence: 0.3 } },
      { t: 1, v: 10, ease: 'bezier', in: { speed: 5, influence: 0.3 } },
    ];
    const out = wiggleOnto(old, [{ t: 0, v: 0, ease: 'ease' }, { t: 2, v: 3, ease: 'ease' }, { t: 3, v: 0, ease: 'ease' }], 3)!;
    expect(out.map((k) => k.t)).toEqual([0, 1, 2, 3]);
    expect(out[1]!.ease).toBe('ease');
    expect(out[1]!.out).toBeUndefined();
  });

  it('normalizeKeys keeps the earlier in', () => {
    const keys: Keyframe[] = [
      { t: 0, v: 0, ease: 'bezier', out: { speed: 1, influence: 0.3 } },
      { t: 1, v: 5, ease: 'bezier', in: { speed: 7, influence: 0.2 }, out: { speed: 2, influence: 0.4 } },
      { t: 1.0004, v: 6, ease: 'bezier', in: { speed: 9, influence: 0.9 }, out: { speed: 3, influence: 0.6 } },
      { t: 3, v: 8, ease: 'linear', in: { speed: 4, influence: 0.5 } },
    ];
    const out = normalizeKeys(keys);
    expect(out).toHaveLength(3);
    expect(out[1]).toStrictEqual({ t: 1.0004, v: 6, ease: 'bezier', in: { speed: 7, influence: 0.2 }, out: { speed: 3, influence: 0.6 } });
    // the result is in stored form: a side that has no part is gone
    const bare = normalizeKeys([{ t: 0, v: 0, ease: 'ease', out: { speed: 1, influence: 0.3 } }, { t: 1, v: 1, ease: 'ease', in: { speed: 1, influence: 0.3 } }]);
    expect(bare).toStrictEqual([{ t: 0, v: 0, ease: 'ease' }, { t: 1, v: 1, ease: 'ease' }]);
  });

  it('keys without handles come back without fields', () => {
    const plain: Keyframe[] = [
      { t: 0, v: 0, ease: 'ease-in' },
      { t: 1, v: 10, ease: 'linear' },
      { t: 2, v: 4, ease: 'ease' },
    ];
    expect(reverseKeys({ x: plain }).x).toStrictEqual([
      { t: 0, v: 4, ease: 'linear' },
      { t: 1, v: 10, ease: 'ease-out' },
      { t: 2, v: 0, ease: 'ease-out' },
    ]);
    expect(fitKeys({ x: plain }, 0, 4).x).toStrictEqual([
      { t: 0, v: 0, ease: 'ease-in' },
      { t: 2, v: 10, ease: 'linear' },
      { t: 4, v: 4, ease: 'ease' },
    ]);
    expect(normalizeKeys(plain)).toStrictEqual(plain);
    const rep = repeatKeys({ x: plain }, 2, true).x!;
    for (const k of rep) expect(Object.keys(k)).toEqual(['t', 'v', 'ease']);
    const wig = wiggleOnto(plain, [{ t: 0.5, v: 1, ease: 'ease' }], 2)!;
    for (const k of wig) expect(Object.keys(k)).toEqual(['t', 'v', 'ease']);
  });
});
