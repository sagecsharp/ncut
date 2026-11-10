import { describe, expect, it } from 'vitest';
import type { AudioClip, Clip, ImageClip, Project, Track, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import {
  clipEnd,
  clipsAtTime,
  collectSnapPoints,
  fadeFactor,
  findFreeStart,
  findTrackWithRoom,
  isRangeFree,
  maxClipDuration,
  normalizeTrackOrder,
  projectDuration,
  rangesOverlap,
  snapTime,
  sourceTimeAt,
} from './timelineOps';

let n = 0;
function video(trackId: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip {
  return {
    id: `v${++n}`,
    type: 'video',
    trackId,
    start,
    duration,
    name: 'v',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'a',
    trimStart: 0,
    speed: 1,
    volume: 1,
    muted: false,
    transform: { ...DEFAULT_TRANSFORM },
    ...over,
  };
}
function image(trackId: string, start: number, duration: number): ImageClip {
  return {
    id: `i${++n}`,
    type: 'image',
    trackId,
    start,
    duration,
    name: 'i',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'b',
    transform: { ...DEFAULT_TRANSFORM },
  };
}
function audio(trackId: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip {
  return {
    id: `a${++n}`,
    type: 'audio',
    trackId,
    start,
    duration,
    name: 'a',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'c',
    trimStart: 0,
    speed: 1,
    volume: 1,
    muted: false,
    ...over,
  };
}
function track(id: string, kind: 'video' | 'audio', locked = false): Track {
  return { id, kind, name: id, muted: false, hidden: false, locked };
}
function proj(clips: Clip[], tracks: Track[] = [track('t1', 'video'), track('t2', 'audio')]): Project {
  return {
    id: 'p',
    name: 'p',
    createdAt: 0,
    updatedAt: 0,
    width: 1920,
    height: 1080,
    fps: 30,
    background: '#000',
    assets: [],
    tracks,
    clips,
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('clipEnd / projectDuration', () => {
  it('clipEnd is start + duration', () => {
    expect(clipEnd({ start: 2, duration: 3 })).toBe(5);
  });
  it('projectDuration is the max end, 0 when empty', () => {
    expect(projectDuration({ clips: [] })).toBe(0);
    expect(projectDuration(proj([video('t1', 0, 2), audio('t2', 1, 7), video('t1', 3, 1)]))).toBe(8);
  });
});

describe('rangesOverlap / isRangeFree', () => {
  it('touching edges do not overlap', () => {
    expect(rangesOverlap(0, 1, 1, 2)).toBe(false);
    expect(rangesOverlap(1, 2, 0, 1)).toBe(false);
  });
  it('detects real overlap and containment', () => {
    expect(rangesOverlap(0, 2, 1, 3)).toBe(true);
    expect(rangesOverlap(0, 10, 3, 4)).toBe(true);
    expect(rangesOverlap(3, 4, 0, 10)).toBe(true);
  });
  it('isRangeFree: touching is free, overlap is not', () => {
    const p = proj([video('t1', 2, 2)]);
    expect(isRangeFree(p, 't1', 0, 2)).toBe(true);
    expect(isRangeFree(p, 't1', 4, 2)).toBe(true);
    expect(isRangeFree(p, 't1', 1, 2)).toBe(false);
    expect(isRangeFree(p, 't1', 3, 2)).toBe(false);
    expect(isRangeFree(p, 't1', 0, 10)).toBe(false);
  });
  it('only looks at the given track', () => {
    const p = proj([video('t1', 0, 5)]);
    expect(isRangeFree(p, 'other', 0, 5)).toBe(true);
  });
  it('negative start is never free', () => {
    expect(isRangeFree(proj([]), 't1', -1, 1)).toBe(false);
  });
  it('ignoreIds are skipped', () => {
    const c = video('t1', 0, 5);
    const p = proj([c]);
    expect(isRangeFree(p, 't1', 1, 2, [c.id])).toBe(true);
  });
});

describe('findFreeStart', () => {
  const c = video('t1', 2, 2); // [2,4)
  const p = proj([c]);
  it('returns the desired start when free', () => {
    expect(findFreeStart(p, 't1', 5, 1)).toBe(5);
    expect(findFreeStart(p, 't1', 1, 1)).toBe(1);
  });
  it('pushes after the blocking clip when that is closer', () => {
    expect(findFreeStart(p, 't1', 3.5, 1)).toBe(4);
  });
  it('pushes before the blocking clip when that is closer', () => {
    expect(findFreeStart(p, 't1', 2.2, 1)).toBe(1);
  });
  it('clamps negative desired to 0', () => {
    expect(findFreeStart(proj([]), 't1', -5, 1)).toBe(0);
    expect(findFreeStart(p, 't1', -5, 1)).toBe(0);
  });
  it('never goes below 0 when pushing before a clip near the start', () => {
    const q = proj([video('t1', 0.5, 2)]);
    const s = findFreeStart(q, 't1', 1, 1);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(isRangeFree(q, 't1', s, 1)).toBe(true);
    expect(s).toBe(2.5);
  });
  it('skips gaps that are too small', () => {
    const q = proj([video('t1', 0, 1), video('t1', 1.5, 1.5)]);
    expect(findFreeStart(q, 't1', 1, 1)).toBe(3);
  });
  it('uses a gap that fits exactly', () => {
    const q = proj([video('t1', 0, 1), video('t1', 2, 1)]);
    expect(findFreeStart(q, 't1', 1.4, 1)).toBe(1);
  });
  it('ignoreIds lets a clip move over itself', () => {
    expect(findFreeStart(p, 't1', 2.5, 2, [c.id])).toBe(2.5);
  });
  it('property: result is >= 0, never overlaps, and is (almost) the nearest free start', () => {
    const rnd = mulberry32(1234);
    for (let iter = 0; iter < 300; iter++) {
      const clips: Clip[] = [];
      let cursor = rnd() * 2;
      const count = Math.floor(rnd() * 7);
      for (let i = 0; i < count; i++) {
        const dur = 0.2 + rnd() * 3;
        clips.push(video('t1', cursor, dur));
        cursor += dur + (rnd() < 0.3 ? 0 : rnd() * 2);
      }
      const q = proj(clips);
      const want = rnd() * 20 - 3;
      const dur = 0.1 + rnd() * 3;
      const ignore = clips.length > 0 && rnd() < 0.2 ? [clips[0]!.id] : [];
      const s = findFreeStart(q, 't1', want, dur, ignore);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(isRangeFree(q, 't1', s, dur, ignore)).toBe(true);
      const d = Math.abs(s - Math.max(0, want));
      for (let g = 0; g <= 30; g += 0.02) {
        if (!isRangeFree(q, 't1', g, dur, ignore)) continue;
        expect(Math.abs(g - Math.max(0, want))).toBeGreaterThanOrEqual(d - 0.021);
      }
    }
  });
});

describe('findTrackWithRoom', () => {
  it('finds the first matching unlocked track with room', () => {
    const tracks = [track('v1', 'video'), track('v2', 'video'), track('a1', 'audio')];
    const p = proj([video('v1', 0, 5)], tracks);
    expect(findTrackWithRoom(p, 'video', 1, 2)?.id).toBe('v2');
    expect(findTrackWithRoom(p, 'video', 5, 2)?.id).toBe('v1');
    expect(findTrackWithRoom(p, 'audio', 0, 2)?.id).toBe('a1');
  });
  it('skips locked tracks', () => {
    const tracks = [track('v1', 'video', true), track('v2', 'video')];
    expect(findTrackWithRoom(proj([], tracks), 'video', 0, 1)?.id).toBe('v2');
  });
  it('returns undefined when nothing fits', () => {
    const tracks = [track('v1', 'video')];
    expect(findTrackWithRoom(proj([video('v1', 0, 5)], tracks), 'video', 1, 1)).toBeUndefined();
    expect(findTrackWithRoom(proj([], tracks), 'audio', 0, 1)).toBeUndefined();
  });
  it('honours ignoreIds', () => {
    const c = video('v1', 0, 5);
    const p = proj([c], [track('v1', 'video')]);
    expect(findTrackWithRoom(p, 'video', 1, 1, [c.id])?.id).toBe('v1');
  });
});

describe('clipsAtTime', () => {
  const a = video('t1', 1, 2); // [1,3)
  const b = video('t1', 3, 1); // [3,4)
  const p = proj([a, b]);
  it('is half-open', () => {
    expect(clipsAtTime(p, 1).map((c) => c.id)).toEqual([a.id]);
    expect(clipsAtTime(p, 2.99).map((c) => c.id)).toEqual([a.id]);
    expect(clipsAtTime(p, 3).map((c) => c.id)).toEqual([b.id]);
    expect(clipsAtTime(p, 4)).toEqual([]);
    expect(clipsAtTime(p, 0.5)).toEqual([]);
  });
  it('returns clips on all tracks', () => {
    const q = proj([a, audio('t2', 0, 10)]);
    expect(clipsAtTime(q, 2)).toHaveLength(2);
  });
});

describe('sourceTimeAt', () => {
  it('maps timeline time to source time with trim and speed', () => {
    const c = video('t1', 5, 4, { trimStart: 2, speed: 2 });
    expect(sourceTimeAt(c, 5)).toBe(2);
    expect(sourceTimeAt(c, 6)).toBe(4);
    const half = audio('t2', 0, 8, { trimStart: 1, speed: 0.5 });
    expect(sourceTimeAt(half, 4)).toBe(3);
  });
  it('is 0 for image clips', () => {
    expect(sourceTimeAt(image('t1', 0, 5), 2)).toBe(0);
  });
});

describe('fadeFactor', () => {
  const c = { start: 10, duration: 4, fadeIn: 1, fadeOut: 2 };
  it('ramps in', () => {
    expect(fadeFactor(c, 10)).toBe(0);
    expect(fadeFactor(c, 10.5)).toBeCloseTo(0.5, 9);
    expect(fadeFactor(c, 11)).toBe(1);
  });
  it('is 1 in the middle and ramps out', () => {
    expect(fadeFactor(c, 12)).toBe(1);
    expect(fadeFactor(c, 13)).toBeCloseTo(0.5, 9);
    expect(fadeFactor(c, 14)).toBe(0);
  });
  it('is 1 without fades and clamps outside the clip', () => {
    const d = { start: 0, duration: 2, fadeIn: 0, fadeOut: 0 };
    expect(fadeFactor(d, 1)).toBe(1);
    expect(fadeFactor(c, 9)).toBe(0);
    expect(fadeFactor(c, 20)).toBe(0);
  });
  it('overlapping fades take the minimum', () => {
    const d = { start: 0, duration: 2, fadeIn: 2, fadeOut: 2 };
    expect(fadeFactor(d, 1)).toBeCloseTo(0.5, 9);
    expect(fadeFactor(d, 0.5)).toBeCloseTo(0.25, 9);
  });
});

describe('maxClipDuration', () => {
  it('accounts for trimStart and speed', () => {
    expect(maxClipDuration(video('t1', 0, 1, { trimStart: 2, speed: 2 }), 10)).toBe(4);
    expect(maxClipDuration(audio('t2', 0, 1, { trimStart: 0, speed: 0.5 }), 10)).toBe(20);
  });
  it('is infinite for images and unknown assets', () => {
    expect(maxClipDuration(image('t1', 0, 1), 3)).toBe(Infinity);
    expect(maxClipDuration(video('t1', 0, 1), undefined)).toBe(Infinity);
  });
  it('is never negative', () => {
    expect(maxClipDuration(video('t1', 0, 1, { trimStart: 12 }), 10)).toBe(0);
  });
});

describe('collectSnapPoints / snapTime', () => {
  it('collects 0, edges and extras, sorted and unique', () => {
    const a = video('t1', 1, 2);
    const b = video('t1', 3, 1);
    expect(collectSnapPoints(proj([a, b]), [], [2.5])).toEqual([0, 1, 2.5, 3, 4]);
  });
  it('ignores the given clips', () => {
    const a = video('t1', 1, 2);
    const b = video('t1', 5, 1);
    expect(collectSnapPoints(proj([a, b]), [a.id])).toEqual([0, 5, 6]);
  });
  it('snaps to the nearest point within threshold', () => {
    expect(snapTime(2.05, [0, 2, 4], 0.1)).toEqual({ time: 2, hit: 2 });
    expect(snapTime(3.9, [0, 2, 4], 0.2)).toEqual({ time: 4, hit: 4 });
  });
  it('returns the input when nothing is close', () => {
    expect(snapTime(3, [0, 2, 4], 0.5)).toEqual({ time: 3, hit: null });
    expect(snapTime(3, [], 1)).toEqual({ time: 3, hit: null });
  });
  it('threshold is inclusive and picks the closest of several', () => {
    expect(snapTime(1, [0, 2], 1).hit).not.toBeNull();
    expect(snapTime(1.4, [1, 1.5], 1)).toEqual({ time: 1.5, hit: 1.5 });
  });
});

describe('normalizeTrackOrder', () => {
  it('puts video before audio and keeps relative order', () => {
    const t = [track('a1', 'audio'), track('v1', 'video'), track('a2', 'audio'), track('v2', 'video')];
    expect(normalizeTrackOrder(t).map((x) => x.id)).toEqual(['v1', 'v2', 'a1', 'a2']);
  });
  it('does not mutate the input', () => {
    const t = [track('a1', 'audio'), track('v1', 'video')];
    normalizeTrackOrder(t);
    expect(t.map((x) => x.id)).toEqual(['a1', 'v1']);
  });
});
