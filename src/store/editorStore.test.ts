import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Clip, ImageClip, MediaAsset, Project, TextClip, VideoClip } from '../types';
import { DEFAULT_TRANSFORM, MIN_CLIP_DURATION } from '../types';
import { createProject } from '../lib/factory';
import { useEditor } from './editorStore';

/* ---------- helpers ---------- */

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): Clip => proj().clips.find((c) => c.id === id)!;
const vid = (id: string) => clipOf(id) as VideoClip;
const aud = (id: string) => clipOf(id) as AudioClip;

function mkAsset(id: string, kind: MediaAsset['kind'], duration: number): MediaAsset {
  return {
    id,
    name: id,
    kind,
    mime: kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'image/png',
    size: 1000,
    duration: kind === 'image' ? 0 : duration,
    width: kind === 'audio' ? 0 : 1920,
    height: kind === 'audio' ? 0 : 1080,
    hasAudio: kind !== 'image',
    createdAt: 0,
  };
}

const EPS = 1e-6;

/** every invariant the editor promises to keep, checked after every action */
function inv(label = ''): void {
  const p = proj();
  const where = label ? ` (${label})` : '';
  const trackById = new Map(p.tracks.map((t) => [t.id, t]));
  expect(trackById.size, `unique track ids${where}`).toBe(p.tracks.length);
  const ids = new Set(p.clips.map((c) => c.id));
  expect(ids.size, `unique clip ids${where}`).toBe(p.clips.length);
  for (const c of p.clips) {
    expect(c.start, `start >= 0${where}`).toBeGreaterThanOrEqual(-EPS);
    expect(c.duration, `duration >= min${where}`).toBeGreaterThanOrEqual(MIN_CLIP_DURATION - EPS);
    const t = trackById.get(c.trackId);
    expect(t, `track exists${where}`).toBeDefined();
    expect(t!.kind, `track kind matches${where}`).toBe(c.type === 'audio' ? 'audio' : 'video');
    expect(c.fadeIn, `fadeIn${where}`).toBeGreaterThanOrEqual(0);
    expect(c.fadeOut, `fadeOut${where}`).toBeGreaterThanOrEqual(0);
    expect(c.fadeIn, `fadeIn <= duration${where}`).toBeLessThanOrEqual(c.duration + EPS);
    expect(c.fadeOut, `fadeOut <= duration${where}`).toBeLessThanOrEqual(c.duration + EPS);
    if (c.type === 'video' || c.type === 'audio') {
      expect(c.trimStart, `trimStart >= 0${where}`).toBeGreaterThanOrEqual(-EPS);
      expect(c.speed).toBeGreaterThan(0);
    }
  }
  for (const t of p.tracks) {
    const list = p.clips.filter((c) => c.trackId === t.id).sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      expect(list[i]!.start, `no overlap on ${t.id}${where}`).toBeGreaterThanOrEqual(list[i - 1]!.start + list[i - 1]!.duration - EPS);
    }
  }
  const firstAudio = p.tracks.findIndex((t) => t.kind === 'audio');
  if (firstAudio >= 0) {
    for (let i = firstAudio; i < p.tracks.length; i++) {
      expect(p.tracks[i]!.kind, `video tracks before audio${where}`).toBe('audio');
    }
  }
  for (const id of ed().selection) expect(ids.has(id), `selection id exists${where}`).toBe(true);
  for (const a of ed().past) expect(a).toBeTruthy();
}

/** run an action and assert invariants */
function act<T>(fn: () => T, label = ''): T {
  const r = fn();
  inv(label);
  return r;
}

