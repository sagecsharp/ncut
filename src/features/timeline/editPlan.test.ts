import { describe, expect, it } from 'vitest';
import type { AudioClip, Clip, ImageClip, MediaAsset, Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { AUTO_TARGETS, NEW_AUDIO, NEW_VIDEO, autoTargetId, editPoints, editReason, editSummary, insertPrep, isEditStop, landsOn, partsFor, planEdit, planInsertMoves, resolveTargets, selectedTargets, targetTrackId } from './editPlan';
import type { EditInput, EditPlan, EditStop, EditStopWhy } from './editPlan';
import { EDIT_TEXT, editStopText } from './editText';

const track = (id: string, kind: 'video' | 'audio', over: Partial<Track> = {}): Track => ({ id, kind, name: id === 'v1' ? 'video 1' : id === 'a1' ? 'audio 1' : id, muted: false, hidden: false, locked: false, ...over });
const asset = (id: string, kind: MediaAsset['kind'], duration: number, hasAudio: boolean, over: Partial<MediaAsset> = {}): MediaAsset => ({
  id, name: id, kind, mime: kind + '/x', size: 1, duration, width: 100, height: 100, hasAudio, createdAt: 0, ...over,
});
const video = (id: string, trackId: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'old', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (id: string, trackId: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'old', trimStart: 0, speed: 1, volume: 1, muted: false, ...over,
});
const image = (id: string, trackId: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'pic', transform: { ...DEFAULT_TRANSFORM }, ...over,
});

/** video 2 over video 1, audio 1 over audio 2: auto picture is video 1, auto sound is audio 1 */
const TRACKS = [track('v2', 'video'), track('v1', 'video'), track('a1', 'audio'), track('a2', 'audio')];
const ASSETS = [
  asset('vid', 'video', 10, true),
  asset('old', 'video', 10, true),
  asset('silent', 'video', 10, false),
  asset('song', 'audio', 8, true),
  asset('pic', 'image', 0, false),
];

function proj(clips: Clip[] = [], over: Partial<Project> = {}, tracks: Track[] = TRACKS): Project {
  return { ...createProject('plan'), tracks, assets: ASSETS, clips, ...over };
}
const withMarks = (id: string, marks: MediaAsset['marks']): MediaAsset[] => ASSETS.map((a) => (a.id === id ? { ...a, marks } : a));
const A = (id: string): MediaAsset => ASSETS.find((a) => a.id === id)!;

let n = 0;
const maker = () => ({ clip: () => `c${++n}`, group: () => `g${++n}` });
const input = (over: Partial<EditInput> = {}): EditInput => ({ mode: 'insert', assetId: 'vid', playhead: 0, targets: AUTO_TARGETS, apart: false, selection: [], ...over });
const plan = (p: Project, over: Partial<EditInput> = {}): EditPlan => {
  const r = planEdit(p, input(over), maker());
  if (isEditStop(r)) throw new Error('stopped: ' + r.why);
  return r;
};
const stop = (p: Project, over: Partial<EditInput> = {}): EditStop => {
  const r = planEdit(p, input(over), maker());
  if (!isEditStop(r)) throw new Error('did not stop');
  return r;
};
const points = (mode: EditInput['mode'], a: MediaAsset, marks: MediaAsset['marks'] | null, range: Project['range'] | null, playhead = 0) => editPoints(mode, a, marks ?? null, range ?? null, playhead, 30);

