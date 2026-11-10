import { describe, expect, it } from 'vitest';
import { MAX_GHOST_COPIES, TRAIL_HEAD_SHARE, blurPlan } from './blurStyle';

const sum = (a: { weight: number }[]) => a.reduce((s, x) => s + x.weight, 0);

describe('blurPlan even', () => {
  it('centers equal shares on the frame time', () => {
    const p = blurPlan('even', 5, 0.1);
    expect(p.over).toBe(false);
    const want = [-0.05, -0.025, 0, 0.025, 0.05];
    p.samples.forEach((s, i) => {
      expect(s.offset).toBeCloseTo(want[i]!, 12);
      expect(s.weight).toBe(1 / 5);
    });
  });
  it('a missing style is even', () => {
    expect(blurPlan(undefined, 4, 0.2)).toEqual(blurPlan('even', 4, 0.2));
  });
});

describe('blurPlan trail', () => {
  it('only reaches into the past and ends on the clip itself', () => {
    const p = blurPlan('trail', 8, 0.05);
    expect(p.over).toBe(false);
    expect(p.samples).toHaveLength(8);
    for (const s of p.samples) expect(s.offset).toBeLessThanOrEqual(0);
    expect(p.samples[0]!.offset).toBeCloseTo(-0.05, 12);
    expect(p.samples[7]!.offset).toBe(0);
  });
  it('weights add up to 1, the newest keeps its share and the tail falls off toward the past', () => {
    for (const n of [2, 3, 8, 32]) {
      const p = blurPlan('trail', n, 0.1);
      expect(sum(p.samples)).toBeCloseTo(1, 12);
      expect(p.samples[n - 1]!.weight).toBe(TRAIL_HEAD_SHARE);
      for (let i = 1; i < n - 1; i++) expect(p.samples[i]!.weight).toBeGreaterThan(p.samples[i - 1]!.weight);
      for (const s of p.samples) expect(s.weight).toBeGreaterThan(0);
    }
  });
});

describe('blurPlan ghost', () => {
  it('caps the copies', () => {
    expect(blurPlan('ghost', 32, 0.1).samples).toHaveLength(MAX_GHOST_COPIES);
    expect(blurPlan('ghost', 3, 0.1).samples).toHaveLength(3);
    expect(blurPlan('ghost', 2, 0.1).samples).toHaveLength(2);
  });
  it('lays copies over each other, oldest first, the clip itself at full strength', () => {
    const p = blurPlan('ghost', 12, 0.08);
    expect(p.over).toBe(true);
    const s = p.samples;
    for (const x of s) {
      expect(x.offset).toBeLessThanOrEqual(0);
      expect(x.weight).toBeGreaterThan(0);
      expect(x.weight).toBeLessThanOrEqual(1);
    }
    expect(s[0]!.offset).toBeCloseTo(-0.08, 12);
    expect(s[s.length - 1]!.offset).toBe(0);
    expect(s[s.length - 1]!.weight).toBe(1);
    for (let i = 1; i < s.length; i++) {
      expect(s[i]!.offset).toBeGreaterThan(s[i - 1]!.offset);
      expect(s[i]!.weight).toBeGreaterThan(s[i - 1]!.weight);
    }
    expect(s[s.length - 2]!.weight).toBeLessThan(1);
  });
});
