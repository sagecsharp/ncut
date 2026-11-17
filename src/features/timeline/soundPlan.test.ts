import { describe, expect, it } from 'vitest';
import type { AudioClip, Clip, EffectClip, Keyframe, MediaAsset, Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { effectBeatGrid } from '../../lib/tempo';
import {
  freezeSound,
  joinWhy,
  pairSummary,
  planJoin,
  planPairSpeed,
  planSeparate,
  planSync,
  sideIds,
  soundKeyReason,
  soundMenu,
  soundRole,
  soundToggle,
} from './soundPlan';
import type { IdMaker, SeparatePlan } from './soundPlan';
import { SOUND_TEXT as T } from './soundText';

const track = (id: string, kind: 'video' | 'audio', over: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, ...over });
const asset = (id: string, kind: MediaAsset['kind'], hasAudio: boolean, duration = 60): MediaAsset => ({ id, name: id, kind, mime: '', size: 1, duration, width: 100, height: 100, hasAudio, createdAt: 0 });
const video = (id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId: 'v1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId: 'a1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 0, speed: 1, volume: 1, muted: false, ...over,
});
const effect = (id: string, trackId: string, start: number, duration: number, over: Partial<EffectClip> = {}): EffectClip => ({
  id, type: 'effect', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, effect: 'shake', amount: 1, params: {}, seed: 1, ...over,
});
const lin = (...pairs: [number, number][]): Keyframe[] => pairs.map(([t, v]) => ({ t, v, ease: 'linear' as const }));

/** tracks top down: v1, v2, a1, a2 (the mirror of v1 is a2, the mirror of v2 is a1) */
function proj(clips: Clip[], tracks?: Track[]): Project {
  return {
    ...createProject('plan'),
    assets: [asset('av', 'video', true), asset('silent', 'video', false), asset('song', 'audio', true)],
    tracks: tracks ?? [track('v1', 'video'), track('v2', 'video'), track('a1', 'audio'), track('a2', 'audio')],
    clips,
  };
}
const maker = (): IdMaker => {
  let c = 0;
  let g = 0;
  return { clip: () => `s${++c}`, group: () => `g${++g}` };
};
const plan = (p: Project, ids: string[], prefer?: string): SeparatePlan => {
  const r = planSeparate(p, ids, maker(), prefer);
  if (typeof r === 'string') throw new Error(r);
  return r;
};
/** a pair as separate sound leaves it: the picture muted, the sound after it */
const pair = (over: { v?: Partial<VideoClip>; s?: Partial<AudioClip> } = {}): Clip[] => [
  video('v', 0, 4, { group: 'g', muted: true, ...over.v }),
  audio('s', 0, 4, { group: 'g', ...over.s }),
];