describe('targets', () => {
  it('auto targets and new keys', () => {
    expect(autoTargetId(TRACKS, 'video')).toBe('v1');
    expect(autoTargetId(TRACKS, 'audio')).toBe('a1');
    const locked = TRACKS.map((t) => (t.id === 'v1' ? { ...t, locked: true } : t));
    expect(autoTargetId(locked, 'video')).toBe('v2');
    expect(autoTargetId(TRACKS.map((t) => ({ ...t, locked: true })), 'video')).toBe(NEW_VIDEO);
    expect(autoTargetId(TRACKS.map((t) => ({ ...t, locked: true })), 'audio')).toBe(NEW_AUDIO);
    expect(autoTargetId([], 'video')).toBe(NEW_VIDEO);
    // hidden and muted tracks can be auto targets
    const quiet = TRACKS.map((t) => (t.id === 'v1' || t.id === 'a1' ? { ...t, hidden: t.kind === 'video', muted: true } : t));
    expect(autoTargetId(quiet, 'video')).toBe('v1');
    expect(autoTargetId(quiet, 'audio')).toBe('a1');
    expect(resolveTargets(TRACKS, AUTO_TARGETS)).toEqual({ picture: 'v1', sound: 'a1' });
    expect(resolveTargets(TRACKS, AUTO_TARGETS)).toBe(resolveTargets(TRACKS, AUTO_TARGETS));
  });

  it('a gone id or the other kind reads auto, false is off', () => {
    expect(targetTrackId(TRACKS, 'video', 'v2')).toBe('v2');
    expect(targetTrackId(TRACKS, 'video', 'gone')).toBe('v1');
    expect(targetTrackId(TRACKS, 'video', 'a2')).toBe('v1');
    expect(targetTrackId(TRACKS, 'audio', 'v2')).toBe('a1');
    expect(targetTrackId(TRACKS, 'audio', false)).toBeNull();
    expect(resolveTargets(TRACKS, { picture: false, sound: 'a2' })).toEqual({ picture: null, sound: 'a2' });
    // a locked track named on purpose stays the target (the edit stops on it)
    const locked = TRACKS.map((t) => (t.id === 'v2' ? { ...t, locked: true } : t));
    expect(targetTrackId(locked, 'video', 'v2')).toBe('v2');
  });

  it('a locked landing target stops, new keys only where a clip lands', () => {
    const locked = TRACKS.map((t) => (t.id === 'v1' ? { ...t, locked: true } : t));
    expect(stop(proj([], {}, locked), { targets: { picture: 'v1', sound: null } })).toEqual({ why: 'target-locked', trackId: 'v1' });
    // a locked sound target that gets nothing (a video without apart) is never checked
    const lockedSound = TRACKS.map((t) => (t.id === 'a1' ? { ...t, locked: true } : t));
    expect(plan(proj([], {}, lockedSound), { targets: { picture: null, sound: 'a1' } }).targetIds).toEqual(['v1']);
    // with apart the sound lands on it: stop
    expect(stop(proj([], {}, lockedSound), { targets: { picture: null, sound: 'a1' }, apart: true })).toEqual({ why: 'target-locked', trackId: 'a1' });
    // all video tracks locked: a new video track, and no new audio track for a video that keeps its sound
    const allLocked = TRACKS.map((t) => ({ ...t, locked: true }));
    const a = plan(proj([], {}, allLocked));
    expect(a.newTracks).toEqual([{ key: NEW_VIDEO, kind: 'video' }]);
    expect(a.targetIds).toEqual([NEW_VIDEO]);
    expect(a.clips[0]!.clip.trackId).toBe(NEW_VIDEO);
    expect(plan(proj([], {}, allLocked), { apart: true }).newTracks.map((t) => t.key)).toEqual([NEW_VIDEO, NEW_AUDIO]);
    expect(plan(proj([], {}, allLocked), { assetId: 'song' }).newTracks).toEqual([{ key: NEW_AUDIO, kind: 'audio' }]);
  });
});

describe('parts', () => {
  it('partsFor, pairs and landsOn', () => {
    const vid = A('vid');
    expect(partsFor(vid, 'v1', 'a1', false)).toEqual({ parts: 'both', pair: false, usesPicture: true, usesSound: false });
    expect(partsFor(vid, 'v1', 'a1', true)).toEqual({ parts: 'both', pair: true, usesPicture: true, usesSound: true });
    expect(partsFor(vid, null, 'a1', false)).toEqual({ parts: 'sound', pair: false, usesPicture: false, usesSound: true });
    expect(partsFor(vid, 'v1', null, true)).toEqual({ parts: 'picture', pair: false, usesPicture: true, usesSound: false });
    expect(partsFor(vid, null, null, false)).toBe('targets-off');
    expect(partsFor(A('silent'), null, 'a1', false)).toBe('picture-off');
    expect(partsFor(A('song'), 'v1', null, false)).toBe('sound-off');
    expect(partsFor(A('song'), null, 'a2', false)).toMatchObject({ usesSound: true, usesPicture: false });
    expect(partsFor(A('pic'), 'v1', null, false)).toMatchObject({ usesPicture: true });
    expect(landsOn('video', vid, true, false)).toBe(true);
    expect(landsOn('video', A('song'), true, false)).toBe(false);
    expect(landsOn('audio', vid, true, false)).toBe(false);
    expect(landsOn('audio', vid, true, true)).toBe(true);
    expect(landsOn('audio', vid, false, false)).toBe(true);
    expect(landsOn('audio', A('song'), true, false)).toBe(true);
    expect(landsOn('audio', A('silent'), false, true)).toBe(false);
  });

  it('a picture has marks null, whatever the input says', () => {
    const p = proj();
    const r = plan(p, { assetId: 'pic', marks: { in: 1, out: 2 } });
    expect(r.points).toMatchObject({ length: 5, from: 0, sourceBy: 'start' });
    expect(r.clips[0]!.clip.type).toBe('image');
  });
});

