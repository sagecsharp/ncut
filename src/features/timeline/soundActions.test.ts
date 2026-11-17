import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Clip, EffectClip, Keyframe, MediaAsset, Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { syncLabel } from '../../lib/soundPair';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { SHORTCUTS } from '../shell/shortcuts';
import { beginEdit, endEdit } from '../properties/edit';
import { markFollowGesture } from './followApply';
import { joinSound, joinSoundNow, selectSideNow, separateSound, separateSoundNow, setPairSpeed, syncSound, syncSoundNow, toggleSoundNow } from './soundActions';
import { SOUND_TEXT as T } from './soundText';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <C extends Clip>(id: string): C => proj().clips.find((c) => c.id === id) as C;
const lastToast = (): string => useUi.getState().toasts.at(-1)?.message ?? '';

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

/** tracks top down: v1, v2, a1, a2 (the mirror of v1 is a2) */
function open(clips: Clip[], tracks?: Track[]): void {
  const p = createProject('sound');
  ed().openProject({
    ...p,
    assets: [asset('av', 'video', true), asset('silent', 'video', false), asset('song', 'audio', true)],
    tracks: tracks ?? [track('v1', 'video'), track('v2', 'video'), track('a1', 'audio'), track('a2', 'audio')],
    clips,
  });
  useEditor.setState({ past: [], future: [], selection: [] });
}

function oneStep(run: () => void): void {
  const before = proj();
  run();
  const after = proj();
  expect(ed().past.length).toBe(1);
  expect(after).not.toEqual(before);
  ed().undo();
  expect(proj()).toEqual(before);
  ed().redo();
  expect(proj()).toEqual(after);
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useUi.setState({ toasts: [] });
  usePlayback.setState({ time: 0 });
});

describe('separate sound', () => {
  it('separate is one undo step', () => {
    open([video('a', 1, 4, { trimStart: 2, speed: 1.25, volume: 0.7, fadeIn: 0.3 }), video('b', 7, 2)]);
    oneStep(() => {
      const r = separateSound(['a', 'b']);
      expect(typeof r).toBe('object');
    });
    const r = clipOf<VideoClip>('a');
    expect(r.muted).toBe(true);
    const sounds = proj().clips.filter((c) => c.type === 'audio') as AudioClip[];
    expect(sounds).toHaveLength(2);
    // right after its picture, in the group of its picture, on the mirror track
    const order = proj().clips.map((c) => c.id);
    const sa = sounds.find((c) => c.start === 1)!;
    expect(order.indexOf(sa.id)).toBe(order.indexOf('a') + 1);
    expect(sa.group).toBe(r.group);
    expect(sa.group).toBeTruthy();
    expect(sa).toMatchObject({ trackId: 'a2', trimStart: 2, speed: 1.25, volume: 0.7, fadeIn: 0.3, duration: 4 });
    expect(ed().selection.sort()).toEqual(['a', 'b', ...sounds.map((c) => c.id)].sort());
  });

  it('answers what it did, a string for nothing and changes nothing then', () => {
    open([video('quiet', 0, 2, { assetId: 'silent' }), video('a', 3, 2)]);
    const none = separateSound(['quiet']);
    expect(none).toBe(T.noSoundInVideo);
    expect(ed().past.length).toBe(0);
    const r = separateSound(['quiet', 'a']);
    expect(r).toMatchObject({ pairs: [{ picture: 'a', track: 'a2' }], skipped: [{ id: 'quiet', why: T.noSoundInVideo }] });
  });

  it('makes a new audio track with the settings of the video track', () => {
    open([video('a', 0, 2)], [track('v1', 'video', { muted: true, volume: 0.5 }), track('a1', 'audio')]);
    const r = separateSound(['a']);
    expect(typeof r).toBe('object');
    const t = proj().tracks;
    expect(t).toHaveLength(3);
    const made = t[2]!;
    expect(made).toMatchObject({ kind: 'audio', muted: true, volume: 0.5 });
    expect((r as { pairs: { track: string }[] }).pairs[0]!.track).toBe(made.id);
    expect(clipOf<AudioClip>((r as { pairs: { sound: string }[] }).pairs[0]!.sound).trackId).toBe(made.id);
    ed().undo();
    expect(proj().tracks).toHaveLength(2);
  });

  it('the asked track comes first', () => {
    open([video('a', 0, 2)]);
    const r = separateSound(['a'], { prefer: 'a1' }) as { pairs: { track: string }[] };
    expect(r.pairs[0]!.track).toBe('a1');
  });

  it('inside a step it opens no step and never rolls back', () => {
    open([video('a', 0, 2)]);
    ed().pushHistory();
    const r = separateSound(['a'], { skipHistory: true });
    expect(typeof r).toBe('object');
    expect(ed().past.length).toBe(1);
    // a plan that fails writes nothing
    expect(separateSound(['a'], { skipHistory: true })).toBe(T.alreadyApart);
    expect(ed().past.length).toBe(1);
  });

  it('toasts only the skips', () => {
    open([video('quiet', 0, 2, { assetId: 'silent' }), video('a', 3, 2)]);
    separateSoundNow(['a']);
    expect(useUi.getState().toasts).toHaveLength(0);
    useEditor.getState().undo();
    separateSoundNow(['quiet', 'a']);
    expect(lastToast()).toBe(`1 separated, 1 skipped: ${T.noSoundInVideo}`);
    separateSoundNow(['quiet']);
    expect(lastToast()).toBe(T.noSoundInVideo);
  });
});

