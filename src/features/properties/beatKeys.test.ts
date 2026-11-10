import { describe, expect, it } from 'vitest';
import { evalKeys } from '../../lib/anim';
import type { Keyframe, Keyframes } from '../../types';
import { fitKeysToBeats, loopKeysOnBeats, loopRounds, sameKeys, snapKeysToGrid, startBeat, type LoopResult } from './beatKeys';

const lin = (...pairs: [number, number][]): Keyframe[] => pairs.map(([t, v]) => ({ t, v, ease: 'linear' as const }));
const tv = (keys: Keyframe[] | undefined) => (keys ?? []).map((k) => [+k.t.toFixed(6), +k.v.toFixed(6)]);
/** 120 bpm from 0: a beat every half second */
const G = { origin: 0, step: 0.5 };
const ok = (r: LoopResult | string): LoopResult => {
  if (typeof r === 'string') throw new Error(r);
  return r;
};
const pickStep = (r: number) => [0.125, 0.25, 0.37, 0.5, 1][Math.floor(r * 5)]!;
const frozen = (kf: Keyframes): Keyframes => {
  for (const p of Object.keys(kf)) {
    for (const k of kf[p]!) Object.freeze(k);
    Object.freeze(kf[p]);
  }
  return Object.freeze(kf);
};

describe('snapKeysToGrid', () => {
  it('every key goes to the nearest beat', () => {
    const r = snapKeysToGrid({ x: lin([0.07, 1], [0.46, 2], [1.2, 3]) }, G, 1, 4);
    expect(tv(r.keys.x)).toEqual([[0, 1], [0.5, 2], [1, 3]]);
    expect(r.moved).toBe(3);
    expect(r.stayed).toBe(0);
  });

  it('half and quarter beats', () => {
    expect(tv(snapKeysToGrid({ x: lin([0.3, 1], [0.8, 2]) }, G, 2, 4).keys.x)).toEqual([[0.25, 1], [0.75, 2]]);
    expect(tv(snapKeysToGrid({ x: lin([0.1, 1], [0.4, 2]) }, G, 4, 4).keys.x)).toEqual([[0.125, 1], [0.375, 2]]);
  });

  it('two keys that want one line: the nearest gets it, the other stays, none is lost', () => {
    const r = snapKeysToGrid({ x: lin([0.4, 1], [0.55, 2], [0.6, 3]) }, G, 1, 4);
    expect(tv(r.keys.x)).toEqual([[0.4, 1], [0.5, 2], [0.6, 3]]);
    expect(r.moved).toBe(1);
    expect(r.stayed).toBe(2);
  });

  it('keys on the beat already do not count as moved', () => {
    const r = snapKeysToGrid({ x: lin([0, 1], [0.5, 2]) }, G, 1, 4);
    expect(r.moved).toBe(0);
    expect(tv(r.keys.x)).toEqual([[0, 1], [0.5, 2]]);
  });

  it('never leaves the clip: a key whose line is outside stays', () => {
    // beats at 0.3 + k * 0.5: the nearest to 0.02 is -0.2, the nearest to 1.95 is 1.8 (inside), to 1.1 is 1.3
    const r = snapKeysToGrid({ x: lin([0.02, 1], [1.1, 2], [1.95, 3]) }, { origin: 0.3, step: 0.5 }, 1, 2);
    expect(tv(r.keys.x)).toEqual([[0.02, 1], [1.3, 2], [1.8, 3]]);
    for (const k of r.keys.x!) expect(k.t >= 0 && k.t <= 2).toBe(true);
  });

  it('a key that would land within 1 ms of a key that stays is left alone: none is lost', () => {
    const r = snapKeysToGrid({ x: lin([0.9994, 1], [1.0006, 2]) }, { origin: 0, step: 1 }, 1, 10);
    expect(tv(r.keys.x)).toEqual([[0.9994, 1], [1.0006, 2]]);
    expect(r.moved).toBe(0);
    expect(r.stayed).toBe(2);
    let s = 99;
    const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 4294967296);
    for (let run = 0; run < 3000; run++) {
      const n = 2 + Math.floor(rand() * 6);
      const keys: Keyframe[] = [];
      let t = rand() * 0.3;
      for (let i = 0; i < n; i++) {
        keys.push({ t, v: i, ease: 'linear' });
        t += 0.001 + (rand() < 0.4 ? rand() * 0.002 : rand() * 0.4);
      }
      const out = snapKeysToGrid({ x: keys }, { origin: rand(), step: pickStep(rand()) }, [1, 2, 4][Math.floor(rand() * 3)]!, 3).keys.x!;
      expect(out.map((k) => k.v)).toEqual(keys.map((k) => k.v));
      for (let i = 1; i < out.length; i++) expect(out[i]!.t - out[i - 1]!.t).toBeGreaterThan(0.00099);
    }
  });

  it('each value on its own, eases kept, input untouched', () => {
    const kf = frozen({ x: [{ t: 0.07, v: 1, ease: 'ease-in' }, { t: 0.9, v: 2, ease: 'hold' }], opacity: lin([0.6, 0.5]) });
    const r = snapKeysToGrid(kf, G, 1, 4);
    expect(r.keys.x).toEqual([{ t: 0, v: 1, ease: 'ease-in' }, { t: 1, v: 2, ease: 'hold' }]);
    expect(tv(r.keys.opacity)).toEqual([[0.5, 0.5]]);
  });

  it('a broken grid moves nothing', () => {
    for (const g of [{ origin: 0, step: 0 }, { origin: NaN, step: 0.5 }, { origin: 0, step: NaN }, { origin: 0, step: 0.0005 }]) {
      const r = snapKeysToGrid({ x: lin([0.07, 1], [0.46, 2]) }, g, 1, 4);
      expect(tv(r.keys.x)).toEqual([[0.07, 1], [0.46, 2]]);
      expect(r.moved).toBe(0);
    }
  });
});

