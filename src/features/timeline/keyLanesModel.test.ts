import { describe, expect, it } from 'vitest';
import type { AudioClip, Clip, EffectClip, Keyframe, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { CLIP_ROW_H, VALUE_ROW_H, buildLaneRows, hitLane, keyedValues, keysInBox, laneKeyX, rowAt, visibleRows } from './keyLanesModel';

const lin = (...pairs: [number, number][]): Keyframe[] => pairs.map(([t, v]) => ({ t, v, ease: 'linear' as const }));
const video = (id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId: 'v1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'a', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId: 'a1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'a', trimStart: 0, speed: 1, volume: 1, muted: false, ...over,
});
const effect = (id: string, over: Partial<EffectClip> = {}): EffectClip => ({
  id, type: 'effect', trackId: 'v2', start: 0, duration: 4, name: id, fadeIn: 0, fadeOut: 0, effect: 'shake', amount: 1, params: {}, seed: 1, ...over,
});
const proj = (clips: Clip[]): Project => ({ clips, tracks: [], markers: [] }) as unknown as Project;
const none = new Set<string>();

describe('keyLanesModel', () => {
  it('clip row, animProps, effect params', () => {
    const v = video('v', 1, 4, { keyframes: { y: lin([0, 1], [2, 3]), x: lin([1, 5]), opacity: lin([0, 1]) } });
    const e = effect('e', { keyframes: { 'p.speed': lin([0, 5]), 'p.strength': lin([1, 2]), amount: lin([0, 1]) } });
    expect(keyedValues(v).map((k) => k.prop)).toEqual(['x', 'y', 'opacity']);
    expect(keyedValues(e).map((k) => [k.prop, k.label])).toEqual([['amount', 'amount'], ['p.strength', 'strength'], ['p.speed', 'speed']]);
    const p = proj([v, e]);
    const rows = buildLaneRows(p, [v, e], none);
    expect(rows.map((r) => [r.kind, r.prop, r.y, r.h])).toEqual([
      ['clip', null, 0, CLIP_ROW_H],
      ['value', 'x', 22, VALUE_ROW_H],
      ['value', 'y', 40, VALUE_ROW_H],
      ['value', 'opacity', 58, VALUE_ROW_H],
      ['clip', null, 76, CLIP_ROW_H],
      ['value', 'amount', 98, VALUE_ROW_H],
      ['value', 'p.strength', 116, VALUE_ROW_H],
      ['value', 'p.speed', 134, VALUE_ROW_H],
    ]);
    expect(rows[0]!.label).toBe('v');
    expect(rows[0]!.keys).toEqual([]);
    expect(rows[0]!.values!.map((x) => x.prop)).toEqual(['x', 'y', 'opacity']);
    // the clip row's times are the union, equal ones once
    expect(rows[0]!.times).toEqual([0, 1, 2]);
    expect(rows[2]!.times).toEqual([0, 2]);
  });

  it('a value the clip cannot animate has no row', () => {
    const a = audio('a', 0, 4, { keyframes: { volume: lin([0, 1]), x: lin([0, 1]), 'p.strength': lin([0, 1]) } });
    expect(keyedValues(a).map((k) => k.prop)).toEqual(['volume']);
    expect(buildLaneRows(proj([a]), [a], none).map((r) => r.prop)).toEqual([null, 'volume']);
  });

  it('no keys: clip row only', () => {
    const v = video('v', 0, 4);
    const rows = buildLaneRows(proj([v]), [v], none);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('clip');
    expect(rows[0]!.times).toEqual([]);
    expect(rows[0]!.outside).toBe(false);
  });

  it('folded: no value rows', () => {
    const v = video('v', 0, 4, { keyframes: { x: lin([0, 1], [1, 2]) } });
    const w = video('w', 0, 4, { keyframes: { y: lin([0, 1]) } });
    const rows = buildLaneRows(proj([v, w]), [v, w], new Set(['v']));
    expect(rows.map((r) => [r.clipId, r.prop, r.folded])).toEqual([['v', null, true], ['w', null, false], ['w', 'y', false]]);
    // the folded clip row still knows its values and times
    expect(rows[0]!.values).toHaveLength(1);
    expect(rows[0]!.times).toEqual([0, 1]);
    expect(rows[1]!.y).toBe(22);
  });

  it('from and to cover inside keys', () => {
    const v = video('v', 0, 4, { keyframes: { x: lin([-1, 0], [0, 1], [2, 2], [4, 3], [5, 4]) } });
    const rows = buildLaneRows(proj([v]), [v], none);
    const r = rows[1]!;
    expect(r.keys).toHaveLength(5);
    expect([r.from, r.to]).toEqual([1, 4]);
    expect(r.times).toEqual([0, 2, 4]);
    expect(r.outside).toBe(false);
    const gone = video('g', 0, 2, { keyframes: { x: lin([3, 1], [4, 2]) } });
    const rows2 = buildLaneRows(proj([gone]), [gone], none);
    expect(rows2[1]!.outside).toBe(true);
    expect(rows2[1]!.from).toBe(rows2[1]!.to);
    expect(rows2[0]!.outside).toBe(true);
  });

  it('laneKeyX exact at 0 and the end', () => {
    const v = video('v', 2, 4, { keyframes: { x: lin([0, 1], [4, 2]) } });
    const r = buildLaneRows(proj([v]), [v], none)[1]!;
    expect(laneKeyX(r, 0, 10, 5)).toBe(15);
    expect(laneKeyX(r, 4, 10, 5)).toBe(55);
    expect(laneKeyX(r, 0, 10, 0)).toBe(20);
  });

  it('visibleRows and rowAt', () => {
    const v = video('v', 0, 4, { keyframes: { x: lin([0, 1]), y: lin([0, 1]) } });
    const rows = buildLaneRows(proj([v]), [v], none);
    expect(visibleRows(rows, 0, 100)).toEqual([0, 3]);
    expect(visibleRows(rows, 22, 18)).toEqual([1, 2]);
    expect(visibleRows(rows, 21, 2)).toEqual([0, 2]);
    expect(visibleRows(rows, 500, 100)).toEqual([3, 3]);
    expect(visibleRows([], 0, 100)).toEqual([0, 0]);
    expect([rowAt(rows, 0), rowAt(rows, 21.9), rowAt(rows, 22), rowAt(rows, 57.9), rowAt(rows, 58), rowAt(rows, -1)]).toEqual([0, 0, 1, 2, -1, -1]);
  });

  it('hitLane on both row kinds', () => {
    const v = video('v', 0, 10, { keyframes: { x: lin([1, 1], [1.1, 2], [3, 3]), y: lin([1, 1], [2, 2]) } });
    const rows = buildLaneRows(proj([v]), [v], none);
    // zoom 10: x at 10 and 11 (one group), 30
    expect(hitLane(rows, 1, 10, 10, 0).map((r) => r.t)).toEqual([1, 1.1]);
    expect(hitLane(rows, 1, 30.5, 10, 0).map((r) => r.t)).toEqual([3]);
    expect(hitLane(rows, 1, 20, 10, 0)).toEqual([]);
    expect(hitLane(rows, 1, 17, 10, 0)).toEqual([]);
    // the clip row gives every value's keys at those times
    const clipHit = hitLane(rows, 0, 10, 10, 0).map((r) => `${r.prop}@${r.t}`);
    expect(clipHit.sort()).toEqual(['x@1', 'x@1.1', 'y@1']);
    // scrolled: the same keys sit further left
    expect(hitLane(rows, 2, 5, 10, 5).map((r) => r.t)).toEqual([1]);
    expect(hitLane(rows, 9, 5, 10, 5)).toEqual([]);
  });

  it('keysInBox', () => {
    const v = video('v', 0, 10, { keyframes: { x: lin([1, 1], [3, 3]), y: lin([1, 1], [2, 2]) } });
    const w = video('w', 0, 10, { keyframes: { x: lin([1, 1]) } });
    const rows = buildLaneRows(proj([v, w]), [v, w], none);
    // rows: v clip 0..22, x 22..40, y 40..58, w clip 58..80, x 80..98
    const ref = (clipId: string, prop: string, t: number) => ({ clipId, prop, t });
    expect(keysInBox(rows, { x0: 5, x1: 25, y0: 25, y1: 35 }, 10, 0)).toEqual([ref('v', 'x', 1)]);
    // a row counts by its middle: the x row's middle is 31: a box from 45 down leaves it out
    expect(keysInBox(rows, { x0: 5, x1: 15, y0: 45, y1: 55 }, 10, 0)).toEqual([ref('v', 'y', 1)]);
    // a clip row in the box: all its values, no repeats when the value rows are in too
    const all = keysInBox(rows, { x0: 0, x1: 100, y0: 0, y1: 60 }, 10, 0);
    expect(all).toHaveLength(4);
    // box edges are inclusive, x given the other way round
    expect(keysInBox(rows, { x0: 30, x1: 10, y0: 31, y1: 31 }, 10, 0)).toEqual([ref('v', 'x', 1), ref('v', 'x', 3)]);
    expect(keysInBox(rows, { x0: 20, x1: 25, y0: 0, y1: 200 }, 10, 0)).toEqual([ref('v', 'y', 2)]);
    expect(keysInBox(rows, { x0: 20, x1: 25, y0: 0, y1: 200 }, 10, 20)).toEqual([]);
  });
});