describe('join sound', () => {
  const pairProject = (): Clip[] => [video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0, 4, { group: 'g', trackId: 'a2' })];

  it('join is one undo step', () => {
    open(pairProject());
    oneStep(() => {
      expect(typeof joinSound(['v'])).toBe('object');
    });
    expect(proj().clips.map((c) => c.id)).toEqual(['v']);
    expect(clipOf<VideoClip>('v').muted).toBe(false);
    expect(clipOf<VideoClip>('v').group).toBeUndefined();
    expect(ed().selection).toEqual(['v']);
  });

  it('separate then join gives the picture back', () => {
    const fx = effect('fx', 'v2', 1, 4, { beat: { source: 'a', every: 1, pulse: 0.5, lock: false } });
    const clips: Clip[] = [
      video('a', 1, 4, { trimStart: 0.5, speed: 1.25, volume: 0.8, fadeIn: 0.3, fadeOut: 0.5, bpm: 120, beatOffset: 0.2, keyframes: { volume: lin([0, 1], [1, 1.6], [3, 0.3]), x: lin([0, 0], [2, 40]) } }),
      fx,
      video('b', 8, 2, { muted: true }),
    ];
    open(clips);
    const before = structuredClone(proj().clips);
    expect(typeof separateSound(['a', 'b'])).toBe('object');
    // the tempo and the beat source moved to the sound clip
    const sound = proj().clips.find((c) => c.type === 'audio' && c.start === 1)! as AudioClip;
    expect(clipOf<VideoClip>('a').bpm).toBeNull();
    expect(sound.bpm).toBe(120);
    expect((clipOf<EffectClip>('fx').beat as { source: string }).source).toBe(sound.id);
    expect(typeof joinSound(['a', 'b'])).toBe('object');
    expect(proj().clips).toEqual(before);
    expect(proj().tracks.map((t) => t.id)).toEqual(['v1', 'v2', 'a1', 'a2']);
  });

  it('the sound keys of the sound clip come back to the picture', () => {
    open([video('v', 0, 4, { keyframes: { volume: lin([0, 1]), x: lin([0, 5], [2, 9]) } })]);
    separateSound(['v']);
    const s = proj().clips.find((c) => c.type === 'audio')!;
    ed().setClipKeyframes(s.id, { volume: lin([0, 0.5], [2, 1]) });
    ed().select(['v'], 'replace');
    expect(typeof joinSound(['v'])).toBe('object');
    expect(clipOf<VideoClip>('v').keyframes).toEqual({ x: lin([0, 5], [2, 9]), volume: lin([0, 0.5], [2, 1]) });
  });

  it('join gives back the volume of the sound clip when its keys are gone', () => {
    open([video('v', 0, 4, { volume: 1.2, keyframes: { volume: lin([1, 1.6], [2, 0.3]) } })]);
    separateSound(['v']);
    const s = proj().clips.find((c) => c.type === 'audio')! as AudioClip;
    ed().clearKeyframes(s.id, 1, 'volume');
    const flat = clipOf<AudioClip>(s.id).volume;
    ed().select(['v'], 'replace');
    expect(typeof joinSound(['v'])).toBe('object');
    expect(clipOf<VideoClip>('v').volume).toBe(flat);
    expect(clipOf<VideoClip>('v').keyframes?.volume).toBeUndefined();
  });

  it('says why a pair does not join and changes nothing', () => {
    open([video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0.5, 4, { group: 'g', trackId: 'a2' })]);
    const before = proj();
    expect(joinSound(['v'])).toBe(T.soundOutOfSync);
    expect(ed().past.length).toBe(0);
    expect(proj()).toBe(before);
    joinSoundNow(['v']);
    expect(lastToast()).toBe(T.soundOutOfSync);
  });

  it('a lone clip has no pair to join', () => {
    open([video('v', 0, 4)]);
    expect(joinSound(['v'])).toBe(T.soundPairFirst);
  });
});

