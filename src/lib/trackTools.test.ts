import { describe, expect, it } from 'vitest';
import type { Clip, Project, Track } from '../types';
import { createProject, createTrack } from './factory';
import { DEFAULT_TRACK_H, TRACK_H_MAX, TRACK_H_MIN, TRACK_SIZES, keepHeights, normalHeights, stepHeights, stepIndex, syncLockOf, syncOffAfter, syncTrackIds, timelineOnlyChange, trackHeightOf, tracksOf, withHeight } from './trackTools';

const tr = (id: string, kind: 'video' | 'audio', over: Partial<Track> = {}): Track => ({ ...createTrack(kind, id), id, ...over });
const clipOn = (id: string, trackId: string, start = 0): Clip => ({ id, trackId, start, duration: 2 }) as unknown as Clip;

describe('trackHeightOf', () => {
  it('trackHeightOf rounds and clamps', () => {
    expect(trackHeightOf({ kind: 'video' })).toBe(56);
    expect(trackHeightOf({ kind: 'audio' })).toBe(48);
    expect(trackHeightOf({ kind: 'video', height: 60.4 })).toBe(60);
    expect(trackHeightOf({ kind: 'video', height: 60.6 })).toBe(61);
    expect(trackHeightOf({ kind: 'audio', height: 3 })).toBe(TRACK_H_MIN);
    expect(trackHeightOf({ kind: 'audio', height: 9000 })).toBe(TRACK_H_MAX);
    expect(trackHeightOf({ kind: 'audio', height: Number.NaN })).toBe(48);
    expect(trackHeightOf({ kind: 'video', height: Infinity })).toBe(56);
  });
});

describe('withHeight', () => {
  it('withHeight stores the default as missing', () => {
    const t = tr('v', 'video');
    const tall = withHeight(t, 96);
    expect(tall.height).toBe(96);
    const back = withHeight(tall, 56);
    expect('height' in back).toBe(false);
    expect('height' in withHeight(tall, null)).toBe(false);
    // the audio default is 48
    expect('height' in withHeight(tr('a', 'audio', { height: 96 }), 48)).toBe(false);
    expect(withHeight(tr('a', 'audio'), 56).height).toBe(56);
  });
  it('the same track comes back when nothing changes', () => {
    const t = tr('v', 'video');
    expect(withHeight(t, null)).toBe(t);
    expect(withHeight(t, 56)).toBe(t);
    const tall = withHeight(t, 96);
    expect(withHeight(tall, 96)).toBe(tall);
    expect(withHeight(tall, 96.2)).toBe(tall);
    expect(withHeight(t, 1000).height).toBe(TRACK_H_MAX);
  });
});

describe('stepHeights', () => {
  it('stepHeights stops at the ends, onto the default is null', () => {
    const v = tr('v', 'video');
    const a = tr('a', 'audio');
    expect(stepHeights([v, a], 1)).toEqual({ v: 72, a: 56 });
    expect(stepHeights([v, a], -1)).toEqual({ v: 48, a: 36 });
    expect(stepHeights([tr('v', 'video', { height: 48 })], 1)).toEqual({ v: null });
    expect(stepHeights([tr('a', 'audio', { height: 36 })], 1)).toEqual({ a: null });
    expect(stepHeights([tr('a', 'audio', { height: 72 })], -1)).toEqual({ a: 56 });
    // the ends are not in the patch
    expect(stepHeights([tr('v', 'video', { height: TRACK_H_MAX })], 1)).toEqual({});
    expect(stepHeights([tr('v', 'video', { height: TRACK_H_MIN })], -1)).toEqual({});
    expect(stepHeights([], 1)).toEqual({});
  });
  it('a height off the ladder goes to the next rung', () => {
    expect(stepHeights([tr('v', 'video', { height: 60 })], 1)).toEqual({ v: 72 });
    expect(stepHeights([tr('v', 'video', { height: 60 })], -1)).toEqual({ v: null });
  });
  it('both defaults are on the ladder', () => {
    expect(TRACK_SIZES).toContain(DEFAULT_TRACK_H.video);
    expect(TRACK_SIZES).toContain(DEFAULT_TRACK_H.audio);
  });
});

describe('normalHeights', () => {
  it('normalHeights lists only stored heights', () => {
    const tracks = [tr('v', 'video', { height: 96 }), tr('a', 'audio'), tr('b', 'audio', { height: 28 })];
    expect(normalHeights(tracks)).toEqual({ v: null, b: null });
    expect(normalHeights([tr('a', 'audio')])).toEqual({});
  });
});

describe('keepHeights', () => {
  it('keepHeights same array when nothing differs', () => {
    const snap = [tr('v', 'video', { height: 96 }), tr('a', 'audio')];
    expect(keepHeights(snap, [...snap])).toBe(snap);
    expect(keepHeights(snap, [{ ...snap[0]! }, { ...snap[1]! }])).toBe(snap);
    // a track that is not there any more is skipped
    expect(keepHeights(snap, [snap[1]!])).toBe(snap);
  });
  it('the heights of now, by id, in the order of the snap', () => {
    const snap = [tr('v', 'video', { height: 96 }), tr('a', 'audio'), tr('b', 'audio')];
    const now = [tr('b', 'audio', { height: 128 }), tr('a', 'audio'), tr('v', 'video')];
    const out = keepHeights(snap, now);
    expect(out).not.toBe(snap);
    expect(out.map((t) => t.id)).toEqual(['v', 'a', 'b']);
    expect(out.map((t) => t.height)).toEqual([undefined, undefined, 128]);
    expect('height' in out[0]!).toBe(false);
    // the snap is not touched, an unchanged track is the same object
    expect(snap[0]!.height).toBe(96);
    expect(out[1]).toBe(snap[1]);
  });
});

