import { describe, expect, it } from 'vitest';
import type { AudioClip, Clip, Keyframe, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import {
  formatSyncOffset,
  hasSoundApart,
  isPair,
  isSoundClip,
  keepsSoundGroup,
  mateOf,
  muteTargets,
  ownSoundsOf,
  pairIndex,
  sameTrackSound,
  soundFromPicture,
  soundKeys,
  soundProps,
  soundsOf,
  syncLabel,
  syncOffset,
  syncPoint,
  withSoundKeys,
} from './soundPair';

const video = (id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId: 'v1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId: 'a1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 0, speed: 1, volume: 1, muted: false, ...over,
});
const lin = (...pairs: [number, number][]): Keyframe[] => pairs.map(([t, v]) => ({ t, v, ease: 'linear' as const }));

describe('soundPair', () => {
  it('syncPoint reads speed 0 as 1', () => {
    expect(syncPoint({ start: 5, trimStart: 2, speed: 2 })).toBe(4);
    expect(syncPoint({ start: 5, trimStart: 2, speed: 0 })).toBe(3);
    expect(syncPoint({ start: 5, trimStart: 2, speed: -1 })).toBe(3);
  });

  it('isSoundClip', () => {
    const assets = [{ id: 'av', kind: 'video' as const }, { id: 'song', kind: 'audio' as const }];
    expect(isSoundClip(audio('s', 0, 1), assets)).toBe(true);
    expect(isSoundClip(audio('s', 0, 1, { assetId: 'song' }), assets)).toBe(false);
    expect(isSoundClip(video('v', 0, 1), assets)).toBe(false);
    expect(isSoundClip(audio('s', 0, 1, { assetId: 'gone' }), assets)).toBe(false);
  });

  it('pairIndex: overlap first, then sync point', () => {
    // two sounds under one picture: the one that overlaps more wins, then the nearer sync point
    const v = video('v', 0, 4, { group: 'g' });
    const far = audio('far', 3, 4, { group: 'g' });
    const near = audio('near', 0, 2, { group: 'g' });
    const clips: Clip[] = [v, far, near];
    expect(mateOf(clips, 'v')?.id).toBe('near');
    expect(pairIndex(clips).others.get('v')).toEqual(['far', 'near']);
    expect(hasSoundApart(clips, 'v')).toBe(true);
    expect(soundsOf(clips, v).map((c) => c.id)).toEqual(['far', 'near']);
    // the same overlap: the sync point decides
    const a = audio('a', 0, 4, { group: 'g', trimStart: 1 });
    const b = audio('b', 0, 4, { group: 'g' });
    expect(mateOf([v, a, b], 'v')?.id).toBe('b');
    expect(isPair([v, a, b], 'v', 'b')).toBe(true);
    expect(isPair([v, a, b], 'v', 'a')).toBe(false);
  });

  it('pairIndex: one computation per array', () => {
    const clips: Clip[] = [video('v', 0, 1, { group: 'g' }), audio('s', 0, 1, { group: 'g' })];
    expect(pairIndex(clips)).toBe(pairIndex(clips));
    expect(pairIndex([...clips])).not.toBe(pairIndex(clips));
    // another file or no group: no pair
    expect(pairIndex([video('v', 0, 1, { group: 'g' }), audio('s', 0, 1, { group: 'g', assetId: 'song' })]).mate.size).toBe(0);
    expect(pairIndex([video('v', 0, 1), audio('s', 0, 1)]).mate.size).toBe(0);
  });

  it('syncOffset and syncLabel', () => {
    const clips: Clip[] = [video('v', 0, 4, { group: 'g' }), audio('s', 0.1, 4, { group: 'g' })];
    expect(syncOffset(clips, 's')).toBeCloseTo(0.1);
    expect(syncOffset(clips, 'v')).toBeCloseTo(-0.1);
    expect(syncLabel(clips, 's', 30)).toBe('+3f');
    expect(syncLabel(clips, 'v', 30)).toBe('-3f');
    const fast: Clip[] = [video('v', 0, 4, { group: 'g' }), audio('s', 0, 2, { group: 'g', speed: 2 })];
    expect(syncOffset(fast, 's')).toBeNaN();
    expect(syncLabel(fast, 's', 30)).toBe('speed');
    expect(syncLabel([video('v', 0, 4, { group: 'g' }), audio('s', 0, 4, { group: 'g' })], 's', 30)).toBeNull();
    expect(syncLabel([video('v', 0, 4)], 'v', 30)).toBeNull();
  });

  it('muteTargets', () => {
    const clips: Clip[] = [
      video('v', 0, 4, { group: 'g' }),
      audio('s', 0, 4, { group: 'g' }),
      video('plain', 5, 2),
      audio('song', 8, 2, { assetId: 'song' }),
    ];
    // a picture with its sound apart stands for its sound clip, any other clip for itself, each once, in project order
    expect(muteTargets(clips, ['plain', 'v', 's']).map((c) => c.id)).toEqual(['s', 'plain']);
    expect(muteTargets(clips, ['song', 'nope']).map((c) => c.id)).toEqual(['song']);
  });

  it('muteTargets: a shot stands for its own sound', () => {
    // an l cut: two shots, two sounds
    const cut: Clip[] = [video('v', 0, 5, { group: 'g' }), video('p2', 5, 5, { group: 'g', trimStart: 5 }), audio('s', 0, 6, { group: 'g' }), audio('s2', 6, 4, { group: 'g', trimStart: 6 })];
    expect(muteTargets(cut, ['v']).map((c) => c.id)).toEqual(['s']);
    expect(muteTargets(cut, ['p2']).map((c) => c.id)).toEqual(['s2']);
    expect(ownSoundsOf(cut, cut[0]!).map((c) => c.id)).toEqual(['s']);
    // one sound under two pictures: the picture that lost the tie still stands for it
    const shared: Clip[] = [video('v', 0, 5, { group: 'g' }), video('p2', 5, 5, { group: 'g', trimStart: 5 }), audio('s', 0, 10, { group: 'g' })];
    expect(muteTargets(shared, ['v']).map((c) => c.id)).toEqual(['s']);
    expect(muteTargets(shared, ['p2']).map((c) => c.id)).toEqual(['s']);
  });

  it('sameTrackSound', () => {
    expect(sameTrackSound({ muted: false }, { muted: false, volume: 1, pan: 0 })).toBe(true);
    expect(sameTrackSound({ muted: false }, { muted: true })).toBe(false);
    expect(sameTrackSound({ muted: false, volume: 0.5 }, { muted: false })).toBe(false);
    expect(sameTrackSound({ muted: false, pan: 0.5 }, { muted: false })).toBe(false);
  });

  it('soundFromPicture keeps null, no visual field', () => {
    const v = video('v', 2, 3, { name: 'talk', fadeIn: 0.3, fadeOut: 0.5, trimStart: 1, speed: 1.25, volume: 0.8, muted: true, bpm: 120, beatOffset: null, pan: -0.5, keyframes: { volume: lin([0, 1], [1, 0.5]), 'transform.x': lin([0, 0], [1, 5]) } });
    const s = soundFromPicture(v, 's1', 'a1', 'g1');
    expect(s).toMatchObject({ id: 's1', type: 'audio', trackId: 'a1', start: 2, duration: 3, name: 'talk', fadeIn: 0.3, fadeOut: 0.5, assetId: 'av', trimStart: 1, speed: 1.25, volume: 0.8, muted: true, bpm: 120, beatOffset: null, pan: -0.5, group: 'g1' });
    expect('beatOffset' in s).toBe(true);
    expect(s.keyframes).toEqual({ volume: lin([0, 1], [1, 0.5]) });
    expect('transform' in s).toBe(false);
    const plain = soundFromPicture(video('p', 0, 1), 's2', 'a1', undefined);
    expect(plain).not.toHaveProperty('group');
    expect(plain).not.toHaveProperty('keyframes');
    expect(plain).not.toHaveProperty('bpm');
  });

  it('soundKeys clones only the sound props', () => {
    expect(soundProps()).toContain('volume');
    const kf = { volume: lin([0, 1]), 'transform.x': lin([0, 3]) };
    const out = soundKeys(kf)!;
    expect(Object.keys(out)).toEqual(['volume']);
    expect(out.volume).not.toBe(kf.volume);
    expect(soundKeys({ 'transform.x': lin([0, 3]) })).toBeUndefined();
    expect(soundKeys(undefined)).toBeUndefined();
  });

  it('withSoundKeys', () => {
    const picture = { volume: lin([0, 1]), 'transform.x': lin([0, 3]) };
    const sound = { volume: lin([0, 0.5], [1, 1]) };
    expect(withSoundKeys(picture, sound)).toEqual({ 'transform.x': lin([0, 3]), volume: lin([0, 0.5], [1, 1]) });
    expect(withSoundKeys(picture, undefined)).toEqual({ 'transform.x': lin([0, 3]) });
    expect(withSoundKeys({ volume: lin([0, 1]) }, undefined)).toBeUndefined();
    expect(withSoundKeys(undefined, sound)).toEqual(sound);
    expect(withSoundKeys(undefined, sound)!.volume).not.toBe(sound.volume);
  });

  it('formatSyncOffset', () => {
    expect(formatSyncOffset(0.1, 30)).toBe('+3f');
    expect(formatSyncOffset(-0.1, 30)).toBe('-3f');
    expect(formatSyncOffset(-0.4 / 30, 30)).toBe('-0.4f');
    expect(formatSyncOffset(0.001 / 30, 30)).toBe('+0.1f');
    expect(formatSyncOffset(12.5, 30)).toBe('+375f');
    expect(formatSyncOffset(40.25, 30)).toBe('+40.3s');
    expect(formatSyncOffset(1, 0)).toBe('+1f');
  });

  it('keepsSoundGroup', () => {
    const v = video('v', 0, 4, { group: 'g' });
    const s = audio('s', 0, 6, { group: 'g' });
    const clips: Clip[] = [v, s];
    // the picture is cut alone at 2: the sound plays on over the cut, so the right half stays in the group
    expect(keepsSoundGroup(clips, v, 2, (o) => o.id === 'v')).toBe(true);
    // both cut: not kept
    expect(keepsSoundGroup(clips, v, 2, () => true)).toBe(false);
    // the sound ends before the cut
    expect(keepsSoundGroup([v, audio('s', 0, 1.5, { group: 'g' })], v, 2, (o) => o.id === 'v')).toBe(false);
    expect(keepsSoundGroup([video('v', 0, 4), s], video('v', 0, 4), 2, () => false)).toBe(false);
    expect(keepsSoundGroup([v, audio('s', 0, 6, { group: 'g', assetId: 'song' })], v, 2, (o) => o.id === 'v')).toBe(false);
  });
});
