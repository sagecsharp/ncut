import { describe, expect, it } from 'vitest';
import type { AudioClip, Clip, ImageClip, MediaAsset, Project, TextClip, Track, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createTextClip } from './factory';
import { matchFrameAt, pickMatchClip, planMatchFrame, planReverseMatch } from './matchFrame';
import type { MediaClip } from './matchFrame';

const asset = (id: string, kind: MediaAsset['kind'], duration: number): MediaAsset => ({
  id,
  name: id,
  kind,
  mime: '',
  size: 0,
  duration,
  width: 0,
  height: 0,
  hasAudio: kind !== 'image',
  createdAt: 0,
});
const trk = (id: string, kind: Track['kind'] = 'video', o: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, ...o });
const base = { fadeIn: 0, fadeOut: 0, name: 'c' };
const vid = (id: string, trackId: string, start: number, duration: number, o: Partial<VideoClip> = {}): VideoClip => ({
  ...base,
  id,
  trackId,
  start,
  duration,
  type: 'video',
  assetId: 'v',
  trimStart: 0,
  speed: 1,
  volume: 1,
  muted: false,
  transform: { ...DEFAULT_TRANSFORM },
  ...o,
});
const aud = (id: string, trackId: string, start: number, duration: number, o: Partial<AudioClip> = {}): AudioClip => ({
  ...base,
  id,
  trackId,
  start,
  duration,
  type: 'audio',
  assetId: 's',
  trimStart: 0,
  speed: 1,
  volume: 1,
  muted: false,
  ...o,
});
const img = (id: string, trackId: string, start: number, duration: number, o: Partial<ImageClip> = {}): ImageClip => ({
  ...base,
  id,
  trackId,
  start,
  duration,
  type: 'image',
  assetId: 'i',
  transform: { ...DEFAULT_TRANSFORM },
  ...o,
});
const assets = [asset('v', 'video', 20), asset('s', 'audio', 30), asset('i', 'image', 0)];
const P = (tracks: Track[], clips: Clip[]): Pick<Project, 'clips' | 'tracks' | 'assets'> => ({ tracks, clips, assets });

describe('pickMatchClip', () => {
  it('selected wins', () => {
    const p = P([trk('v2'), trk('v1')], [vid('top', 'v2', 0, 10), vid('low', 'v1', 0, 10)]);
    expect(pickMatchClip(p, 1, [])?.id).toBe('top');
    expect(pickMatchClip(p, 1, ['low'])?.id).toBe('low');
    // a selected clip that is not under t does not count
    expect(pickMatchClip(P([trk('v2'), trk('v1')], [vid('top', 'v2', 0, 10), vid('low', 'v1', 20, 5)]), 1, ['low'])?.id).toBe('top');
  });
  it('picture, then heard sound, then any', () => {
    const tracks = [trk('v1', 'video', { hidden: true }), trk('v2'), trk('a1', 'audio', { muted: true }), trk('a2', 'audio')];
    const clips = [vid('hid', 'v1', 0, 10), aud('mut', 'a1', 0, 10), aud('hear', 'a2', 0, 10), vid('shown', 'v2', 0, 10)];
    expect(pickMatchClip(P(tracks, clips), 1, [])?.id).toBe('shown');
    expect(pickMatchClip(P(tracks, clips.filter((c) => c.id !== 'shown')), 1, [])?.id).toBe('hear');
    expect(pickMatchClip(P(tracks, [clips[0]!, clips[1]!]), 1, [])?.id).toBe('hid');
  });
  it('non media never', () => {
    const t: TextClip = createTextClip('v1', 0, { duration: 10 });
    expect(pickMatchClip(P([trk('v1')], [t]), 1, [t.id])).toBeNull();
    // a clip whose media is gone is not a media clip here
    expect(pickMatchClip(P([trk('v1')], [vid('x', 'v1', 0, 10, { assetId: 'gone' })]), 1, [])).toBeNull();
    // under the text, the picture is found
    expect(pickMatchClip(P([trk('v2'), trk('v1')], [createTextClip('v2', 0, { duration: 10 }), vid('a', 'v1', 0, 10)]), 1, [])?.id).toBe('a');
  });
  it('join and project end', () => {
    const p = P([trk('v1')], [vid('a', 'v1', 0, 4), vid('b', 'v1', 4, 4)]);
    expect(pickMatchClip(p, 4, [])?.id).toBe('b');
    expect(pickMatchClip(p, 4 - 1e-7, [])?.id).toBe('b');
    expect(pickMatchClip(p, 3.9, [])?.id).toBe('a');
    expect(pickMatchClip(p, 8, [])).toBeNull();
    expect(pickMatchClip(p, 100, [])).toBeNull();
  });
  it('locked tracks count', () => {
    const p = P([trk('v1', 'video', { locked: true })], [vid('a', 'v1', 0, 4)]);
    expect(pickMatchClip(p, 1, [])?.id).toBe('a');
  });
});

