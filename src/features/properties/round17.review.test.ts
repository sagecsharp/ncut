import { describe, expect, it } from 'vitest';
import { evalKeys } from '../../lib/anim';
import { createShapeClip } from '../../lib/factory';
import type { Easing, Keyframe } from '../../types';
import { MAX_KEYS_PER_PROP, wiggleKeys, wiggleOnto } from './keyTools';
import { DEFAULT_PATH, pathKeys } from './pathMoves';

const k = (t: number, v: number, ease: Easing = 'linear'): Keyframe => ({ t, v, ease });

describe('a wiggle on top of an animation', () => {
  // a closed loop: out and back, the kind of curve two samples would flatten
  const loop = [k(0, 0), k(0.25, 100), k(0.5, 0), k(0.75, -100), k(1, 0)];

  it('keeps every key of the animation where it was', () => {
    const offsets = wiggleKeys(0, { amount: 10, perSecond: 1, from: 0, to: 1, seed: 5 });
    const out = wiggleOnto(loop, offsets, 1)!;
    for (const old of loop) {
      const hit = out.find((q) => Math.abs(q.t - old.t) < 1e-9)!;
      expect(hit).toBeDefined();
      expect(Math.abs(hit.v - old.v)).toBeLessThanOrEqual(10 + 1e-9);
      expect(hit.ease).toBe(old.ease);
    }
    // the loop is still a loop: far from a flat line
    expect(evalKeys(out, 0.25)).toBeGreaterThan(80);
    expect(evalKeys(out, 0.75)).toBeLessThan(-80);
  });

  it('adds the shake between the old keys, on the old curve', () => {
    const ramp = [k(0, 0), k(4, 400)];
    const offsets = wiggleKeys(0, { amount: 20, perSecond: 2, from: 0, to: 4, seed: 9 });
    const out = wiggleOnto(ramp, offsets, 4)!;
    expect(out.length).toBeGreaterThan(ramp.length);
    for (const q of out) expect(Math.abs(q.v - q.t * 100)).toBeLessThanOrEqual(20 + 1e-6);
    // starts and ends at rest like every wiggle
    expect(out[0]!.v).toBeCloseTo(0, 6);
    expect(out[out.length - 1]!.v).toBeCloseTo(400, 6);
  });

  it('a held animation stays held', () => {
    const steps = [k(0, 0, 'hold'), k(1, 50, 'hold'), k(2, 100, 'hold')];
    const offsets = wiggleKeys(0, { amount: 5, perSecond: 3, from: 0, to: 2, seed: 2 });
    const out = wiggleOnto(steps, offsets, 2)!;
    expect(out.every((q) => q.ease === 'hold')).toBe(true);
  });

  it('keys outside the clip are left alone, and the cap holds', () => {
    const split = [k(-2, 7), k(0, 0), k(1, 10), k(5, 99)];
    const offsets = wiggleKeys(0, { amount: 3, perSecond: 4, from: 0, to: 1, seed: 4 });
    const out = wiggleOnto(split, offsets, 1)!;
    expect(out[0]).toEqual(k(-2, 7));
    expect(out[out.length - 1]).toEqual(k(5, 99));

    const many = Array.from({ length: 200 }, (_, i) => k(i * 0.05, i));
    const dense = wiggleKeys(0, { amount: 1, perSecond: 12, from: 0, to: 10, seed: 1 });
    expect(wiggleOnto(many, dense, 10)!.length).toBeLessThanOrEqual(MAX_KEYS_PER_PROP);
    const full = Array.from({ length: MAX_KEYS_PER_PROP - 1 }, (_, i) => k(i * 0.05, i));
    expect(wiggleOnto(full, dense, 12)).toBeNull();
  });
});

describe('swing leans toward its pivot', () => {
  it('at the right end the top of the clip points up and to the left (a negative turn), and the other way round', () => {
    const clip = createShapeClip('t', 0, { duration: 4 });
    const kf = pathKeys(clip, { ...DEFAULT_PATH, kind: 'swing', size: 100, turns: 1, face: true }, { width: 1920, height: 1080 });
    const x = kf.x!;
    const rot = kf.rotation!;
    const base = x[0]!.v;
    const right = x.reduce((best, q) => (q.v > best.v ? q : best));
    const left = x.reduce((best, q) => (q.v < best.v ? q : best));
    expect(right.v).toBeGreaterThan(base);
    expect(evalKeys(rot, right.t)).toBeLessThan(0);
    expect(evalKeys(rot, left.t)).toBeGreaterThan(0);
    // hanging straight at the start
    expect(rot[0]!.v).toBeCloseTo(0, 6);
  });
});
