import { describe, expect, it } from 'vitest';
import type { ImageClip } from '../../types';
import { MAX_REPEAT, applyRepeatEntry, repeatCount, repeatFitsOneTrack, repeatPlan, repeatPresets } from './repeat';

function clip(over: Partial<ImageClip> = {}): ImageClip {
  return {
    id: 'a',
    type: 'image',
    assetId: 'x',
    trackId: 't',
    start: 2,
    duration: 3,
    name: 'pic',
    fadeIn: 0,
    fadeOut: 0,
    transform: { x: 10, y: 20, scale: 1, rotation: 5, opacity: 1 },
    ...over,
  };
}

function allFinite(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (v && typeof v === 'object') return Object.values(v).every(allFinite);
  return true;
}

describe('repeatCount', () => {
  it('limits', () => {
    expect(repeatCount(1)).toBe(1);
    expect(repeatCount(0)).toBe(1);
    expect(repeatCount(-4)).toBe(1);
    expect(repeatCount(999)).toBe(MAX_REPEAT);
    expect(repeatCount(4.9)).toBe(4);
    expect(repeatCount(NaN)).toBe(1);
    expect(repeatCount(undefined)).toBe(1);
  });
});

describe('repeatPlan', () => {
  it('count 1 or less makes no copies', () => {
    expect(repeatPlan(clip(), { count: 1, dx: 5 })).toEqual([]);
    expect(repeatPlan(clip(), { count: 0 })).toEqual([]);
    expect(repeatPlan(clip(), { count: NaN })).toEqual([]);
  });

  it('one entry per copy and the count is capped', () => {
    expect(repeatPlan(clip(), { count: 4 })).toHaveLength(3);
    expect(repeatPlan(clip(), { count: 500 })).toHaveLength(MAX_REPEAT - 1);
    expect(repeatPlan(clip(), { count: 4 }).map((e) => e.index)).toEqual([1, 2, 3]);
  });

  it('zero steps change nothing', () => {
    for (const e of repeatPlan(clip(), { count: 3 })) {
      expect(e.transform).toEqual({});
      expect(e.keyframes).toEqual({});
      expect(e.offset).toBe(0);
    }
  });

  it('adds steps for a flat clip and ignores the 3d ones', () => {
    const plan = repeatPlan(clip(), { count: 3, dx: 60, dy: -30, rotation: 15, dz: 400, rotX: 9 });
    expect(plan[0]!.transform).toEqual({ x: 70, y: -10, rotation: 20 });
    expect(plan[1]!.transform).toEqual({ x: 130, y: -40, rotation: 35 });
  });

  it('3d clip: z and three turns, a missing value counts as 0', () => {
    const c = clip({ threeD: true });
    const plan = repeatPlan(c, { count: 3, dz: 100, rotX: 10, rotY: 20, rotZ: 30, rotation: 99 });
    expect(plan[0]!.transform).toEqual({ z: 100, rotX: 10, rotY: 20, rotation: 35 });
    expect(plan[1]!.transform).toEqual({ z: 200, rotX: 20, rotY: 40, rotation: 65 });
  });

  it('3d clip with an existing z', () => {
    const c = clip({ threeD: true, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 50 } });
    expect(repeatPlan(c, { count: 2, dz: 10 })[0]!.transform.z).toBe(60);
  });

  it('scale and opacity multiply', () => {
    const c = clip({ transform: { x: 0, y: 0, scale: 2, rotation: 0, opacity: 0.8 } });
    const plan = repeatPlan(c, { count: 3, scale: 0.5, opacity: 0.5 });
    expect(plan[0]!.transform.scale).toBeCloseTo(1);
    expect(plan[1]!.transform.scale).toBeCloseTo(0.5);
    expect(plan[0]!.transform.opacity).toBeCloseTo(0.4);
    expect(plan[1]!.transform.opacity).toBeCloseTo(0.2);
  });

  it('clamps scale and opacity', () => {
    const plan = repeatPlan(clip(), { count: 32, scale: 0.1, opacity: 5 });
    expect(plan[30]!.transform.scale).toBe(0.01);
    expect(plan[30]!.transform.opacity).toBe(1);
    expect(repeatPlan(clip(), { count: 32, scale: 10 })[30]!.transform.scale).toBe(100);
    const zero = repeatPlan(clip(), { count: 3, scale: 0, opacity: 0 });
    expect(zero[0]!.transform.scale).toBe(0.01);
    expect(zero[1]!.transform.opacity).toBe(0);
  });

  it('delay gives the offsets and is never negative', () => {
    expect(repeatPlan(clip(), { count: 4, delay: 0.5 }).map((e) => e.offset)).toEqual([0.5, 1, 1.5]);
    expect(repeatPlan(clip(), { count: 3, delay: -2 }).map((e) => e.offset)).toEqual([0, 0]);
  });

  it('keys get the step in every key and the static value stays', () => {
    const keys = [
      { t: 0, v: 0, ease: 'linear' as const },
      { t: 1, v: 100, ease: 'ease' as const },
    ];
    const c = clip({
      keyframes: {
        x: keys,
        opacity: [
          { t: 0, v: 1, ease: 'linear' },
          { t: 2, v: 0.5, ease: 'linear' },
        ],
      },
    });
    const plan = repeatPlan(c, { count: 3, dx: 50, dy: 10, opacity: 0.5 });
    expect(plan[1]!.keyframes.x).toEqual([
      { t: 0, v: 100, ease: 'linear' },
      { t: 1, v: 200, ease: 'ease' },
    ]);
    expect(plan[0]!.keyframes.opacity!.map((k) => k.v)).toEqual([0.5, 0.25]);
    expect(plan[0]!.transform.x).toBeUndefined();
    expect(plan[0]!.transform.opacity).toBeUndefined();
    expect(plan[0]!.transform.y).toBe(30);
    expect(c.keyframes!.x).toEqual(keys);
  });

  it('empty key lists count as static', () => {
    const plan = repeatPlan(clip({ keyframes: { x: [] } }), { count: 2, dx: 5 });
    expect(plan[0]!.transform.x).toBe(15);
    expect(plan[0]!.keyframes.x).toBeUndefined();
  });

  it('never makes NaN or Infinity', () => {
    const bad = { count: 6, dx: NaN, dy: Infinity, dz: -Infinity, rotation: NaN, rotX: NaN, scale: NaN, opacity: Infinity, delay: NaN };
    expect(allFinite(repeatPlan(clip(), bad))).toBe(true);
    expect(allFinite(repeatPlan(clip({ threeD: true }), bad))).toBe(true);
    const huge = clip({ transform: { x: 1e308, y: 0, scale: 1e300, rotation: 0, opacity: 1 } });
    expect(allFinite(repeatPlan(huge, { count: 32, dx: 1e308, scale: 1e300 }))).toBe(true);
  });
});