describe('planSeparate', () => {
  it('lands on the mirror track', () => {
    const r = plan(proj([video('a', 0, 4), video('b', 0, 4, { trackId: 'v2' })]), ['a', 'b']);
    expect(r.sounds.map((s) => [s.clip.id, s.clip.trackId, s.after])).toEqual([['s1', 'a2', 'a'], ['s2', 'a1', 'b']]);
    expect(r.newTracks).toEqual([]);
  });

  it('keeps project order, copies the sound fields and mutes the picture', () => {
    const p = proj([video('b', 5, 2, { volume: 0.5 }), video('a', 0, 4, { fadeIn: 0.3, trimStart: 2, speed: 2 })]);
    const r = plan(p, ['a', 'b']);
    expect(r.sounds.map((s) => s.after)).toEqual(['b', 'a']);
    expect(r.sounds[0]!.clip).toMatchObject({ type: 'audio', start: 5, duration: 2, volume: 0.5, assetId: 'av' });
    expect(r.sounds[1]!.clip).toMatchObject({ fadeIn: 0.3, trimStart: 2, speed: 2 });
    expect(r.mute).toEqual(['b', 'a']);
    expect(r.pairs).toEqual([{ picture: 'b', sound: 's1' }, { picture: 'a', sound: 's2' }]);
    // an already muted picture is not muted again, and its sound clip is muted
    const m = plan(proj([video('a', 0, 4, { muted: true })]), ['a']);
    expect(m.mute).toEqual([]);
    expect(m.sounds[0]!.clip.muted).toBe(true);
  });

  it('groups: the picture keeps its group, an ungrouped one gets a new one', () => {
    const r = plan(proj([video('a', 0, 4, { group: 'old' }), video('b', 5, 2)]), ['a', 'b']);
    expect(r.sounds[0]!.clip.group).toBe('old');
    expect(r.sounds[1]!.clip.group).toBe('g1');
    expect(r.groups).toEqual([{ id: 'b', group: 'g1' }]);
  });

  it('passes over a track whose sound differs', () => {
    // the mirror track is muted: the sound goes to the first audio track that plays like the video track
    const p = proj([video('a', 0, 4)], [track('v1', 'video'), track('v2', 'video'), track('a1', 'audio'), track('a2', 'audio', { muted: true })]);
    expect(plan(p, ['a']).sounds[0]!.clip.trackId).toBe('a1');
    const q = proj([video('a', 0, 4)], [track('v1', 'video'), track('v2', 'video'), track('a1', 'audio', { volume: 0.5 }), track('a2', 'audio', { pan: 0.5 })]);
    expect(plan(q, ['a']).newTracks).toHaveLength(1);
  });

  it('a track without room is passed over', () => {
    const p = proj([video('a', 0, 4), audio('song', 1, 2, { assetId: 'song', trackId: 'a2' })]);
    expect(plan(p, ['a']).sounds[0]!.clip.trackId).toBe('a1');
  });

  it('makes a new track with the settings of the video track, once per video track', () => {
    const tracks = [track('v1', 'video', { muted: true, volume: 0.5 }), track('a1', 'audio')];
    const p = proj([video('a', 0, 4), video('b', 5, 2), video('c', 1, 2, { trackId: 'v1' })], tracks);
    const r = plan(p, ['a', 'b']);
    expect(r.newTracks).toEqual([{ key: 'new:1', muted: true, volume: 0.5 }]);
    // the second picture lands on the track this plan made when it is free there
    expect(r.sounds.map((s) => s.clip.trackId)).toEqual(['new:1', 'new:1']);
    // two overlapping pictures cannot share it
    const two = plan(proj([video('a', 0, 4), video('b', 2, 4, { trackId: 'v2' })], [track('v1', 'video', { muted: true }), track('v2', 'video', { muted: true }), track('a1', 'audio')]), ['a', 'b']);
    expect(two.newTracks.map((t) => t.key)).toEqual(['new:1', 'new:2']);
  });

  it('tries the asked track first', () => {
    const p = proj([video('a', 0, 4)]);
    expect(plan(p, ['a']).sounds[0]!.clip.trackId).toBe('a2');
    expect(plan(p, ['a'], 'a1').sounds[0]!.clip.trackId).toBe('a1');
    // an asked track that does not fit is passed over
    expect(plan(proj([video('a', 0, 4), audio('x', 0, 1, { assetId: 'song', trackId: 'a1' })]), ['a'], 'a1').sounds[0]!.clip.trackId).toBe('a2');
  });

  it('skips with a reason', () => {
    const p = proj([
      video('lock', 0, 4, { trackId: 'v2' }),
      video('quiet', 5, 2, { assetId: 'silent' }),
      video('apart', 10, 4, { group: 'g', muted: true }),
      audio('apart-s', 10, 4, { group: 'g' }),
      video('ok', 20, 2),
    ], [track('v1', 'video'), track('v2', 'video', { locked: true }), track('a1', 'audio'), track('a2', 'audio')]);
    const r = plan(p, ['lock', 'quiet', 'apart', 'ok']);
    expect(r.skipped).toEqual([
      { id: 'lock', why: T.trackLocked },
      { id: 'quiet', why: T.noSoundInVideo },
      { id: 'apart', why: T.alreadyApart },
    ]);
    expect(r.pairs.map((x) => x.picture)).toEqual(['ok']);
  });

  it('says why nothing is planned', () => {
    const p = proj([video('quiet', 0, 2, { assetId: 'silent' }), audio('song', 3, 2, { assetId: 'song' })]);
    expect(planSeparate(p, ['quiet'], maker())).toBe(T.noSoundInVideo);
    expect(planSeparate(p, ['song'], maker())).toBe(T.soundVideoFirst);
    expect(planSeparate(p, [], maker())).toBe(T.soundVideoFirst);
    expect(planSeparate(proj([video('lock', 0, 2)], [track('v1', 'video', { locked: true }), track('a1', 'audio')]), ['lock'], maker())).toBe(T.trackLocked);
  });

  it('the tempo and the beat sources move to the sound clip, the grid stays', () => {
    const v = video('a', 1, 4, { bpm: 120, beatOffset: 0.2, trimStart: 0.5 });
    const fx = effect('fx', 'v2', 1, 4, { beat: { source: 'a', every: 1, pulse: 0.5, lock: false } });
    const p = proj([v, fx]);
    const r = plan(p, ['a']);
    const s = r.sounds[0]!.clip;
    expect(r.tempo).toEqual([{ id: 'a', patch: { bpm: null, beatOffset: null } }]);
    expect(r.beats).toEqual([{ id: 'fx', beat: { ...fx.beat!, source: s.id } }]);
    expect(s).toMatchObject({ bpm: 120, beatOffset: 0.2 });
    // the same grid after the move
    const after = proj([{ ...v, bpm: null, beatOffset: null, muted: true }, s, { ...fx, beat: r.beats[0]!.beat }]);
    const grid = effectBeatGrid(p, fx);
    expect(grid).not.toBeNull();
    expect(effectBeatGrid(after, after.clips[2] as EffectClip)).toEqual(grid);
  });

  it('a locked effect keeps the tempo on the picture', () => {
    const fx = effect('fx', 'v2', 1, 4, { beat: { source: 'a', every: 1, pulse: 0.5, lock: false } });
    const p = proj([video('a', 1, 4, { bpm: 100 }), fx], [track('v1', 'video'), track('v2', 'video', { locked: true }), track('a1', 'audio'), track('a2', 'audio')]);
    const r = plan(p, ['a']);
    expect(r.tempo).toEqual([]);
    expect(r.beats).toEqual([]);
    expect(r.sounds[0]!.clip.bpm).toBe(100);
  });

  it('only a beat offset also moves', () => {
    expect(plan(proj([video('a', 0, 4, { beatOffset: 0.3 })]), ['a']).tempo).toEqual([{ id: 'a', patch: { beatOffset: null } }]);
    expect(plan(proj([video('a', 0, 4)]), ['a']).tempo).toEqual([]);
  });
});