describe('editPoints', () => {
  it('editPoints: both timeline marks', () => {
    const vid = A('vid');
    expect(points('insert', vid, { in: 2, out: 6 }, { in: 1, out: 4 })).toMatchObject({ start: 1, length: 3, from: 2, speed: 1, by: 'range', sourceBy: 'in', ignored: 'source-out', usedRange: true });
    expect(points('overwrite', vid, { in: 2 }, { in: 1, out: 4 })).toMatchObject({ from: 2, sourceBy: 'in', ignored: null });
    expect(points('insert', vid, { out: 6 }, { in: 1, out: 4 })).toMatchObject({ from: 3, sourceBy: 'out', ignored: null });
    expect(points('insert', vid, null, { in: 1, out: 4 })).toMatchObject({ from: 0, sourceBy: 'start' });
    expect(points('insert', vid, { out: 2 }, { in: 1, out: 4 })).toEqual({ why: 'media-short-back', have: 2, need: 3 });
    expect(points('insert', vid, { out: 3 }, { in: 1, out: 4 })).toMatchObject({ from: 0, sourceBy: 'out' });
    expect(points('insert', vid, { in: 8 }, { in: 1, out: 4 })).toEqual({ why: 'media-short', have: 2, need: 3, where: 'in' });
    expect(points('insert', vid, null, { in: 0, out: 12 })).toEqual({ why: 'media-short', have: 10, need: 12, where: 'start' });
    expect(points('insert', A('pic'), null, { in: 0, out: 12 })).toMatchObject({ length: 12, from: 0 });
  });

  it('editPoints: one timeline mark or none', () => {
    const vid = A('vid');
    const m = { in: 2, out: 6 };
    expect(points('insert', vid, m, null, 1.04)).toMatchObject({ start: 31 / 30, length: 4, from: 2, by: 'playhead', usedRange: false });
    expect(points('overwrite', vid, m, { in: 5 })).toMatchObject({ start: 5, length: 4, by: 'in', usedRange: true });
    expect(points('insert', vid, m, { out: 7 })).toMatchObject({ start: 3, length: 4, by: 'out', usedRange: true });
    expect(points('insert', vid, m, { out: 3 })).toEqual({ why: 'before-zero' });
    expect(points('insert', vid, null, null)).toMatchObject({ length: 10, from: 0 });
    expect(points('insert', vid, { in: 4 }, null)).toMatchObject({ length: 6, from: 4, sourceBy: 'in' });
    expect(points('insert', A('pic'), null, null)).toMatchObject({ length: 5, from: 0 });
  });

  it('editPoints: fit', () => {
    const vid = A('vid');
    expect(points('fit', vid, { in: 2, out: 6 }, { in: 0, out: 2 })).toMatchObject({ start: 0, length: 2, from: 2, speed: 2, usedRange: true, by: 'range' });
    expect(points('fit', vid, null, { in: 1, out: 6 })).toMatchObject({ length: 5, from: 0, speed: 2 });
    expect(points('fit', vid, { in: 2, out: 6 }, null)).toEqual({ why: 'needs-range' });
    expect(points('fit', vid, { in: 2, out: 6 }, { in: 1 })).toEqual({ why: 'needs-range' });
    const fast = points('fit', vid, { in: 2, out: 6 }, { in: 0, out: 0.5 }) as EditStop;
    expect(fast.why).toBe('fit-fast');
    expect(fast.speed).toBeCloseTo(8, 6);
    const slow = points('fit', vid, { in: 2, out: 3 }, { in: 0, out: 40 }) as EditStop;
    expect(slow.why).toBe('fit-slow');
    expect(slow.speed).toBeCloseTo(0.025, 6);
    expect(points('fit', vid, { in: 2, out: 10 }, { in: 0, out: 2 })).toMatchObject({ speed: 4 });
    expect(points('fit', A('pic'), null, { in: 1, out: 4 })).toMatchObject({ length: 3, speed: 1, from: 0 });
  });

  it('too-short', () => {
    const vid = A('vid');
    expect(points('insert', vid, null, { in: 1, out: 1.02 })).toEqual({ why: 'too-short' });
    expect(points('insert', vid, { in: 2, out: 2.02 }, null)).toEqual({ why: 'too-short' });
    expect(points('append', vid, { in: 2, out: 2.02 }, null)).toEqual({ why: 'too-short' });
    expect(points('fit', vid, { in: 2, out: 2.02 }, { in: 0, out: 2 })).toEqual({ why: 'too-short' });
    expect(points('insert', asset('tiny', 'video', 0.03, true), null, null)).toEqual({ why: 'too-short' });
    expect((points('insert', vid, { in: 2, out: 2.05 }, null) as { length: number }).length).toBeCloseTo(0.05, 6);
  });

  it('append goes after the last clip of the landing tracks', () => {
    const p = proj([video('x', 'v1', 0, 3), audio('y', 'a1', 0, 7), video('z', 'v2', 0, 20)]);
    const a = plan(p, { mode: 'append' });
    expect(a.points).toMatchObject({ start: 3, by: 'end' });
    expect(a.usedRange).toBe(false);
    expect(plan(p, { mode: 'append', apart: true }).points.start).toBe(7);
    expect(plan(p, { mode: 'append', targets: { picture: 'v2', sound: null } }).points.start).toBe(20);
    expect(plan(proj(), { mode: 'append' }).points.start).toBe(0);
    // a range is never read or cleared
    const r = plan(proj([video('x', 'v1', 0, 3)], { range: { in: 5, out: 6 } }), { mode: 'append' });
    expect(r.points).toMatchObject({ start: 3, length: 10 });
    expect(r.usedRange).toBe(false);
    expect(r.prep).toBeNull();
    expect(r.clear).toBeNull();
    // a new track starts at 0
    expect(plan(proj([video('x', 'v1', 0, 3)], {}, TRACKS.map((t) => ({ ...t, locked: true }))), { mode: 'append' }).points.start).toBe(0);
  });
});