describe('applyRepeatEntry', () => {
  it('moves the start, merges the transform and the keys', () => {
    const c = clip({ keyframes: { x: [{ t: 0, v: 0, ease: 'linear' }] } });
    const entry = repeatPlan(c, { count: 2, dx: 5, dy: 5, delay: 1 })[0]!;
    const copy = applyRepeatEntry(c, entry);
    expect(copy.start).toBe(3);
    expect(copy.duration).toBe(3);
    expect(copy.transform.y).toBe(25);
    expect(copy.keyframes!.x![0]!.v).toBe(5);
    expect(copy).not.toBe(c);
    expect(c.start).toBe(2);
    expect(c.transform.y).toBe(20);
  });
});

describe('repeatFitsOneTrack', () => {
  it('needs a delay at least as long as the clip', () => {
    expect(repeatFitsOneTrack({ duration: 2 }, 2)).toBe(true);
    expect(repeatFitsOneTrack({ duration: 2 }, 3)).toBe(true);
    expect(repeatFitsOneTrack({ duration: 2 }, 1.9)).toBe(false);
    expect(repeatFitsOneTrack({ duration: 2 }, 0)).toBe(false);
    expect(repeatFitsOneTrack({ duration: 2 }, NaN)).toBe(false);
  });
});

describe('repeatPresets', () => {
  it('has echo, stairs, tunnel', () => {
    expect(repeatPresets.map((p) => p.id)).toEqual(['echo', 'stairs', 'tunnel']);
    expect(repeatPresets.find((p) => p.id === 'tunnel')!.needs3d).toBe(true);
    expect(repeatPresets.find((p) => p.id === 'echo')!.values).toEqual({ count: 6, opacity: 0.7, delay: 0.08 });
  });
});