describe('planJoin', () => {
  it('takes a pair in sync back', () => {
    const p = proj(pair({ s: { volume: 0.8, muted: false } }));
    const r = planJoin(p, ['s']) as Exclude<ReturnType<typeof planJoin>, string>;
    expect(r.joined).toEqual(['v']);
    expect(r.remove).toEqual(['s']);
    expect(r.pictures).toEqual([{ id: 'v', patch: { muted: false, volume: 0.8 }, ungroup: true }]);
    // either side, once
    expect((planJoin(p, ['s', 'v']) as { joined: string[] }).joined).toEqual(['v']);
  });

  it('a group of three stays', () => {
    const p = proj([...pair(), video('other', 6, 1, { group: 'g' })]);
    expect((planJoin(p, ['v']) as { pictures: { ungroup: boolean }[] }).pictures[0]!.ungroup).toBe(false);
  });

  it('the tempo and the beat sources go back', () => {
    const fx = effect('fx', 'v2', 0, 4, { beat: { source: 's', every: 1, pulse: 0.5, lock: false } });
    const p = proj([...pair({ s: { bpm: 120, beatOffset: 0.1 } }), fx]);
    const r = planJoin(p, ['v']) as Exclude<ReturnType<typeof planJoin>, string>;
    expect(r.pictures[0]!.patch).toEqual({ muted: false, bpm: 120, beatOffset: 0.1 });
    expect(r.beats).toEqual([{ id: 'fx', beat: { ...fx.beat!, source: 'v' } }]);
  });

  it('the sound keys come back', () => {
    const p = proj(pair({ v: { keyframes: { volume: lin([0, 1]), 'transform.x': lin([0, 2]) } }, s: { keyframes: { volume: lin([0, 0.5], [2, 1]) } } }));
    const r = planJoin(p, ['v']) as Exclude<ReturnType<typeof planJoin>, string>;
    expect(r.pictures[0]!.keyframes).toEqual({ 'transform.x': lin([0, 2]), volume: lin([0, 0.5], [2, 1]) });
    // equal keys: nothing to write
    const same = proj(pair({ v: { keyframes: { volume: lin([0, 1]) } }, s: { keyframes: { volume: lin([0, 1]) } } }));
    expect('keyframes' in (planJoin(same, ['v']) as { pictures: object[] }).pictures[0]!).toBe(false);
  });

  it('refuses each way with its reason', () => {
    const v = (over: Partial<VideoClip>) => ({ v: over });
    const s = (over: Partial<AudioClip>) => ({ s: over });
    const why = (clips: Clip[], tracks?: Track[]) => planJoin(proj(clips, tracks), ['v']);
    expect(why(pair(), [track('v1', 'video'), track('v2', 'video'), track('a1', 'audio', { locked: true }), track('a2', 'audio')])).toBe(T.trackLocked);
    const fx = effect('fx', 'v2', 0, 4, { beat: { source: 's', every: 1, pulse: 0.5, lock: false } });
    expect(why([...pair(), fx], [track('v1', 'video'), track('v2', 'video', { locked: true }), track('a1', 'audio'), track('a2', 'audio')])).toBe(T.soundBeatLocked);
    expect(why(pair(s({ speed: 2 })))).toBe(T.soundOtherSpeed);
    expect(why(pair(s({ start: 0.5 })))).toBe(T.soundOutOfSync);
    // a j cut: the same sync point, another span
    expect(why(pair({ v: { trimStart: 1, start: 1 }, s: { start: 0, trimStart: 0, duration: 5 } }))).toBe(T.soundOtherLength);
    expect(why(pair(s({ fadeIn: 0.5 })))).toBe(T.soundOtherFades);
    expect(why([...pair(), audio('s2', 0, 4, { group: 'g', trackId: 'a2' })])).toBe(T.soundMany);
    // the sound plays under another picture that comes first
    expect(why([video('v2', 0, 4, { group: 'g', trackId: 'v2' }), ...pair()])).toBe(T.soundShared);
    expect(why(pair(), [track('v1', 'video'), track('v2', 'video'), track('a1', 'audio', { muted: true }), track('a2', 'audio')])).toBe(T.soundTrackDiffers);
    expect(why([video('v', 0, 4)])).toBe(T.soundPairFirst);
    // the muted picture is not a reason
    expect(typeof why(pair(v({ muted: true })))).toBe('object');
  });

  it('joinWhy answers one pair', () => {
    const [v, s] = pair() as [VideoClip, AudioClip];
    expect(joinWhy(proj([v, s]), v, s)).toBeNull();
    expect(joinWhy(proj([v, { ...s, fadeOut: 1 }]), v, { ...s, fadeOut: 1 })).toBe(T.soundOtherFades);
  });
});