describe('planMatchFrame and matchFrameAt', () => {
  const av = assets[0]!;
  it('trim and speed', () => {
    const c = vid('a', 'v1', 2, 5, { trimStart: 3, speed: 2 });
    expect(planMatchFrame(c, av, 4).time).toBe(3 + 2 * 2);
    expect(planMatchFrame(c, av, 2).time).toBe(3);
  });
  it('time clamps to the media', () => {
    const c = vid('a', 'v1', 0, 50, { trimStart: 15, speed: 1 });
    expect(planMatchFrame(c, av, 30).time).toBe(20);
    expect(planMatchFrame(vid('a', 'v1', 5, 5), av, 1).time).toBe(0);
  });
  it('marks cut at the end', () => {
    const c = vid('a', 'v1', 0, 10, { trimStart: 5, speed: 2 });
    // 5 + 10 * 2 = 25 is past the 20 s file
    expect(planMatchFrame(c, av, 1).marks).toEqual({ in: 5, out: 20 });
    const d = vid('b', 'v1', 0, 4, { trimStart: 1, speed: 1 });
    expect(planMatchFrame(d, av, 1).marks).toEqual({ in: 1, out: 5 });
  });
  it('picture at 0', () => {
    const c = img('p', 'v1', 0, 5);
    const t = planMatchFrame(c, assets[2]!, 3);
    expect(t.time).toBe(0);
    expect(t.marks).toBeNull();
    expect(t.clip).toBe(c);
  });
  it('matchFrameAt joins pick and plan', () => {
    const p = P([trk('v1')], [vid('a', 'v1', 2, 5, { trimStart: 3 })]);
    const t = matchFrameAt(p, 4, [])!;
    expect(t.clip.id).toBe('a');
    expect(t.asset.id).toBe('v');
    expect(t.time).toBe(5);
    expect(matchFrameAt(p, 9, [])).toBeNull();
  });
});

describe('planReverseMatch', () => {
  it('reverse: selected then nearest', () => {
    const p = P([trk('v1'), trk('v2')], [vid('near', 'v1', 0, 10), vid('far', 'v2', 30, 10)]);
    expect(planReverseMatch(p, 'v', 5, 12, [])?.clipId).toBe('near');
    expect(planReverseMatch(p, 'v', 5, 28, [])?.clipId).toBe('far');
    expect(planReverseMatch(p, 'v', 5, 12, ['far'])?.clipId).toBe('far');
    // the playhead inside wins (distance 0)
    expect(planReverseMatch(p, 'v', 5, 35, [])?.clipId).toBe('far');
  });
  it('reverse: ties go to the upper track, then the earlier start', () => {
    const p = P([trk('v1'), trk('v2')], [vid('low', 'v2', 0, 10), vid('top', 'v1', 0, 10)]);
    expect(planReverseMatch(p, 'v', 5, 5, [])?.clipId).toBe('top');
    const q = P([trk('v1')], [vid('late', 'v1', 20, 5), vid('early', 'v1', 0, 5)]);
    expect(planReverseMatch(q, 'v', 2, 12.5, [])?.clipId).toBe('early');
  });
  it('reverse: speed and unused', () => {
    const p = P([trk('v1')], [vid('a', 'v1', 10, 5, { trimStart: 4, speed: 2 })]);
    // source 8 is 2 s into the clip at speed 2
    const r = planReverseMatch(p, 'v', 8, 0, [])!;
    expect(r.clipId).toBe('a');
    expect(r.time).toBe(12);
    // before the used part and past it
    expect(planReverseMatch(p, 'v', 3.9, 0, [])).toBeNull();
    expect(planReverseMatch(p, 'v', 14, 0, [])).toBeNull();
    // another media
    expect(planReverseMatch(p, 's', 8, 0, [])).toBeNull();
    // never the clip end itself
    const first = planReverseMatch(p, 'v', 4, 0, [])!;
    expect(first.time).toBe(10);
    const last = planReverseMatch(p, 'v', 13.99999, 0, [])!;
    expect(last.time).toBeLessThan(15);
  });
  it('reverse: picture', () => {
    const p = P([trk('v1')], [img('p', 'v1', 4, 5)]);
    expect(planReverseMatch(p, 'i', 0, 6, [])).toEqual({ clipId: 'p', time: 6 });
    expect(planReverseMatch(p, 'i', 0, 1, [])).toEqual({ clipId: 'p', time: 4 });
    expect(planReverseMatch(p, 'i', 0, 20, [])).toEqual({ clipId: 'p', time: 4 });
  });
});

describe('types', () => {
  it('MediaClip is the types.ts one', () => {
    const c: MediaClip = vid('a', 'v1', 0, 1);
    expect(c.type).toBe('video');
  });
});
