import { describe, expect, it } from 'vitest';
import type { AudioClip, Clip, Crossfade, MediaAsset, Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { crossfadeSpan } from '../../lib/audioCross';
import type { CrossfadeSpan } from '../../lib/audioCross';
import type { CrossfadePick } from '../../store/ui';
import { planSeparate } from './soundPlan';
import { CROSS_TEXT, crossShortText } from './crossfadeText';
import {
  crossfadeTargets,
  crossfadesToDrop,
  dragCrossfade,
  editsOnTrack,
  fitCrossfade,
  nudgePlan,
  oneTake,
  pickCounts,
  placeOf,
  planFadeShapes,
  planSetCrossfade,
  planToggle,
  planTrackCrossfades,
  planWithTransition,
  soundEditAt,
} from './crossfadePlan';
import type { CrossInput, CrossPlan } from './crossfadePlan';

const LOCKED = 'the track is locked';
const track = (id: string, kind: 'video' | 'audio', over: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, ...over });
const asset = (id: string, kind: MediaAsset['kind'], hasAudio: boolean, duration = 60): MediaAsset => ({ id, name: id, kind, mime: '', size: 1, duration, width: 100, height: 100, hasAudio, createdAt: 0 });
const audio = (id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId: 'a1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'song', trimStart: 10, speed: 1, volume: 1, muted: false, ...over,
});
const video = (id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId: 'v1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 10, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});

const TRACKS = [track('v1', 'video'), track('a1', 'audio'), track('a2', 'audio')];
function proj(clips: Clip[], tracks: Track[] = TRACKS, fps = 30): Project {
  return {
    ...createProject('cross', undefined, fps),
    assets: [asset('song', 'audio', true), asset('av', 'video', true), asset('silent', 'video', false), asset('short', 'audio', true, 14)],
    tracks,
    clips,
  };
}
/** a, b and c touch on a1. the media runs on elsewhere, so every edit has 2 s a side (half of a 4 s clip) */
const three = (over: { b?: Partial<AudioClip>; c?: Partial<AudioClip>; a?: Partial<AudioClip> } = {}): Clip[] => [
  audio('a', 0, 4, { trimStart: 10, ...over.a }),
  audio('b', 4, 4, { trimStart: 30, ...over.b }),
  audio('c', 8, 4, { trimStart: 50, ...over.c }),
];
const input = (over: Partial<CrossInput> = {}): CrossInput => ({ selection: [], trimEdge: null, pick: null, time: 0, ...over });
const plan = (r: CrossPlan | string): CrossPlan => {
  expect(typeof r).toBe('object');
  return r as CrossPlan;
};
const cf = (p: Project, id: string): Crossfade | null | undefined => (p.clips.find((c) => c.id === id) as AudioClip).crossfade;
const apply = (p: Project, pl: CrossPlan): Project => ({
  ...p,
  clips: p.clips.map((c) => {
    const x = pl.patches.find((q) => q.id === c.id);
    if (!x) return c;
    const next = { ...c, ...x.patch } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
    return next as unknown as Clip;
  }),
});
const toIds = (r: ReturnType<typeof crossfadeTargets>): string[] => (typeof r === 'string' ? [r] : r.map((e) => e.toId));

describe('crossfade planners', () => {
  it('pickCounts wants the very array', () => {
    const p = proj(three({ b: { crossfade: { before: 0.1, after: 0.1 } } }));
    const sel = ['b'];
    const pick: CrossfadePick = { clipId: 'b', selection: sel };
    expect(pickCounts(p, sel, pick)).toBe('b');
    expect(pickCounts(p, ['b'], pick)).toBeNull();
    expect(pickCounts(p, sel, null)).toBeNull();
    // a clip without a crossfade is no pick
    const c: CrossfadePick = { clipId: 'c', selection: sel };
    expect(pickCounts(p, sel, c)).toBeNull();
  });

  it('placeOf', () => {
    expect(placeOf({ before: 0.125, after: 0.125 }, 24)).toBe('center');
    // under half a frame apart
    expect(placeOf({ before: 0.2, after: 0.21 }, 30)).toBe('center');
    expect(placeOf({ before: 0, after: 0.25 }, 30)).toBe('start');
    expect(placeOf({ before: 0.25, after: 0 }, 30)).toBe('end');
    expect(placeOf({ before: 0.1, after: 0.2 }, 30)).toBe('custom');
  });

  it('targets: pick, then edge', () => {
    const p = proj(three({ b: { crossfade: { before: 0.1, after: 0.1 } } }));
    const sel = ['b'];
    const pick: CrossfadePick = { clipId: 'b', selection: sel };
    // the pick comes first, even with an edge and a selection
    const edge = { clipId: 'c', edge: 'start' as const, both: false, alone: false };
    expect(toIds(crossfadeTargets(p, input({ selection: sel, pick, trimEdge: edge })))).toEqual(['b']);
    // the end of a clip: the edit to the clip after, the start: the clip itself
    expect(toIds(crossfadeTargets(p, input({ trimEdge: { clipId: 'a', edge: 'end', both: false, alone: false } })))).toEqual(['b']);
    expect(toIds(crossfadeTargets(p, input({ trimEdge: edge })))).toEqual(['c']);
    // a both edge is the end of the clip on the left
    expect(toIds(crossfadeTargets(p, input({ trimEdge: { clipId: 'b', edge: 'end', both: true, alone: false } })))).toEqual(['c']);
    // an edge with no edit says so, and the selection does not take over
    expect(crossfadeTargets(p, input({ selection: ['a'], trimEdge: { clipId: 'c', edge: 'end', both: false, alone: false } }))).toBe(CROSS_TEXT.crossNoEdit);
    // a pick whose clip has lost its clip before
    const lone = proj([three()[1]!].map((c) => ({ ...c, crossfade: { before: 0.1, after: 0.1 } }) as Clip));
    const pick2: CrossfadePick = { clipId: 'b', selection: sel };
    expect(crossfadeTargets(lone, input({ selection: sel, pick: pick2 }))).toBe(CROSS_TEXT.crossNoEdit);
  });

  it('targets: selected clips, each edit once', () => {
    const p = proj(three());
    expect(toIds(crossfadeTargets(p, input({ selection: ['a'] })))).toEqual(['b']);
    expect(toIds(crossfadeTargets(p, input({ selection: ['b'] })))).toEqual(['b', 'c']);
    expect(toIds(crossfadeTargets(p, input({ selection: ['a', 'b', 'c'] })))).toEqual(['b', 'c']);
    expect(toIds(crossfadeTargets(p, input({ selection: ['c', 'a'] })))).toEqual(['b', 'c']);
    // a lone clip has no edit
    expect(crossfadeTargets(proj([audio('x', 0, 4)]), input({ selection: ['x'] }))).toBe(CROSS_TEXT.crossNoEdit);
    // a soundless video is no side
    const q = proj([video('s', 0, 4, { assetId: 'silent' }), video('t', 4, 4)]);
    expect(crossfadeTargets(q, input({ selection: ['t'] }))).toBe(CROSS_TEXT.crossNoEdit);
    const e = crossfadeTargets(p, input({ selection: ['b'] }));
    expect(e).toEqual([
      { fromId: 'a', toId: 'b', trackId: 'a1', time: 4 },
      { fromId: 'b', toId: 'c', trackId: 'a1', time: 8 },
    ]);
  });

  it('targets: the playhead on two tracks', () => {
    const clips = [...three(), audio('d', 0, 4, { trackId: 'a2', trimStart: 5 }), audio('e', 4, 4, { trackId: 'a2', trimStart: 25 })];
    const p = proj(clips);
    expect(toIds(crossfadeTargets(p, input({ time: 4 })))).toEqual(['b', 'e']);
    // within half a frame
    expect(toIds(crossfadeTargets(p, input({ time: 4.01 })))).toEqual(['b', 'e']);
    expect(crossfadeTargets(p, input({ time: 4.05 }))).toBe(CROSS_TEXT.crossNoEditHere);
    expect(crossfadeTargets(p, input({ time: 0 }))).toBe(CROSS_TEXT.crossNoEditHere);
  });

  it('targets: a picture apart', () => {
    const pictures = [video('pa', 0, 4), video('pb', 4, 4, { trimStart: 30 })];
    const base = proj(pictures);
    const sep = plan2(base, ['pa', 'pb']);
    const p = proj([...pictures.map((c) => ({ ...c, muted: true, group: 'g' + c.id })), ...sep]);
    const sounds = sep.map((s) => s.id);
    expect(sounds).toHaveLength(2);
    // the picture stands for its sound clips
    const r = crossfadeTargets(p, input({ selection: ['pb'] }));
    expect(typeof r).toBe('object');
    expect((r as { toId: string }[]).map((e) => e.toId)).toEqual([sounds[1]]);
    // the picture itself has no sound to fade
    expect(soundEditAt(p, 'pb')).toBe(CROSS_TEXT.crossApart);
    expect(soundEditAt(p, sounds[1]!)).toMatchObject({ toId: sounds[1], fromId: sounds[0] });
  });

  it('fit at 24, 25, 30 and 60 fps', () => {
    for (const [fps, frames] of [[24, 3], [25, 3], [30, 4], [60, 8]] as const) {
      const p = proj(three(), TRACKS, fps);
      const edit = soundEditAt(p, 'b');
      expect(typeof edit).toBe('object');
      const x = fitCrossfade(p, edit as never, 0.25, 'center') as Crossfade;
      expect(x.before).toBeCloseTo(frames / fps, 6);
      expect(x.after).toBeCloseTo(frames / fps, 6);
      expect(x.shape).toBeUndefined();
      expect(x.withTransition).toBeUndefined();
    }
    const p = proj(three());
    const edit = soundEditAt(p, 'b') as never;
    const start = fitCrossfade(p, edit, 0.25, 'start') as Crossfade;
    expect(start.before).toBe(0);
    expect(start.after).toBeCloseTo(8 / 30, 6);
    const end = fitCrossfade(p, edit, 0.25, 'end') as Crossfade;
    expect(end.before).toBeCloseTo(8 / 30, 6);
    expect(end.after).toBe(0);
    // a non power shape stays
    expect((fitCrossfade(p, edit, 0.25, 'center', 'smooth') as Crossfade).shape).toBe('smooth');
    expect((fitCrossfade(p, edit, 0.25, 'center', 'power') as Crossfade).shape).toBeUndefined();
    // a very short ask is one frame a side at least
    const tiny = fitCrossfade(p, edit, 0.001, 'center') as Crossfade;
    expect(tiny.before).toBeCloseTo(1 / 30, 6);
  });

  it('fit hands over, no media', () => {
    // 0.1 s of media before the edit is 3 frames: the rest of the side goes after the edit
    const p = proj(three({ b: { trimStart: 0.1 } }));
    const a = fitCrossfade(p, soundEditAt(p, 'b') as never, 0.25, 'center') as Crossfade;
    expect(a.before).toBeCloseTo(0.1, 6);
    expect(a.after).toBeCloseTo(5 / 30, 6);
    // nothing before the edit: the whole length goes after it
    const q = proj(three({ b: { trimStart: 0 } }));
    const b = fitCrossfade(q, soundEditAt(q, 'b') as never, 0.25, 'center') as Crossfade;
    expect(b.before).toBe(0);
    expect(b.after).toBeCloseTo(8 / 30, 6);
    // a start or end place does not hand anything over
    const s = fitCrossfade(q, soundEditAt(q, 'b') as never, 0.25, 'end');
    expect(s).toBe(CROSS_TEXT.crossNoMedia);
    // no media either way
    const none = proj([audio('a', 0, 4, { assetId: 'short', trimStart: 10 }), audio('b', 4, 4, { assetId: 'short', trimStart: 0 })]);
    expect(fitCrossfade(none, soundEditAt(none, 'b') as never, 0.25, 'center')).toBe(CROSS_TEXT.crossNoMedia);
    // an edit that is not one
    expect(fitCrossfade(none, { fromId: 'x', toId: 'a', trackId: 'a1', time: 0 }, 0.25, 'center')).toBe(CROSS_TEXT.crossNoEdit);
  });

  it('toggle', () => {
    const p = proj(three());
    const added = plan(planToggle(p, input({ selection: ['a', 'b', 'c'] })));
    expect(added.added).toEqual(['b', 'c']);
    expect(added.removed).toEqual([]);
    expect(added.patches.map((x) => x.id)).toEqual(['b', 'c']);
    const v = added.patches[0]!.patch.crossfade as Crossfade;
    expect(v.before).toBeCloseTo(4 / 30, 6);
    expect(v.after).toBeCloseTo(4 / 30, 6);
    // again: every target has one, they go
    const q = apply(p, added);
    const gone = plan(planToggle(q, input({ selection: ['a', 'b', 'c'] })));
    expect(gone.removed).toEqual(['b', 'c']);
    expect(gone.patches.every((x) => x.patch.crossfade === null)).toBe(true);
    // one has one, one has none: adds the one
    const half = proj(three({ b: { crossfade: { before: 0.1, after: 0.1 } } }));
    expect(plan(planToggle(half, input({ selection: ['a', 'b', 'c'] }))).added).toEqual(['c']);
    // a locked track: skipped, and nothing at all gives its reason
    const locked = proj(three(), [track('v1', 'video'), track('a1', 'audio', { locked: true }), track('a2', 'audio')]);
    expect(planToggle(locked, input({ selection: ['a', 'b'] }))).toBe(LOCKED);
    // no edit
    expect(planToggle(p, input())).toBe(CROSS_TEXT.crossNoEditHere);
    // a side with no media: shorter, and said
    const short = proj(three({ b: { trimStart: 0 } }));
    const s = plan(planToggle(short, input({ selection: ['a', 'b'] })));
    expect(s.added).toEqual(['b', 'c']);
    expect(s.short).toEqual([{ id: 'b', side: 'before', why: 'media' }]);
    // no fit at all
    const none = proj([audio('a', 0, 4, { assetId: 'short', trimStart: 10 }), audio('b', 4, 4, { assetId: 'short', trimStart: 0 })]);
    expect(planToggle(none, input({ selection: ['a'] }))).toBe(CROSS_TEXT.crossNoMedia);
    // the playhead picks the edit
    expect(plan(planToggle(p, input({ time: 8 }))).added).toEqual(['c']);
  });

  it('track: one takes and locked', () => {
    // b picks up where a ends: one take
    const clips = [audio('a', 0, 4, { trimStart: 10 }), audio('b', 4, 4, { trimStart: 14 }), audio('c', 8, 4, { trimStart: 50 })];
    expect(oneTake(clips[0] as AudioClip, clips[1] as AudioClip)).toBe(true);
    expect(oneTake(clips[1] as AudioClip, clips[2] as AudioClip)).toBe(false);
    expect(oneTake(clips[0] as AudioClip, { ...clips[1], speed: 2 } as AudioClip)).toBe(false);
    expect(oneTake(clips[0] as AudioClip, { ...clips[1], assetId: 'av' } as AudioClip)).toBe(false);
    const p = proj(clips);
    expect(editsOnTrack(p, 'a1').map((e) => e.toId)).toEqual(['b', 'c']);
    const add = plan(planTrackCrossfades(p, ['a1'], 'add'));
    expect(add.added).toEqual(['c']);
    expect(add.skipped).toEqual([{ id: 'b', why: CROSS_TEXT.crossOneTake }]);
    // only one takes left
    const take = proj(clips.slice(0, 2));
    expect(planTrackCrossfades(take, ['a1'], 'add')).toBe(CROSS_TEXT.crossOneTake);
    // every edit has one
    const all = apply(p, add);
    const both = proj(all.clips.map((c) => (c.id === 'b' ? ({ ...c, crossfade: { before: 0.1, after: 0.1 } } as Clip) : c)));
    expect(planTrackCrossfades(both, ['a1'], 'add')).toBe(CROSS_TEXT.crossAllHave);
    // no edit, nothing selected
    expect(planTrackCrossfades(proj([audio('x', 0, 4)]), ['a1'], 'add')).toBe(CROSS_TEXT.crossNoEditTrack);
    expect(planTrackCrossfades(p, ['a2'], 'add')).toBe(CROSS_TEXT.crossNoEditTrack);
    // locked
    const locked = proj(clips, [track('v1', 'video'), track('a1', 'audio', { locked: true }), track('a2', 'audio')]);
    expect(planTrackCrossfades(locked, ['a1'], 'add')).toBe(LOCKED);
    expect(planTrackCrossfades(locked, ['a1'], 'remove')).toBe(LOCKED);
    // remove takes every stored one, one that waits too
    const stored = proj([...clips.slice(0, 2).map((c) => ({ ...c, crossfade: { before: 0.1, after: 0.1 } }) as Clip), audio('w', 20, 4, { crossfade: { before: 0.1, after: 0.1 } })]);
    const rm = plan(planTrackCrossfades(stored, ['a1'], 'remove'));
    expect(rm.removed.sort()).toEqual(['a', 'b', 'w']);
    expect(planTrackCrossfades(p, ['a1'], 'remove')).toBe(CROSS_TEXT.crossNoneTrack);
    // several tracks at once
    const two = proj([...three(), audio('d', 0, 4, { trackId: 'a2', trimStart: 5 }), audio('e', 4, 4, { trackId: 'a2', trimStart: 25 })]);
    expect(plan(planTrackCrossfades(two, ['a1', 'a2'], 'add')).added.sort()).toEqual(['b', 'c', 'e']);
  });

  it('set', () => {
    const p = proj(three());
    // none: the default, centered
    const first = plan(planSetCrossfade(p, 'b', { length: 0.5 }));
    expect(first.added).toEqual(['b']);
    const v = first.patches[0]!.patch.crossfade as Crossfade;
    expect(v.before).toBeCloseTo(8 / 30, 6);
    expect(v.after).toBeCloseTo(8 / 30, 6);
    const q = apply(p, first);
    // length keeps the place
    const start = plan(planSetCrossfade(q, 'b', { place: 'start' }));
    const sv = start.patches[0]!.patch.crossfade as Crossfade;
    expect(sv.before).toBe(0);
    expect(sv.after).toBeCloseTo(16 / 30, 6);
    const r = apply(q, start);
    expect(placeOf(cf(r, 'b')!, 30)).toBe('start');
    const longer = plan(planSetCrossfade(r, 'b', { length: 1 }));
    const lv = longer.patches[0]!.patch.crossfade as Crossfade;
    expect(lv.before).toBe(0);
    expect(lv.after).toBeCloseTo(1, 6);
    // custom scales both sides
    const odd = proj(three({ b: { crossfade: { before: 0.1, after: 0.3 } } }));
    const scaled = plan(planSetCrossfade(odd, 'b', { length: 0.8 }));
    const cv = scaled.patches[0]!.patch.crossfade as Crossfade;
    expect(cv.before).toBeCloseTo(0.2, 6);
    expect(cv.after).toBeCloseTo(0.6, 6);
    // a side
    const side = plan(planSetCrossfade(p, 'b', { before: 0.1 }));
    const bv = side.patches[0]!.patch.crossfade as Crossfade;
    expect(bv.before).toBeCloseTo(0.1, 6);
    expect(bv.after).toBe(0);
    const keep = plan(planSetCrossfade(odd, 'b', { after: 0.2 }));
    const kv = keep.patches[0]!.patch.crossfade as Crossfade;
    expect(kv.before).toBeCloseTo(0.1, 6);
    expect(kv.after).toBeCloseTo(0.2, 6);
    // held to the rooms (2 s)
    const big = plan(planSetCrossfade(p, 'b', { after: 5 }));
    expect((big.patches[0]!.patch.crossfade as Crossfade).after).toBeCloseTo(2, 6);
    expect(big.short).toEqual([{ id: 'b', side: 'after', why: 'half' }]);
    // zero and zero
    expect(planSetCrossfade(p, 'b', { before: 0, after: 0 })).toBe(crossShortText('before', 'shortest', '', ''));
    // a shape alone keeps the sides
    const sh = plan(planSetCrossfade(odd, 'b', { shape: 'smooth' }));
    expect(sh.patches[0]!.patch.crossfade).toEqual({ before: 0.1, after: 0.3, shape: 'smooth' });
    expect(sh.changed).toEqual(['b']);
    // equal is no patch, a reason
    expect(typeof planSetCrossfade(odd, 'b', { shape: 'power' })).toBe('string');
    // remove, waiting too
    const rm = plan(planSetCrossfade(odd, 'b', { remove: true }));
    expect(rm.removed).toEqual(['b']);
    const wait = proj([audio('w', 0, 4, { crossfade: { before: 0.1, after: 0.1 } })]);
    expect(plan(planSetCrossfade(wait, 'w', { remove: true })).removed).toEqual(['w']);
    expect(planSetCrossfade(p, 'b', { remove: true })).toBe(CROSS_TEXT.crossNoneTrack);
    // a length change drops the link to the transition
    const linked = proj(three({ b: { crossfade: { before: 0.1, after: 0.1, withTransition: true } } }));
    const lk = plan(planSetCrossfade(linked, 'b', { length: 0.4 }));
    expect((lk.patches[0]!.patch.crossfade as Crossfade).withTransition).toBeUndefined();
    // reasons
    expect(planSetCrossfade(p, 'a', { length: 0.5 })).toBe(CROSS_TEXT.crossNoEdit);
    expect(planSetCrossfade(p, 'zz', { length: 0.5 })).toBe(CROSS_TEXT.crossNoEdit);
    const locked = proj(three(), [track('v1', 'video'), track('a1', 'audio', { locked: true }), track('a2', 'audio')]);
    expect(planSetCrossfade(locked, 'b', { length: 0.5 })).toBe(LOCKED);
  });

  it('shapes', () => {
    const p = proj([...three(), video('s', 0, 4, { assetId: 'silent' })]);
    const pw = plan(planFadeShapes(p, ['a', 'b'], 'power'));
    expect(pw.changed).toEqual(['a', 'b']);
    expect(pw.patches[0]!.patch).toEqual({ fadeInShape: 'power', fadeOutShape: 'power' });
    // linear writes null
    const q = apply(p, pw);
    const lin = plan(planFadeShapes(q, ['a'], 'linear'));
    expect(lin.patches[0]!.patch).toEqual({ fadeInShape: null, fadeOutShape: null });
    // nothing changes
    expect(typeof planFadeShapes(q, ['a'], 'power')).toBe('string');
    // no sound
    expect(planFadeShapes(p, ['s'], 'power')).toBe('select a clip with sound first');
    expect(planFadeShapes(p, [], 'power')).toBe('select a clip with sound first');
    // a locked track
    const locked = proj(three(), [track('v1', 'video'), track('a1', 'audio', { locked: true }), track('a2', 'audio')]);
    expect(planFadeShapes(locked, ['a'], 'smooth')).toBe(LOCKED);
    // a picture apart: its sound clip
    const pictures = [video('pa', 0, 4)];
    const sep = plan2(proj(pictures), ['pa']);
    const apart = proj([{ ...pictures[0]!, muted: true, group: 'gpa' } as Clip, ...sep]);
    const ap = plan(planFadeShapes(apart, ['pa'], 'smooth'));
    expect(ap.changed).toEqual([sep[0]!.id]);
  });

  it('switch', () => {
    const tr = { id: 'fade', duration: 1 };
    const clips = [video('x', 0, 4), video('y', 4, 4, { trimStart: 30, transition: tr, crossfade: { before: 0.1, after: 0.1, shape: 'smooth' } })];
    const p = proj(clips);
    // no transition on a clip
    expect(planWithTransition(p, 'x', true)).toBe(CROSS_TEXT.crossNoTransition);
    expect(planWithTransition(p, 'zz', true)).toBe(CROSS_TEXT.crossNoTransition);
    // on: the halves of the transition, the shape stays
    const on = plan(planWithTransition(p, 'y', true));
    expect(on.patches[0]!.patch.crossfade).toEqual({ before: 0.5, after: 0.5, shape: 'smooth', withTransition: true });
    expect(on.changed).toEqual(['y']);
    // off: the sides as plain sides
    const q = apply(p, on);
    const off = plan(planWithTransition(q, 'y', false));
    expect(off.patches[0]!.patch.crossfade).toEqual({ before: 0.5, after: 0.5, shape: 'smooth' });
    // already off
    expect(typeof planWithTransition(p, 'y', false)).toBe('string');
    // none yet: it adds
    const bare = proj([clips[0]!, { ...clips[1], crossfade: undefined } as Clip]);
    expect(plan(planWithTransition(bare, 'y', true)).added).toEqual(['y']);
    // no sound before
    const lone = proj([clips[1]!]);
    expect(planWithTransition(lone, 'y', true)).toBe(CROSS_TEXT.crossNoEdit);
  });
});

/** a plan of dragCrossfade's rooms: a clip before 4 s long, a clip after with 0.1 s of media before it */
describe('crossfade drag', () => {
  const p = proj(three());
  const f = (n: number): number => n / 30;
  const mid: Crossfade = { before: f(4), after: f(4) };

  it('drag: mirror and alt', () => {
    // an end moves its side, the other follows while centered
    const m = dragCrossfade(p, 'b', 'after', mid, f(2), false, 0);
    expect(m.value.before).toBeCloseTo(f(6), 6);
    expect(m.value.after).toBeCloseTo(f(6), 6);
    expect(m.stop).toBeNull();
    // before: moving left grows it
    const l = dragCrossfade(p, 'b', 'before', mid, -f(3), false, 0);
    expect(l.value.before).toBeCloseTo(f(7), 6);
    expect(l.value.after).toBeCloseTo(f(7), 6);
    // alt: this end only
    const a = dragCrossfade(p, 'b', 'after', mid, f(2), true, 0);
    expect(a.value.before).toBeCloseTo(f(4), 6);
    expect(a.value.after).toBeCloseTo(f(6), 6);
    // not centered: this end only
    const off = dragCrossfade(p, 'b', 'after', { before: f(3), after: f(8) }, -f(2), false, 0);
    expect(off.value.before).toBeCloseTo(f(3), 6);
    expect(off.value.after).toBeCloseTo(f(6), 6);
    // the shape stays, the link to the transition never does
    const s = dragCrossfade(p, 'b', 'after', { ...mid, shape: 'smooth', withTransition: true }, f(1), false, 0);
    expect(s.value.shape).toBe('smooth');
    expect(s.value.withTransition).toBeUndefined();
    // whole frames
    const w = dragCrossfade(p, 'b', 'after', mid, 0.0123, true, 0);
    expect(w.value.after * 30).toBeCloseTo(Math.round(w.value.after * 30), 3);
  });

  it('drag: catches', () => {
    // 3 frames before and 9 after: total 12
    const start: Crossfade = { before: f(3), after: f(9) };
    // the middle moves both across the edit, the total stays
    const moved = dragCrossfade(p, 'b', 'body', start, -f(1), false, 0);
    expect(moved.value.before).toBeCloseTo(f(4), 6);
    expect(moved.value.after).toBeCloseTo(f(8), 6);
    // centered on the edit catches within snap
    const center = dragCrossfade(p, 'b', 'body', start, -f(2.6), false, f(2));
    expect(center.value.before).toBeCloseTo(f(6), 6);
    expect(center.value.after).toBeCloseTo(f(6), 6);
    // without a snap it does not
    const free = dragCrossfade(p, 'b', 'body', start, -f(2.6), false, 0);
    expect(free.value.before).toBeCloseTo(f(6), 6);
    const near = dragCrossfade(p, 'b', 'body', start, -f(2.2), false, 0);
    expect(near.value.before).toBeCloseTo(f(5), 6);
    // starts at the edit
    const st = dragCrossfade(p, 'b', 'body', start, f(2.7), false, f(1));
    expect(st.value.before).toBe(0);
    expect(st.value.after).toBeCloseTo(f(12), 6);
    // ends at the edit
    const en = dragCrossfade(p, 'b', 'body', start, -f(8.7), false, f(1));
    expect(en.value.before).toBeCloseTo(f(12), 6);
    expect(en.value.after).toBe(0);
  });

  it('drag: stops and floor', () => {
    // 3 frames of media before the edit
    const q = proj(three({ b: { trimStart: 0.1 } }));
    const s = dragCrossfade(q, 'b', 'before', { before: f(3), after: f(8) }, -1, true, 0);
    expect(s.value.before).toBeCloseTo(0.1, 6);
    expect(s.stop).toEqual({ side: 'before', why: 'media' });
    // half of the clip before (2 s)
    const h = dragCrossfade(p, 'b', 'after', { before: f(8), after: f(8) }, 5, true, 0);
    expect(h.value.after).toBeCloseTo(2, 6);
    expect(h.stop).toEqual({ side: 'after', why: 'half' });
    // mirrored: the smaller room ends it for both
    const mir = dragCrossfade(q, 'b', 'after', { before: f(3), after: f(3) }, 1, false, 0);
    expect(mir.value.before).toBeCloseTo(0.1, 6);
    expect(mir.value.after).toBeCloseTo(0.1, 6);
    expect(mir.stop).toEqual({ side: 'before', why: 'media' });
    // the floor: one frame
    const fl = dragCrossfade(p, 'b', 'after', { before: 0, after: f(3) }, -1, true, 0);
    expect(fl.value.before).toBe(0);
    expect(fl.value.after).toBeCloseTo(f(1), 6);
    expect(fl.stop).toEqual({ side: 'after', why: 'shortest' });
    const mf = dragCrossfade(p, 'b', 'before', mid, 1, false, 0);
    expect(mf.value.before).toBeCloseTo(f(1), 6);
    expect(mf.stop).toEqual({ side: 'before', why: 'shortest' });
    // a side to 0 is fine while the other has frames
    const z = dragCrossfade(p, 'b', 'before', { before: f(3), after: f(8) }, 1, true, 0);
    expect(z.value.before).toBe(0);
    expect(z.stop).toBeNull();
    // no clip before: nothing moves
    const lone = proj([three()[1]!]);
    expect(dragCrossfade(lone, 'b', 'after', mid, 1, false, 0)).toEqual({ value: mid, stop: null });
  });
});

describe('crossfade nudge and drop', () => {
  const f = (n: number): number => n / 30;

  it('nudge', () => {
    const p = proj(three({ b: { crossfade: { before: f(4), after: f(4) } } }));
    const up = plan(nudgePlan(p, 'b', 1));
    expect((up.patches[0]!.patch.crossfade as Crossfade).before).toBeCloseTo(f(5), 6);
    expect((up.patches[0]!.patch.crossfade as Crossfade).after).toBeCloseTo(f(5), 6);
    const down = plan(nudgePlan(p, 'b', -10));
    // the floor is one frame a side
    expect((down.patches[0]!.patch.crossfade as Crossfade).before).toBeCloseTo(f(1), 6);
    // a side at 0 stays there
    const start = proj(three({ b: { crossfade: { before: 0, after: f(4) } } }));
    const sv = plan(nudgePlan(start, 'b', 1)).patches[0]!.patch.crossfade as Crossfade;
    expect(sv.before).toBe(0);
    expect(sv.after).toBeCloseTo(f(5), 6);
    // the room stops it: 3 frames before the edit, 8 after
    const room = proj(three({ b: { trimStart: 0.1, crossfade: { before: f(3), after: f(8) } } }));
    const rv = plan(nudgePlan(room, 'b', 1));
    expect((rv.patches[0]!.patch.crossfade as Crossfade).before).toBeCloseTo(f(3), 6);
    expect((rv.patches[0]!.patch.crossfade as Crossfade).after).toBeCloseTo(f(9), 6);
    // nothing moves: the stop is the answer
    const full = proj(three({ b: { trimStart: 0.1, crossfade: { before: f(3), after: f(3) } }, a: {} }));
    const small = proj(three({ b: { trimStart: 0.1, crossfade: { before: f(3), after: 2 } } }));
    expect(nudgePlan(small, 'b', 1)).toBe(crossShortText('before', 'media', 'a', 'b'));
    expect(typeof nudgePlan(full, 'b', 1)).toBe('object');
    const min = proj(three({ b: { crossfade: { before: f(1), after: f(1) } } }));
    expect(nudgePlan(min, 'b', -1)).toBe(crossShortText('before', 'shortest', 'a', 'b'));
    // no crossfade, no clip before, locked
    expect(nudgePlan(proj(three()), 'b', 1)).toBe(CROSS_TEXT.crossNoEdit);
    const locked = proj(three({ b: { crossfade: { before: f(4), after: f(4) } } }), [track('v1', 'video'), track('a1', 'audio', { locked: true }), track('a2', 'audio')]);
    expect(nudgePlan(locked, 'b', 1)).toBe(LOCKED);
  });

  it('crossfadesToDrop', () => {
    const cfx = { before: 0.1, after: 0.1 };
    const before = proj([audio('a', 0, 4), audio('b', 4, 4, { trimStart: 30, crossfade: cfx })]);
    expect(crossfadesToDrop(before, before, new Map())).toEqual([]);
    // the clip before is gone
    expect(crossfadesToDrop(before, proj([before.clips[1]!]), new Map())).toEqual(['b']);
    // the clip before was cut: its right half is the same clip by lineage
    const cut = proj([audio('a', 0, 2), audio('a2', 2, 2), before.clips[1]!]);
    expect(crossfadesToDrop(before, cut, new Map([['a2', 'a']]))).toEqual([]);
    expect(crossfadesToDrop(before, cut, new Map())).toEqual(['b']);
    // another clip touches now
    const other = proj([audio('n', 0, 4, { trimStart: 40 }), before.clips[1]!]);
    expect(crossfadesToDrop(before, other, new Map())).toEqual(['b']);
    // a crossfade that waited keeps waiting
    const wait = proj([audio('w', 10, 4, { crossfade: cfx })]);
    expect(crossfadesToDrop(wait, wait, new Map())).toEqual([]);
    // a clip that is new has no old edit
    const fresh = proj([...before.clips, audio('n', 20, 2, { crossfade: cfx })]);
    expect(crossfadesToDrop(before, fresh, new Map())).toEqual([]);
    // a nudge within CUT_EPS is the same edit
    const near = proj([audio('a', 0, 4), { ...before.clips[1]!, start: 4.0005 } as Clip]);
    expect(crossfadesToDrop(before, near, new Map())).toEqual([]);
  });

  it('a span of the plan is what the planner fitted', () => {
    // the box and the plan agree: what fit stores is what plays
    const p = proj(three());
    const pl = plan(planSetCrossfade(p, 'b', { length: 0.25 }));
    const q = apply(p, pl);
    const span = crossfadeSpan(q, q.clips[1]!) as CrossfadeSpan;
    expect(span.plays).toBe(true);
    expect(span.shortBefore).toBeNull();
    expect(span.before).toBeCloseTo(4 / 30, 6);
  });
});

/** the sound clips planSeparate makes for pictures: the pure way to a picture with its sound apart */
function plan2(p: Project, ids: string[]): AudioClip[] {
  let n = 0;
  const r = planSeparate(p, ids, { clip: () => `snd${n++}`, group: () => `grp${n++}` });
  if (typeof r === 'string') throw new Error(r);
  return r.sounds.map((s) => ({ ...s.clip, trackId: 'a1', group: 'g' + (s.clip.name || '') }) as AudioClip);
}