describe('planSync', () => {
  const asRec = (r: ReturnType<typeof planSync>) => r as Exclude<ReturnType<typeof planSync>, string>;

  it('moves the sound clip when both are selected', () => {
    const p = proj(pair({ s: { start: 0.5 } }));
    const r = asRec(planSync(p, ['v', 's'], 'move'));
    expect(r.moves).toEqual([{ id: 's', trackId: 'a1', start: 0 }]);
    expect(r.synced).toEqual(['s']);
    // one side alone moves that side
    expect(asRec(planSync(p, ['v'], 'move')).moves).toEqual([{ id: 'v', trackId: 'v1', start: 0.5 }]);
  });

  it('the effects on a moved picture go with it', () => {
    const fx = effect('fx', 'v2', 0, 4, { target: 'v' });
    const p = proj([...pair({ s: { start: 0.5 } }), fx]);
    const r = asRec(planSync(p, ['v'], 'move'));
    expect(r.moves).toEqual([{ id: 'v', trackId: 'v1', start: 0.5 }, { id: 'fx', trackId: 'v2', start: 0.5 }]);
  });

  it('already in sync, other speeds, locked', () => {
    expect(planSync(proj(pair()), ['v'], 'move')).toBe(T.inSync);
    expect(planSync(proj(pair({ s: { speed: 2 } })), ['v'], 'move')).toBe(T.soundOtherSpeed);
    expect(planSync(proj(pair({ s: { start: 1 } })), ['s'], 'move')).not.toBe(T.trackLocked);
    expect(planSync(proj(pair({ s: { start: 1 } }), [track('v1', 'video'), track('v2', 'video'), track('a1', 'audio', { locked: true }), track('a2', 'audio')]), ['s'], 'move')).toBe(T.trackLocked);
    expect(planSync(proj([video('v', 0, 2)]), ['v'], 'move')).toBe(T.soundPairFirst);
  });

  it('syncNoRoom when a clip is in the way or the start goes below 0', () => {
    const p = proj([...pair({ s: { start: 1, duration: 2 }, v: { duration: 2 } }), audio('block', 3.2, 1, { assetId: 'song' })]);
    // sound at 1 wants to go to 0: free; the picture alone at 0 wants to go to 1... on its own track: free too
    expect(asRec(planSync(p, ['v', 's'], 'move')).moves).toEqual([{ id: 's', trackId: 'a1', start: 0 }]);
    const q = proj([...pair({ v: { start: 1, trimStart: 1 }, s: { start: 0, trimStart: 0 } })]);
    // the picture is the mover: its sync point 0 equals the sound's, in sync
    expect(planSync(q, ['v'], 'move')).toBe(T.inSync);
    const crowd = proj([...pair({ s: { start: 1 } }), audio('block', -5, 5.5, { assetId: 'song' })]);
    expect(planSync(crowd, ['s'], 'move')).toBe(T.syncNoRoom);
    const wall = proj([...pair({ s: { start: 1 } }), audio('block', 4.5, 1, { assetId: 'song', trackId: 'a1' }), video('w', 4, 1, { trackId: 'v1', assetId: 'silent' })]);
    // moving the picture to 1 would run into the clip behind it
    expect(planSync(wall, ['v'], 'move')).toBe(T.syncNoRoom);
    const neg = proj(pair({ v: { start: 0, trimStart: 2 }, s: { start: 0, trimStart: 0 } }));
    // the sound's sync point is 0, the picture's -2: the sound would go to -2
    expect(planSync(neg, ['s'], 'move')).toBe(T.syncNoRoom);
  });

  it('slips and the media that is too short', () => {
    const p = proj(pair({ s: { start: 0.5 } }));
    const r = asRec(planSync(p, ['s'], 'slip'));
    expect(r.slips).toHaveLength(1);
    expect(r.slips[0]!.id).toBe('s');
    expect(r.slips[0]!.delta).toBeCloseTo(0.5);
    expect(r.moves).toEqual([]);
    // the file is 4.2 s: sliding 0.5 s further in runs past its end
    const short = proj(pair({ s: { start: 0.5 } }));
    short.assets = short.assets.map((a) => (a.id === 'av' ? { ...a, duration: 4.2 } : a));
    expect(planSync(short, ['s'], 'slip')).toBe(T.slipTooShort);
    // the other way would go below the start of the file
    expect(planSync(proj(pair({ s: { start: 0.5 } })), ['v'], 'slip')).toBe(T.slipTooShort);
  });

  it('speed: a shorter clip changes speed first, a longer one after', () => {
    // the sound plays at 1 and the picture at 2: the sound gets faster, so shorter
    const faster = proj(pair({ v: { speed: 2, duration: 2 } }));
    expect(asRec(planSync(faster, ['v', 's'], 'speed')).speeds).toEqual([{ id: 's', speed: 2, first: true }]);
    const slower = proj(pair({ v: { duration: 4 }, s: { speed: 2, duration: 2 } }));
    expect(asRec(planSync(slower, ['v', 's'], 'speed')).speeds).toEqual([{ id: 's', speed: 1, first: false }]);
    expect(planSync(proj(pair()), ['v', 's'], 'speed')).toBe(T.inSync);
  });
});