describe('startBeat', () => {
  it('the nearest beat inside the clip', () => {
    expect(startBeat(G, 0.2, 4)).toBe(0);
    expect(startBeat(G, 0.3, 4)).toBe(0.5);
    expect(startBeat({ origin: 0.3, step: 0.5 }, 0, 4)).toBeCloseTo(0.3, 9);
    // the nearest one is past the end: the last one inside
    expect(startBeat(G, 3.9, 3.8)).toBe(3.5);
  });

  it('null when no beat falls inside', () => {
    expect(startBeat({ origin: 0.3, step: 0.5 }, 0, 0.2)).toBeNull();
    expect(startBeat({ origin: 0, step: 0 }, 0, 4)).toBeNull();
    expect(startBeat(G, 0, 0)).toBeNull();
  });
});

describe('fitKeysToBeats', () => {
  it('stretches the whole animation to the beats, from the nearest beat', () => {
    const r = fitKeysToBeats({ x: lin([0.1, 0], [0.4, 50], [0.7, 100]), y: lin([0.4, 7]) }, G, 4, 10);
    if (typeof r === 'string') throw new Error(r);
    expect(r.from).toBe(0);
    expect(r.to).toBe(2);
    expect(tv(r.keys.x)).toEqual([[0, 0], [1, 50], [2, 100]]);
    expect(tv(r.keys.y)).toEqual([[1, 7]]);
  });

  it('squeezes too, half a beat', () => {
    const r = fitKeysToBeats({ x: lin([1.05, 0], [3, 100]) }, G, 0.5, 10);
    if (typeof r === 'string') throw new Error(r);
    expect(tv(r.keys.x)).toEqual([[1, 0], [1.25, 100]]);
  });

  it('says why it cannot', () => {
    expect(fitKeysToBeats({}, G, 4, 10)).toBe('no keys');
    expect(fitKeysToBeats({ x: lin([1, 5]) }, G, 4, 10)).toBe('one moment');
    expect(fitKeysToBeats({ x: lin([0, 0], [1, 1]) }, { origin: 0.3, step: 0.5 }, 4, 0.2)).toBe('no beat');
    expect(fitKeysToBeats({ x: lin([0, 0], [1, 1]) }, { origin: 0, step: 0 }, 4, 10)).toBe('no beat');
  });
});

