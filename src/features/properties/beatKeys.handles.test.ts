import { describe, expect, it } from 'vitest';
import { evalKeys } from '../../lib/anim';
import type { Keyframe, Keyframes } from '../../types';
import { loopKeysOnBeats, sameKeys, type LoopResult } from './beatKeys';

/** 120 bpm from 0: a beat every half second */
const G = { origin: 0, step: 0.5 };
const ok = (r: LoopResult | string): LoopResult => {
  if (typeof r === 'string') throw new Error(r);
  return r;
};
const samples = (from: number, to: number, n = 200): number[] => Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 0.5)) / n);

/** a custom curve that lasts exactly three beats (1.5 s) */
const round = (): Keyframe[] => [
  { t: 0, v: 0, ease: 'bezier', out: { speed: 40, influence: 0.4 } },
  { t: 0.75, v: 20, ease: 'bezier', in: { speed: 10, influence: 0.3 }, out: { speed: -20, influence: 0.4 } },
  { t: 1.5, v: 5, ease: 'linear', in: { speed: 3, influence: 0.4 } },
];
/** a custom curve that runs past the end of a round of three beats */
const long = (): Keyframe[] => [
  { t: 0, v: 0, ease: 'bezier', out: { speed: 40, influence: 0.4 } },
  { t: 1, v: 20, ease: 'bezier', in: { speed: 10, influence: 0.3 }, out: { speed: -20, influence: 0.4 } },
  { t: 2, v: 5, ease: 'linear', in: { speed: 3, influence: 0.4 } },
];

describe('loop on the beat keeps custom curves', () => {
  it('loop carries handles', () => {
    const r = ok(loopKeysOnBeats({ x: round() }, G, 3, 3, false));
    const keys = r.keys.x!;
    expect(r.rounds).toBe(2);
    // the first round has the old handles, the second the same ones 1.5 s later
    expect(keys.find((k) => k.t === 0)!.out).toEqual({ speed: 40, influence: 0.4 });
    const mid = keys.filter((k) => Math.abs(k.t - 0.75) < 1e-9 || Math.abs(k.t - 2.25) < 1e-9);
    expect(mid).toHaveLength(2);
    for (const k of mid) {
      expect(k.in).toEqual({ speed: 10, influence: 0.3 });
      expect(k.out).toEqual({ speed: -20, influence: 0.4 });
    }
    // the last key of a round steps 1 ms back to make room for the jump, so the first part of each round is the exact one
    for (const t of samples(0, 0.74)) expect(evalKeys(keys, t)).toBeCloseTo(evalKeys(round(), t), 9);
    for (const t of samples(1.5, 2.24)) expect(evalKeys(keys, t)).toBeCloseTo(evalKeys(round(), t - 1.5), 9);
  });

  it('a custom part cut at the round end is split exactly', () => {
    for (const pingPong of [true, false]) {
      const r = ok(loopKeysOnBeats({ x: long() }, G, 3, 3, pingPong));
      const keys = r.keys.x!;
      // the round ends at 1.5 inside the part 1 .. 2: one split key, not a string of straight pieces
      const cut = keys.find((k) => Math.abs(k.t - 1.5) < 1e-9 || (!pingPong && Math.abs(k.t - 1.499) < 1e-9))!;
      expect(cut).toBeDefined();
      expect(keys.filter((k) => k.t > 1 && k.t < 1.498).length).toBe(0);
      for (const t of samples(0, pingPong ? 1.49 : 0.99)) expect(evalKeys(keys, t)).toBeCloseTo(evalKeys(long(), t), 7);
    }
    // the second round of a ping pong plays that curve backwards
    const ping = ok(loopKeysOnBeats({ x: long() }, G, 3, 3, true)).keys.x!;
    for (const t of samples(1.55, 2.95)) expect(evalKeys(ping, t)).toBeCloseTo(evalKeys(long(), 3 - t), 7);
  });

  it('loop twice gives the same keys', () => {
    for (const pingPong of [false, true]) {
      for (const kf of [{ x: round() }, { x: long() }]) {
        const once = ok(loopKeysOnBeats(kf, G, 3, 3, pingPong));
        const again = ok(loopKeysOnBeats(once.keys, G, 3, 3, pingPong));
        expect(sameKeys(once.keys, again.keys)).toBe(true);
      }
    }
  });

  it('ping pong mirrors handles', () => {
    const r = ok(loopKeysOnBeats({ x: round() }, G, 3, 3, true));
    const keys = r.keys.x!;
    // time 1.5 is the seam: the key of the first round gave way, the second round starts with the old last key's in
    expect(keys.filter((k) => Math.abs(k.t - 1.5) < 1e-9)).toHaveLength(1);
    const seam = keys.find((k) => Math.abs(k.t - 1.5) < 1e-9)!;
    expect(seam.in).toEqual({ speed: 3, influence: 0.4 });
    expect(seam.out).toEqual({ speed: -3, influence: 0.4 });
    const mid = keys.find((k) => Math.abs(k.t - 2.25) < 1e-9)!;
    expect(mid.in).toEqual({ speed: 20, influence: 0.4 });
    expect(mid.out).toEqual({ speed: -10, influence: 0.3 });
    for (const t of samples(1.5, 3)) expect(evalKeys(keys, t)).toBeCloseTo(evalKeys(round(), 3 - t), 9);
  });

  it('sameKeys sees handles', () => {
    const a: Keyframes = { x: round() };
    const b: Keyframes = { x: round() };
    expect(sameKeys(a, b)).toBe(true);
    b.x![0] = { ...b.x![0]!, out: { speed: 41, influence: 0.4 } };
    expect(sameKeys(a, b)).toBe(false);
    const c: Keyframes = { x: round() };
    c.x![1] = { ...c.x![1]!, in: { speed: 10, influence: 0.31 } };
    expect(sameKeys(a, c)).toBe(false);
    const d: Keyframes = { x: round().map((k) => ({ t: k.t, v: k.v, ease: k.ease })) };
    expect(sameKeys(a, d)).toBe(false);
  });
});