describe('planPairSpeed', () => {
  const asRec = (r: ReturnType<typeof planPairSpeed>) => r as Exclude<ReturnType<typeof planPairSpeed>, string>;

  it('sets both sides, the sound stays', () => {
    const r = asRec(planPairSpeed(proj(pair()), ['v'], 2));
    expect(r.speeds).toEqual([{ id: 'v', speed: 2 }, { id: 's', speed: 2 }]);
    expect(r.moves).toEqual([]);
    expect(r.pictures).toEqual(['v']);
  });

  it('a j cut lead scales', () => {
    // the sound starts 1 s before the picture (j cut): at double speed it starts half a second before
    const p = proj(pair({ v: { start: 4, trimStart: 1, duration: 4 }, s: { start: 3, trimStart: 0, duration: 5 } }));
    const r = asRec(planPairSpeed(p, ['v', 's'], 2));
    expect(r.moves).toHaveLength(1);
    expect(r.moves[0]!.id).toBe('s');
    expect(r.moves[0]!.start).toBeCloseTo(3.5);
    // an offset scales the same way
    const off = asRec(planPairSpeed(proj(pair({ s: { start: 0.2 } })), ['v'], 2));
    expect(off.moves[0]!.start).toBeCloseTo(0.1);
  });

  it('leaves out what is no pair, locked or at two speeds, and a move that does not fit', () => {
    expect(planPairSpeed(proj([video('v', 0, 4)]), ['v'], 2)).toBe(T.soundPairFirst);
    expect(planPairSpeed(proj(pair({ s: { speed: 2 } })), ['v'], 2)).toBe(T.soundPairFirst);
    expect(planPairSpeed(proj(pair(), [track('v1', 'video'), track('v2', 'video'), track('a1', 'audio', { locked: true }), track('a2', 'audio')]), ['v'], 2)).toBe(T.soundPairFirst);
    expect(planPairSpeed(proj(pair()), ['v'], 0)).toBe(T.soundPairFirst);
    // the sound would land on another clip: no move, the speeds still go
    const p = proj([...pair({ s: { start: 0.4 } }), audio('block', 0.3, 0.7, { assetId: 'song' })]);
    const r = asRec(planPairSpeed(p, ['v'], 2));
    expect(r.speeds).toHaveLength(2);
    expect(r.moves).toEqual([]);
  });
});