describe('toggle', () => {
  it('toggle on a mixed selection', () => {
    open([video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0, 4, { group: 'g', trackId: 'a2' }), video('plain', 6, 2)]);
    ed().select(['v', 's', 'plain'], 'replace');
    toggleSoundNow(ed().selection);
    // the plain video separates, the pair that is apart already stays and is not mentioned
    expect(proj().clips.filter((c) => c.type === 'audio')).toHaveLength(2);
    expect(clipOf<VideoClip>('plain').muted).toBe(true);
    expect(useUi.getState().toasts).toHaveLength(0);
    expect(ed().past.length).toBe(1);
    // everything is apart now: the same selection joins back
    ed().select(['v', 'plain'], 'replace');
    toggleSoundNow(ed().selection);
    expect(proj().clips.filter((c) => c.type === 'audio')).toHaveLength(0);
    expect(ed().past.length).toBe(2);
  });

  it('toggle tells what it skipped', () => {
    open([video('a', 0, 4), video('b', 6, 2, { assetId: 'silent' })]);
    toggleSoundNow(['a', 'b']);
    expect(lastToast()).toBe(`1 separated, 1 skipped: ${T.noSoundInVideo}`);
  });

  it('says why when there is nothing to do', () => {
    open([video('v', 0, 4, { group: 'g', muted: true }), audio('s', 1, 4, { group: 'g', trackId: 'a2' })]);
    toggleSoundNow(['v']);
    expect(lastToast()).toBe(T.soundOutOfSync);
    expect(ed().past.length).toBe(0);
    toggleSoundNow([]);
    expect(lastToast()).toBe(T.soundVideoFirst);
  });

  it('shift+m mutes the sound clip', () => {
    open([video('v', 0, 4)]);
    separateSound(['v']);
    const s = proj().clips.find((c) => c.type === 'audio')!;
    ed().select(['v'], 'replace');
    SHORTCUTS.find((x) => x.id === 'mute')!.run();
    expect(clipOf<AudioClip>(s.id).muted).toBe(true);
    // the picture stays muted: unmuting it would play the sound twice
    expect(clipOf<VideoClip>('v').muted).toBe(true);
    SHORTCUTS.find((x) => x.id === 'mute')!.run();
    expect(clipOf<AudioClip>(s.id).muted).toBe(false);
    expect(clipOf<VideoClip>('v').muted).toBe(true);
  });
});

