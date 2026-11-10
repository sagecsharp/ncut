import { describe, expect, it } from 'vitest';
import type { Clip } from '../../types';
import { MAX_KEYS_PER_PROP, MIN_GAP } from './keyTools';
import { DEFAULT_PATH, PATH_KINDS, pathKeys, pathProps } from './pathMoves';
import type { PathOptions } from './pathMoves';

const size = { width: 1920, height: 1080 };

function clip(over: Record<string, unknown> = {}, tf: Record<string, number> = {}): Clip {
  return {
    id: 'c1',
    type: 'shape',
    trackId: 't',
    start: 2,
    duration: 4,
    transform: { x: 10, y: 20, scale: 1, rotation: 5, opacity: 1, ...tf },
    ...over,
  } as unknown as Clip;
}
const opts = (o: Partial<PathOptions>): PathOptions => ({ ...DEFAULT_PATH, ...o });
const KINDS = PATH_KINDS.map((k) => k.id);

describe('path moves', () => {
  it('every kind starts at the clip pose and ends on the duration', () => {
    for (const kind of KINDS) {
      for (const threeD of [false, true]) {
        const c = clip({ threeD }, threeD ? { z: 50 } : {});
        const kf = pathKeys(c, opts({ kind, face: true }), size);
        for (const [prop, keys] of Object.entries(kf)) {
          expect(keys[keys.length - 1]!.t).toBe(4);
          expect(keys[0]!.t).toBe(0);
          const base = prop === 'x' ? 10 : prop === 'y' ? 20 : prop === 'z' ? 50 : prop === 'rotation' ? 5 : 0;
          expect(keys[0]!.v).toBe(base);
        }
      }
    }
  });
  it('writes exactly the properties pathProps lists', () => {
    for (const kind of KINDS) {
      for (const threeD of [false, true]) {
        for (const face of [false, true]) {
          const c = clip({ threeD });
          const got = Object.keys(pathKeys(c, opts({ kind, face }), size)).sort();
          expect(got).toEqual(pathProps(c, { kind, face }).sort());
        }
      }
    }
  });
  it('a flat clip never gets z or rotY keys', () => {
    for (const kind of KINDS) {
      const kf = pathKeys(clip(), opts({ kind, face: true }), size);
      expect(kf.z).toBeUndefined();
      expect(kf.rotY).toBeUndefined();
    }
  });
  it('a 3d circle moves in x / z and turns rotY', () => {
    const kf = pathKeys(clip({ threeD: true }), opts({ kind: 'circle', face: true }), size);
    expect(kf.y).toBeUndefined();
    expect(kf.z).toBeDefined();
    expect(kf.rotY).toBeDefined();
    expect(kf.rotation).toBeUndefined();
  });
  it('a circle is round and closed', () => {
    const kf = pathKeys(clip(), opts({ kind: 'circle', size: 100 }), size);
    expect(kf.x!.length).toBeGreaterThanOrEqual(25);
    const last = kf.x!.length - 1;
    expect(kf.x![last]!.v).toBe(10);
    expect(kf.y![last]!.v).toBe(20);
    for (let i = 0; i <= last; i++) {
      // every point is 100 from the center (10, 120)
      expect(Math.hypot(kf.x![i]!.v - 10, kf.y![i]!.v - 120)).toBeCloseTo(100, 0);
    }
  });
  it('reverse goes the other way round', () => {
    const a = pathKeys(clip(), opts({ kind: 'circle' }), size);
    const b = pathKeys(clip(), opts({ kind: 'circle', reverse: true }), size);
    expect(a.x![1]!.v - 10).toBeCloseTo(-(b.x![1]!.v - 10), 2);
    expect(a.y![1]!.v).toBeCloseTo(b.y![1]!.v, 2);
  });
  it('keys stay under the cap and apart, at high turns too', () => {
    for (const kind of KINDS) {
      for (const turns of [0.25, 1, 5, 10]) {
        for (const duration of [0.01, 0.5, 60]) {
          const kf = pathKeys(clip({ duration }), opts({ kind, turns, face: true }), size);
          for (const keys of Object.values(kf)) {
            expect(keys.length).toBeLessThanOrEqual(MAX_KEYS_PER_PROP);
            expect(keys[keys.length - 1]!.t).toBe(duration);
            for (let i = 1; i < keys.length; i++) expect(keys[i]!.t - keys[i - 1]!.t).toBeGreaterThanOrEqual(MIN_GAP - 1e-9);
          }
        }
      }
    }
  });
  it('a clip too short gives nothing', () => {
    expect(pathKeys(clip({ duration: 0 }), opts({}), size)).toEqual({});
  });
  it('face never jumps by 360 and is added to the own angle', () => {
    const kf = pathKeys(clip(), opts({ kind: 'circle', face: true, turns: 3 }), size);
    const r = kf.rotation!;
    expect(r[0]!.v).toBe(5);
    for (let i = 1; i < r.length; i++) expect(Math.abs(r[i]!.v - r[i - 1]!.v)).toBeLessThan(90);
    expect(r[r.length - 1]!.v).toBeCloseTo(5 + 3 * 360, 0);
  });
  it('reversed face turns the other way', () => {
    const r = pathKeys(clip(), opts({ kind: 'circle', face: true, reverse: true }), size).rotation!;
    expect(r[r.length - 1]!.v).toBeCloseTo(5 - 360, 0);
  });
  it('hop goes up from the ground and lands on whole hops', () => {
    const y = pathKeys(clip(), opts({ kind: 'hop', turns: 3, size: 80 }), size).y!;
    expect(Math.min(...y.map((k) => k.v))).toBeCloseTo(20 - 80, 0);
    expect(Math.max(...y.map((k) => k.v))).toBe(20);
    expect(y[y.length - 1]!.v).toBe(20);
    expect(y.filter((k) => k.v === 20).length).toBe(4);
  });
  it('hop has no facing keys', () => {
    expect(Object.keys(pathKeys(clip(), opts({ kind: 'hop', face: true }), size))).toEqual(['y']);
  });
  it('spiral grows from zero to the size, a 3d one also rises', () => {
    const kf = pathKeys(clip({ threeD: true }), opts({ kind: 'spiral', size: 100, turns: 2 }), size);
    const n = kf.x!.length - 1;
    expect(Math.hypot(kf.x![n]!.v - 10, kf.z![n]!.v - 0)).toBeCloseTo(100, 0);
    expect(kf.y![n]!.v).toBe(20 - 100);
  });
  it('zigzag sweeps both sides while travelling by size', () => {
    const kf = pathKeys(clip(), opts({ kind: 'zigzag', size: 50, turns: 2 }), size);
    expect(kf.x!.map((k) => k.v)).toEqual([10, 60, 10, -40, 10, 60, 10, -40, 10]);
    expect(kf.y![kf.y!.length - 1]!.v).toBe(70);
    const z = pathKeys(clip({ threeD: true }), opts({ kind: 'zigzag', size: 50 }), size);
    expect(z.z![z.z!.length - 1]!.v).toBe(50);
  });
  it('swing is a pendulum around the start', () => {
    const kf = pathKeys(clip(), opts({ kind: 'swing', size: 100 }), size);
    const xs = kf.x!.map((k) => k.v);
    expect(Math.max(...xs)).toBeCloseTo(110, 0);
    expect(Math.min(...xs)).toBeCloseTo(-90, 0);
    expect(Math.max(...kf.y!.map((k) => k.v))).toBe(20);
  });
  it('drift is smooth, returns to the start and is repeatable', () => {
    const a = pathKeys(clip(), opts({ kind: 'drift', size: 60, seed: 7 }), size);
    const b = pathKeys(clip(), opts({ kind: 'drift', size: 60, seed: 7 }), size);
    const c = pathKeys(clip(), opts({ kind: 'drift', size: 60, seed: 8 }), size);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    const x = a.x!;
    expect(x[x.length - 1]!.v).toBe(10);
    for (let i = 1; i < x.length; i++) expect(Math.abs(x[i]!.v - x[i - 1]!.v)).toBeLessThan(30);
  });
  it('all keys are linear and finite', () => {
    for (const kind of KINDS) {
      for (const keys of Object.values(pathKeys(clip({ threeD: true }), opts({ kind, face: true }), size))) {
        for (const k of keys) {
          expect(k.ease).toBe('linear');
          expect(Number.isFinite(k.v)).toBe(true);
        }
      }
    }
  });
});