describe('freezeSound', () => {
  it('cuts the sound clips that cross the freeze and shifts their tracks', () => {
    const p = proj(pair());
    expect(freezeSound(p, 'v', 2)).toEqual({ cut: ['s'], tracks: ['a1'] });
    // a sound that starts after the freeze is only shifted
    expect(freezeSound(proj(pair({ s: { start: 3, duration: 1 } })), 'v', 2)).toEqual({ cut: [], tracks: ['a1'] });
    // a sound that ends before it needs no gap
    expect(freezeSound(proj(pair({ s: { duration: 1 } })), 'v', 2)).toEqual({ cut: [], tracks: [] });
  });

  it('leaves a track out when the cut would be too near an edge or another clip crosses it', () => {
    expect(freezeSound(proj(pair()), 'v', 0.02)).toEqual({ cut: [], tracks: [] });
    expect(freezeSound(proj(pair()), 'v', 3.98)).toEqual({ cut: [], tracks: [] });
    expect(freezeSound(proj([...pair(), audio('other', 1, 3, { assetId: 'song', trackId: 'a1', start: 5 })]), 'v', 2)).toEqual({ cut: ['s'], tracks: ['a1'] });
    // a clip crossing the freeze point on the sound's track: it would be torn
    const crossed = proj([video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0, 1, { group: 'g' }), audio('long', 1, 3, { assetId: 'song', trackId: 'a1' })]);
    expect(freezeSound(crossed, 'v', 2)).toEqual({ cut: [], tracks: [] });
  });

  it('is empty for a picture with no sound apart, a locked track or a missing clip', () => {
    expect(freezeSound(proj([video('v', 0, 4)]), 'v', 2)).toEqual({ cut: [], tracks: [] });
    expect(freezeSound(proj(pair(), [track('v1', 'video'), track('v2', 'video'), track('a1', 'audio', { locked: true }), track('a2', 'audio')]), 'v', 2)).toEqual({ cut: [], tracks: [] });
    expect(freezeSound(proj(pair()), 'nope', 2)).toEqual({ cut: [], tracks: [] });
  });
});

describe('soundToggle', () => {
  it('separates, joins or says why', () => {
    expect(soundToggle(proj([video('a', 0, 4)]), ['a'])).toEqual({ kind: 'separate', ids: ['a'] });
    expect(soundToggle(proj(pair()), ['v'])).toEqual({ kind: 'join', ids: ['v'] });
    expect(soundToggle(proj(pair({ s: { start: 1 } })), ['v'])).toEqual({ kind: 'none', reason: T.soundOutOfSync });
    expect(soundToggle(proj([video('a', 0, 2, { assetId: 'silent' })]), ['a'])).toEqual({ kind: 'none', reason: T.noSoundInVideo });
    expect(soundToggle(proj([video('a', 0, 2)]), [])).toEqual({ kind: 'none', reason: T.soundVideoFirst });
  });

  it('a mixed selection separates what can be separated', () => {
    const p = proj([...pair(), video('a', 6, 2)]);
    expect(soundToggle(p, ['v', 'a'])).toEqual({ kind: 'separate', ids: ['v', 'a'] });
    // nothing left to separate: join the pair
    expect(soundToggle(p, ['v'])).toEqual({ kind: 'join', ids: ['v'] });
  });
});