describe('plan', () => {
  it('ids come from the maker', () => {
    n = 0;
    const p = proj();
    const r = planEdit(p, input({ apart: true }), maker()) as EditPlan;
    expect(r.pair).toBe(true);
    expect(r.clips.map((e) => e.clip.id)).toEqual(['c1', 'c3']);
    expect((r.clips[0]!.clip as VideoClip).group).toBe('g2');
    expect(r.clips[0]!.clip).toMatchObject({ type: 'video', trackId: 'v1', muted: true });
    expect(r.clips[1]).toMatchObject({ after: 'c1', clip: { type: 'audio', trackId: 'a1', group: 'g2', muted: false } });
    const one = plan(p);
    expect(one.clips).toHaveLength(1);
    expect(one.clips[0]!.clip.id).toMatch(/^c\d+$/);
    expect((one.clips[0]!.clip as VideoClip).muted).toBe(false);
    expect(one.playheadAfter).toBe(10);
    expect(one.prep).toMatchObject({ at: 0, by: 10 });
    expect(one.clear).toBeNull();
    // overwrite and fit clear a span instead
    const o = plan(p, { mode: 'overwrite', playhead: 2 });
    expect(o.prep).toBeNull();
    expect(o.clear).toEqual({ start: 2, end: 12 });
    // the clip carries the marked part
    const c = plan(proj([], { assets: withMarks('vid', { in: 2, out: 6 }) })).clips[0]!.clip as VideoClip;
    expect(c).toMatchObject({ trimStart: 2, duration: 4, speed: 1 });
    // picture off: the sound alone, a sound clip
    const s = plan(p, { targets: { picture: false, sound: null } });
    expect(s.parts).toBe('sound');
    expect(s.clips[0]!.clip).toMatchObject({ type: 'audio', trackId: 'a1' });
  });

  it('a fit clip has the speed and the range length', () => {
    const p = proj([], { assets: withMarks('vid', { in: 2, out: 6 }), range: { in: 1, out: 3 } });
    const r = plan(p, { mode: 'fit' });
    expect(r.clips[0]!.clip).toMatchObject({ start: 1, duration: 2, trimStart: 2, speed: 2 });
    expect(r.clear).toEqual({ start: 1, end: 3 });
    expect(r.usedRange).toBe(true);
    expect(stop(p, { mode: 'fit', range: null }).why).toBe('needs-range');
  });
});

describe('insert', () => {
  const T = ['v1', 'a1'];
  const prepOf = (clips: Clip[], at = 3, by = 2, landing = T, tracks = [...TRACKS, track('lk', 'video', { locked: true })]) => insertPrep({ clips, tracks }, at, by, landing);

  it('insertPrep: splits, slivers, locked across', () => {
    // a clip across with room on both sides is split, on any unlocked track
    const a = prepOf([video('a', 'v1', 0, 6), audio('b', 'a2', 1, 4), video('c', 'v2', 0, 3)]);
    expect(a.split).toEqual(['a', 'b']);
    expect(a.trims).toEqual([]);
    expect(a.kept).toBe(0);
    // a sliver on a landing track is trimmed off, the clip stays
    const b = prepOf([video('a', 'v1', 0, 3.03), audio('b', 'a1', 2.98, 3)]);
    expect(b.trims).toEqual([{ id: 'a', edge: 'end', time: 3 }, { id: 'b', edge: 'start', time: 3 }]);
    expect(b.slivers).toBe(2);
    expect(b.split).toEqual([]);
    // slivers on both sides: the clip goes
    const c = prepOf([video('a', 'v1', 2.97, 0.06)]);
    expect(c.deletes).toEqual(['a']);
    expect(c.slivers).toBe(2);
    // a sliver on a track that does not take the clip: it moves whole or stays whole
    const d = prepOf([video('a', 'v2', 0, 3.03), audio('b', 'a2', 2.98, 3), video('c', 'v2', 10, 1)]);
    expect(d.trims).toEqual([]);
    expect(d.deletes).toEqual([]);
    expect([...d.atOf]).toEqual([['a2', 2.98]]);
    expect(d.kept).toBe(2);
    expect(d.slivers).toBe(0);
    // a locked track is only named (S8: movingTracks decides)
    const e = prepOf([video('a', 'lk', 0, 6), video('b', 'lk', 8, 1)]);
    expect(e.lockedSpan).toEqual(['lk']);
    expect(e.split).toEqual([]);
    expect(e.kept).toBe(0);
    // a clip that ends or starts at the edit point is not across
    const f = prepOf([video('a', 'v1', 0, 3), video('b', 'v1', 3, 2)]);
    expect(f.split).toEqual([]);
    expect(f.trims).toEqual([]);
    expect(f).toMatchObject({ at: 3, by: 2 });
  });

  it('planInsertMoves: whole moves, followers, locked behind', () => {
    const fx = { id: 'fx', type: 'effect', trackId: 'v2', start: 6, duration: 2, name: 'fx', fadeIn: 0, fadeOut: 0, effect: 'blur', amount: 1, params: {}, target: 'y' } as unknown as Clip;
    const tracks = [...TRACKS, track('lk', 'video', { locked: true })];
    const clips: Clip[] = [video('x', 'v1', 3, 2), video('y', 'v1', 6, 2), audio('z', 'a1', 3, 1), audio('w', 'a2', 2, 2.5), video('l', 'lk', 4, 2), fx];
    const r = planInsertMoves({ clips, tracks }, 3, 2, new Set(['v1', 'a1']), new Map([['a2', 2]]));
    const by = Object.fromEntries(r.moves.map((m) => [m.id, m.start]));
    expect(by).toEqual({ x: 5, y: 8, z: 5, w: 4, fx: 8 });
    expect(r.lockedBehind).toEqual(['lk']);
    expect(planInsertMoves({ clips: [video('q', 'v1', 0, 2)], tracks }, 3, 2, new Set(['v1']), new Map()).moves).toEqual([]);
    expect(planInsertMoves({ clips, tracks }, 3, 0, new Set(['v1']), new Map()).moves).toEqual([]);
  });
});

