import { describe, expect, it } from 'vitest';
import {
  WINDOW_BUCKET,
  WINDOW_MIN_CLIPS,
  buildLaneIndex,
  clipNearView,
  spanInWindow,
  windowBounds,
  windowKey,
  windowMargin,
  windowMask,
} from './clipWindow';
import type { LaneItem } from './clipWindow';

/** the plain way: test every item */
function brute(items: LaneItem[], zoom: number, ws: number, we: number, pinned: number[] = []): number[] {
  const out: number[] = [];
  items.forEach((it, i) => {
    const x0 = it.start * zoom;
    const x1 = x0 + Math.max(2, it.duration * zoom);
    if ((x1 >= ws && x0 <= we) || pinned.includes(i)) out.push(i);
  });
  return out;
}
const idx = (m: Uint8Array) => [...m].flatMap((v, i) => (v ? [i] : []));

describe('window key', () => {
  it('a small lane mounts everything', () => {
    expect(windowKey(5000, 800, 0)).toBe('');
    expect(windowKey(5000, 800, WINDOW_MIN_CLIPS - 1)).toBe('');
    expect(windowBounds('')).toBeNull();
  });
  it('only changes when a bucket border is crossed', () => {
    const k = windowKey(5000, 800, 100);
    expect(windowKey(5001, 800, 100)).toBe(k);
    expect(windowKey(5000 + WINDOW_BUCKET, 800, 100)).not.toBe(k);
  });
  it('the bucket window always contains viewport + margin', () => {
    for (const w of [300, 800, 1900]) {
      for (let s = 0; s < 9000; s += 37) {
        const b = windowBounds(windowKey(s, w, 100))!;
        expect(b.start).toBeLessThanOrEqual(s - windowMargin(w));
        expect(b.end).toBeGreaterThanOrEqual(s + w + windowMargin(w));
      }
    }
  });
  it('margin is about one viewport, at least 600', () => {
    expect(windowMargin(300)).toBe(600);
    expect(windowMargin(1900)).toBe(1900);
  });
});

describe('window mask', () => {
  const lane: LaneItem[] = Array.from({ length: 200 }, (_, i) => ({ start: i * 3, duration: 2 }));

  it('empty lane', () => {
    expect(idx(windowMask(buildLaneIndex([]), 50, 0, 1000))).toEqual([]);
  });
  it('matches testing every item', () => {
    const index = buildLaneIndex(lane);
    for (const zoom of [1, 10, 50, 200]) {
      for (const [a, b] of [
        [0, 500],
        [1000, 2000],
        [-300, 100],
        [5000, 9000],
        [100000, 200000],
      ] as const) {
        expect(idx(windowMask(index, zoom, a, b))).toEqual(brute(lane, zoom, a, b));
      }
    }
  });
  it('a clip longer than the window is mounted when it covers the window', () => {
    const items: LaneItem[] = [
      { start: 0, duration: 1000 },
      { start: 2000, duration: 1 },
    ];
    expect(idx(windowMask(buildLaneIndex(items), 10, 3000, 4000))).toEqual([0]);
  });
  it('unsorted lane order keeps lane indexes', () => {
    const items: LaneItem[] = [
      { start: 90, duration: 2 },
      { start: 0, duration: 2 },
      { start: 45, duration: 2 },
    ];
    expect(idx(windowMask(buildLaneIndex(items), 10, 400, 500))).toEqual([2]);
    expect(idx(windowMask(buildLaneIndex(items), 10, 0, 50))).toEqual([1]);
  });
  it('overlapping clips: a long early clip is found past later short ones', () => {
    const items: LaneItem[] = [
      { start: 0, duration: 500 },
      { start: 10, duration: 1 },
      { start: 20, duration: 1 },
    ];
    expect(idx(windowMask(buildLaneIndex(items), 10, 4000, 4500))).toEqual([0]);
  });
  it('pinned clips outside the window stay', () => {
    const index = buildLaneIndex(lane);
    const m = windowMask(index, 50, 0, 400, (i) => i === 150 || i === 199);
    expect(idx(m)).toEqual(brute(lane, 50, 0, 400, [150, 199]));
    expect(m[150]).toBe(1);
    expect(m[199]).toBe(1);
  });
  it('exactly on the edge counts as inside', () => {
    const items: LaneItem[] = [
      { start: 10, duration: 5 }, // 100..150 at zoom 10
      { start: 20, duration: 5 }, // 200..250
    ];
    const index = buildLaneIndex(items);
    expect(idx(windowMask(index, 10, 150, 200))).toEqual([0, 1]);
    expect(idx(windowMask(index, 10, 150.5, 199.5))).toEqual([]);
  });
  it('a zero length clip still has its 2 px box', () => {
    const items: LaneItem[] = [{ start: 10, duration: 0 }];
    const index = buildLaneIndex(items);
    expect(idx(windowMask(index, 10, 101, 300))).toEqual([0]);
    expect(idx(windowMask(index, 10, 103, 300))).toEqual([]);
  });
  it('a zoom change moves the window over different clips', () => {
    const index = buildLaneIndex(lane);
    expect(idx(windowMask(index, 10, 0, 100))).toEqual(brute(lane, 10, 0, 100));
    expect(idx(windowMask(index, 100, 0, 100))).toEqual(brute(lane, 100, 0, 100));
    expect(idx(windowMask(index, 100, 0, 100)).length).toBeLessThan(idx(windowMask(index, 10, 0, 100)).length);
  });
  it('random lanes agree with the plain test', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let round = 0; round < 60; round++) {
      const items: LaneItem[] = Array.from({ length: 1 + Math.floor(rnd() * 150) }, () => ({
        start: Math.round(rnd() * 600 * 4) / 4,
        duration: rnd() < 0.1 ? 0 : Math.round(rnd() * (rnd() < 0.2 ? 300 : 12) * 4) / 4,
      }));
      const zoom = 1 + rnd() * 120;
      const ws = rnd() * 40000 - 2000;
      const we = ws + rnd() * 4000;
      const pins = [Math.floor(rnd() * items.length)];
      expect(idx(windowMask(buildLaneIndex(items), zoom, ws, we, (i) => pins.includes(i)))).toEqual(brute(items, zoom, ws, we, pins));
    }
  });
});

describe('span and near', () => {
  it('transition band in the window', () => {
    expect(spanInWindow(10, 11, 10, 0, 105)).toBe(true);
    expect(spanInWindow(10, 11, 10, 0, 99)).toBe(false);
    expect(spanInWindow(10, 10, 10, 100, 200)).toBe(true);
    expect(spanInWindow(10, 10, 10, 107, 200)).toBe(false);
  });
  it('near view: window plus one margin', () => {
    // viewport 0..800, margin 800 each side
    expect(clipNearView(100, 1, 10, 0, 800)).toBe(true);
    expect(clipNearView(160, 1, 10, 0, 800)).toBe(true);
    expect(clipNearView(161, 1, 10, 0, 800)).toBe(false);
    expect(clipNearView(0, 1, 10, 5000, 800)).toBe(false);
    expect(clipNearView(0, 1000, 10, 5000, 800)).toBe(true);
  });
});