describe('pair speed', () => {
  it('pair speed is one step and stays in sync', () => {
    open([video('v', 2, 4, { group: 'g', muted: true, trimStart: 1 }), audio('s', 2, 4, { group: 'g', trimStart: 1, trackId: 'a2' })]);
    oneStep(() => setPairSpeed(['v'], 2, false));
    expect(clipOf<VideoClip>('v')).toMatchObject({ speed: 2, duration: 2 });
    expect(clipOf<AudioClip>('s')).toMatchObject({ speed: 2, duration: 2 });
    expect(syncLabel(proj().clips, 's', 30)).toBeNull();
  });

  it('a j cut lead scales with the speed', () => {
    // the sound starts a second before the picture (a j cut)
    open([video('v', 4, 4, { group: 'g', muted: true, trimStart: 1 }), audio('s', 3, 5, { group: 'g', trimStart: 0, trackId: 'a2' })]);
    setPairSpeed(['s'], 2, false);
    expect(clipOf<AudioClip>('s').start).toBeCloseTo(3.5);
    expect(syncLabel(proj().clips, 's', 30)).toBeNull();
    expect(ed().past.length).toBe(1);
  });

  it('a j cut sound that slows down and moves left never clamps', () => {
    // the sound starts 2 s before the picture and a clip waits just past its planned end
    const pair = (): Clip[] => [
      video('v', 10, 5, { group: 'g', muted: true, trimStart: 10 }),
      audio('s', 8, 7, { group: 'g', trimStart: 8 }),
      audio('next', 16.3, 2, { assetId: 'song' }),
    ];
    open(pair());
    setPairSpeed(['v', 's'], 0.8, false);
    expect(clipOf<AudioClip>('s').start).toBeCloseTo(7.5);
    expect(clipOf<AudioClip>('s').duration).toBeCloseTo(8.75);
    expect(clipOf<AudioClip>('next').start).toBe(16.3);
    // a live drag that goes there and back ends where it began
    open(pair());
    beginEdit();
    markFollowGesture();
    for (const sp of [0.9, 0.8, 0.9, 1]) setPairSpeed(['v', 's'], sp, true);
    endEdit();
    expect(clipOf<AudioClip>('s').duration).toBeCloseTo(7);
    expect(clipOf<AudioClip>('s').start).toBeCloseTo(8);
  });

  it('a lone clip changes nothing', () => {
    open([video('v', 0, 4)]);
    setPairSpeed(['v'], 2, false);
    expect(ed().past.length).toBe(0);
  });
});