let seq = 0;
function mkVideo(trackId: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip {
  return {
    id: `mv${++seq}`,
    type: 'video',
    trackId,
    start,
    duration,
    name: 'v',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'vid10',
    trimStart: 0,
    speed: 1,
    volume: 1,
    muted: false,
    transform: { ...DEFAULT_TRANSFORM },
    ...over,
  };
}
function mkAudio(trackId: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip {
  return {
    id: `ma${++seq}`,
    type: 'audio',
    trackId,
    start,
    duration,
    name: 'a',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'aud10',
    trimStart: 0,
    speed: 1,
    volume: 1,
    muted: false,
    ...over,
  };
}
function mkImage(trackId: string, start: number, duration: number): ImageClip {
  return {
    id: `mi${++seq}`,
    type: 'image',
    trackId,
    start,
    duration,
    name: 'i',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'img',
    transform: { ...DEFAULT_TRANSFORM },
  };
}

const ASSETS = [mkAsset('vid10', 'video', 10), mkAsset('vid2', 'video', 2), mkAsset('aud10', 'audio', 10), mkAsset('img', 'image', 0)];

/** open a fresh project with the standard assets. returns [videoTrackId, audioTrackId] */
function fresh(): { v: string; a: string } {
  useEditor.setState({ clipboard: [] });
  const p = createProject('test');
  ed().openProject({ ...p, assets: [...ASSETS] });
  return { v: p.tracks[0]!.id, a: p.tracks[1]!.id };
}

/** open a project with the given clips on the default tracks */
function load(build: (v: string, a: string) => Clip[], extraTracks: (v: string, a: string) => void = () => {}): { v: string; a: string } {
  const t = fresh();
  extraTracks(t.v, t.a);
  const p = proj();
  ed().openProject({ ...p, clips: build(t.v, t.a) });
  return t;
}

beforeEach(() => {
  fresh();
});

/* ---------- insertAsset ---------- */

describe('insertAsset', () => {
  it('returns null for an unknown asset and records nothing', () => {
    const before = proj();
    expect(ed().insertAsset('nope')).toBeNull();
    expect(proj()).toBe(before);
    expect(ed().past).toHaveLength(0);
  });

  it('appends one after another on the first track', () => {
    const { v } = fresh();
    const a = act(() => ed().insertAsset('vid10'))!;
    const b = act(() => ed().insertAsset('vid2'))!;
    expect(clipOf(a)).toMatchObject({ trackId: v, start: 0, duration: 10 });
    expect(clipOf(b)).toMatchObject({ trackId: v, start: 10, duration: 2 });
    expect(ed().selection).toEqual([b]);
  });

  it('places audio on the audio track', () => {
    const { a } = fresh();
    const id = act(() => ed().insertAsset('aud10'))!;
    expect(clipOf(id).trackId).toBe(a);
  });

  it('places at a start time on a track with room', () => {
    const { v } = fresh();
    const id = act(() => ed().insertAsset('vid2', { start: 3 }))!;
    expect(clipOf(id)).toMatchObject({ trackId: v, start: 3 });
  });

  it('clamps a negative start to 0', () => {
    fresh();
    const id = act(() => ed().insertAsset('vid2', { start: -4 }))!;
    expect(clipOf(id).start).toBe(0);
  });

  it('creates a new top video track when start is occupied everywhere', () => {
    const { v } = fresh();
    act(() => ed().insertAsset('vid10', { start: 0 }));
    const id = act(() => ed().insertAsset('vid2', { start: 5 }))!;
    const c = clipOf(id);
    expect(c.trackId).not.toBe(v);
    expect(c.start).toBe(5);
    expect(proj().tracks[0]!.id).toBe(c.trackId);
    expect(proj().tracks[0]!.kind).toBe('video');
  });

  it('on a given track: nearest free spot to start', () => {
    const { v } = fresh();
    act(() => ed().insertAsset('vid10'));
    const id = act(() => ed().insertAsset('vid2', { trackId: v, start: 4 }))!;
    expect(clipOf(id)).toMatchObject({ trackId: v, start: 10 });
  });

  it('on a given track without start: appended after the last clip', () => {
    const { v } = fresh();
    act(() => ed().insertAsset('vid10'));
    const id = act(() => ed().insertAsset('vid2', { trackId: v }))!;
    expect(clipOf(id)).toMatchObject({ trackId: v, start: 10 });
  });

  it('ignores a wrong-kind track (audio asset on video track)', () => {
    const { v, a } = fresh();
    const id = act(() => ed().insertAsset('aud10', { trackId: v, start: 2 }))!;
    expect(clipOf(id)).toMatchObject({ trackId: a, start: 2 });
    const id2 = act(() => ed().insertAsset('vid2', { trackId: a }))!;
    expect(clipOf(id2).trackId).toBe(v);
  });

  it('creates an audio track at the bottom when none exists', () => {
    const { a } = fresh();
    ed().removeTrack(a);
    const id = act(() => ed().insertAsset('aud10'))!;
    const last = proj().tracks[proj().tracks.length - 1]!;
    expect(last.kind).toBe('audio');
    expect(clipOf(id).trackId).toBe(last.id);
  });

  it('never uses a locked track', () => {
    const { v } = fresh();
    ed().updateTrack(v, { locked: true });
    const id = act(() => ed().insertAsset('vid2'))!;
    expect(clipOf(id).trackId).not.toBe(v);
    expect(proj().tracks.find((t) => t.id === clipOf(id).trackId)!.locked).toBe(false);
    // explicit locked track is ignored too
    const id2 = act(() => ed().insertAsset('vid2', { trackId: v, start: 0 }))!;
    expect(clipOf(id2).trackId).not.toBe(v);
    expect(proj().clips.filter((c) => c.trackId === v)).toHaveLength(0);
  });

  it('images get the default duration and live on video tracks', () => {
    const { v } = fresh();
    const id = act(() => ed().insertAsset('img'))!;
    expect(clipOf(id)).toMatchObject({ type: 'image', trackId: v, duration: 5 });
  });

  it('skipHistory does not record an undo step', () => {
    fresh();
    ed().insertAsset('vid2', { skipHistory: true });
    expect(ed().past).toHaveLength(0);
  });
});

/* ---------- addText ---------- */

describe('addText', () => {
  it('adds a text clip on the video track with the default duration', () => {
    const { v } = fresh();
    const id = act(() => ed().addText())!;
    expect(clipOf(id)).toMatchObject({ type: 'text', trackId: v, start: 0, duration: 4 });
    expect(ed().selection).toEqual([id]);
  });
  it('enforces the minimum duration', () => {
    fresh();
    const id = act(() => ed().addText({ duration: 0.001 }));
    expect(clipOf(id).duration).toBe(MIN_CLIP_DURATION);
  });
  it('appends after existing clips and honours start', () => {
    const { v } = fresh();
    act(() => ed().insertAsset('vid2'));
    const a = act(() => ed().addText())!;
    expect(clipOf(a)).toMatchObject({ trackId: v, start: 2 });
    const b = act(() => ed().addText({ start: 20 }))!;
    expect(clipOf(b)).toMatchObject({ trackId: v, start: 20 });
  });
  it('creates a new track when the start is occupied on all tracks', () => {
    const { v } = fresh();
    act(() => ed().insertAsset('vid10'));
    const id = act(() => ed().addText({ start: 1 }))!;
    expect(clipOf(id).trackId).not.toBe(v);
  });
  it('applies preset fields but never lets them override placement', () => {
    const { v } = fresh();
    const id = act(() => ed().addText({ preset: { text: 'hi', color: '#ff0000', trackId: 'zzz', start: 99, type: 'text' } as Partial<TextClip> }));
    const c = clipOf(id) as TextClip;
    expect(c.text).toBe('hi');
    expect(c.color).toBe('#ff0000');
    expect(c.trackId).toBe(v);
    expect(c.start).toBe(0);
  });
  // regression: preset fades are not clamped to the clip duration (updateClip does clamp them).
  it('clamps preset fades to the duration', () => {
    fresh();
    const id = ed().addText({ duration: 2, preset: { fadeIn: 10 } });
    expect(clipOf(id).fadeIn).toBeLessThanOrEqual(2);
  });
});

/* ---------- moveClips ---------- */

describe('moveClips', () => {
  let t: { v: string; a: string };
  let A: string;
  let B: string;
  beforeEach(() => {
    t = load((v) => {
      const a = mkVideo(v, 0, 2);
      const b = mkVideo(v, 3, 2);
      A = a.id;
      B = b.id;
      return [a, b];
    });
  });

  it('moves to a free spot (same track)', () => {
    expect(act(() => ed().moveClips([{ id: B, trackId: t.v, start: 6 }]))).toBe(true);
    expect(clipOf(B).start).toBe(6);
  });
  it('allows flush placement against a neighbour', () => {
    expect(act(() => ed().moveClips([{ id: B, trackId: t.v, start: 2 }]))).toBe(true);
  });
  it('rejects overlap and changes nothing', () => {
    const before = proj();
    expect(act(() => ed().moveClips([{ id: B, trackId: t.v, start: 1 }]))).toBe(false);
    expect(proj()).toBe(before);
    expect(ed().past).toHaveLength(0);
  });
  it('rejects a wrong-kind track', () => {
    const before = proj();
    expect(act(() => ed().moveClips([{ id: A, trackId: t.a, start: 0 }]))).toBe(false);
    expect(proj()).toBe(before);
  });
  it('rejects unknown tracks', () => {
    expect(ed().moveClips([{ id: A, trackId: 'nope', start: 0 }])).toBe(false);
  });
  it('rejects a locked target track', () => {
    const v2 = ed().addTrack('video');
    ed().updateTrack(v2, { locked: true });
    expect(act(() => ed().moveClips([{ id: A, trackId: v2, start: 0 }]))).toBe(false);
  });
  it('rejects moving a clip off a locked track', () => {
    const v2 = ed().addTrack('video');
    ed().updateTrack(t.v, { locked: true });
    expect(act(() => ed().moveClips([{ id: A, trackId: v2, start: 0 }]))).toBe(false);
    expect(clipOf(A).trackId).toBe(t.v);
  });
  it('rejects negative and non-finite starts', () => {
    expect(ed().moveClips([{ id: A, trackId: t.v, start: -1 }])).toBe(false);
    expect(ed().moveClips([{ id: A, trackId: t.v, start: NaN }])).toBe(false);
    expect(ed().moveClips([{ id: A, trackId: t.v, start: Infinity }])).toBe(false);
    inv();
  });
  it('moves to another track of the same kind', () => {
    const v2 = ed().addTrack('video');
    expect(act(() => ed().moveClips([{ id: B, trackId: v2, start: 0 }]))).toBe(true);
    expect(clipOf(B)).toMatchObject({ trackId: v2, start: 0 });
  });
  it('multi-move swap is valid', () => {
    expect(
      act(() =>
        ed().moveClips([
          { id: A, trackId: t.v, start: 3 },
          { id: B, trackId: t.v, start: 0 },
        ]),
      ),
    ).toBe(true);
    expect(clipOf(A).start).toBe(3);
    expect(clipOf(B).start).toBe(0);
  });
  it('multi-move is all-or-nothing', () => {
    const before = proj();
    expect(
      act(() =>
        ed().moveClips([
          { id: A, trackId: t.v, start: 10 },
          { id: B, trackId: t.v, start: 10.5 },
        ]),
      ),
    ).toBe(false);
    expect(proj()).toBe(before);
    expect(
      ed().moveClips([
        { id: A, trackId: t.v, start: 10 },
        { id: B, trackId: t.a, start: 3 },
      ]),
    ).toBe(false);
    expect(proj()).toBe(before);
  });
  it('moving several clips together keeps them valid', () => {
    expect(
      act(() =>
        ed().moveClips([
          { id: A, trackId: t.v, start: 5 },
          { id: B, trackId: t.v, start: 8 },
        ]),
      ),
    ).toBe(true);
  });
  it('a no-op move returns false and records nothing', () => {
    expect(ed().moveClips([{ id: A, trackId: t.v, start: 0 }])).toBe(false);
    expect(ed().moveClips([])).toBe(false);
    expect(ed().past).toHaveLength(0);
  });
  it('a move onto its old slot by a different clip within a multi move works (chain shift)', () => {
    expect(
      act(() =>
        ed().moveClips([
          { id: A, trackId: t.v, start: 3 },
          { id: B, trackId: t.v, start: 5 },
        ]),
      ),
    ).toBe(true);
  });
});

/* ---------- trimClip ---------- */

describe('trimClip', () => {
  it('end edge: clamped by source bounds with trimStart and speed', () => {
    const c = mkVideo('', 5, 2, { trimStart: 2, speed: 2 });
    load((v) => [{ ...c, trackId: v }]);
    act(() => ed().trimClip(c.id, 'end', 100));
    // (10 - 2) / 2 = 4
    expect(vid(c.id).duration).toBe(4);
    expect(vid(c.id).start).toBe(5);
  });
  it('end edge: shrinks and keeps min duration', () => {
    const c = mkVideo('', 5, 4);
    load((v) => [{ ...c, trackId: v }]);
    act(() => ed().trimClip(c.id, 'end', 6));
    expect(clipOf(c.id).duration).toBeCloseTo(1, 9);
    act(() => ed().trimClip(c.id, 'end', 0));
    expect(clipOf(c.id).duration).toBeCloseTo(MIN_CLIP_DURATION, 9);
  });
  it('end edge: clamped by the next neighbour', () => {
    const c = mkVideo('', 0, 2);
    let n = '';
    load((v) => {
      const o = mkVideo(v, 5, 2);
      n = o.id;
      return [{ ...c, trackId: v }, o];
    });
    act(() => ed().trimClip(c.id, 'end', 9));
    expect(clipOf(c.id).duration).toBe(5);
    expect(clipOf(n).start).toBe(5);
  });
  it('end edge on images and text is unbounded by media', () => {
    const i = mkImage('', 0, 2);
    load((v) => [{ ...i, trackId: v }]);
    act(() => ed().trimClip(i.id, 'end', 60));
    expect(clipOf(i.id).duration).toBe(60);
  });
  it('start edge: moves start and trimStart (speed 1)', () => {
    const c = mkVideo('', 2, 6);
    load((v) => [{ ...c, trackId: v }]);
    act(() => ed().trimClip(c.id, 'start', 4));
    expect(vid(c.id)).toMatchObject({ start: 4, duration: 4, trimStart: 2 });
  });
  it('start edge: trimStart follows with speed != 1 and is bounded at 0', () => {
    const c = mkVideo('', 5, 4, { trimStart: 2, speed: 2 });
    load((v) => [{ ...c, trackId: v }]);
    act(() => ed().trimClip(c.id, 'start', 0));
    // can extend left by trimStart/speed = 1 s
    expect(vid(c.id).start).toBeCloseTo(4, 9);
    expect(vid(c.id).trimStart).toBeCloseTo(0, 9);
    expect(vid(c.id).duration).toBeCloseTo(5, 9);
    // trim right by 1 s of timeline = 2 s of source
    act(() => ed().trimClip(c.id, 'start', 5));
    expect(vid(c.id).trimStart).toBeCloseTo(2, 9);
    expect(vid(c.id).duration).toBeCloseTo(4, 9);
  });
  it('start edge: clamped by the previous neighbour', () => {
    const c = mkVideo('', 5, 3, { trimStart: 4 });
    load((v) => [mkVideo(v, 0, 3), { ...c, trackId: v }]);
    act(() => ed().trimClip(c.id, 'start', 1));
    expect(clipOf(c.id).start).toBe(3);
    expect(vid(c.id).trimStart).toBe(2);
  });
  it('start edge: clamped at 0 for images', () => {
    const i = mkImage('', 1, 3);
    load((v) => [{ ...i, trackId: v }]);
    act(() => ed().trimClip(i.id, 'start', -5));
    expect(clipOf(i.id)).toMatchObject({ start: 0, duration: 4 });
  });
  it('start edge: min duration', () => {
    const c = mkVideo('', 0, 4);
    load((v) => [{ ...c, trackId: v }]);
    act(() => ed().trimClip(c.id, 'start', 100));
    expect(clipOf(c.id).duration).toBeCloseTo(MIN_CLIP_DURATION, 9);
    expect(clipOf(c.id).start).toBeCloseTo(4 - MIN_CLIP_DURATION, 9);
  });
  it('clamps fades when the clip gets shorter', () => {
    const c = mkVideo('', 0, 4, { fadeIn: 1.5, fadeOut: 1.5 });
    load((v) => [{ ...c, trackId: v }]);
    act(() => ed().trimClip(c.id, 'end', 1));
    expect(clipOf(c.id).fadeIn).toBe(1);
    expect(clipOf(c.id).fadeOut).toBe(1);
    act(() => ed().trimClip(c.id, 'start', 0.5));
    expect(clipOf(c.id).fadeIn).toBeLessThanOrEqual(clipOf(c.id).duration);
  });
  it('does nothing on a locked track or for an unknown clip or an unchanged edge', () => {
    const c = mkVideo('', 0, 4);
    const t = load((v) => [{ ...c, trackId: v }]);
    const before = proj();
    ed().trimClip(c.id, 'end', 4);
    ed().trimClip('nope', 'end', 1);
    expect(proj()).toBe(before);
    ed().updateTrack(t.v, { locked: true });
    const locked = proj();
    ed().trimClip(c.id, 'end', 2);
    expect(proj()).toBe(locked);
  });
  it('audio clips are bounded by the source too', () => {
    const c = mkAudio('', 0, 2, { trimStart: 1, speed: 0.5 });
    const t = load((_v, a) => [{ ...c, trackId: a }]);
    void t;
    act(() => ed().trimClip(c.id, 'end', 500));
    // (10 - 1) / 0.5 = 18
    expect(aud(c.id).duration).toBe(18);
  });
});

/* ---------- setClipSpeed ---------- */

describe('setClipSpeed', () => {
  it('duration follows the speed', () => {
    const c = mkVideo('', 0, 4);
    load((v) => [{ ...c, trackId: v }]);
    act(() => ed().setClipSpeed(c.id, 2));
    expect(vid(c.id)).toMatchObject({ speed: 2, duration: 2 });
    act(() => ed().setClipSpeed(c.id, 0.5));
    expect(vid(c.id)).toMatchObject({ speed: 0.5, duration: 8 });
  });
  it('clamps the speed to the allowed range', () => {
    const c = mkVideo('', 0, 4);
    load((v) => [{ ...c, trackId: v }]);
    act(() => ed().setClipSpeed(c.id, 100));
    expect(vid(c.id).speed).toBe(4);
    expect(vid(c.id).duration).toBe(1);
    act(() => ed().setClipSpeed(c.id, 0));
    expect(vid(c.id).speed).toBe(0.25);
    expect(vid(c.id).duration).toBe(16);
  });
  it('is clamped by the next clip', () => {
    const c = mkVideo('', 0, 4);
    load((v) => [{ ...c, trackId: v }, mkVideo(v, 6, 2)]);
    act(() => ed().setClipSpeed(c.id, 0.5));
    expect(vid(c.id).speed).toBe(0.5);
    expect(vid(c.id).duration).toBe(6);
  });
  it('works for audio and keeps the source span', () => {
    const c = mkAudio('', 0, 6, { trimStart: 1 });
    load((_v, a) => [{ ...c, trackId: a }]);
    act(() => ed().setClipSpeed(c.id, 2));
    expect(aud(c.id).duration).toBe(3);
    expect(aud(c.id).trimStart).toBe(1);
  });
  it('clamps fades to the shorter duration', () => {
    const c = mkVideo('', 0, 4, { fadeIn: 2, fadeOut: 2 });
    load((v) => [{ ...c, trackId: v }]);
    act(() => ed().setClipSpeed(c.id, 4));
    expect(clipOf(c.id).fadeIn).toBe(1);
    expect(clipOf(c.id).fadeOut).toBe(1);
  });
  it('ignores images, same speed, NaN, locked tracks', () => {
    const i = mkImage('', 0, 4);
    const c = mkVideo('', 5, 4);
    const t = load((v) => [{ ...i, trackId: v }, { ...c, trackId: v }]);
    const before = proj();
    ed().setClipSpeed(i.id, 2);
    ed().setClipSpeed(c.id, 1);
    ed().setClipSpeed(c.id, NaN);
    expect(proj()).toBe(before);
    ed().updateTrack(t.v, { locked: true });
    const locked = proj();
    ed().setClipSpeed(c.id, 2);
    expect(proj()).toBe(locked);
  });
});

/* ---------- splitClips ---------- */

describe('splitClips', () => {
  it('splits a clip: trimStart of the right part follows speed', () => {
    const c = mkVideo('', 0, 10, { trimStart: 1, speed: 2 });
    load((v) => [{ ...c, trackId: v }]);
    const [rid] = act(() => ed().splitClips(4))!;
    const l = vid(c.id);
    const r = vid(rid!);
    expect(l).toMatchObject({ start: 0, duration: 4, trimStart: 1 });
    expect(r).toMatchObject({ start: 4, duration: 6, speed: 2 });
    expect(r.trimStart).toBeCloseTo(1 + 4 * 2, 9);
    expect(r.id).not.toBe(l.id);
    expect(r.trackId).toBe(l.trackId);
  });
  it('audio clips split with the same rule', () => {
    const c = mkAudio('', 2, 6, { trimStart: 0.5, speed: 0.5 });
    load((_v, a) => [{ ...c, trackId: a }]);
    const [rid] = act(() => ed().splitClips(5))!;
    expect(aud(rid!).trimStart).toBeCloseTo(0.5 + 3 * 0.5, 9);
  });
  it('distributes fades: fadeIn stays left, fadeOut goes right, both clamped', () => {
    const c = mkVideo('', 0, 10, { fadeIn: 5, fadeOut: 8 });
    load((v) => [{ ...c, trackId: v }]);
    const [rid] = act(() => ed().splitClips(4))!;
    expect(clipOf(c.id)).toMatchObject({ fadeIn: 4, fadeOut: 0 });
    expect(clipOf(rid!)).toMatchObject({ fadeIn: 0, fadeOut: 6 });
  });
  it('right part copies the transform without sharing the object', () => {
    const c = mkVideo('', 0, 10, { transform: { x: 5, y: 6, scale: 2, rotation: 10, opacity: 0.5 } });
    load((v) => [{ ...c, trackId: v }]);
    const [rid] = ed().splitClips(5);
    const r = vid(rid!);
    expect(r.transform).toEqual(c.transform);
    expect(r.transform).not.toBe(vid(c.id).transform);
  });
  it('with no selection splits every clip under the time', () => {
    let a = '';
    let b = '';
    load((v) => {
      const x = mkVideo(v, 0, 10);
      const y = mkAudio('', 0, 10);
      a = x.id;
      b = y.id;
      return [x, y];
    });
    // put the audio clip on the audio track
    const p = proj();
    ed().openProject({ ...p, clips: p.clips.map((c) => (c.id === b ? { ...c, trackId: p.tracks[1]!.id } : c)) });
    const created = act(() => ed().splitClips(5));
    expect(created).toHaveLength(2);
    expect(proj().clips).toHaveLength(4);
    void a;
  });
  it('with a selection only splits the selected clips', () => {
    let a = '';
    let b = '';
    load(
      (v) => {
        const x = mkVideo(v, 0, 10);
        a = x.id;
        return [x];
      },
    );
    const v2 = ed().addTrack('video');
    const y = mkVideo(v2, 0, 10);
    b = y.id;
    const p = proj();
    ed().openProject({ ...p, clips: [...p.clips, y] });
    ed().select([a]);
    const created = act(() => ed().splitClips(5));
    expect(created).toHaveLength(1);
    expect(clipOf(a).duration).toBe(5);
    expect(clipOf(b).duration).toBe(10);
  });
  it('explicit ids override the selection', () => {
    let a = '';
    let b = '';
    load((v) => {
      const x = mkVideo(v, 0, 10);
      const y = mkVideo(v, 10, 10);
      a = x.id;
      b = y.id;
      return [x, y];
    });
    ed().select([a]);
    const created = act(() => ed().splitClips(15, [b]));
    expect(created).toHaveLength(1);
    expect(clipOf(a).duration).toBe(10);
    expect(clipOf(b).duration).toBe(5);
  });
  it('skips clips on locked tracks', () => {
    const c = mkVideo('', 0, 10);
    const t = load((v) => [{ ...c, trackId: v }]);
    ed().updateTrack(t.v, { locked: true });
    const before = proj();
    expect(ed().splitClips(5)).toEqual([]);
    expect(proj()).toBe(before);
  });
  it('splitting at an edge (or too close to it) does nothing and records no history', () => {
    const c = mkVideo('', 2, 4);
    load((v) => [{ ...c, trackId: v }]);
    const before = proj();
    expect(ed().splitClips(2)).toEqual([]);
    expect(ed().splitClips(6)).toEqual([]);
    expect(ed().splitClips(2.01)).toEqual([]);
    expect(ed().splitClips(0)).toEqual([]);
    expect(ed().splitClips(100)).toEqual([]);
    expect(proj()).toBe(before);
    expect(ed().past).toHaveLength(0);
  });
  it('split halves never violate the min duration', () => {
    const c = mkVideo('', 0, 1);
    load((v) => [{ ...c, trackId: v }]);
    for (const t of [0.051, 0.5, 0.949]) {
      load((v) => [{ ...mkVideo(v, 0, 1) }]);
      act(() => ed().splitClips(t), `t=${t}`);
    }
  });
  it('splits text and image clips (no trimStart)', () => {
    const i = mkImage('', 0, 4);
    load((v) => [{ ...i, trackId: v }]);
    const [rid] = act(() => ed().splitClips(1))!;
    expect(clipOf(rid!)).toMatchObject({ type: 'image', start: 1, duration: 3 });
  });
});

/* ---------- deleteClips ---------- */

describe('deleteClips', () => {
  it('removes clips and prunes the selection', () => {
    let a = '';
    let b = '';
    load((v) => {
      const x = mkVideo(v, 0, 2);
      const y = mkVideo(v, 3, 2);
      a = x.id;
      b = y.id;
      return [x, y];
    });
    ed().select([a, b]);
    act(() => ed().deleteClips([a]));
    expect(proj().clips.map((c) => c.id)).toEqual([b]);
    expect(ed().selection).toEqual([b]);
  });
  it('non ripple leaves gaps', () => {
    let c = '';
    load((v) => {
      const x = mkVideo(v, 0, 2);
      const y = mkVideo(v, 2, 2);
      const z = mkVideo(v, 5, 1);
      c = z.id;
      return [x, y, z];
    });
    act(() => ed().deleteClips([proj().clips[1]!.id]));
    expect(clipOf(c).start).toBe(5);
  });
  it('ripple closes the gap on the same track only', () => {
    let z = '';
    let other = '';
    let mid = '';
    load((v, a) => {
      const x = mkVideo(v, 0, 2);
      const y = mkVideo(v, 2, 2);
      const zz = mkVideo(v, 5, 1);
      const o = mkAudio(a, 5, 1);
      mid = y.id;
      z = zz.id;
      other = o.id;
      return [x, y, zz, o];
    });
    act(() => ed().deleteClips([mid], { ripple: true }));
    expect(clipOf(z).start).toBe(3);
    expect(clipOf(other).start).toBe(5);
  });
  it('ripple with several deleted clips shifts by the sum and never goes negative', () => {
    let last = '';
    const ids: string[] = [];
    load((v) => {
      const x = mkVideo(v, 0, 2);
      const y = mkVideo(v, 2, 2);
      const z = mkVideo(v, 4, 2);
      ids.push(x.id, y.id);
      last = z.id;
      return [x, y, z];
    });
    act(() => ed().deleteClips(ids, { ripple: true }));
    expect(clipOf(last).start).toBe(0);
  });
  it('skips clips on locked tracks', () => {
    let a = '';
    const t = load((v) => {
      const x = mkVideo(v, 0, 2);
      a = x.id;
      return [x];
    });
    ed().updateTrack(t.v, { locked: true });
    const before = proj();
    ed().deleteClips([a]);
    expect(proj()).toBe(before);
  });
  it('unknown ids are a no-op', () => {
    load((v) => [mkVideo(v, 0, 2)]);
    ed().deleteClips(['nope']);
    expect(ed().past).toHaveLength(0);
  });
});

/* ---------- duplicateClips ---------- */

describe('duplicateClips', () => {
  it('places the copy right after the original and selects it', () => {
    let a = '';
    load((v) => {
      const x = mkVideo(v, 1, 2, { fadeIn: 0.5 });
      a = x.id;
      return [x];
    });
    const [copy] = act(() => ed().duplicateClips([a]))!;
    expect(copy).not.toBe(a);
    expect(clipOf(copy!)).toMatchObject({ start: 3, duration: 2, trackId: clipOf(a).trackId, fadeIn: 0.5 });
    expect(ed().selection).toEqual([copy]);
  });
  it('pushes the copy past occupied space', () => {
    let a = '';
    load((v) => {
      const x = mkVideo(v, 0, 2);
      a = x.id;
      return [x, mkVideo(v, 2, 3)];
    });
    const [copy] = act(() => ed().duplicateClips([a]))!;
    expect(clipOf(copy!).start).toBe(5);
  });
  it('duplicating several clips on one track does not overlap', () => {
    const ids: string[] = [];
    load((v) => {
      const x = mkVideo(v, 0, 1);
      const y = mkVideo(v, 1, 1);
      ids.push(x.id, y.id);
      return [x, y];
    });
    const created = act(() => ed().duplicateClips(ids));
    expect(created).toHaveLength(2);
    expect(proj().clips).toHaveLength(4);
  });
  it('copies are deep (changing the copy transform does not affect the original)', () => {
    let a = '';
    load((v) => {
      const x = mkVideo(v, 0, 1);
      a = x.id;
      return [x];
    });
    const [copy] = ed().duplicateClips([a]);
    ed().updateTransform(copy!, { x: 50 });
    expect(vid(a).transform.x).toBe(0);
  });
  it('a clip on a locked track is copied to another track', () => {
    let a = '';
    const t = load((v) => {
      const x = mkVideo(v, 0, 2);
      a = x.id;
      return [x];
    });
    ed().updateTrack(t.v, { locked: true });
    const [copy] = act(() => ed().duplicateClips([a]))!;
    expect(clipOf(copy!).trackId).not.toBe(t.v);
    expect(clipOf(a).trackId).toBe(t.v);
  });
  it('unknown ids give nothing', () => {
    load(() => []);
    expect(ed().duplicateClips(['nope'])).toEqual([]);
    expect(ed().past).toHaveLength(0);
  });
});

/* ---------- clipboard ---------- */

describe('copy / cut / paste', () => {
  it('copy then paste at a time places a copy at that time', () => {
    let a = '';
    load((v) => {
      const x = mkVideo(v, 0, 2);
      a = x.id;
      return [x];
    });
    ed().select([a]);
    ed().copySelection();
    expect(ed().clipboard).toHaveLength(1);
    const [p] = act(() => ed().paste(5))!;
    expect(clipOf(p!)).toMatchObject({ start: 5, trackId: clipOf(a).trackId });
    expect(p).not.toBe(a);
    expect(ed().selection).toEqual([p]);
  });
  it('copy without selection keeps the previous clipboard', () => {
    let a = '';
    load((v) => {
      const x = mkVideo(v, 0, 2);
      a = x.id;
      return [x];
    });
    ed().select([a]);
    ed().copySelection();
    ed().clearSelection();
    ed().copySelection();
    expect(ed().clipboard).toHaveLength(1);
  });
  it('paste with an empty clipboard does nothing', () => {
    load((v) => [mkVideo(v, 0, 2)]);
    expect(ed().paste(0)).toEqual([]);
    expect(ed().past).toHaveLength(0);
  });
  it('cut removes the clips and paste brings them back', () => {
    let a = '';
    load((v) => {
      const x = mkVideo(v, 0, 2);
      a = x.id;
      return [x];
    });
    ed().select([a]);
    act(() => ed().cutSelection());
    expect(proj().clips).toHaveLength(0);
    expect(ed().clipboard).toHaveLength(1);
    const [p] = act(() => ed().paste(1))!;
    expect(clipOf(p!)).toMatchObject({ start: 1, duration: 2 });
  });
  it('pasting several clips keeps their relative offsets', () => {
    const ids: string[] = [];
    load((v, a) => {
      const x = mkVideo(v, 2, 1);
      const y = mkAudio(a, 4, 1);
      ids.push(x.id, y.id);
      return [x, y];
    });
    ed().select(ids);
    ed().copySelection();
    const [p1, p2] = act(() => ed().paste(10))!;
    expect(clipOf(p1!).start).toBe(10);
    expect(clipOf(p2!).start).toBe(12);
    expect(clipOf(p2!).type).toBe('audio');
  });
  it('paste after the asset was removed skips the clip', () => {
    let a = '';
    load((v) => {
      const x = mkVideo(v, 0, 2, { assetId: 'vid2' });
      a = x.id;
      return [x];
    });
    ed().select([a]);
    ed().copySelection();
    ed().removeAsset('vid2');
    expect(proj().clips).toHaveLength(0);
    expect(ed().paste(0)).toEqual([]);
    expect(proj().clips).toHaveLength(0);
    inv();
  });
  it('paste skips removed assets but still pastes the others at the right offset', () => {
    const ids: string[] = [];
    load((v) => {
      const x = mkVideo(v, 0, 2, { assetId: 'vid2' });
      const y = mkVideo(v, 5, 2, { assetId: 'vid10' });
      ids.push(x.id, y.id);
      return [x, y];
    });
    ed().select(ids);
    ed().copySelection();
    ed().removeAsset('vid2');
    const created = act(() => ed().paste(20));
    expect(created).toHaveLength(1);
    // offsets are relative to the earliest *copied* clip, so the survivor keeps its +5 offset
    expect(clipOf(created[0]!).start).toBe(25);
  });
  it('paste onto occupied space goes to another track, or a new one', () => {
    let a = '';
    load((v) => {
      const x = mkVideo(v, 0, 4);
      a = x.id;
      return [x];
    });
    ed().select([a]);
    ed().copySelection();
    const home = clipOf(a).trackId;
    const [p1] = act(() => ed().paste(1))!;
    expect(clipOf(p1!).trackId).not.toBe(home);
    expect(proj().tracks.filter((t) => t.kind === 'video')).toHaveLength(2);
    // third paste at same spot: both tracks occupied -> a third one is created
    const [p2] = act(() => ed().paste(1))!;
    expect(clipOf(p2!).trackId).not.toBe(home);
    expect(clipOf(p2!).trackId).not.toBe(clipOf(p1!).trackId);
    expect(proj().tracks.filter((t) => t.kind === 'video')).toHaveLength(3);
    // fourth paste elsewhere re-uses an existing track
    const [p3] = act(() => ed().paste(10))!;
    expect(proj().tracks.filter((t) => t.kind === 'video')).toHaveLength(3);
    expect(clipOf(p3!).start).toBe(10);
  });
  it('paste never uses a locked track', () => {
    let a = '';
    const t = load((v) => {
      const x = mkVideo(v, 0, 2);
      a = x.id;
      return [x];
    });
    ed().select([a]);
    ed().copySelection();
    ed().updateTrack(t.v, { locked: true });
    const [p] = act(() => ed().paste(10))!;
    expect(clipOf(p!).trackId).not.toBe(t.v);
  });
  it('paste at a negative time clamps to 0', () => {
    let a = '';
    load((v) => {
      const x = mkVideo(v, 0, 2);
      a = x.id;
      return [x];
    });
    ed().select([a]);
    ed().copySelection();
    const [p] = act(() => ed().paste(-5))!;
    expect(clipOf(p!).start).toBe(0);
  });
  it('clipboard is a snapshot: later edits of the original do not change it', () => {
    let a = '';
    load((v) => {
      const x = mkVideo(v, 0, 2);
      a = x.id;
      return [x];
    });
    ed().select([a]);
    ed().copySelection();
    ed().updateTransform(a, { x: 99 });
    const [p] = ed().paste(10);
    expect(vid(p!).transform.x).toBe(0);
  });
});

/* ---------- tracks ---------- */

describe('track ops', () => {
  it('addTrack: video goes on top, audio at the bottom', () => {
    fresh();
    const v2 = act(() => ed().addTrack('video'));
    const a2 = act(() => ed().addTrack('audio'));
    const kinds = proj().tracks.map((t) => t.kind);
    expect(kinds).toEqual(['video', 'video', 'audio', 'audio']);
    expect(proj().tracks[0]!.id).toBe(v2);
    expect(proj().tracks[3]!.id).toBe(a2);
  });
  it('addTrack with an index respects video-first grouping', () => {
    const { v, a } = fresh();
    const v2 = act(() => ed().addTrack('video', { index: 99 }));
    expect(proj().tracks.map((t) => t.id)).toEqual([v, v2, a]);
    const a2 = act(() => ed().addTrack('audio', { index: 0 }));
    expect(proj().tracks.map((t) => t.id)).toEqual([v, v2, a2, a]);
    act(() => ed().addTrack('video', { index: -5 }));
    expect(proj().tracks[0]!.kind).toBe('video');
  });
  it('addTrack returns a fresh id every time', () => {
    fresh();
    const ids = new Set([ed().addTrack('video'), ed().addTrack('video'), ed().addTrack('audio')]);
    expect(ids.size).toBe(3);
  });
  // regression: names are derived from the track count, so removing "video 1" and adding a track creates a second "video 2".
  it('new track names are unique', () => {
    const { v } = fresh();
    ed().addTrack('video'); // video 2
    ed().removeTrack(v); // leaves only "video 2"
    ed().addTrack('video');
    const names = proj().tracks.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
  it('removeTrack removes its clips and prunes selection', () => {
    let a = '';
    const t = load((v) => {
      const x = mkVideo(v, 0, 2);
      a = x.id;
      return [x, mkAudio('', 0, 2)];
    });
    // move the audio clip to the audio track
    const p = proj();
    ed().openProject({ ...p, clips: p.clips.map((c) => (c.type === 'audio' ? { ...c, trackId: t.a } : c)) });
    ed().select([a]);
    act(() => ed().removeTrack(t.v));
    expect(proj().tracks.map((x) => x.id)).toEqual([t.a]);
    expect(proj().clips).toHaveLength(1);
    expect(proj().clips[0]!.type).toBe('audio');
    expect(ed().selection).toEqual([]);
  });
  it('removeTrack of an unknown id is a no-op', () => {
    fresh();
    ed().removeTrack('nope');
    expect(ed().past).toHaveLength(0);
  });
  it('moveTrack reorders inside the group and clamps at the group bounds', () => {
    const { v, a } = fresh();
    const v2 = ed().addTrack('video');
    const a2 = ed().addTrack('audio');
    expect(proj().tracks.map((t) => t.id)).toEqual([v2, v, a, a2]);
    act(() => ed().moveTrack(v2, 1));
    expect(proj().tracks.map((t) => t.id)).toEqual([v, v2, a, a2]);
    // a video track can not go into the audio block
    act(() => ed().moveTrack(v, 99));
    expect(proj().tracks.map((t) => t.id)).toEqual([v2, v, a, a2]);
    // and an audio track can not go into the video block
    act(() => ed().moveTrack(a2, -5));
    expect(proj().tracks.map((t) => t.id)).toEqual([v2, v, a2, a]);
    act(() => ed().moveTrack(a2, 99));
    expect(proj().tracks.map((t) => t.id)).toEqual([v2, v, a, a2]);
  });
  it('moveTrack to the same place or an unknown track records nothing', () => {
    const { v } = fresh();
    ed().moveTrack(v, 0);
    ed().moveTrack('nope', 0);
    expect(ed().past).toHaveLength(0);
  });
  it('updateTrack patches name/muted/hidden/locked', () => {
    const { v } = fresh();
    act(() => ed().updateTrack(v, { name: 'main', muted: true, hidden: true, locked: true }));
    expect(proj().tracks[0]).toMatchObject({ name: 'main', muted: true, hidden: true, locked: true });
    const before = proj();
    ed().updateTrack('nope', { name: 'x' });
    expect(proj()).toBe(before);
  });
});

/* ---------- misc edits ---------- */

describe('updateClip / updateTransform / updateProject', () => {
  it('updateClip ignores placement fields and fields the type does not have', () => {
    let a = '';
    load((v) => {
      const x = mkVideo(v, 1, 2);
      a = x.id;
      return [x];
    });
    const before = proj();
    ed().updateClip(a, { start: 50, duration: 50, trackId: 'zz', trimStart: 3, speed: 3 } as never);
    ed().updateClip(a, { text: 'hi' });
    expect(proj()).toBe(before);
    ed().updateClip(a, { volume: 5, name: 'renamed' });
    expect(vid(a)).toMatchObject({ volume: 2, name: 'renamed', start: 1, duration: 2 });
    ed().updateClip(a, { fadeIn: 99 });
    expect(vid(a).fadeIn).toBe(2);
    inv();
  });
  it('updateTransform clamps opacity and scale and ignores audio', () => {
    let a = '';
    let au = '';
    load((v, aT) => {
      const x = mkVideo(v, 0, 2);
      const y = mkAudio(aT, 0, 2);
      a = x.id;
      au = y.id;
      return [x, y];
    });
    ed().updateTransform(a, { opacity: 5, scale: 0, x: 10 });
    expect(vid(a).transform).toMatchObject({ opacity: 1, scale: 0.01, x: 10 });
    const before = proj();
    ed().updateTransform(au, { x: 1 });
    expect(proj()).toBe(before);
  });
  // regression: updateTransform with values identical to the current ones still builds a new project object
  // (updateClip / moveClips / trimClip detect no-ops). a gesture that sets the same value therefore leaves a useless undo step.
  it('updateTransform with unchanged values is a no-op', () => {
    let a = '';
    load((v) => {
      const x = mkVideo(v, 0, 2);
      a = x.id;
      return [x];
    });
    const before = proj();
    ed().updateTransform(a, { x: 0, scale: 1 });
    expect(proj()).toBe(before);
    expect(ed().past).toHaveLength(0);
  });
  it('updateProject clamps size and fps and cleans the name', () => {
    fresh();
    ed().updateProject({ width: 1, height: 99999, fps: 500, name: '   ' });
    expect(proj()).toMatchObject({ width: 16, height: 7680, fps: 120, name: 'untitled project' });
  });
});

/* ---------- selection ---------- */

describe('selection', () => {
  let ids: string[];
  let lockedId: string;
  beforeEach(() => {
    ids = [];
    load(
      (v, a) => {
        const x = mkVideo(v, 0, 1);
        const y = mkVideo(v, 1, 1);
        const z = mkAudio(a, 0, 1);
        ids.push(x.id, y.id, z.id);
        return [x, y, z];
      },
    );
  });
  it('replace / add / toggle', () => {
    ed().select([ids[0]!]);
    expect(ed().selection).toEqual([ids[0]]);
    ed().select([ids[1]!], 'add');
    expect(ed().selection).toEqual([ids[0], ids[1]]);
    ed().select([ids[1]!, ids[2]!], 'toggle');
    expect(ed().selection).toEqual([ids[0], ids[2]]);
    ed().select([ids[2]!], 'add');
    expect(ed().selection).toEqual([ids[0], ids[2]]);
    ed().select([ids[2]!]);
    expect(ed().selection).toEqual([ids[2]]);
    ed().select([]);
    expect(ed().selection).toEqual([]);
    inv();
  });
  it('ignores unknown ids and clips on locked tracks', () => {
    ed().select(['nope', ids[0]!]);
    expect(ed().selection).toEqual([ids[0]]);
    lockedId = proj().tracks[1]!.id;
    ed().updateTrack(lockedId, { locked: true });
    ed().select([ids[2]!], 'add');
    expect(ed().selection).toEqual([ids[0]]);
    ed().selectAll();
    expect(ed().selection).toEqual([ids[0], ids[1]]);
  });
  it('selectAll and clearSelection', () => {
    ed().selectAll();
    expect(ed().selection).toHaveLength(3);
    ed().clearSelection();
    expect(ed().selection).toEqual([]);
  });
  it('selection is never part of history but is pruned by undo', () => {
    const [x] = ed().duplicateClips([ids[0]!]);
    expect(ed().selection).toEqual([x]);
    ed().undo();
    expect(ed().selection).toEqual([]);
    inv();
  });
});

/* ---------- history ---------- */

describe('history', () => {
  function base(): { v: string; a: string; c: string } {
    let c = '';
    const t = load((v) => {
      const x = mkVideo(v, 0, 4);
      c = x.id;
      return [x];
    });
    // a second (empty) video track so reorder actions have something to do
    ed().addTrack('video', { skipHistory: true });
    ed().openProject(proj());
    return { ...t, c };
  }

  const actions: Array<[string, (b: { v: string; a: string; c: string }) => void]> = [
    ['updateProject', () => ed().updateProject({ name: 'renamed', fps: 24 })],
    ['addTrack', () => void ed().addTrack('video')],
    ['removeTrack', (b) => ed().removeTrack(b.v)],
    ['updateTrack', (b) => ed().updateTrack(b.v, { muted: true })],
    ['moveTrack', (b) => ed().moveTrack(b.v, 0)],
    ['insertAsset', () => void ed().insertAsset('vid2')],
    ['addText', () => void ed().addText()],
    ['updateClip', (b) => ed().updateClip(b.c, { name: 'x' })],
    ['updateTransform', (b) => ed().updateTransform(b.c, { x: 10 })],
    ['moveClips', (b) => void ed().moveClips([{ id: b.c, trackId: b.v, start: 7 }])],
    ['trimClip', (b) => ed().trimClip(b.c, 'end', 2)],
    ['setClipSpeed', (b) => ed().setClipSpeed(b.c, 2)],
    ['splitClips', () => void ed().splitClips(2)],
    ['deleteClips', (b) => ed().deleteClips([b.c])],
    ['duplicateClips', (b) => void ed().duplicateClips([b.c])],
    ['cutSelection', (b) => {
      ed().select([b.c]);
      ed().cutSelection();
    }],
    ['paste', (b) => {
      ed().select([b.c]);
      ed().copySelection();
      ed().paste(10);
    }],
  ];

  for (const [name, run] of actions) {
    it(`undo/redo: ${name}`, () => {
      const b = base();
      const start = proj();
      const pastLen = ed().past.length;
      run(b);
      inv(name);
      const after = proj();
      expect(after).not.toBe(start);
      expect(ed().past.length).toBeGreaterThan(pastLen);
      expect(ed().future).toHaveLength(0);
      // undo everything the helper recorded
      while (ed().past.length > 0) {
        ed().undo();
        inv(`undo ${name}`);
      }
      expect(proj()).toEqual(start);
      while (ed().future.length > 0) {
        ed().redo();
        inv(`redo ${name}`);
      }
      expect(proj()).toEqual(after);
    });
  }

  it('assets survive undo and redo', () => {
    base();
    ed().updateProject({ name: 'a' });
    ed().addAsset(mkAsset('late', 'video', 3));
    ed().updateProject({ name: 'b' });
    ed().undo();
    expect(proj().assets.some((a) => a.id === 'late')).toBe(true);
    ed().undo();
    expect(proj().assets.some((a) => a.id === 'late')).toBe(true);
    ed().redo();
    ed().redo();
    expect(proj().assets.some((a) => a.id === 'late')).toBe(true);
    expect(proj().name).toBe('b');
  });

  it('addAsset ignores duplicates and records no history', () => {
    base();
    const n = proj().assets.length;
    ed().addAsset(mkAsset('vid10', 'video', 10));
    expect(proj().assets).toHaveLength(n);
    ed().addAsset(mkAsset('new', 'audio', 1));
    expect(proj().assets).toHaveLength(n + 1);
    expect(ed().past).toHaveLength(0);
  });

  it('renameAsset is not undoable and ignores blank names', () => {
    base();
    ed().renameAsset('vid10', '  new name ');
    expect(proj().assets.find((a) => a.id === 'vid10')!.name).toBe('new name');
    ed().renameAsset('vid10', '   ');
    expect(proj().assets.find((a) => a.id === 'vid10')!.name).toBe('new name');
    expect(ed().past).toHaveLength(0);
  });

  it('pushHistory + skipHistory gesture is exactly one undo step', () => {
    const b = base();
    const start = proj();
    ed().pushHistory();
    for (let i = 1; i <= 20; i++) {
      ed().updateTransform(b.c, { x: i }, { skipHistory: true });
      ed().moveClips([{ id: b.c, trackId: b.v, start: i * 0.1 }], { skipHistory: true });
    }
    inv('gesture');
    expect(ed().past).toHaveLength(1);
    const end = proj();
    expect(vid(b.c).transform.x).toBe(20);
    ed().undo();
    expect(proj()).toEqual(start);
    ed().redo();
    expect(proj()).toEqual(end);
  });

  it('two gestures in a row are two steps', () => {
    const b = base();
    ed().pushHistory();
    ed().updateTransform(b.c, { x: 1 }, { skipHistory: true });
    ed().pushHistory();
    ed().updateTransform(b.c, { x: 2 }, { skipHistory: true });
    expect(ed().past).toHaveLength(2);
    ed().undo();
    expect(vid(b.c).transform.x).toBe(1);
    ed().undo();
    expect(vid(b.c).transform.x).toBe(0);
  });

  it('pushHistory twice with no change records one step', () => {
    const b = base();
    ed().pushHistory();
    ed().pushHistory();
    expect(ed().past).toHaveLength(1);
    void b;
  });

  it('a gesture that changed nothing leaves no extra undo step', () => {
    const b = base();
    const original = proj();
    ed().updateClip(b.c, { name: 'first' });
    const afterFirst = proj();
    ed().pushHistory(); // gesture starts
    expect(ed().moveClips([{ id: b.c, trackId: b.v, start: 0 }], { skipHistory: true })).toBe(false); // unchanged -> no-op
    expect(proj()).toBe(afterFirst);
    ed().undo();
    // one undo goes back past the empty gesture to before the real edit
    expect(proj()).toEqual(original);
    expect(ed().past).toHaveLength(0);
  });

  it('undo on a fresh project after an empty gesture changes nothing', () => {
    base();
    const p = proj();
    ed().pushHistory();
    ed().undo();
    expect(proj()).toBe(p);
    expect(ed().past).toHaveLength(0);
  });

  it('redo is cleared by a new action', () => {
    const b = base();
    ed().updateClip(b.c, { name: 'one' });
    ed().undo();
    expect(ed().future).toHaveLength(1);
    ed().updateClip(b.c, { name: 'two' });
    expect(ed().future).toHaveLength(0);
    const p = proj();
    ed().redo();
    expect(proj()).toBe(p);
  });

  it('redo is cleared when a gesture starts', () => {
    const b = base();
    ed().updateClip(b.c, { name: 'one' });
    ed().undo();
    ed().pushHistory();
    expect(ed().future).toHaveLength(0);
  });

  it('undo/redo with nothing to do are no-ops', () => {
    base();
    const p = proj();
    ed().undo();
    ed().redo();
    expect(proj()).toBe(p);
  });

  it('keeps at most HISTORY_LIMIT (100) steps', () => {
    base();
    for (let i = 1; i <= 150; i++) ed().updateProject({ name: `n${i}` });
    expect(ed().past).toHaveLength(100);
    for (let i = 0; i < 200; i++) ed().undo();
    expect(proj().name).toBe('n50');
    expect(ed().past).toHaveLength(0);
    expect(ed().future.length).toBeLessThanOrEqual(100);
    for (let i = 0; i < 200; i++) ed().redo();
    expect(proj().name).toBe('n150');
  });

  it('removeAsset removes its clips and clears history', () => {
    let a = '';
    let b = '';
    load((v) => {
      const x = mkVideo(v, 0, 2, { assetId: 'vid2' });
      const y = mkVideo(v, 2, 2, { assetId: 'vid10' });
      a = x.id;
      b = y.id;
      return [x, y];
    });
    ed().updateProject({ name: 'x' });
    ed().undo();
    ed().select([a, b]);
    ed().removeAsset('vid2');
    expect(ed().past).toEqual([]);
    expect(ed().future).toEqual([]);
    expect(proj().assets.some((x) => x.id === 'vid2')).toBe(false);
    expect(proj().clips.map((c) => c.id)).toEqual([b]);
    expect(ed().selection).toEqual([b]);
    inv();
  });

  it('openProject resets history and selection; closeProject clears the project', () => {
    const b = base();
    ed().select([b.c]);
    ed().updateProject({ name: 'x' });
    fresh();
    expect(ed().past).toEqual([]);
    expect(ed().selection).toEqual([]);
    ed().closeProject();
    expect(ed().project).toBeNull();
    expect(ed().insertAsset('vid2')).toBeNull();
    expect(ed().addTrack('video')).toBe('');
    expect(ed().moveClips([])).toBe(false);
  });
});

/* ---------- view ---------- */

describe('view state', () => {
  it('zoom is clamped', () => {
    ed().setZoom(1);
    expect(ed().zoom).toBe(4);
    ed().setZoom(99999);
    expect(ed().zoom).toBe(600);
    ed().setZoom(120);
    expect(ed().zoom).toBe(120);
  });
  it('snapping toggles', () => {
    ed().setSnapping(false);
    expect(ed().snapping).toBe(false);
    ed().setSnapping(true);
    expect(ed().snapping).toBe(true);
  });
});

/* ---------- randomized fuzz: invariants hold after any sequence of actions ---------- */

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

describe('fuzz', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`random action sequences keep every invariant (seed ${seed})`, () => {
      fresh();
      const rnd = mulberry32(seed);
      const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
      const time = () => Math.round(rnd() * 30 * 20) / 20;
      const log: string[] = [];
      for (let step = 0; step < 250; step++) {
        const p = proj();
        const clip = p.clips.length > 0 ? pick(p.clips) : undefined;
        const track = pick(p.tracks.length > 0 ? p.tracks : [undefined as never]);
        const op = Math.floor(rnd() * 22);
        let desc = `#${step} op${op}`;
        switch (op) {
          case 0:
          case 1:
            desc += ' insert';
            ed().insertAsset(pick(['vid10', 'vid2', 'aud10', 'img']), rnd() < 0.5 ? { start: time() } : rnd() < 0.5 && track ? { trackId: track.id, start: time() } : undefined);
            break;
          case 2:
            desc += ' text';
            ed().addText(rnd() < 0.5 ? { start: time(), duration: 0.5 + rnd() * 5 } : undefined);
            break;
          case 3:
          case 4:
            if (clip) {
              const t = pick(p.tracks.filter((x) => x.kind === (clip.type === 'audio' ? 'audio' : 'video')));
              desc += ` move ${clip.id}`;
              ed().moveClips([{ id: clip.id, trackId: t ? t.id : clip.trackId, start: time() }]);
            }
            break;
          case 5:
          case 6:
            if (clip) {
              desc += ` trim ${clip.id}`;
              ed().trimClip(clip.id, rnd() < 0.5 ? 'start' : 'end', time());
            }
            break;
          case 7:
            if (clip) {
              desc += ` speed ${clip.id}`;
              ed().setClipSpeed(clip.id, pick([0.25, 0.5, 1, 1.5, 2, 4, 9]));
            }
            break;
          case 8:
          case 9:
            desc += ' split';
            if (rnd() < 0.5 && clip) ed().select([clip.id]);
            ed().splitClips(time());
            break;
          case 10:
            if (clip) {
              desc += ' delete';
              ed().deleteClips([clip.id], { ripple: rnd() < 0.5 });
            }
            break;
          case 11:
            if (clip) {
              desc += ' dup';
              ed().duplicateClips([clip.id]);
            }
            break;
          case 12:
            if (clip) {
              ed().select([clip.id]);
              ed().copySelection();
              desc += ' copy';
            }
            break;
          case 13:
            desc += ' paste';
            ed().paste(time());
            break;
          case 14:
            desc += ' addTrack';
            ed().addTrack(rnd() < 0.6 ? 'video' : 'audio', rnd() < 0.3 ? { index: Math.floor(rnd() * 6) - 1 } : undefined);
            break;
          case 15:
            if (track && p.tracks.length > 1) {
              desc += ' removeTrack';
              ed().removeTrack(track.id);
            }
            break;
          case 16:
            if (track) {
              desc += ' moveTrack';
              ed().moveTrack(track.id, Math.floor(rnd() * 7) - 1);
            }
            break;
          case 17:
            if (track) {
              desc += ' lock';
              ed().updateTrack(track.id, { locked: rnd() < 0.3 });
            }
            break;
          case 18:
            desc += ' undo';
            ed().undo();
            break;
          case 19:
            desc += ' redo';
            ed().redo();
            break;
          case 20:
            if (clip) {
              desc += ' fades';
              ed().updateClip(clip.id, { fadeIn: rnd() * 3, fadeOut: rnd() * 3 });
            }
            break;
          default:
            desc += ' selectAll cut';
            ed().selectAll();
            if (rnd() < 0.3) ed().cutSelection();
            break;
        }
        log.push(desc);
        try {
          inv(desc);
        } catch (e) {
          throw new Error(`invariant broke after: ${log.slice(-6).join(' | ')}\n${(e as Error).message}`);
        }
      }
    });
  }
});

/* ---------- locked tracks ---------- */

describe('locked track editing', () => {
  it('drops selection and blocks updateClip / updateTransform on a locked track', () => {
    const t = load((v) => [mkVideo(v, 0, 2, { id: 'LK' })]);
    ed().select(['LK']);
    expect(ed().selection).toEqual(['LK']);
    ed().updateTrack(t.v, { locked: true });
    expect(ed().selection).toEqual([]);
    const before = clipOf('LK');
    ed().updateClip('LK', { volume: 0.5 } as never);
    ed().updateTransform('LK', { x: 50 });
    expect(clipOf('LK')).toBe(before);
    ed().updateTrack(t.v, { locked: false });
    ed().updateTransform('LK', { x: 50 });
    expect((clipOf('LK') as VideoClip).transform.x).toBe(50);
  });
});

export type { TextClip };
