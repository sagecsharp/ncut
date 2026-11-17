import { describe, expect, it } from 'vitest';
import type { Clip, Keyframe, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { SNAP_PX } from './layout';
import { keyDragTarget, keySnapPoints, selHas, stretchFactor, stretchPivot } from './keyDrag';

const lin = (...ts: number[]): Keyframe[] => ts.map((t) => ({ t, v: t, ease: 'linear' as const }));
const video = (id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId: 'v1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'a', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const proj = (clips: Clip[], extra: Partial<Project> = {}): Project => ({ clips, tracks: [], markers: [], ...extra }) as unknown as Project;

describe('keyDrag', () => {
  it('snaps, else frames', () => {
    const points = [0, 2, 5];
    // zoom 10: SNAP_PX / 10 seconds of reach
    const reach = SNAP_PX / 10;
    expect(keyDragTarget(2 + reach / 2, points, 10, 30, true)).toEqual({ time: 2, hit: 2 });
    // out of reach: the nearest whole frame
    expect(keyDragTarget(3.51, points, 10, 30, true)).toEqual({ time: Math.round(3.51 * 30) / 30, hit: null });
    // no clamp: before 0 stays before 0
    expect(keyDragTarget(-1, [], 10, 30, true)).toEqual({ time: -1, hit: null });
  });

  it('snapping off gives frames', () => {
    // right on a point, but snapping is off
    expect(keyDragTarget(2.01, [2], 10, 30, false)).toEqual({ time: Math.round(2.01 * 30) / 30, hit: null });
    expect(keyDragTarget(2.01, [2], 10, 30, false).time).toBeCloseTo(2, 1);
    expect(keyDragTarget(1 / 60 + 0.001, [], 10, 30, false)).toEqual({ time: 1 / 30, hit: null });
  });

  it('selHas finds a time in a sorted list within the tolerance', () => {
    const l = Float64Array.from([0.5, 1, 2]);
    expect(selHas(l, 1.00001)).toBe(true);
    expect(selHas(l, 1.5)).toBe(false);
    expect(selHas(l, 3)).toBe(false);
    expect(selHas(undefined, 1)).toBe(false);
  });

  it('keySnapPoints has playhead, edges, in, out, unselected keys', () => {
    const a = video('a', 2, 4, { keyframes: { x: lin(0, 1, 4), y: lin(2, 9) } });
    const b = video('b', 10, 3, { keyframes: { x: lin(1) } });
    const p = proj([a, b], { range: { in: 1, out: 12 }, markers: [{ id: 'm', time: 7, name: '' }] });
    const sel = [{ clipId: 'a', prop: 'x', t: 1 }, { clipId: 'a', prop: 'y', t: 2.00001 }];
    const pts = keySnapPoints(p, [a], sel, 3.5);
    // 0, the playhead, the clip edges, the marker, in and out, and the unselected keys of the shown clip: x at 0 and 4 (timeline 2 and 6), y at 9 is outside
    expect(pts).toEqual([...pts].sort((x, y) => x - y));
    for (const t of [0, 3.5, 2, 6, 10, 13, 7, 1, 12]) expect(pts).toContain(t);
    // a key at timeline 3 (x at 1) and 4 (y at 2) is selected, so not a point of its own
    expect(pts.filter((t) => t === 3)).toHaveLength(0);
    expect(pts.filter((t) => t === 4)).toHaveLength(0);
    // the key of b (not shown) and the outside key (t 9 of a, past the clip end) add nothing
    expect(pts).not.toContain(11);
    expect(pts.filter((t) => t === 2)).toHaveLength(2);
  });

  it('stretchPivot falls back to the farthest key', () => {
    // pressed a frame or more from the playhead: the playhead
    expect(stretchPivot(5, 2, [5, 6], 30)).toBe(2);
    expect(stretchPivot(5, 5 - 1 / 30, [5, 6], 30)).toBe(5 - 1 / 30);
    // pressed on the playhead: the selected time farthest from it
    expect(stretchPivot(5, 5, [3, 5, 8], 30)).toBe(8);
    expect(stretchPivot(5, 5.01, [3, 5, 6], 30)).toBe(3);
    // everything within a frame of the pressed key: the playhead
    expect(stretchPivot(5, 5, [5, 5.01], 30)).toBe(5);
    expect(stretchPivot(5, 5, [], 30)).toBe(5);
  });

  it('stretchFactor lands the pressed key', () => {
    expect(stretchFactor(6, 7, 4)).toBe(1.5);
    expect(stretchFactor(6, 5, 4)).toBe(0.5);
    // the key before the pivot stretches the other way
    expect(stretchFactor(2, 1, 4)).toBe(1.5);
    // unclamped, also past the pivot (a flip) and to zero
    expect(stretchFactor(6, 2, 4)).toBe(-1);
    expect(stretchFactor(6, 4, 4)).toBe(0);
    expect(stretchFactor(6, 100, 4)).toBe(48);
    // on the pivot: 1
    expect(stretchFactor(4, 9, 4)).toBe(1);
    expect(stretchFactor(4 + 1e-12, 9, 4)).toBe(1);
    // the pressed key lands at `to` for any factor it gives
    const pivot = 4;
    const pressed = 6;
    const to = 7.3;
    expect(pivot + (pressed - pivot) * stretchFactor(pressed, to, pivot)).toBeCloseTo(to, 12);
  });
});