describe('replace', () => {
  /** a clip c on video 1 from 2 to 8 showing 'old' from 1 s */
  const base = (over: Partial<VideoClip> = {}, extra: Clip[] = []): Project => proj([video('c', 'v1', 2, 6, { trimStart: 1, ...over }), ...extra]);
  const rep = (p: Project, over: Partial<EditInput> = {}): EditPlan => plan(p, { mode: 'replace', playhead: 4, ...over });

  it('replace: frame match and pick', () => {
    const p = base();
    const a = rep(p, { sourceTime: 5 });
    expect(a.replace).toMatchObject({ clipId: 'c', swap: true, trimStart: 3, sounds: [], soundsKept: 0 });
    expect(a.points).toMatchObject({ start: 2, length: 6, from: 3, speed: 1, by: 'clip' });
    expect(a.clips).toEqual([]);
    expect(a.playheadAfter).toBeNull();
    expect(a.usedRange).toBe(false);
    // no source time: the in mark (or 0) lands on the playhead
    expect(rep(p).replace!.trimStart).toBe(0);
    expect(rep(proj(p.clips, { assets: withMarks('vid', { in: 4 }) })).replace!.trimStart).toBe(4);
    // a clip at another speed: the source moves speed x as fast
    const fast = proj([video('c', 'v1', 2, 3, { trimStart: 1, speed: 2 })]);
    expect(rep(fast, { sourceTime: 5 }).replace!.trimStart).toBe(1);
    // the asked clip wins, then a selected one under the playhead, in track order
    const two = proj([video('c', 'v1', 2, 6), video('d', 'v2', 0, 6), video('e', 'v2', 9, 2)]);
    expect(rep(two).replace!.clipId).toBe('c');
    expect(rep(two, { selection: ['d'] }).replace!.clipId).toBe('d');
    expect(rep(two, { selection: ['e'] }).replace!.clipId).toBe('c');
    expect(rep(two, { clipId: 'd', selection: [] }).replace!.clipId).toBe('d');
    expect(stop(two, { mode: 'replace', playhead: 4, clipId: 'gone' })).toEqual({ why: 'no-clip-under' });
    // a join: the next clip wins, the end of the last clip holds nothing
    const join = proj([video('a', 'v1', 0, 4), video('b', 'v1', 4, 4)]);
    expect(rep(join, { playhead: 4 }).replace!.clipId).toBe('b');
    expect(stop(join, { mode: 'replace', playhead: 8, assetId: 'silent' })).toEqual({ why: 'no-clip-under', trackId: 'v1' });
    // a video with sound looks at the picture target, then at the sound target
    const sound = proj([audio('s', 'a1', 0, 8)]);
    expect(rep(sound).replace!.clipId).toBe('s');
    expect(stop(proj(), { mode: 'replace', playhead: 4 })).toEqual({ why: 'no-clip-under' });
    expect(stop(proj(), { mode: 'replace', playhead: 4, assetId: 'silent' })).toEqual({ why: 'no-clip-under', trackId: 'v1' });
    expect(stop(proj(), { mode: 'replace', playhead: 4, assetId: 'song' })).toEqual({ why: 'no-clip-under', trackId: 'a1' });
    // targets off
    expect(stop(p, { mode: 'replace', playhead: 4, assetId: 'silent', targets: { picture: false, sound: null } }).why).toBe('picture-off');
    expect(stop(p, { mode: 'replace', playhead: 4, assetId: 'song', targets: { picture: null, sound: false } }).why).toBe('sound-off');
    expect(stop(p, { mode: 'replace', playhead: 4, targets: { picture: false, sound: false } }).why).toBe('targets-off');
    // a selected clip needs no target
    expect(rep(p, { assetId: 'silent', targets: { picture: false, sound: false }, selection: ['c'] }).replace!.clipId).toBe('c');
  });

  it('replace: kinds, bounds and clamp', () => {
    const img = proj([image('i', 'v1', 0, 8)]);
    expect(stop(img, { mode: 'replace', playhead: 4 })).toEqual({ why: 'replace-kind', clipId: 'i' });
    const img2 = proj([image('i', 'v1', 0, 8, { assetId: 'other' })], { assets: [...ASSETS, asset('other', 'image', 0, false)] });
    expect(rep(img2, { assetId: 'pic' }).replace).toMatchObject({ clipId: 'i', swap: true, trimStart: 0, sounds: [] });
    const txt = { id: 't', type: 'text', trackId: 'v1', start: 0, duration: 8, name: 't', fadeIn: 0, fadeOut: 0 } as unknown as Clip;
    expect(stop(proj([txt]), { mode: 'replace', playhead: 4 })).toEqual({ why: 'replace-text', clipId: 't' });
    expect(stop(proj([audio('s', 'a1', 0, 8)]), { mode: 'replace', playhead: 4, assetId: 'silent', clipId: 's' })).toEqual({ why: 'replace-kind', clipId: 's' });
    expect(stop(proj([video('c', 'v1', 0, 8)]), { mode: 'replace', playhead: 4, assetId: 'song', clipId: 'c' })).toEqual({ why: 'replace-kind', clipId: 'c' });
    const locked = proj([video('c', 'v1', 0, 8)], {}, TRACKS.map((t) => (t.id === 'v1' ? { ...t, locked: true } : t)));
    expect(stop(locked, { mode: 'replace', playhead: 4, clipId: 'c' })).toEqual({ why: 'target-locked', clipId: 'c', trackId: 'v1' });
    // the media starts too late or ends too early
    const p = base();
    expect(stop(p, { mode: 'replace', playhead: 4, sourceTime: 0.5 })).toEqual({ why: 'media-before', clipId: 'c' });
    expect(stop(p, { mode: 'replace', playhead: 4, sourceTime: 8 })).toEqual({ why: 'media-after', clipId: 'c' });
    expect(rep(p, { sourceTime: 2 }).replace!.trimStart).toBe(0);
    expect(rep(p, { sourceTime: 6 }).replace!.trimStart).toBe(4);
    // a hair outside is clamped into the media
    expect(rep(p, { sourceTime: 2 - 5e-7 }).replace!.trimStart).toBe(0);
    expect(rep(p, { sourceTime: 6 + 5e-7 }).replace!.trimStart).toBe(4);
  });

  it('replace: sound clips slip or are kept', () => {
    const pair = (over: Partial<AudioClip> = {}, tracks = TRACKS): Project => proj([video('c', 'v1', 2, 6, { trimStart: 1, group: 'g' }), audio('s', 'a1', 2, 6, { trimStart: 1, group: 'g', ...over })], {}, tracks);
    const a = plan(pair(), { mode: 'replace', playhead: 4, sourceTime: 5 });
    expect(a.replace).toMatchObject({ trimStart: 3, sounds: [{ id: 's', trimStart: 3 }], soundsKept: 0 });
    // a sound clip out of sync keeps its offset
    expect(plan(pair({ trimStart: 1.5 }), { mode: 'replace', playhead: 4, sourceTime: 5 }).replace!.sounds).toEqual([{ id: 's', trimStart: 3.5 }]);
    // the new media has no sound: the sound clip keeps the old media and stays
    const b = plan(pair(), { mode: 'replace', playhead: 4, sourceTime: 5, assetId: 'silent' });
    expect(b.replace).toMatchObject({ sounds: [], soundsKept: 1 });
    // a sound clip on a locked track is kept as it is
    const c = plan(pair({}, TRACKS.map((t) => (t.id === 'a1' ? { ...t, locked: true } : t))), { mode: 'replace', playhead: 4, sourceTime: 5 });
    expect(c.replace).toMatchObject({ sounds: [], soundsKept: 1 });
    // a sound clip that would run out of the media stops, naming it
    expect(stop(pair({ trimStart: 4 }), { mode: 'replace', playhead: 4, sourceTime: 5 })).toEqual({ why: 'media-after', clipId: 's' });
    expect(stop(pair({ trimStart: 0 }), { mode: 'replace', playhead: 4, sourceTime: 1.5 })).toMatchObject({ why: 'media-before' });
  });

  it('replace: the sound of the next shot is not slipped', () => {
    // an l cut: the first picture ends at 5, its sound at 6, the second picture and its sound follow
    const cut = proj([
      video('c', 'v1', 0, 5, { group: 'g' }),
      video('p2', 'v1', 5, 5, { group: 'g', trimStart: 5 }),
      audio('s', 'a1', 0, 6, { group: 'g' }),
      audio('s2', 'a1', 6, 4, { group: 'g', trimStart: 6 }),
    ]);
    const r = plan(cut, { mode: 'replace', playhead: 2, clipId: 'c', sourceTime: 3 });
    expect(r.replace!.sounds).toEqual([{ id: 's', trimStart: 1 }]);
  });

  it('replace: same media', () => {
    const same = proj([video('c', 'v1', 2, 6, { trimStart: 3, assetId: 'vid' })]);
    expect(stop(same, { mode: 'replace', playhead: 4, sourceTime: 5 })).toEqual({ why: 'replace-same', clipId: 'c' });
    // the same media at another frame is a slip
    const r = plan(same, { mode: 'replace', playhead: 4, sourceTime: 6 });
    expect(r.replace).toMatchObject({ swap: false, trimStart: 4 });
    // another media at the same frame is a swap
    expect(plan(proj([video('c', 'v1', 2, 6, { trimStart: 3 })]), { mode: 'replace', playhead: 4, sourceTime: 5 }).replace).toMatchObject({ swap: true, trimStart: 3 });
    const img = proj([image('i', 'v1', 0, 8)]);
    expect(stop(img, { mode: 'replace', playhead: 4, assetId: 'pic' })).toEqual({ why: 'replace-same', clipId: 'i' });
    // same media at another frame: the sound clip slips by the same amount, keeping its offset
    const p = proj([video('c', 'v1', 2, 6, { trimStart: 3, assetId: 'vid', group: 'g' }), audio('s', 'a1', 2, 6, { trimStart: 2, assetId: 'vid', group: 'g' })]);
    expect(plan(p, { mode: 'replace', playhead: 4, sourceTime: 6 }).replace).toMatchObject({ swap: false, trimStart: 4, sounds: [{ id: 's', trimStart: 3 }] });
    expect(stop(p, { mode: 'replace', playhead: 4, sourceTime: 5 }).why).toBe('replace-same');
  });
});

