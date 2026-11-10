import { describe, expect, it } from 'vitest';
import type { Clip, Track } from '../../types';
import { planTrimToPlayhead } from './trimPlan';

const track = (id: string, locked = false) => ({ id, kind: 'video', locked }) as unknown as Track;
const vid = (id: string, trackId: string, start: number, duration: number) => ({ id, type: 'video', trackId, start, duration }) as unknown as Clip;
const fx = (id: string, trackId: string, start: number, duration: number, target: string | null) =>
  ({ id, type: 'effect', trackId, start, duration, target }) as unknown as Clip;
const tracks = [track('v1'), track('v2'), track('fx'), track('lock', true)];
const ids = (s: { id: string }[]) => s.map((x) => x.id);

describe('planTrimToPlayhead', () => {
  it('cuts the selected clips the playhead is inside of', () => {
    const clips = [vid('a', 'v1', 0, 10), vid('b', 'v2', 0, 10), vid('c', 'v1', 20, 5)];
    expect(planTrimToPlayhead(clips, tracks, ['a', 'c'], 4, 'start')).toEqual([{ id: 'a', time: 4 }]);
    expect(planTrimToPlayhead(clips, tracks, ['a', 'b'], 4, 'end')).toEqual([
      { id: 'a', time: 4 },
      { id: 'b', time: 4 },
    ]);
  });

  it('with nothing selected it takes every clip under the playhead', () => {
    const clips = [vid('a', 'v1', 0, 10), vid('b', 'v2', 2, 4), vid('c', 'v1', 20, 5)];
    expect(ids(planTrimToPlayhead(clips, tracks, [], 3, 'start'))).toEqual(['a', 'b']);
    expect(ids(planTrimToPlayhead(clips, tracks, [], 8, 'start'))).toEqual(['a']);
  });

  it('does nothing when the playhead is on an edge, or outside with nothing selected', () => {
    const clips = [vid('a', 'v1', 2, 4)];
    for (const edge of ['start', 'end'] as const) {
      expect(planTrimToPlayhead(clips, tracks, ['a'], 2, edge)).toEqual([]);
      expect(planTrimToPlayhead(clips, tracks, ['a'], 6, edge)).toEqual([]);
      expect(planTrimToPlayhead(clips, tracks, [], 1, edge)).toEqual([]);
      expect(planTrimToPlayhead(clips, tracks, [], 7, edge)).toEqual([]);
    }
  });

  it('a selected clip grows to a playhead outside it, on the side of that edge only', () => {
    const clips = [vid('a', 'v1', 2, 4)];
    expect(planTrimToPlayhead(clips, tracks, ['a'], 1, 'start')).toEqual([{ id: 'a', time: 1 }]);
    expect(planTrimToPlayhead(clips, tracks, ['a'], 7, 'end')).toEqual([{ id: 'a', time: 7 }]);
    // the wrong side: the start cannot go past the end
    expect(planTrimToPlayhead(clips, tracks, ['a'], 7, 'start')).toEqual([]);
    expect(planTrimToPlayhead(clips, tracks, ['a'], 1, 'end')).toEqual([]);
  });

  it('a cut wins: a selected clip somewhere else does not grow while another one is cut', () => {
    const clips = [vid('a', 'v1', 0, 10), vid('c', 'v1', 20, 5)];
    expect(planTrimToPlayhead(clips, tracks, ['a', 'c'], 4, 'start')).toEqual([{ id: 'a', time: 4 }]);
  });

  it('skips clips on locked tracks', () => {
    const clips = [vid('a', 'lock', 0, 10), vid('b', 'v1', 0, 10)];
    expect(ids(planTrimToPlayhead(clips, tracks, ['a', 'b'], 4, 'end'))).toEqual(['b']);
    expect(ids(planTrimToPlayhead(clips, tracks, [], 4, 'end'))).toEqual(['b']);
  });

  it('trims an effect through its target, not twice', () => {
    const clips = [vid('a', 'v1', 0, 10), fx('e', 'fx', 0, 10, 'a')];
    expect(ids(planTrimToPlayhead(clips, tracks, [], 4, 'start'))).toEqual(['a']);
    expect(ids(planTrimToPlayhead(clips, tracks, ['a', 'e'], 4, 'end'))).toEqual(['a']);
  });

  it('trims a selected effect on its own when its target is not trimmed', () => {
    const clips = [vid('a', 'v1', 0, 10), fx('e', 'fx', 0, 10, 'a')];
    expect(planTrimToPlayhead(clips, tracks, ['e'], 4, 'start')).toEqual([{ id: 'e', time: 4 }]);
  });

  it('stops one minimum length short of the other edge', () => {
    const clips = [vid('a', 'v1', 0, 10)];
    expect(planTrimToPlayhead(clips, tracks, ['a'], 9.99, 'start')).toEqual([{ id: 'a', time: 9.95 }]);
    const [s] = planTrimToPlayhead(clips, tracks, ['a'], 0.01, 'end');
    expect(s!.time).toBeCloseTo(0.05, 9);
  });

  it('skips a clip that is already at the minimum length', () => {
    const clips = [vid('a', 'v1', 0, 0.05)];
    expect(planTrimToPlayhead(clips, tracks, ['a'], 0.02, 'start')).toEqual([]);
    expect(planTrimToPlayhead(clips, tracks, ['a'], 0.02, 'end')).toEqual([]);
  });
});