describe('sync', () => {
  it('a sync speed change never clamps', () => {
    // the sound runs at 2 from 1 to 3, the picture at 1 from 0 to 4: the sound gets longer and moves left.
    // a clip stands on the sound's track from 4: changing the speed first would run into it and clamp
    open([
      video('v', 0, 4, { group: 'g', muted: true }),
      audio('s', 1, 2, { group: 'g', speed: 2, trackId: 'a2' }),
      audio('next', 4, 2, { assetId: 'song', trackId: 'a2' }),
    ]);
    const r = syncSound(['v', 's'], 'speed');
    expect(r).toMatchObject({ synced: ['s'] });
    expect(clipOf<AudioClip>('s')).toMatchObject({ speed: 1, start: 0, duration: 4 });
    expect(clipOf<AudioClip>('next').start).toBe(4);
    expect(ed().past.length).toBe(1);
  });

  it('a speed sync gives the effects on the picture its new span', () => {
    open([video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0, 2, { group: 'g', speed: 2, trackId: 'a2' }), effect('fx', 'v2', 0, 4, { target: 'v' })]);
    expect(syncSound(['v'], 'speed')).toMatchObject({ synced: ['v'] });
    expect(clipOf<VideoClip>('v')).toMatchObject({ speed: 2, duration: 2 });
    expect(clipOf<EffectClip>('fx')).toMatchObject({ start: 0, duration: 2 });
  });

  it('two movers that would run into each other: the second is skipped', () => {
    // sA gets longer (speed 2 to 1) and takes 0 to 2; sB would take 1.8 to 3.8: free alone, not together
    open([
      video('vA', 0, 2, { group: 'g', muted: true }),
      audio('sA', 4, 1, { group: 'g', speed: 2, trackId: 'a1' }),
      video('vB', 1.8, 2, { group: 'h', muted: true, trackId: 'v2' }),
      audio('sB', 6, 2, { group: 'h', trackId: 'a1' }),
    ]);
    const r = syncSound(['sA', 'sB'], 'speed');
    expect(r).toMatchObject({ synced: ['sA'] });
    expect(clipOf<AudioClip>('sA')).toMatchObject({ speed: 1, start: 0, duration: 2 });
    expect(clipOf<AudioClip>('sB').start).toBe(6);
  });

  it('a skipped mover does not stop a speed-only pair', () => {
    // sA and sB want overlapping spans on a2: the second is skipped; sC only needs its speed
    open([
      video('vA', 0, 2, { group: 'a', muted: true }),
      audio('sA', 3, 2, { group: 'a', trackId: 'a2' }),
      video('vB', 0.5, 2, { group: 'b', muted: true, trackId: 'v2' }),
      audio('sB', 4, 2, { group: 'b', trackId: 'a2' }),
      video('vC', 20, 4, { group: 'c', muted: true }),
      audio('sC', 20, 2, { group: 'c', speed: 2, trackId: 'a1' }),
    ]);
    const r = syncSound(['sA', 'sB', 'sC'], 'speed');
    expect(typeof r).toBe('object');
    if (typeof r === 'string') return;
    expect(r.synced).toContain('sC');
    expect(clipOf<AudioClip>('sC').speed).toBe(1);
    expect(r.synced).not.toContain('sB');
    expect(r.skipped.map((s) => s.id)).toContain('sB');
  });

  it('move into sync, one step, and the followers come along', () => {
    open([video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0.5, 4, { group: 'g', trackId: 'a2' }), effect('fx', 'v2', 0, 4, { target: 'v' })]);
    oneStep(() => {
      expect(syncSound(['v'], 'move')).toMatchObject({ synced: ['v'] });
    });
    expect(clipOf<VideoClip>('v').start).toBeCloseTo(0.5);
    expect(clipOf<EffectClip>('fx').start).toBeCloseTo(0.5);
    expect(syncLabel(proj().clips, 's', 30)).toBeNull();
  });

  it('slip into sync keeps the clip and slides its media', () => {
    open([video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0.5, 4, { group: 'g', trackId: 'a2' })]);
    oneStep(() => {
      expect(syncSound(['s'], 'slip')).toMatchObject({ synced: ['s'] });
    });
    expect(clipOf<AudioClip>('s')).toMatchObject({ start: 0.5, trimStart: 0.5 });
    expect(syncLabel(proj().clips, 's', 30)).toBeNull();
  });

  it('names the clip in the way', () => {
    open([video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0.5, 4, { group: 'g', trackId: 'a2' }), video('wall', 4.2, 2, { assetId: 'silent', name: 'the wall' })]);
    syncSoundNow(['v'], 'move');
    expect(lastToast()).toBe(`${T.syncNoRoom}: the wall is in the way`);
    expect(ed().past.length).toBe(0);
  });

  it('a move the store refuses skips the clip', () => {
    // two pairs, one of them blocked by a clip the plan cannot see: a clip of another track kind is no help, so
    // the first pair syncs and the second is reported
    open([
      video('v', 0, 2, { group: 'g', muted: true }),
      audio('s', 0.5, 2, { group: 'g', trackId: 'a2' }),
      video('w', 5, 2, { group: 'h', muted: true }),
      audio('t', 5.5, 2, { group: 'h', trackId: 'a2' }),
      video('wall', 7, 1, { assetId: 'silent' }),
    ]);
    syncSoundNow(['v', 'w'], 'move');
    expect(lastToast()).toBe(`1 lined up, 1 skipped: ${T.syncNoRoom}: wall is in the way`);
    expect(clipOf<VideoClip>('v').start).toBeCloseTo(0.5);
    expect(clipOf<VideoClip>('w').start).toBe(5);
  });
});

describe('select a side', () => {
  it('selects the sound or the picture, or says why not', () => {
    open([video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0, 4, { group: 'g', trackId: 'a2' }), video('plain', 6, 1)]);
    selectSideNow(['v'], 'sound');
    expect(ed().selection).toEqual(['s']);
    selectSideNow(['s'], 'picture');
    expect(ed().selection).toEqual(['v']);
    selectSideNow(['plain'], 'sound');
    expect(lastToast()).toBe(T.soundPairFirst);
    expect(ed().selection).toEqual(['v']);
  });
});