describe('sideIds, menu, summary, role, reasons', () => {
  const p = proj([...pair(), video('plain', 6, 2), audio('song', 9, 1, { assetId: 'song' })]);

  it('sideIds', () => {
    expect(sideIds(p, ['v'], 'sound')).toEqual(['s']);
    expect(sideIds(p, ['s'], 'sound')).toEqual(['s']);
    expect(sideIds(p, ['s'], 'picture')).toEqual(['v']);
    expect(sideIds(p, ['v', 's'], 'picture')).toEqual(['v']);
    expect(sideIds(p, ['plain', 'song'], 'sound')).toEqual([]);
  });

  it('soundMenu', () => {
    expect(soundMenu(p, ['plain'], 'plain')).toEqual({ canSeparate: true, join: null, offset: null, sound: false, picture: false });
    expect(soundMenu(p, ['s'], 's')).toEqual({ canSeparate: false, join: 'yes', offset: null, sound: true, picture: true });
    const off = proj(pair({ s: { start: 0.1 } }));
    expect(soundMenu(off, ['s'], 's')).toMatchObject({ join: T.soundOutOfSync, offset: '+3f' });
    // the clicked clip counts even when it is not in the list
    expect(soundMenu(p, [], 'plain').canSeparate).toBe(true);
  });

  it('pairSummary', () => {
    expect(pairSummary(null, ['v'])).toEqual({ pairs: 0, separable: 0, outOfSync: 0, speed: 1, joinWhy: null });
    expect(pairSummary(p, ['v', 's', 'plain'])).toEqual({ pairs: 1, separable: 1, outOfSync: 0, speed: 1, joinWhy: null });
    const off = proj(pair({ s: { start: 0.1 } }));
    expect(pairSummary(off, ['v'])).toMatchObject({ pairs: 1, outOfSync: 1, joinWhy: T.soundOutOfSync });
    const fast = proj(pair({ v: { speed: 2 }, s: { speed: 2 } }));
    expect(pairSummary(fast, ['s']).speed).toBe(2);
  });

  it('pairSummary: a join reason only when no pair can join, the first pair gives it', () => {
    const two = (a: Partial<AudioClip>, b: Partial<AudioClip>): Project => proj([
      video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0, 4, { group: 'g', ...a }),
      video('w', 10, 4, { group: 'h', muted: true }), audio('t', 10, 4, { group: 'h', ...b }),
    ]);
    expect(pairSummary(two({}, { fadeOut: 1 }), ['v', 'w']).joinWhy).toBeNull();
    expect(pairSummary(two({ fadeOut: 1 }, {}), ['v', 'w']).joinWhy).toBeNull();
    expect(pairSummary(two({ fadeOut: 1 }, { start: 10.1 }), ['v', 'w']).joinWhy).toBe(T.soundOtherFades);
    expect(pairSummary(two({ fadeOut: 1 }, { start: 10.1 }), ['w', 'v']).joinWhy).toBe(T.soundOtherFades);
  });

  it('soundRole', () => {
    expect(soundRole(p, 'v')).toBe('apart');
    expect(soundRole(p, 's')).toBe('sound');
    expect(soundRole(p, 'plain')).toBe('separable');
    expect(soundRole(p, 'song')).toBe('none');
    expect(soundRole(p, 'nope')).toBe('none');
    expect(soundRole(proj([video('q', 0, 1, { assetId: 'silent' })]), 'q')).toBe('none');
  });

  it('soundKeyReason answers from the planners', () => {
    expect(soundKeyReason('separate-sound', p, ['plain'])).toBeNull();
    expect(soundKeyReason('separate-sound', p, [])).toBe(T.soundVideoFirst);
    expect(soundKeyReason('join-sound', p, ['v'])).toBeNull();
    expect(soundKeyReason('join-sound', p, ['plain'])).toBe(T.soundPairFirst);
    expect(soundKeyReason('move-into-sync', p, ['v'])).toBe(T.inSync);
    expect(soundKeyReason('slip-into-sync', p, ['plain'])).toBe(T.soundPairFirst);
    expect(soundKeyReason('select-sound', p, ['v'])).toBeNull();
    expect(soundKeyReason('select-sound', p, ['plain'])).toBe(T.soundPairFirst);
    expect(soundKeyReason('select-picture', p, ['s'])).toBeNull();
    expect(soundKeyReason('select-picture', p, [])).toBe(T.soundPairFirst);
    expect(soundKeyReason('something-else', p, ['v'])).toBeNull();
  });
});