describe('loop on the beat keeps a bulge between equal values', () => {
  const hump = (): Keyframe[] => [
    { t: 0, v: 0, ease: 'bezier', out: { speed: 40, influence: 1 / 3 } },
    { t: 2, v: 0, ease: 'linear', in: { speed: -40, influence: 1 / 3 } },
  ];
  it('a custom part between equal values is cut, not flattened', () => {
    const r = ok(loopKeysOnBeats({ x: hump() }, G, 2, 3, true));
    expect(r.keys.x!.length).toBeGreaterThan(1);
    expect(evalKeys(r.keys.x!, 0.5)).toBeCloseTo(evalKeys(hump(), 0.5), 6);
  });
  it('a custom part into a key that rests keeps its end handle', () => {
    const kf: Keyframe[] = [
      { t: 0, v: 0, ease: 'bezier', out: { speed: 40, influence: 0.33 } },
      { t: 1, v: 0, ease: 'linear', in: { speed: -40, influence: 0.33 } },
    ];
    const r = ok(loopKeysOnBeats({ x: kf }, G, 2, 2, false));
    expect(r.keys.x!.length).toBeGreaterThan(1);
    expect(evalKeys(r.keys.x!, 0.5)).toBeCloseTo(evalKeys(kf, 0.5), 6);
  });
  it('a ping pong round reverses a custom part after a hold', () => {
    const kf: Keyframe[] = [
      { t: 0, v: 0, ease: 'hold' },
      { t: 0.5, v: 10, ease: 'bezier', out: { speed: 10, influence: 0.5 } },
      { t: 1.5, v: 0, ease: 'linear', in: { speed: -6, influence: 0.6 } },
    ];
    const r = ok(loopKeysOnBeats({ x: kf }, G, 3, 3, true));
    const keys = r.keys.x!;
    const first = ok(loopKeysOnBeats({ x: kf }, G, 3, 3, false)).keys.x!;
    expect(keys.length).toBeGreaterThan(first.length - 1);
    expect(sameKeys(ok(loopKeysOnBeats(r.keys, G, 3, 3, true)).keys, r.keys)).toBe(true);
  });
});
