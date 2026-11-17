import { describe, expect, it } from 'vitest';
import type { Track } from '../../types';
import { GAP_PX, ZONE_H, computeLayout, gapAllows, hitGap, laneHeight } from './layout';

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

describe('track heights', () => {
  it('a stored height is used', () => {
    const tall = [{ ...tr('v', 'video'), height: 96 }, { ...tr('a', 'audio'), height: 5 }, { ...tr('b', 'audio'), height: 999 }] as unknown as Track[];
    const l = computeLayout(tall);
    expect(l.heights).toEqual([96, 28, 240]);
    expect(l.tops).toEqual([14, 110, 138]);
    expect(l.bottomZoneTop).toBe(378);
    expect(l.total).toBe(392);
    // a new tracks array is a new layout, the same array the same object
    const again = tall.map((t) => ({ ...t }));
    expect(computeLayout(again)).not.toBe(l);
    expect(computeLayout(tall)).toBe(l);
    const changed = [{ ...tall[0]!, height: 128 }, tall[1]!, tall[2]!] as Track[];
    expect(computeLayout(changed).heights[0]).toBe(128);
    expect(laneHeight({ kind: 'audio', height: 72 })).toBe(72);
  });
  it('an old project lays out as before', () => {
    const l = computeLayout(vvaa);
    expect(l.heights).toEqual([56, 56, 48, 48]);
    expect(l.tops).toEqual([14, 70, 126, 174]);
    expect(l.bottomZoneTop).toBe(222);
    expect(l.total).toBe(236);
  });
});
