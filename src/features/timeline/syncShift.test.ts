import { describe, expect, it } from 'vitest';
import type { Clip, EffectClip, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { movingTracks, planSyncShift, syncShiftMoves } from './syncShift';

const track = (id: string, locked = false): Track => ({ id, kind: id.startsWith('a') ? 'audio' : 'video', name: id, muted: false, hidden: false, locked });
const video = (trackId: string, id: string, start: number, duration: number): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'm', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM },
});
const fx = (trackId: string, id: string, target: string, start: number, duration: number): EffectClip => ({
  id, type: 'effect', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, effect: 'shake', params: {}, amount: 1, seed: 1, target,
});
const proj = (clips: Clip[], locked: string[] = []) => ({ clips, tracks: ['v1', 'v2', 'v3'].map((t) => track(t, locked.includes(t))) });
const ids = (list: readonly Clip[]) => list.map((c) => c.id);
const none = new Set<string>();

describe('planSyncShift', () => {
  it('moves what starts at or after the edit point', () => {
    const p = proj([video('v1', 'a', 0, 2), video('v1', 'b', 2, 2), video('v2', 'c', 3, 2), video('v2', 'd', 0, 1)]);
    const s = planSyncShift(p, 2, none, none);
    expect(ids(s.moving)).toEqual(['b', 'c']);
    expect(s.lockedBehind).toEqual([]);
  });

  it('a clip spanning the edit point stays', () => {
    const p = proj([video('v1', 'a', 0, 2), video('v1', 'b', 2, 2), video('v2', 'sp', 1, 2), video('v2', 'c', 3, 2)]);
    const s = planSyncShift(p, 2, none, none);
    expect(ids(s.moving)).toEqual(['b', 'c']);
    // nothing may move left on v2: the spanning clip ends where c starts
    expect(s.room).toBe(0);
    expect(s.first?.id).toBe('b');
    expect(s.stay?.id).toBe('a');
  });

  it('the tightest room names both clips', () => {
    const p = proj([video('v1', 'a', 0, 2), video('v1', 'b', 4, 2), video('v2', 'c', 0, 3), video('v2', 'd', 6, 2)]);
    const s = planSyncShift(p, 3.5, none, none);
    expect(s.room).toBe(2);
    expect(s.first?.id).toBe('b');
    expect(s.stay?.id).toBe('a');
  });

  it('a tie in room goes to the first track in track order', () => {
    const p = proj([video('v2', 'c', 5, 1), video('v1', 'b', 5, 1)]);
    const s = planSyncShift(p, 4, none, none);
    expect(s.room).toBe(5);
    expect(s.first?.id).toBe('b');
  });

  it('room runs to the timeline start', () => {
    const p = proj([video('v1', 'a', 1.5, 2)]);
    const s = planSyncShift(p, 1, none, none);
    expect(s.room).toBe(1.5);
    expect(s.first?.id).toBe('a');
    expect(s.stay).toBeNull();
  });

  it('nothing moves: infinite room', () => {
    const s = planSyncShift(proj([video('v1', 'a', 0, 2)]), 5, none, none);
    expect(s.moving).toEqual([]);
    expect(s.room).toBe(Infinity);
    expect(s.first).toBeNull();
    expect(s.stay).toBeNull();
  });

  it('locked tracks are listed, not moved', () => {
    const p = proj([video('v1', 'a', 2, 2), video('v2', 'l1', 3, 1), video('v2', 'l2', 6, 1), video('v3', 'k', 0, 1)], ['v2']);
    const s = planSyncShift(p, 2, none, none);
    expect(ids(s.moving)).toEqual(['a']);
    expect(s.lockedBehind).toEqual(['v2']);
  });

  it('per track points from atOf', () => {
    const p = proj([video('v1', 'a', 2, 1), video('v1', 'b', 5, 1), video('v2', 'c', 2, 1), video('v2', 'd', 5, 1)]);
    const s = planSyncShift(p, 2, none, none, new Map([['v1', 5]]));
    expect(ids(s.moving)).toEqual(['b', 'c', 'd']);
    // v1 starts moving at 5: a stays, so b has 2 s of room; v2 moves from 2 and has 2 s in front of c
    expect(s.room).toBe(2);
  });

  it('skipped clips neither move nor stay', () => {
    const p = proj([video('v1', 'a', 0, 2), video('v1', 'edited', 2, 2), video('v1', 'b', 4, 2)]);
    const s = planSyncShift(p, 4, new Set(['edited']), none);
    expect(ids(s.moving)).toEqual(['b']);
    // the edited clip is not the stay: the room runs back to a
    expect(s.stay?.id).toBe('a');
    expect(s.room).toBe(2);
    const t = planSyncShift(p, 2, new Set(['edited']), none);
    expect(ids(t.moving)).toEqual(['b']);
  });

  it('followers of movers come along', () => {
    const p = proj([video('v1', 'a', 0, 2), video('v1', 'b', 4, 2), fx('v3', 'e', 'b', 4, 2)]);
    // the effect track has its own, later edit point: only the follower rule brings the effect along
    const s = planSyncShift(p, 3, none, none, new Map([['v3', 100]]));
    expect(ids(s.moving)).toEqual(['b', 'e']);
    expect(s.room).toBe(2);
    expect(s.first?.id).toBe('b');
  });

  it('followers never count for first, stay or room', () => {
    const p = proj([video('v1', 'a', 0, 2), video('v1', 'b', 4, 2), fx('v3', 'e', 'b', 4, 2), video('v3', 'near', 3, 1)]);
    const s = planSyncShift(p, 3, none, none, new Map([['v3', 100]]));
    // v3 has no mover of its own, so only v1 gives room
    expect(s.room).toBe(2);
  });

  it('movingTracks is every unlocked track', () => {
    const tracks = [track('v1'), track('v2', true), track('a1')];
    expect([...movingTracks(tracks, new Set(['v1']))]).toEqual(['v1', 'a1']);
  });
});

describe('syncShiftMoves', () => {
  it('moves every mover and never before 0', () => {
    const p = proj([video('v1', 'a', 1, 2), video('v2', 'b', 3, 2)]);
    const s = planSyncShift(p, 0, none, none);
    expect(syncShiftMoves(s, -2)).toEqual([
      { id: 'a', trackId: 'v1', start: 0 },
      { id: 'b', trackId: 'v2', start: 1 },
    ]);
    expect(syncShiftMoves(s, 1.5)[0]).toEqual({ id: 'a', trackId: 'v1', start: 2.5 });
  });

  it('no amount, no moves', () => {
    const s = planSyncShift(proj([video('v1', 'a', 1, 2)]), 0, none, none);
    expect(syncShiftMoves(s, 0)).toEqual([]);
    expect(syncShiftMoves(s, 1e-12)).toEqual([]);
  });
});
