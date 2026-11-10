import { describe, expect, it } from 'vitest';
import type { Clip, Track } from '../../types';
import { followerSpans, withFollowerMoves } from './followMoves';

const track = (id: string, locked = false) => ({ id, kind: 'video', locked }) as unknown as Track;
const clip = (id: string, trackId: string, start: number, duration = 2) => ({ id, type: 'video', trackId, start, duration }) as unknown as Clip;
const fx = (id: string, trackId: string, target: string, start: number, duration = 2) =>
  ({ id, type: 'effect', trackId, start, duration, target }) as unknown as Clip;

const tracks = [track('v'), track('e'), track('l', true)];

describe('withFollowerMoves', () => {
  const clips = [clip('a', 'v', 1), fx('f', 'e', 'a', 1), fx('g', 'e', 'a', 5)];
  it('adds the follower of a moved clip, not an effect that does not match', () => {
    const r = withFollowerMoves(clips, tracks, [{ id: 'a', trackId: 'v', start: 3 }]);
    expect(r).toEqual([
      { id: 'a', trackId: 'v', start: 3 },
      { id: 'f', trackId: 'e', start: 3 },
    ]);
  });
  it('leaves a follower where it is when its track has no room', () => {
    const c = [...clips, clip('x', 'e', 3.5, 1)] as Clip[];
    const r = withFollowerMoves(c, [track('v'), { ...track('e'), kind: 'video' }], [{ id: 'a', trackId: 'v', start: 3 }]);
    expect(r.map((m) => m.id)).toEqual(['a']);
  });
  it('does not double a follower that already moves', () => {
    const r = withFollowerMoves(clips, tracks, [
      { id: 'a', trackId: 'v', start: 2 },
      { id: 'f', trackId: 'e', start: 2 },
    ]);
    expect(r).toHaveLength(2);
  });
  it('drops an effect whose clip stays (locked clip track)', () => {
    const c = [clip('a', 'l', 1), fx('f', 'e', 'a', 1)];
    const moves = [{ id: 'f', trackId: 'e', start: 2 }];
    expect(withFollowerMoves(c, tracks, moves, true)).toEqual([]);
    expect(withFollowerMoves(c, tracks, moves)).toEqual(moves);
  });
});

describe('followerSpans', () => {
  it('lists the followers with the new span', () => {
    const clips = [clip('a', 'v', 1), fx('f', 'e', 'a', 1)];
    expect(followerSpans(clips, tracks, 'a', { start: 1, duration: 1 })).toEqual([{ id: 'f', start: 1, duration: 1 }]);
    expect(followerSpans(clips, tracks, 'a', { start: 1, duration: 2 })).toEqual([]);
  });
});
