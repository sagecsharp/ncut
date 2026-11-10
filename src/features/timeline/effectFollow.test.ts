import { describe, expect, it } from 'vitest';
import type { Clip, Track } from '../../types';
import { findFollowers, planEffectFollow, placeFollowers } from './effectFollow';
import type { ClipSpan } from './effectFollow';

const track = (id: string, locked = false) => ({ id, kind: 'video', locked }) as unknown as Track;
const vid = (id: string, trackId: string, start: number, duration: number) => ({ id, type: 'video', trackId, start, duration }) as unknown as Clip;
const fx = (id: string, trackId: string, start: number, duration: number, target: string | null) =>
  ({ id, type: 'effect', trackId, start, duration, target }) as unknown as Clip;
const tracks = [track('fx'), track('v')];

describe('effect follow', () => {
  it('finds effects with the same start and duration as their target', () => {
    const clips = [vid('a', 'v', 2, 4), fx('e1', 'fx', 2, 4, 'a'), fx('e2', 'fx', 7, 4, 'a'), fx('e3', 'fx', 20, 1, null)];
    expect(findFollowers(clips, tracks, ['a']).map((c) => c.id)).toEqual(['e1']);
  });

  it('skips locked tracks, ids that move on their own and non visual targets', () => {
    const clips = [vid('a', 'v', 0, 2), fx('e1', 'fx', 0, 2, 'a'), fx('e2', 'fx2', 0, 2, 'a'), fx('e3', 'fx', 5, 2, 'e1')];
    const t = [...tracks, track('fx2', true)];
    expect(findFollowers(clips, t, ['a']).map((c) => c.id)).toEqual(['e1']);
    expect(findFollowers(clips, t, ['a'], new Set(['e1']))).toEqual([]);
    expect(findFollowers(clips, t, ['e1'])).toEqual([]);
  });

  it('takes the new start and duration of the target', () => {
    const clips = [vid('a', 'v', 2, 4), fx('e1', 'fx', 2, 4, 'a')];
    const out = planEffectFollow(clips, tracks, new Map<string, ClipSpan>([['a', { start: 10, duration: 3 }]]));
    expect(out).toEqual([{ id: 'e1', start: 10, duration: 3 }]);
  });

  it('stays put when its track has no room', () => {
    const clips = [vid('a', 'v', 2, 4), fx('e1', 'fx', 2, 4, 'a'), fx('block', 'fx', 8, 4, null)];
    const out = planEffectFollow(clips, tracks, new Map<string, ClipSpan>([['a', { start: 6, duration: 4 }]]));
    expect(out).toEqual([{ id: 'e1', start: 2, duration: 4 }]);
  });

  it('may move into the place another following effect leaves', () => {
    const clips = [vid('a', 'v', 0, 2), vid('b', 'v', 2, 2), fx('ea', 'fx', 0, 2, 'a'), fx('eb', 'fx', 2, 2, 'b')];
    const changes = new Map<string, ClipSpan>([
      ['a', { start: 2, duration: 2 }],
      ['b', { start: 4, duration: 2 }],
    ]);
    const out = planEffectFollow(clips, tracks, changes);
    expect(out.find((r) => r.id === 'ea')).toEqual({ id: 'ea', start: 2, duration: 2 });
    expect(out.find((r) => r.id === 'eb')).toEqual({ id: 'eb', start: 4, duration: 2 });
  });

  it('never goes before zero', () => {
    const clips = [vid('a', 'v', 1, 2), fx('e1', 'fx', 1, 2, 'a')];
    const followers = findFollowers(clips, tracks, ['a']);
    expect(placeFollowers(clips, followers, new Map([['a', { start: -1, duration: 2 }]]))).toEqual([{ id: 'e1', start: 1, duration: 2 }]);
  });

  it('is empty when nothing follows', () => {
    expect(placeFollowers([], [], new Map())).toEqual([]);
  });
});
