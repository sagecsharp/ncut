import { describe, expect, it } from 'vitest';
import { snapTime } from '../../lib/timelineOps';
import { snapTimeFast } from './snapSearch';

describe('snapTimeFast', () => {
  it('same answer as the linear scan on random inputs (ties, duplicates, thresholds, ends)', () => {
    let seed = 99;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let round = 0; round < 400; round++) {
      const n = Math.floor(rnd() * 120);
      // quarter second grid so exact ties (equal distance on both sides) and duplicates happen a lot
      const pts = Array.from({ length: n }, () => Math.round(rnd() * 80) / 4).sort((a, b) => a - b);
      for (let q = 0; q < 40; q++) {
        const t = rnd() < 0.5 ? Math.round(rnd() * 90 * 8) / 8 - 2 : rnd() * 90 - 2;
        const thr = [0, 0.125, 0.25, 0.5, 1, 3, Infinity][Math.floor(rnd() * 7)]!;
        expect(snapTimeFast(t, pts, thr)).toEqual(snapTime(t, pts, thr));
      }
    }
  });
  it('a tie between two points goes to the later one, like the scan', () => {
    const pts = Array.from({ length: 20 }, (_, i) => i);
    expect(snapTimeFast(4.5, pts, 1)).toEqual({ time: 5, hit: 5 });
    expect(snapTimeFast(4.5, pts, 1)).toEqual(snapTime(4.5, pts, 1));
  });
  it('threshold is inclusive and nothing near gives no hit', () => {
    const pts = Array.from({ length: 20 }, (_, i) => i * 2);
    expect(snapTimeFast(3, pts, 1)).toEqual({ time: 4, hit: 4 });
    expect(snapTimeFast(3, pts, 0.5)).toEqual({ time: 3, hit: null });
    expect(snapTimeFast(100, pts, 1)).toEqual({ time: 100, hit: null });
    expect(snapTimeFast(-5, pts, 1)).toEqual({ time: -5, hit: null });
  });
  it('an unsorted list falls back to the scan', () => {
    const pts = Array.from({ length: 30 }, (_, i) => (i * 7) % 30);
    for (const t of [0.4, 5.5, 12, 29.9]) expect(snapTimeFast(t, pts, 2)).toEqual(snapTime(t, pts, 2));
  });
  it('empty and NaN', () => {
    expect(snapTimeFast(1, [], 1)).toEqual({ time: 1, hit: null });
    const pts = Array.from({ length: 20 }, (_, i) => i);
    expect(snapTimeFast(NaN, pts, 1)).toEqual(snapTime(NaN, pts, 1));
  });
});