describe('syncLockOf', () => {
  it('only false turns it off', () => {
    expect(syncLockOf({})).toBe(true);
    expect(syncLockOf({ syncLock: false })).toBe(false);
  });
});

describe('syncTrackIds', () => {
  it('syncTrackIds', () => {
    const tracks = [
      { id: 'a', locked: false },
      { id: 'b', locked: false, syncLock: false },
      { id: 'c', locked: true },
      { id: 'd', locked: true, syncLock: false },
      { id: 'e', locked: false, syncLock: false },
    ];
    // nothing edited: unlocked tracks with sync lock on
    expect([...syncTrackIds(tracks, new Set())]).toEqual(['a']);
    // an edited track moves when it is unlocked, whatever its sync lock says
    expect([...syncTrackIds(tracks, new Set(['b', 'e']))].sort()).toEqual(['a', 'b', 'e']);
    // a locked track never moves, edited or not
    expect(syncTrackIds(tracks, new Set(['c', 'd'])).has('c')).toBe(false);
    expect(syncTrackIds(tracks, new Set(['c', 'd'])).has('d')).toBe(false);
    // a missing sync lock is on
    expect(syncTrackIds([{ id: 'x', locked: false }], new Set()).has('x')).toBe(true);
  });
});

describe('syncOffAfter', () => {
  it('syncOffAfter', () => {
    const tracks = [tr('a', 'audio', { syncLock: false }), tr('v', 'video'), tr('l', 'audio', { syncLock: false, locked: true })];
    const p = { tracks, clips: [clipOn('c1', 'a', 5), clipOn('c2', 'v', 9), clipOn('c3', 'l', 9)] };
    expect(syncOffAfter(p, 5)).toBe(true);
    expect(syncOffAfter(p, 5 + 1e-7)).toBe(true);
    expect(syncOffAfter(p, 6)).toBe(false);
    // a locked sync lock off track and a sync lock on track do not count
    expect(syncOffAfter({ tracks, clips: [clipOn('c2', 'v', 9), clipOn('c3', 'l', 9)] }, 0)).toBe(false);
    expect(syncOffAfter({ tracks: [tr('v', 'video')], clips: [clipOn('c', 'v', 9)] }, 0)).toBe(false);
  });
});

describe('stepIndex', () => {
  it('stepIndex', () => {
    const tracks = [tr('v1', 'video'), tr('v2', 'video'), tr('a1', 'audio'), tr('a2', 'audio')];
    expect(stepIndex(tracks, 'v2', -1)).toBe(0);
    expect(stepIndex(tracks, 'v1', -1)).toBeNull();
    // the end of the kind
    expect(stepIndex(tracks, 'v2', 1)).toBeNull();
    expect(stepIndex(tracks, 'a1', -1)).toBeNull();
    expect(stepIndex(tracks, 'a1', 1)).toBe(3);
    expect(stepIndex(tracks, 'a2', 1)).toBeNull();
    expect(stepIndex(tracks, 'nope', 1)).toBeNull();
  });
});

describe('tracksOf', () => {
  it('tracksOf keeps track order', () => {
    const p = { tracks: [tr('v', 'video'), tr('a', 'audio'), tr('b', 'audio')], clips: [clipOn('c1', 'b'), clipOn('c2', 'v'), clipOn('c3', 'b'), clipOn('c4', 'a')] };
    expect(tracksOf(p, ['c1', 'c2', 'c3'])).toEqual(['v', 'b']);
    expect(tracksOf(p, [])).toEqual([]);
    expect(tracksOf(p, ['zzz'])).toEqual([]);
  });
});

describe('timelineOnlyChange', () => {
  const base = (): Project => {
    const p = createProject('t');
    return { ...p, tracks: [tr('v1', 'video'), tr('v2', 'video'), tr('a1', 'audio')] };
  };
  it('a height or a sync lock is a timeline only change', () => {
    const p = base();
    expect(timelineOnlyChange(p, { ...p, tracks: [withHeight(p.tracks[0]!, 96), p.tracks[1]!, p.tracks[2]!] })).toBe(true);
    expect(timelineOnlyChange(p, { ...p, tracks: [p.tracks[0]!, p.tracks[1]!, { ...p.tracks[2]!, syncLock: false }] })).toBe(true);
  });
  it('timelineOnlyChange never a reorder', () => {
    const p = base();
    expect(timelineOnlyChange(p, { ...p, tracks: [p.tracks[1]!, p.tracks[0]!, p.tracks[2]!] })).toBe(false);
    // a reorder plus a height is still a reorder
    expect(timelineOnlyChange(p, { ...p, tracks: [withHeight(p.tracks[1]!, 96), p.tracks[0]!, p.tracks[2]!] })).toBe(false);
  });
  it('never a mute, a level or another project field', () => {
    const p = base();
    expect(timelineOnlyChange(p, { ...p, tracks: [{ ...p.tracks[0]!, muted: true }, p.tracks[1]!, p.tracks[2]!] })).toBe(false);
    expect(timelineOnlyChange(p, { ...p, tracks: [p.tracks[0]!, p.tracks[1]!, { ...p.tracks[2]!, volume: 0.5 }] })).toBe(false);
    expect(timelineOnlyChange(p, { ...p, tracks: [...p.tracks], name: 'other' })).toBe(false);
    expect(timelineOnlyChange(p, { ...p, tracks: p.tracks.slice(1) })).toBe(false);
    expect(timelineOnlyChange(p, p)).toBe(false);
    // the same tracks array, another project
    expect(timelineOnlyChange(p, { ...p, name: 'x' })).toBe(false);
  });
});
