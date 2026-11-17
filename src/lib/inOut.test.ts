import { describe, expect, it } from 'vitest';
import type { AudioClip, CameraClip, Clip, EffectClip, Project, Track, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import {
  cleanRange,
  editSpan,
  editTime,
  editableTrackIds,
  frameAt,
  inOutSpan,
  lastFrameIn,
  lastFrameStart,
  markClipSpan,
  markOutTime,
  playheadStops,
  rangeEditBlock,
  rangeTimes,
  sameRange,
  selectionSpan,
  withIn,
  withOut,
} from './inOut';

const trk = (id: string, locked = false, kind: Track['kind'] = 'video'): Track => ({ id, kind, name: id, muted: false, hidden: false, locked });
const base = { fadeIn: 0, fadeOut: 0, name: 'c' };
const vid = (id: string, trackId: string, start: number, duration: number): VideoClip => ({
  ...base,
  id,
  trackId,
  start,
  duration,
  type: 'video',
  assetId: 'a',
  trimStart: 0,
  speed: 1,
  volume: 1,
  muted: false,
  transform: { ...DEFAULT_TRANSFORM },
});
const aud = (id: string, trackId: string, start: number, duration: number): AudioClip => ({
  ...base,
  id,
  trackId,
  start,
  duration,
  type: 'audio',
  assetId: 'a',
  trimStart: 0,
  speed: 1,
  volume: 1,
  muted: false,
});
const fx = (id: string, trackId: string, start: number, duration: number): EffectClip => ({
  ...base,
  id,
  trackId,
  start,
  duration,
  type: 'effect',
  effect: 'shake',
  amount: 1,
  params: {},
  seed: 0,
});
const cam = (id: string, trackId: string, start: number, duration: number): CameraClip => ({
  ...base,
  id,
  trackId,
  start,
  duration,
  type: 'camera',
  x: 0,
  y: 0,
  z: 0,
  pan: 0,
  tilt: 0,
  roll: 0,
  fov: 50,
});
const proj = (tracks: Track[], clips: Clip[], range?: Project['range']): Pick<Project, 'clips' | 'tracks' | 'range'> => ({ tracks, clips, ...(range ? { range } : {}) });

describe('cleanRange', () => {
  it('drops bad marks', () => {
    expect(cleanRange({ in: -1, out: 2 })).toEqual({ out: 2 });
    expect(cleanRange({ in: NaN, out: Infinity })).toBeNull();
    expect(cleanRange({ in: 1, out: '3' as unknown as number })).toEqual({ in: 1 });
  });
  it('drops an out at or near 0 and an out that is not after the in', () => {
    expect(cleanRange({ out: 0 })).toBeNull();
    expect(cleanRange({ out: 1e-7 })).toBeNull();
    expect(cleanRange({ in: 2, out: 2 })).toEqual({ in: 2 });
    expect(cleanRange({ in: 2, out: 1 })).toEqual({ in: 2 });
    expect(cleanRange({ in: 2, out: 2 + 1e-7 })).toEqual({ in: 2 });
  });
  it('keeps an in of 0', () => {
    expect(cleanRange({ in: 0 })).toEqual({ in: 0 });
  });
  it('is null for nothing and always a new object', () => {
    expect(cleanRange(null)).toBeNull();
    expect(cleanRange(undefined)).toBeNull();
    expect(cleanRange({})).toBeNull();
    const r = { in: 1, out: 2 };
    const c = cleanRange(r)!;
    expect(c).toEqual(r);
    expect(c).not.toBe(r);
  });
  it('writes only the set keys', () => {
    expect(Object.keys(cleanRange({ in: 1, out: undefined })!)).toEqual(['in']);
    expect(Object.keys(cleanRange({ out: 3 })!)).toEqual(['out']);
  });
});

describe('sameRange', () => {
  it('both null is the same', () => {
    expect(sameRange(null, null)).toBe(true);
    expect(sameRange({ in: 1 }, null)).toBe(false);
    expect(sameRange(null, { out: 1 })).toBe(false);
  });
  it('compares in and out', () => {
    expect(sameRange({ in: 1, out: 2 }, { in: 1, out: 2 })).toBe(true);
    expect(sameRange({ in: 1 }, { in: 1, out: 2 })).toBe(false);
    expect(sameRange({ in: 1, out: 2 }, { in: 1, out: 3 })).toBe(false);
  });
});

describe('frameAt', () => {
  it('lands on the frame start', () => {
    expect(frameAt(1.51, 30)).toBeCloseTo(1.5, 9);
    expect(frameAt(0, 30)).toBe(0);
  });
  it('forgives noise 1e-6 below a line at 23.976 fps', () => {
    const fps = 23.976;
    const line = 48 / fps;
    expect(frameAt(line - 1e-8, fps)).toBeCloseTo(48 / fps, 9);
    expect(frameAt(line - 1e-8, fps) * fps).toBeCloseTo(48, 6);
    // clearly below the line is the frame before
    expect(frameAt(line - 0.01, fps) * fps).toBeCloseTo(47, 6);
  });
});

describe('markOutTime', () => {
  it('ends the frame on screen', () => {
    expect(markOutTime(1.51, 30, 10)).toBeCloseTo(1.5 + 1 / 30, 9);
  });
  it('stops at the end', () => {
    expect(markOutTime(9.99, 30, 10)).toBe(10);
    expect(markOutTime(10, 30, 10)).toBe(10);
  });
});

describe('lastFrameStart and lastFrameIn', () => {
  it('is the start of the last frame before the end', () => {
    expect(lastFrameStart(0, 1, 30)).toBeCloseTo(29 / 30, 9);
    expect(lastFrameStart(0, 10, 24)).toBeCloseTo(239 / 24, 9);
  });
  it('never goes before the start', () => {
    expect(lastFrameStart(2, 2.001, 30)).toBe(2);
    expect(lastFrameStart(5, 1, 30)).toBe(5);
  });
  it('an end between lines is the frame it falls in', () => {
    expect(lastFrameStart(0, 1.01, 30)).toBeCloseTo(1, 9);
    expect(lastFrameIn({ in: 0, out: 1.01 }, 30)).toBeCloseTo(1, 9);
    expect(lastFrameIn({ out: 1.01 }, 30)).toBeCloseTo(1, 9);
  });
  it('lastFrameIn is null without an out', () => {
    expect(lastFrameIn(null, 30)).toBeNull();
    expect(lastFrameIn({ in: 1 }, 30)).toBeNull();
  });
});

describe('inOutSpan and editSpan', () => {
  it('cuts to the project', () => {
    expect(inOutSpan({ in: 2, out: 4 }, 10)).toEqual({ start: 2, end: 4 });
    expect(inOutSpan({ in: 2, out: 40 }, 10)).toEqual({ start: 2, end: 10 });
    expect(inOutSpan({ in: 2 }, 10)).toEqual({ start: 2, end: 10 });
    expect(inOutSpan({ out: 4 }, 10)).toEqual({ start: 0, end: 4 });
  });
  it('is null without a range, without a project or when nothing is inside', () => {
    expect(inOutSpan(null, 10)).toBeNull();
    expect(inOutSpan({ in: 2, out: 4 }, 0)).toBeNull();
    expect(inOutSpan({ in: 12, out: 14 }, 10)).toBeNull();
    expect(inOutSpan({ in: 10 }, 10)).toBeNull();
  });
  it('editSpan needs both marks and is not cut to the project', () => {
    expect(editSpan({ in: 2, out: 40 })).toEqual({ start: 2, end: 40 });
    expect(editSpan({ in: 2 })).toBeNull();
    expect(editSpan({ out: 2 })).toBeNull();
    expect(editSpan(null)).toBeNull();
  });
});

describe('withIn and withOut', () => {
  it('set the mark and keep the other', () => {
    expect(withIn({ in: 1, out: 5 }, 2)).toEqual({ range: { in: 2, out: 5 }, dropped: false });
    expect(withOut({ in: 1, out: 5 }, 4)).toEqual({ range: { in: 1, out: 4 }, dropped: false });
    expect(withIn(null, 2)).toEqual({ range: { in: 2 }, dropped: false });
    expect(withOut(undefined, 2)).toEqual({ range: { out: 2 }, dropped: false });
  });
  it('crossing drops the other mark', () => {
    expect(withIn({ in: 1, out: 5 }, 6)).toEqual({ range: { in: 6 }, dropped: true });
    expect(withIn({ in: 1, out: 5 }, 5)).toEqual({ range: { in: 5 }, dropped: true });
    expect(withOut({ in: 3, out: 5 }, 2)).toEqual({ range: { out: 2 }, dropped: true });
    expect(withOut({ in: 3, out: 5 }, 3)).toEqual({ range: { out: 3 }, dropped: true });
  });
  it('one frame ranges stay', () => {
    const f = 1 / 30;
    expect(withIn({ in: 0, out: 1 + f }, 1)).toEqual({ range: { in: 1, out: 1 + f }, dropped: false });
    expect(withOut({ in: 1 }, 1 + f)).toEqual({ range: { in: 1, out: 1 + f }, dropped: false });
  });
});

describe('rangeTimes, playheadStops and editTime', () => {
  it('rangeTimes lists the set marks', () => {
    expect(rangeTimes({ in: 1, out: 3 })).toEqual([1, 3]);
    expect(rangeTimes({ out: 3 })).toEqual([3]);
    expect(rangeTimes(null)).toEqual([]);
  });
  it('playheadStops is the in and the last frame inside', () => {
    expect(playheadStops({ in: 1, out: 2 }, 30)[0]).toBe(1);
    expect(playheadStops({ in: 1, out: 2 }, 30)[1]).toBeCloseTo(59 / 30, 9);
    expect(playheadStops({ in: 1 }, 30)).toEqual([1]);
    expect(playheadStops({ out: 2 }, 30)).toHaveLength(1);
    expect(playheadStops(undefined, 30)).toEqual([]);
  });
  it('editTime is the in, else the playhead', () => {
    expect(editTime({ in: 2 }, 5)).toBe(2);
    expect(editTime({ in: 0 }, 5)).toBe(0);
    expect(editTime({ out: 9 }, 5)).toBe(5);
    expect(editTime(null, 5)).toBe(5);
  });
});

describe('markClipSpan', () => {
  const tracks = [trk('v2'), trk('v1'), trk('a1', false, 'audio')];
  it('the clip under t', () => {
    const p = { tracks, clips: [vid('a', 'v1', 0, 4), vid('b', 'v1', 6, 4)] };
    const s = markClipSpan(p, 2, [])!;
    expect(s.clip?.id).toBe('a');
    expect([s.start, s.end]).toEqual([0, 4]);
  });
  it('at a join the next clip wins', () => {
    const p = { tracks, clips: [vid('a', 'v1', 0, 4), vid('b', 'v1', 4, 4)] };
    expect(markClipSpan(p, 4, [])!.clip?.id).toBe('b');
    expect(markClipSpan(p, 4 - 1e-7, [])!.clip?.id).toBe('b');
    expect(markClipSpan(p, 3.9, [])!.clip?.id).toBe('a');
  });
  it('a selected clip wins, then the topmost track', () => {
    const p = { tracks, clips: [vid('low', 'v1', 0, 4), vid('top', 'v2', 0, 4), aud('snd', 'a1', 0, 4)] };
    expect(markClipSpan(p, 1, [])!.clip?.id).toBe('top');
    expect(markClipSpan(p, 1, ['low'])!.clip?.id).toBe('low');
    expect(markClipSpan(p, 1, ['snd'])!.clip?.id).toBe('snd');
  });
  it('skips effects and cameras while a picture or sound is under', () => {
    const p = { tracks, clips: [fx('f', 'v2', 0, 10), cam('c', 'v2', 0, 10), vid('a', 'v1', 2, 3)] };
    expect(markClipSpan(p, 3, [])!.clip?.id).toBe('a');
    // an effect alone is still a clip
    expect(markClipSpan(p, 7, [])!.clip?.id).toBe('f');
  });
  it('locked and hidden tracks count', () => {
    const p = { tracks: [trk('v1', true)], clips: [vid('a', 'v1', 0, 4)] };
    expect(markClipSpan(p, 1, [])!.clip?.id).toBe('a');
  });
  it('over nothing it is the gap', () => {
    const p = { tracks, clips: [vid('a', 'v1', 0, 2), vid('b', 'v1', 5, 3), aud('s', 'a1', 3, 1)] };
    const g = markClipSpan(p, 2.5, [])!;
    expect(g.clip).toBeNull();
    expect([g.start, g.end]).toEqual([2, 3]);
    const g2 = markClipSpan(p, 4.5, [])!;
    expect([g2.start, g2.end]).toEqual([4, 5]);
  });
  it('a gap before the first clip starts at 0', () => {
    const p = { tracks, clips: [vid('a', 'v1', 3, 2)] };
    const g = markClipSpan(p, 1, [])!;
    expect([g.start, g.end]).toEqual([0, 3]);
  });
  it('null at or past the project end and for an empty project', () => {
    const p = { tracks, clips: [vid('a', 'v1', 0, 4)] };
    expect(markClipSpan(p, 4, [])).toBeNull();
    expect(markClipSpan(p, 9, [])).toBeNull();
    expect(markClipSpan({ tracks, clips: [] }, 0, [])).toBeNull();
  });
});

describe('selectionSpan', () => {
  const clips = [vid('a', 'v1', 1, 2), vid('b', 'v1', 5, 3), vid('c', 'v1', 9, 1)];
  it('runs from the first start to the last end', () => {
    expect(selectionSpan({ clips }, ['a', 'b'])).toEqual({ start: 1, end: 8 });
    expect(selectionSpan({ clips }, ['c'])).toEqual({ start: 9, end: 10 });
  });
  it('is null for nothing selected', () => {
    expect(selectionSpan({ clips }, [])).toBeNull();
    expect(selectionSpan({ clips }, ['zzz'])).toBeNull();
  });
});

describe('editableTrackIds', () => {
  it('is the unlocked tracks', () => {
    const ids = editableTrackIds({ tracks: [trk('a'), trk('b', true), trk('c')] });
    expect([...ids]).toEqual(['a', 'c']);
  });
});

describe('rangeEditBlock', () => {
  const tracks = [trk('v1'), trk('v2', true)];
  it("both: a mark is missing", () => {
    expect(rangeEditBlock(proj(tracks, []), false)).toBe('both');
    expect(rangeEditBlock(proj(tracks, [], { in: 1 }), true)).toBe('both');
  });
  it('null when an unlocked clip is inside', () => {
    expect(rangeEditBlock(proj(tracks, [vid('a', 'v1', 0, 10)], { in: 2, out: 4 }), false)).toBeNull();
  });
  it("nothing: no clip in the way", () => {
    expect(rangeEditBlock(proj(tracks, [vid('a', 'v1', 0, 1)], { in: 2, out: 4 }), false)).toBe('nothing');
    expect(rangeEditBlock(proj(tracks, [], { in: 2, out: 4 }), true)).toBe('nothing');
  });
  it('nothing: a clip that only touches the span does not count', () => {
    const p = proj(tracks, [vid('a', 'v1', 0, 2), vid('b', 'v1', 4, 1)], { in: 2, out: 4 });
    expect(rangeEditBlock(p, false)).toBe('nothing');
    // extract: the one after the out point moves
    expect(rangeEditBlock(p, true)).toBeNull();
  });
  it('locked: only locked tracks are inside', () => {
    const p = proj(tracks, [vid('a', 'v2', 0, 10)], { in: 2, out: 4 });
    expect(rangeEditBlock(p, false)).toBe('locked');
    expect(rangeEditBlock(p, true)).toBe('locked');
  });
  it('a locked clip after the span alone is nothing, not locked', () => {
    const p = proj(tracks, [vid('a', 'v2', 5, 2)], { in: 2, out: 4 });
    expect(rangeEditBlock(p, true)).toBe('nothing');
  });
  it('an unlocked clip anywhere in reach wins over a locked one', () => {
    const p = proj(tracks, [vid('a', 'v2', 0, 10), vid('b', 'v1', 3, 1)], { in: 2, out: 4 });
    expect(rangeEditBlock(p, false)).toBeNull();
  });
});
