import { describe, expect, it } from 'vitest';
import type { EffectClip, Keyframe, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { ALL_EASES, EASE_LABEL, EASINGS, KEY_EPS, applyEasing, evalKeys, keyRange, resolveClip, valueAt, withKey, withoutKey, withoutKeyAt } from './anim';

const k = (t: number, v: number, ease: Keyframe['ease'] = 'linear', extra: Partial<Keyframe> = {}): Keyframe => ({ t, v, ease, ...extra });
const video = (o: Partial<VideoClip> = {}): VideoClip => ({
  id: 'v',
  type: 'video',
  trackId: 't',
  start: 0,
  duration: 10,
  name: 'c',
  fadeIn: 0,
  fadeOut: 0,
  assetId: 'a',
  trimStart: 0,
  speed: 1,
  volume: 1,
  muted: false,
  transform: { ...DEFAULT_TRANSFORM },
  ...o,
});
const effect = (o: Partial<EffectClip> = {}): EffectClip => ({ id: 'e', type: 'effect', trackId: 't', start: 0, duration: 10, name: 'e', fadeIn: 0, fadeOut: 0, effect: 'shake', amount: 1, params: {}, seed: 0, ...o });

/** evalKeys and withKey as they were before the graph editor, copied in word for word */
function oldEvalKeys(keys: readonly Keyframe[], t: number): number {
  const n = keys.length;
  const first = keys[0]!;
  if (n === 1 || t <= first.t) return first.v;
  const last = keys[n - 1]!;
  if (t >= last.t) return last.v;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = keys[lo]!;
  const b = keys[hi]!;
  const span = b.t - a.t;
  if (span <= KEY_EPS) return b.v;
  return a.v + (b.v - a.v) * applyEasing(a.ease, (t - a.t) / span);
}
function oldWithKey(keys: readonly Keyframe[], t: number, v: number, ease?: Keyframe['ease']): Keyframe[] {
  const at = keys.findIndex((x) => Math.abs(x.t - t) <= KEY_EPS);
  if (at >= 0) {
    const next = keys.slice();
    next[at] = { t: keys[at]!.t, v, ease: ease ?? keys[at]!.ease };
    return next;
  }
  let prev: Keyframe | undefined;
  for (const x of keys) if (x.t < t) prev = x;
  const next = [...keys, { t, v, ease: ease ?? prev?.ease ?? 'ease' }];
  next.sort((a, b) => a.t - b.t);
  return next;
}

describe('the ease lists', () => {
  it('EASINGS stays eight and ALL_EASES adds custom', () => {
    expect(EASINGS).toHaveLength(8);
    expect(ALL_EASES).toHaveLength(9);
    expect(ALL_EASES.slice(0, 8)).toEqual(EASINGS.map((e) => e.id));
    expect(ALL_EASES[8]).toBe('bezier');
    expect(EASE_LABEL.bezier).toBe('custom');
    for (const e of EASINGS) expect(EASE_LABEL[e.id]).toBe(e.label);
  });
  it('applyEasing has a default for an unknown ease', () => {
    expect(applyEasing('bezier', 0.3)).toBe(0.3);
    expect(applyEasing('bezier', 0)).toBe(0);
    expect(applyEasing('bezier', 1)).toBe(1);
  });
});

describe('old eases give the same doubles', () => {
  it('every named ease, 10 000 times, bit for bit', () => {
    for (const e of EASINGS) {
      const keys = [k(1, -3, e.id), k(4.5, 7.25, 'linear'), k(6, 2, e.id), k(9, 100)];
      for (let n = 0; n < 10000; n++) {
        const t = -1 + (11 * n) / 9999;
        expect(Object.is(evalKeys(keys, t), oldEvalKeys(keys, t))).toBe(true);
      }
    }
  });
  it('with a clip and a prop too', () => {
    const c = video({ keyframes: { opacity: [k(0, 0, 'ease'), k(2, 1, 'back'), k(5, 0.5)] } });
    const keys = c.keyframes!.opacity!;
    for (let n = 0; n < 500; n++) {
      const t = (6 * n) / 499;
      expect(Object.is(evalKeys(keys, t, c, 'opacity'), oldEvalKeys(keys, t))).toBe(true);
    }
  });
});

describe('clamp scope', () => {
  const wild = (): Keyframe[] => [k(0, 0.2, 'bezier', { out: { speed: 10, influence: 1 } }), k(1, 0.8, 'linear', { in: { speed: -10, influence: 1 } })];
  it('a custom part of a prop with a range stays inside it, widened by both key values', () => {
    const keys = wild();
    const c = video({ keyframes: { opacity: keys } });
    let hit = 0;
    for (let n = 0; n <= 200; n++) {
      const v = evalKeys(keys, n / 200, c, 'opacity');
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      if (v === 1 || v === 0) hit++;
    }
    expect(hit).toBeGreaterThan(0);
    // without the clip the same part runs past the range
    let over = false;
    for (let n = 0; n <= 200; n++) if (evalKeys(keys, n / 200) > 1) over = true;
    expect(over).toBe(true);
  });
  it('the range is widened by the key values when they sit outside it', () => {
    const keys = [k(0, 0.5, 'bezier', { out: { speed: 40, influence: 1 } }), k(1, 3, 'linear', { in: { speed: 40, influence: 1 } })];
    const c = video({ keyframes: { opacity: keys } });
    expect(evalKeys(keys, 1, c, 'opacity')).toBe(3);
    for (let n = 0; n <= 100; n++) expect(evalKeys(keys, n / 100, c, 'opacity')).toBeLessThanOrEqual(3);
  });
  it('a prop with no min and max is not clamped', () => {
    const keys = [k(0, 0, 'bezier', { out: { speed: 500, influence: 1 } }), k(1, 10, 'linear', { in: { speed: 500, influence: 1 } })];
    const c = video({ keyframes: { x: keys } });
    let over = false;
    for (let n = 0; n <= 100; n++) {
      const v = evalKeys(keys, n / 100, c, 'x');
      expect(v).toBe(evalKeys(keys, n / 100));
      if (v > 10) over = true;
    }
    expect(over).toBe(true);
  });
  it('p.<key> of an effect is not clamped', () => {
    const keys = wild();
    const c = effect({ keyframes: { 'p.amount': keys } });
    let over = false;
    for (let n = 0; n <= 100; n++) if (evalKeys(keys, n / 100, c, 'p.amount') > 1) over = true;
    expect(over).toBe(true);
    expect(keyRange(c, 'p.amount')).toBeUndefined();
  });
  it('keyRange gives the range of a prop that has both ends', () => {
    expect(keyRange(video(), 'opacity')).toEqual({ lo: 0, hi: 1 });
    expect(keyRange(video(), 'scale')).toEqual({ lo: 0.01, hi: 100 });
    expect(keyRange(video(), 'x')).toBeUndefined();
    expect(keyRange(video(), 'nothing')).toBeUndefined();
    expect(keyRange(effect(), 'amount')).toEqual({ lo: 0, hi: 1 });
  });
  it('valueAt and resolveClip pass the clip and prop', () => {
    const keys = wild();
    const c = video({ start: 2, keyframes: { opacity: keys } });
    for (let n = 0; n <= 100; n++) {
      const time = 2 + n / 100;
      const v = valueAt(c, 'opacity', time)!;
      expect(v).toBeLessThanOrEqual(1);
      expect(resolveClip(c, time).transform.opacity).toBe(v);
    }
  });
  it('withoutKeyAt freezes the clamped value', () => {
    const c = video({ keyframes: { opacity: wild() } });
    const only = withoutKeyAt(withoutKeyAt(c, 'opacity', 0), 'opacity', 1);
    expect(only.keyframes).toBeUndefined();
    expect(only.transform.opacity).toBeLessThanOrEqual(1);
  });
});

describe('withKey splits custom parts exactly', () => {
  const keys = [k(0, 0, 'bezier', { out: { speed: 4, influence: 0.6 } }), k(3, 5, 'linear', { in: { speed: -2, influence: 0.35 } })];
  it('a new key inside a custom part keeps the line', () => {
    const t = 1.3;
    const v = evalKeys(keys, t);
    const next = withKey(keys, t, v);
    expect(next).toHaveLength(3);
    expect(next[1]!.t).toBe(t);
    expect(next[1]!.ease).toBe('bezier');
    for (let n = 0; n <= 300; n++) {
      const x = (3 * n) / 300;
      expect(Math.abs(evalKeys(next, x) - evalKeys(keys, x))).toBeLessThan(5e-8);
    }
  });
  it('the new value is the one given', () => {
    const next = withKey(keys, 1.3, 42);
    expect(next[1]!.v).toBe(42);
  });
  it('a named ease for the new key turns its part named', () => {
    const next = withKey(keys, 1.3, 2, 'ease');
    expect(next[1]!.ease).toBe('ease');
    expect('out' in next[1]!).toBe(false);
    expect('in' in next[2]!).toBe(false);
    expect(next[0]!.ease).toBe('bezier');
  });
  it('a key at an existing time keeps its handles and takes a bezier ease as the twin', () => {
    const set = withKey(keys, 0, 1);
    expect(set[0]!.v).toBe(1);
    expect(set[0]!.out).toEqual({ speed: 4, influence: 0.6 });
    const lin = withKey([k(0, 0), k(2, 4)], 0, 0, 'bezier');
    expect(lin[0]!.ease).toBe('bezier');
    expect(lin[0]!.out).toEqual({ speed: 2, influence: 1 / 3 });
  });
  it('a key added after the last custom key makes that key smooth', () => {
    const custom = [k(0, 0), k(1, 1, 'bezier')];
    const next = withKey(custom, 3, 5);
    expect(next[1]!.ease).toBe('ease');
    expect(next[2]!.ease).toBe('ease');
    expect(withKey(custom, 3, 5, 'linear')[2]!.ease).toBe('linear');
  });
  it('withoutKey tidies the neighbours and gives the same array when no key is there', () => {
    const three = [k(0, 0, 'bezier', { out: { speed: 1, influence: 0.5 } }), k(1, 1, 'ease', { in: { speed: 1, influence: 0.5 } }), k(2, 2)];
    const out = withoutKey(three, 1);
    expect(out).toHaveLength(2);
    expect('out' in out[0]!).toBe(true);
    expect(withoutKey(three, 1.5)).toBe(three);
    const out0 = withoutKey(three, 0);
    expect('in' in out0[0]!).toBe(false);
  });
});

describe('withKey on named parts is unchanged', () => {
  it('same objects as before for plain keys', () => {
    const cases: Array<[Keyframe[], number, number, Keyframe['ease']?]> = [
      [[k(0, 0, 'ease'), k(2, 4, 'back')], 1, 5],
      [[k(0, 0, 'ease'), k(2, 4, 'back')], 1, 5, 'bounce'],
      [[k(0, 0, 'ease'), k(2, 4, 'back')], 2, 9],
      [[k(0, 0, 'hold'), k(2, 4, 'elastic')], 0, 1, 'linear'],
      [[k(0, 0, 'hold'), k(2, 4, 'elastic')], 3, 1],
      [[], 1, 1],
      [[k(0, 0, 'ease-in')], 1, 1],
      [[k(1, 0, 'ease-out')], 0, 3],
    ];
    for (const [keys, t, v, ease] of cases) {
      const now = withKey(keys, t, v, ease);
      expect(now).toEqual(oldWithKey(keys, t, v, ease));
      expect(JSON.stringify(now)).toBe(JSON.stringify(oldWithKey(keys, t, v, ease)));
    }
  });
});
