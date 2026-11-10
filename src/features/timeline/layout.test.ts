import { describe, expect, it } from 'vitest';
import type { Track } from '../../types';
import { GAP_PX, ZONE_H, computeLayout, gapAllows, hitGap } from './layout';

const tr = (id: string, kind: 'video' | 'audio') => ({ id, kind }) as unknown as Track;
const vvaa = [tr('v1', 'video'), tr('v2', 'video'), tr('a1', 'audio'), tr('a2', 'audio')];

describe('hitGap', () => {
  const l = computeLayout(vvaa);
  it('finds the inner borders', () => {
    expect(hitGap(l, l.tops[1]!)).toBe(1);
    expect(hitGap(l, l.tops[2]!)).toBe(2);
    expect(hitGap(l, l.tops[3]!)).toBe(3);
  });
  it('band edges are in, one px past is out', () => {
    const b = l.tops[1]!;
    expect(hitGap(l, b - GAP_PX)).toBe(1);
    expect(hitGap(l, b + GAP_PX)).toBe(1);
    expect(hitGap(l, b - GAP_PX - 1)).toBeNull();
    expect(hitGap(l, b + GAP_PX + 1)).toBeNull();
  });
  it('outer borders and lane middles give null', () => {
    expect(hitGap(l, ZONE_H)).toBeNull();
    expect(hitGap(l, l.bottomZoneTop)).toBeNull();
    expect(hitGap(l, l.tops[1]! + l.heights[1]! / 2)).toBeNull();
  });
  it('one track or none gives null', () => {
    const one = computeLayout([tr('v', 'video')]);
    expect(hitGap(one, one.tops[0]!)).toBeNull();
    expect(hitGap(one, one.bottomZoneTop)).toBeNull();
    expect(hitGap(computeLayout([]), 0)).toBeNull();
  });
});

describe('gapAllows', () => {
  it('video goes up to the end of the video tracks', () => {
    expect([1, 2, 3].map((i) => gapAllows(vvaa, i, 'video'))).toEqual([true, true, false]);
  });
  it('audio goes from the start of the audio tracks', () => {
    expect([1, 2, 3].map((i) => gapAllows(vvaa, i, 'audio'))).toEqual([false, true, true]);
  });
});