describe('loopKeysOnBeats', () => {
  it('counts the rounds', () => {
    expect(loopRounds(0, 1, 4)).toBe(4);
    expect(loopRounds(0, 1, 2.5)).toBe(3);
    expect(loopRounds(0.5, 1, 4)).toBe(4);
    expect(loopRounds(0, 8, 2)).toBe(1);
  });

  it('repeats the first beats until the clip ends, jumping back at the seam', () => {
    const r = ok(loopKeysOnBeats({ x: lin([0, 0], [0.5, 100]) }, G, 2, 4, false));
    expect(r.from).toBe(0);
    expect(r.period).toBe(1);
    expect(r.rounds).toBe(4);
    expect(tv(r.keys.x)).toEqual([[0, 0], [0.5, 100], [1, 0], [1.5, 100], [2, 0], [2.5, 100], [3, 0], [3.5, 100]]);
    const x = r.keys.x!;
    for (let round = 0; round < 4; round++) {
      expect(evalKeys(x, round + 0.25)).toBeCloseTo(50, 6);
      expect(evalKeys(x, round + 0.5)).toBeCloseTo(100, 6);
      // rests on its last value until the next round starts
      expect(evalKeys(x, round + 0.75)).toBeCloseTo(100, 6);
      expect(evalKeys(x, round + 0.999)).toBeCloseTo(100, 6);
    }
    expect(evalKeys(x, 1)).toBe(0);
  });

  it('moves the animation onto the nearest beat without stretching it', () => {
    const r = ok(loopKeysOnBeats({ x: lin([0.6, 0], [0.9, 100]) }, G, 1, 2, false));
    expect(r.from).toBe(0.5);
    expect(tv(r.keys.x)).toEqual([[0.5, 0], [0.8, 100], [1, 0], [1.3, 100], [1.5, 0], [1.8, 100]]);
  });

  it('ping pong plays every second round backwards, nothing jumps', () => {
    const r = ok(loopKeysOnBeats({ x: lin([0, 0], [0.5, 100]) }, G, 2, 4, true));
    expect(tv(r.keys.x)).toEqual([[0, 0], [0.5, 100], [1.5, 100], [2, 0], [2.5, 100], [3.5, 100], [4, 0]]);
    const x = r.keys.x!;
    expect(evalKeys(x, 0.25)).toBeCloseTo(50, 6);
    expect(evalKeys(x, 1.25)).toBeCloseTo(100, 6);
    expect(evalKeys(x, 1.75)).toBeCloseTo(50, 6);
    expect(evalKeys(x, 2.25)).toBeCloseTo(50, 6);
    // continuous: no two keys 1 ms apart with different values
    for (let i = 1; i < x.length; i++) if (x[i]!.t - x[i - 1]!.t < 0.01) expect(x[i]!.v).toBe(x[i - 1]!.v);
  });

  it('ping pong mirrors the eases', () => {
    const r = ok(loopKeysOnBeats({ x: [{ t: 0, v: 0, ease: 'ease-in' }, { t: 1, v: 100, ease: 'linear' }] }, G, 2, 2, true));
    expect(r.keys.x).toEqual([
      { t: 0, v: 0, ease: 'ease-in' },
      { t: 1, v: 100, ease: 'ease-out' },
      { t: 2, v: 0, ease: 'linear' },
    ]);
    const x = r.keys.x!;
    // the way back is the way there, mirrored in time
    for (const d of [0.1, 0.3, 0.5, 0.8]) expect(evalKeys(x, 2 - d)).toBeCloseTo(evalKeys(x, d), 6);
  });

  it('a curve that runs past the round is cut at the value it has there', () => {
    const r = ok(loopKeysOnBeats({ x: lin([0, 0], [2, 200]) }, G, 2, 3, false));
    expect(tv(r.keys.x)).toEqual([[0, 0], [0.999, 100], [1, 0], [1.999, 100], [2, 0], [2.999, 100]]);
    expect(evalKeys(r.keys.x!, 1.5)).toBeCloseTo(50, 0);
  });

  it('the last round is kept whole where it runs past the end of the clip', () => {
    const r = ok(loopKeysOnBeats({ x: lin([0, 0], [1, 100]) }, G, 2, 2.5, true));
    expect(r.rounds).toBe(3);
    expect(tv(r.keys.x)).toEqual([[0, 0], [1, 100], [2, 0], [3, 100]]);
    expect(evalKeys(r.keys.x!, 2.5)).toBeCloseTo(50, 6);
  });

  it('a round that ends inside a curve follows the curve, not a squeezed copy of its ease', () => {
    for (const ease of ['ease-out', 'ease-in', 'ease', 'back', 'bounce', 'elastic'] as const) {
      const keys: Keyframe[] = [{ t: 0, v: -4, ease }, { t: 2.32, v: 2, ease: 'linear' }];
      for (const pp of [false, true]) {
        const r = ok(loopKeysOnBeats({ x: keys }, { origin: 0, step: 1 }, 2, 8, pp));
        const x = r.keys.x!;
        // a few straight pieces follow the curve: within 2 % of the 6 it travels (the squeezed ease was 11 % off)
        const tol = ease === 'bounce' || ease === 'elastic' ? 0.3 : 0.12;
        for (let u = 0.01; u < 1.99; u += 0.0173) {
          expect(Math.abs(evalKeys(x, u) - evalKeys(keys, u))).toBeLessThan(tol);
          // every round is that same piece of the curve (backwards in every second one with ping pong)
          expect(Math.abs(evalKeys(x, 2 + (pp ? 2 - u : u)) - evalKeys(keys, u))).toBeLessThan(tol);
        }
      }
    }
  });

  it('a step keeps its values when it plays backwards', () => {
    // 0 held, then 5 held, then 2: backwards that is 2, then 5, then 0, each for as long as it was held
    const keys: Keyframe[] = [{ t: 0, v: 0, ease: 'hold' }, { t: 0.4, v: 5, ease: 'hold' }, { t: 0.8, v: 2, ease: 'linear' }];
    const x = ok(loopKeysOnBeats({ x: keys }, G, 2, 4, true)).keys.x!;
    const first = (u: number) => evalKeys(keys, u);
    for (const u of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      expect(evalKeys(x, u)).toBe(first(u));
      expect(evalKeys(x, 2 - u)).toBe(first(u));
      expect(evalKeys(x, 2 + u)).toBe(first(u));
    }
  });

  it('the key on a seam is the one that starts the next round, whatever the float noise', () => {
    // a -> b -> a over exactly one round, on grids where round end and next round start differ in the last bit
    for (const [origin, step, dur] of [[3.35231093224138, 0.4411, 6.560331330613941], [-2.792894479352981, 0.37, 5.047391886396333], [0.1, 0.3, 7], [1 / 3, 0.7, 9.1]] as const) {
      const grid = { origin: origin - 3, step };
      for (const pp of [false, true]) {
        const start = startBeat(grid, 0.02, dur)!;
        const P = 2 * step;
        const keys: Keyframe[] = [{ t: start, v: 0, ease: 'ease-in' }, { t: start + P / 2, v: 3, ease: 'ease-out' }, { t: start + P, v: 0, ease: 'linear' }];
        const r = ok(loopKeysOnBeats({ x: keys }, grid, 2, dur, pp));
        const x = r.keys.x!;
        // the same number of keys in every round: no seam kept both, none lost both
        expect(x.length).toBe(2 * r.rounds + 1);
        for (let i = 0; i + 1 < x.length; i++) expect(x[i]!.ease).toBe(i % 2 === 0 ? 'ease-in' : 'ease-out');
        for (let round = 0; round < r.rounds; round++) {
          for (const u of [0.13, 0.31, 0.5, 0.77, 0.9]) {
            const want = evalKeys(keys, start + u * P);
            expect(evalKeys(x, start + (round + u) * P)).toBeCloseTo(want, 6);
          }
        }
      }
    }
  });

  it('plays what a brute force loop of the first round plays (fuzz)', () => {
    let s = 12345;
    const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 4294967296);
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
    const eases = ['linear', 'ease', 'ease-in', 'ease-out'] as const;
    let checked = 0;
    for (let run = 0; run < 1500; run++) {
      const grid = { origin: rand() * 8 - 4, step: 0.2 + rand() * 0.7 };
      const beats = pick([0.5, 1, 2, 4]);
      const duration = 0.5 + rand() * 11;
      const pp = rand() < 0.5;
      const period = beats * grid.step;
      // keys inside one round (the cut of a longer curve is approximate and has its own test)
      const lo = rand() * 3;
      const kf: Keyframes = {};
      for (const prop of ['x', 'y', 'z'].slice(0, 1 + Math.floor(rand() * 3))) {
        const n = 2 + Math.floor(rand() * 4);
        // a key less than 1 ms from the edge of a round merges with its mirror image there: not what is tested here
        const times = Array.from({ length: n }, () => lo + 0.004 + rand() * (period * 0.98 - 0.008)).sort((a, b) => a - b);
        if (prop === 'x') times[0] = lo;
        const keys: Keyframe[] = [];
        for (const t of times) if (keys.length === 0 || t - keys[keys.length - 1]!.t > 0.03) keys.push({ t, v: Math.round(rand() * 10 - 5), ease: pick(eases) });
        if (keys.length >= 2) kf[prop] = keys;
      }
      if (!kf.x) continue;
      const r = loopKeysOnBeats(kf, grid, beats, duration, pp);
      if (typeof r === 'string') {
        expect(['no beat', 'too many']).toContain(r);
        continue;
      }
      expect(Math.abs(r.from - startBeat(grid, lo, duration)!)).toBeLessThan(1e-9);
      for (const prop of Object.keys(kf)) {
        const src = kf[prop]!.map((k) => ({ ...k, t: k.t - lo + r.from }));
        const got = r.keys[prop]!;
        expect(got.length).toBeLessThanOrEqual(240);
        for (let i = 1; i < got.length; i++) expect(got[i]!.t - got[i - 1]!.t).toBeGreaterThan(0.0009);
        const end = Math.min(duration, r.from + r.rounds * period);
        for (let q = 0; q < 40; q++) {
          const t = r.from + rand() * (end - r.from);
          // a jump takes 1 ms: not compared right at a key
          if (got.some((k) => Math.abs(k.t - t) < 0.0025)) continue;
          const round = Math.floor((t - r.from) / period);
          const u = t - r.from - round * period;
          if (u < 0.0025 || u > period - 0.0025) continue;
          const want = evalKeys(src, r.from + (pp && round % 2 === 1 ? period - u : u));
          expect(Math.abs(evalKeys(got, t) - want)).toBeLessThan(1e-6);
          checked++;
        }
      }
      // pressed again: the same keys
      const again = ok(loopKeysOnBeats(r.keys, grid, beats, duration, pp));
      expect(sameKeys(again.keys, r.keys)).toBe(true);
      // and what the other button makes of it is what it makes of the original
      const other = loopKeysOnBeats(r.keys, grid, beats, duration, !pp);
      const direct = loopKeysOnBeats(kf, grid, beats, duration, !pp);
      if (typeof other !== 'string' && typeof direct !== 'string') {
        for (const prop of Object.keys(direct.keys)) {
          for (let q = 0; q < 12; q++) {
            const t = r.from + rand() * (Math.min(duration, r.from + r.rounds * period) - r.from);
            const u = (t - r.from) % period;
            if (u < 0.004 || u > period - 0.004 || direct.keys[prop]!.some((k) => Math.abs(k.t - t) < 0.004) || other.keys[prop]!.some((k) => Math.abs(k.t - t) < 0.004)) continue;
            expect(Math.abs(evalKeys(other.keys[prop]!, t) - evalKeys(direct.keys[prop]!, t))).toBeLessThan(1e-6);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(20000);
  });

  it('each value loops on its own, a value with one key keeps it', () => {
    const r = ok(loopKeysOnBeats({ x: lin([0, 0], [0.5, 10]), y: lin([0.25, 5], [0.5, 9]), opacity: lin([0.3, 0.4]) }, G, 1, 1.5, false));
    expect(tv(r.keys.x)).toEqual([[0, 0], [0.499, 10], [0.5, 0], [0.999, 10], [1, 0], [1.499, 10]]);
    // y starts later in the round: it holds its first value from the start of every later round
    expect(tv(r.keys.y)).toEqual([[0.25, 5], [0.499, 9], [0.5, 5], [0.75, 5], [0.999, 9], [1, 5], [1.25, 5], [1.499, 9]]);
    expect(tv(r.keys.opacity)).toEqual([[0.3, 0.4]]);
  });

  it('a value that only moves after the first round holds what it shows there', () => {
    const r = ok(loopKeysOnBeats({ x: lin([0, 0], [0.5, 10]), y: lin([3, 7], [3.5, 9]) }, G, 1, 4, true));
    expect(tv(r.keys.y)).toEqual([[0, 7]]);
  });

  it('running it on its own result changes nothing', () => {
    const cases: Keyframes[] = [
      { x: lin([0, 0], [0.5, 100]) },
      { x: lin([0, 0], [2, 200]) },
      { x: lin([0.1, 0], [0.4, 50], [0.7, 20]), y: lin([0.3, 1], [0.9, 2]) },
      { x: [{ t: 0, v: 0, ease: 'ease-in' }, { t: 0.6, v: 30, ease: 'back' }, { t: 1, v: 0, ease: 'linear' }] },
      { x: lin([0, 0], [0.5, 100], [0.75, 0]), y: lin([0.25, 5], [0.5, 9]) },
      { x: lin([0, 0], [1, 100]), y: lin([0.2, 3], [0.6, 3]) },
      { x: [{ t: 0, v: 0, ease: 'hold' }, { t: 0.5, v: 100, ease: 'hold' }] },
    ];
    for (const kf of cases) {
      for (const pp of [false, true]) {
        for (const dur of [4, 3, 2.5, 3.2, 0.7]) {
          const once = ok(loopKeysOnBeats(kf, G, 2, dur, pp));
          const twice = ok(loopKeysOnBeats(once.keys, G, 2, dur, pp));
          expect(twice.keys).toEqual(once.keys);
        }
      }
    }
  });

  it('an edit of the first round is carried into every round', () => {
    const once = ok(loopKeysOnBeats({ x: lin([0, 0], [0.5, 100]) }, G, 2, 4, false));
    // the last key of the first round goes from 100 to 200, the first one from 0 to 40
    const edited: Keyframes = { x: once.keys.x!.map((k, i) => (i === 1 ? { ...k, v: 200 } : i === 0 ? { ...k, v: 40 } : k)) };
    const again = ok(loopKeysOnBeats(edited, G, 2, 4, false));
    expect(tv(again.keys.x)).toEqual([[0, 40], [0.5, 200], [1, 40], [1.5, 200], [2, 40], [2.5, 200], [3, 40], [3.5, 200]]);
    const x = again.keys.x!;
    for (let round = 0; round < 4; round++) {
      expect(evalKeys(x, round + 0.25)).toBeCloseTo(120, 6);
      expect(evalKeys(x, round + 0.9995)).toBeCloseTo(200, 6);
    }
  });

  it('loop then ping pong plays what ping pong alone plays, and back', () => {
    const kf: Keyframes = { x: lin([0, 0], [0.5, 100]) };
    const pp = ok(loopKeysOnBeats(kf, G, 2, 4, true)).keys.x!;
    const loop = ok(loopKeysOnBeats(kf, G, 2, 4, false)).keys.x!;
    const loopThenPp = ok(loopKeysOnBeats({ x: loop }, G, 2, 4, true)).keys.x!;
    const ppThenLoop = ok(loopKeysOnBeats({ x: pp }, G, 2, 4, false)).keys.x!;
    for (let t = 0; t < 4; t += 0.0373) {
      expect(evalKeys(loopThenPp, t)).toBeCloseTo(evalKeys(pp, t), 6);
      // 1 ms before a seam the two may differ: the jump is a moment earlier in one of them
      if (t % 1 < 0.998) expect(evalKeys(ppThenLoop, t)).toBeCloseTo(evalKeys(loop, t), 6);
    }
  });

  it('a loop over more beats of a looped animation plays the same', () => {
    const two = ok(loopKeysOnBeats({ x: lin([0, 0], [0.5, 100]) }, G, 2, 8, false)).keys.x!;
    const four = ok(loopKeysOnBeats({ x: two }, G, 4, 8, false)).keys.x!;
    for (let t = 0; t < 8; t += 0.0411) if (t % 1 < 0.998) expect(evalKeys(four, t)).toBeCloseTo(evalKeys(two, t), 6);
  });

  it('a 1 ms step loops, and loops again', () => {
    for (const lo of [0.924, 0.93202475405743, 2.0995]) {
      const kf: Keyframes = { x: [{ t: lo, v: 3.8, ease: 'hold' }, { t: lo + 0.001, v: 1.5, ease: 'ease' }] };
      for (const pp of [false, true]) {
        const once = loopKeysOnBeats(kf, G, 3, 1.49, pp);
        if (typeof once === 'string') continue;
        const again = ok(loopKeysOnBeats(once.keys, G, 3, 1.49, pp));
        expect(sameKeys(again.keys, once.keys)).toBe(true);
        expect(typeof loopKeysOnBeats(once.keys, G, 3, 1.49, !pp)).toBe('object');
      }
    }
  });

  it('a held value that runs past the round needs no end key, and a second run agrees', () => {
    const kf: Keyframes = { x: [{ t: 0.2256, v: 9.5, ease: 'hold' }, { t: 1.2276, v: 7.4, ease: 'ease-in' }] };
    const once = ok(loopKeysOnBeats(kf, { origin: 0, step: 0.25 }, 4, 1.15, false));
    expect(tv(once.keys.x)).toEqual([[0.25, 9.5]]);
    const two: Keyframes = { x: [{ t: 0, v: 1, ease: 'hold' }, { t: 0.3, v: 5, ease: 'hold' }, { t: 1.4, v: 2, ease: 'linear' }] };
    for (const pp of [false, true]) {
      const a = ok(loopKeysOnBeats(two, G, 2, 4, pp));
      expect(sameKeys(ok(loopKeysOnBeats(a.keys, G, 2, 4, pp)).keys, a.keys)).toBe(true);
      for (const u of [0.1, 0.5, 0.9]) expect(evalKeys(a.keys.x!, u)).toBe(u < 0.3 ? 1 : 5);
    }
  });

  it('says why it cannot', () => {
    expect(loopKeysOnBeats({}, G, 2, 4, false)).toBe('no keys');
    expect(loopKeysOnBeats({ x: lin([1, 5]) }, G, 2, 4, false)).toBe('one moment');
    expect(loopKeysOnBeats({ x: lin([0, 0], [1, 1]) }, { origin: 0.3, step: 0.5 }, 2, 0.2, false)).toBe('no beat');
    expect(loopKeysOnBeats({ x: lin([0, 0], [1, 1]) }, { origin: 0, step: 0.001 }, 1, 4, false)).toBe('no beat');
    expect(loopKeysOnBeats({ x: lin([0, 0], [0.2, 1], [0.4, 0]) }, G, 1, 100, false)).toBe('too many');
  });

  it('never hands back more keys than a value may have, and never touches its input', () => {
    const kf = frozen({ x: lin([0, 0], [0.1, 1], [0.2, 0], [0.3, 1]), y: lin([0, 0], [0.4, 3]) });
    const r = loopKeysOnBeats(kf, G, 1, 23.9, true);
    if (typeof r === 'string') {
      expect(r).toBe('too many');
    } else {
      for (const p of Object.keys(r.keys)) expect(r.keys[p]!.length).toBeLessThanOrEqual(240);
    }
    const small = ok(loopKeysOnBeats(kf, G, 1, 6, false));
    for (const p of Object.keys(small.keys)) {
      const keys = small.keys[p]!;
      for (let i = 1; i < keys.length; i++) expect(keys[i]!.t).toBeGreaterThan(keys[i - 1]!.t);
      for (const k of keys) expect(k.t >= 0 && k.t <= 6 + 1e-9).toBe(true);
    }
  });
});