describe('selectedTargets', () => {
  it('selectedTargets', () => {
    const clips = [video('a', 'v2', 0, 2), video('b', 'v1', 0, 2), audio('c', 'a2', 0, 2), audio('d', 'a1', 0, 2)];
    const p = proj(clips);
    expect(selectedTargets(p, ['a'])).toEqual({ picture: 'v2' });
    expect(selectedTargets(p, ['a', 'b'])).toEqual({ picture: 'v1' });
    expect(selectedTargets(p, ['c', 'd'])).toEqual({ sound: 'a1' });
    expect(selectedTargets(p, ['b', 'c'])).toEqual({ picture: 'v1', sound: 'a2' });
    expect(selectedTargets(p, [])).toBeNull();
    const locked = proj(clips, {}, TRACKS.map((t) => (t.id === 'v2' ? { ...t, locked: true } : t)));
    expect(selectedTargets(locked, ['a'])).toBeNull();
  });
});

describe('summary and reason', () => {
  it('editSummary', () => {
    expect(editSummary(null, 'vid', AUTO_TARGETS, false)).toBeNull();
    expect(editSummary(proj(), null, AUTO_TARGETS, false)).toBeNull();
    expect(editSummary(proj(), 'gone', AUTO_TARGETS, false)).toBeNull();
    const base = proj([], { assets: withMarks('vid', { in: 2, out: 6 }) });
    expect(editSummary(base, 'vid', AUTO_TARGETS, false)).toEqual({ text: '4s at the playhead on video 1', blocked: false, fit: null });
    expect(editSummary(base, 'vid', AUTO_TARGETS, true)!.text).toBe('4s at the playhead on video 1 and audio 1');
    expect(editSummary(base, 'song', AUTO_TARGETS, false)!.text).toBe('8s at the playhead on audio 1');
    const inOnly = { ...base, range: { in: 5 } };
    expect(editSummary(inOnly, 'vid', AUTO_TARGETS, false)!.text).toBe('4s at the in point on video 1');
    expect(editSummary({ ...base, range: { out: 7 } }, 'vid', AUTO_TARGETS, false)!.text).toBe('4s ending at the out point on video 1');
    const both = editSummary({ ...base, range: { in: 1, out: 4 } }, 'vid', AUTO_TARGETS, false)!;
    expect(both.text).toBe('3s in to out on video 1. ' + EDIT_TEXT.fourth);
    expect(both.fit).toBe('the marked part fills the 3s in to out range at 1.33x');
    const back = proj([], { assets: withMarks('vid', { out: 6 }), range: { in: 1, out: 4 } });
    expect(editSummary(back, 'vid', AUTO_TARGETS, false)!.text).toBe('3s in to out on video 1. ' + EDIT_TEXT.backtimed);
    expect(editSummary(proj([], { range: { in: 1, out: 4 } }), 'pic', AUTO_TARGETS, false)!.fit).toBeNull();
    // a stop: the text, blocked
    const locked = proj([], {}, TRACKS.map((t) => (t.id === 'v1' ? { ...t, locked: true } : t)));
    expect(editSummary(locked, 'vid', { picture: 'v1', sound: null }, false)).toEqual({ text: 'video 1 is locked: unlock it or pick another target', blocked: true, fit: null });
    expect(editSummary(base, 'vid', { picture: false, sound: false }, false)).toEqual({ text: EDIT_TEXT.targetsOff, blocked: true, fit: null });
    expect(editSummary(proj([], { range: { in: 0, out: 12 } }), 'vid', AUTO_TARGETS, false)!.blocked).toBe(true);
    // a new track
    const allLocked = proj([], {}, TRACKS.map((t) => ({ ...t, locked: true })));
    expect(editSummary(allLocked, 'vid', AUTO_TARGETS, false)!.text).toBe('10s at the playhead on a new video track');
    // one entry cache: clips and playhead are not in the key
    const a = editSummary(base, 'vid', AUTO_TARGETS, false);
    expect(editSummary({ ...base, clips: [video('x', 'v1', 0, 1)] }, 'vid', AUTO_TARGETS, false)).toBe(a);
    expect(editSummary({ ...base, assets: [...base.assets] }, 'vid', AUTO_TARGETS, false)).not.toBe(a);
  });

  it('editReason plans with separate sound off', () => {
    const ctx = { assetId: 'vid', sourceTime: 0, playhead: 0, selection: [], targets: AUTO_TARGETS };
    expect(editReason('insert', proj(), { ...ctx, assetId: null })).toBeNull();
    expect(editReason('insert', proj(), ctx)).toBeNull();
    expect(editReason('fit', proj(), ctx)).toBe(EDIT_TEXT.needsRange);
    expect(editReason('replace', proj(), ctx)).toBe(EDIT_TEXT.noClipUnderAny);
    const lockedSound = proj([], {}, TRACKS.map((t) => (t.id === 'a1' ? { ...t, locked: true } : t)));
    expect(editReason('insert', lockedSound, { ...ctx, targets: { picture: null, sound: 'a1' } })).toBeNull();
    expect(editReason('insert', proj(), { ...ctx, targets: { picture: false, sound: false } })).toBe(EDIT_TEXT.targetsOff);
  });

  it('stop texts fill every field', () => {
    const clips = [video('c', 'v1', 0, 4), audio('s', 'a1', 0, 4), image('i', 'v2', 0, 4)];
    const p = proj(clips);
    const whys: EditStopWhy[] = ['media-gone', 'picture-off', 'sound-off', 'targets-off', 'target-locked', 'needs-range', 'too-short', 'before-zero', 'media-short', 'media-short-back', 'fit-fast', 'fit-slow', 'no-clip-under', 'replace-kind', 'replace-text', 'replace-same', 'media-before', 'media-after'];
    for (const why of whys) {
      const text = editStopText({ why, clipId: 'c', trackId: 'v1', have: 2.5, need: 4, speed: 5.123, where: 'in' }, p);
      expect(text, why).not.toMatch(/[{}]/);
      expect(text.length).toBeGreaterThan(10);
    }
    expect(editStopText({ why: 'media-short', have: 2.5, need: 4, where: 'in' }, p)).toBe('the media has 2.5s from its in point, the range needs 4s. fit to the range changes the speed instead');
    expect(editStopText({ why: 'media-short', have: 2, need: 4, where: 'start' }, p)).toContain('from its start');
    expect(editStopText({ why: 'media-short-back', have: 2, need: 3 }, p)).toBe('the media has 2s before its out point, the range needs 3s');
    expect(editStopText({ why: 'fit-fast', speed: 5.123 }, p)).toContain('5.12x');
    expect(editStopText({ why: 'target-locked', trackId: 'v1' }, p)).toBe('video 1 is locked: unlock it or pick another target');
    expect(editStopText({ why: 'no-clip-under', trackId: 'a1' }, p)).toBe('no clip under the playhead on audio 1 to replace');
    expect(editStopText({ why: 'no-clip-under' }, p)).toBe(EDIT_TEXT.noClipUnderAny);
    expect(editStopText({ why: 'replace-kind', clipId: 'c' }, p)).toBe('"c" is a video clip: it takes only video media');
    expect(editStopText({ why: 'replace-kind', clipId: 's' }, p)).toBe('"s" is a audio clip: it takes audio or a video with sound');
    expect(editStopText({ why: 'replace-kind', clipId: 'i' }, p)).toBe('"i" is a picture clip: it takes only pictures');
    expect(editStopText({ why: 'media-before', clipId: 'c' }, p)).toContain('"c"');
  });
});
