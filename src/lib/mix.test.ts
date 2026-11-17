import { describe, expect, it } from 'vitest';
import type { AudioClip, Clip, MediaAsset, Project, Track, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject, createTrack } from './factory';
import { fadeFactor } from './timelineOps';
import { valueAt } from './anim';
import {
  FADER_MAX_DB,
  MAX_TRACK_GAIN,
  NO_SOLO,
  clipMix,
  clipPan,
  clipPanAt,
  dbToGain,
  formatDb,
  formatDbShort,
  formatPan,
  gainToDb,
  isMixFlat,
  mixerTracks,
  needsPan,
  outputGain,
  panGains,
  parseDb,
  patchOutput,
  patchTrack,
  planMixerReset,
  soloActive,
  soloSet,
  soundTracksOf,
  toggledSolo,
  trackHeard,
  trackPan,
  trackSoundLine,
  trackVolume,
} from './mix';

const audio = (id: string, trackId: string, over: Partial<AudioClip> = {}): AudioClip => ({
  id, name: id, type: 'audio', trackId, assetId: 'snd', start: 0, duration: 10, trimStart: 0, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, ...over,
});
const video = (id: string, trackId: string, assetId = 'vid', over: Partial<VideoClip> = {}): VideoClip => ({
  id, name: id, type: 'video', trackId, assetId, start: 0, duration: 10, trimStart: 0, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const asset = (id: string, hasAudio: boolean): MediaAsset => ({
  id, name: id, kind: hasAudio && id === 'snd' ? 'audio' : 'video', mime: 'x/x', size: 1, duration: 10, width: 0, height: 0, hasAudio, createdAt: 0,
}) as MediaAsset;

function proj(clips: Clip[], tracks?: Track[], assets: MediaAsset[] = [asset('snd', true), asset('vid', true), asset('mute', false)]): Project {
  const p = createProject('mix');
  return { ...p, tracks: tracks ?? p.tracks, clips, assets };
}

describe('panGains', () => {
  it('is exactly 1 and 1 in the middle', () => {
    expect(panGains(0)).toEqual([1, 1]);
    expect(Object.is(panGains(0)[0], 1)).toBe(true);
  });
  it('the far side is exactly 0 at the ends', () => {
    expect(panGains(1)).toEqual([0, 1]);
    expect(panGains(-1)).toEqual([1, 0]);
  });
  it('half way the far side is cos of a quarter turn', () => {
    expect(panGains(0.5)[0]).toBeCloseTo(Math.cos(Math.PI / 4), 12);
    expect(panGains(0.5)[1]).toBe(1);
    expect(panGains(-0.5)[1]).toBeCloseTo(Math.cos(Math.PI / 4), 12);
    expect(panGains(-0.5)[0]).toBe(1);
  });
});

describe('levels', () => {
  const t = (over: Partial<Track>): Track => ({ ...createTrack('audio', 'a'), ...over });
  it('trackVolume reads missing, NaN and null as 1 and clamps', () => {
    expect(trackVolume(t({}))).toBe(1);
    expect(trackVolume(t({ volume: Number.NaN }))).toBe(1);
    expect(trackVolume(t({ volume: null as unknown as number }))).toBe(1);
    expect(trackVolume(t({ volume: -2 }))).toBe(0);
    expect(trackVolume(t({ volume: 9 }))).toBe(MAX_TRACK_GAIN);
    expect(trackVolume(t({ volume: 0.5 }))).toBe(0.5);
  });
  it('trackPan reads missing as the middle and clamps', () => {
    expect(trackPan(t({}))).toBe(0);
    expect(trackPan(t({ pan: Number.NaN }))).toBe(0);
    expect(trackPan(t({ pan: 5 }))).toBe(1);
    expect(trackPan(t({ pan: -5 }))).toBe(-1);
  });
  it('outputGain reads missing, null and NaN as 1 and clamps', () => {
    const p = proj([]);
    expect(outputGain(p)).toBe(1);
    expect(outputGain({ ...p, output: null })).toBe(1);
    expect(outputGain({ ...p, output: { volume: Number.NaN } })).toBe(1);
    expect(outputGain({ ...p, output: { volume: 0.4 } })).toBe(0.4);
    expect(outputGain({ ...p, output: { volume: 99 } })).toBe(MAX_TRACK_GAIN);
    expect(outputGain({ ...p, output: { volume: -1 } })).toBe(0);
  });
  it('clipPan and clipPanAt read the stored value, then the keys', () => {
    const c = audio('a', 't', { pan: 0.25 });
    expect(clipPan(c)).toBe(0.25);
    expect(clipPanAt(c, 3)).toBe(0.25);
    expect(clipPan(audio('b', 't'))).toBe(0);
    const k = audio('k', 't', { keyframes: { pan: [{ t: 0, v: -1, ease: 'linear' }, { t: 10, v: 1, ease: 'linear' }] } });
    expect(clipPanAt(k, 5)).toBeCloseTo(0, 12);
    expect(clipPanAt(k, 0)).toBe(-1);
  });
  it('needsPan is false only for a clip and a track in the middle with no keys', () => {
    expect(needsPan(0, audio('a', 't'))).toBe(false);
    expect(needsPan(0.2, audio('a', 't'))).toBe(true);
    expect(needsPan(0, audio('a', 't', { pan: -0.1 }))).toBe(true);
    expect(needsPan(0, audio('a', 't', { keyframes: { pan: [{ t: 0, v: 0, ease: 'linear' }] } }))).toBe(true);
  });
});

describe('solo', () => {
  const p = proj([]);
  const [a, b] = p.tracks as [Track, Track];
  it('no solo is null and stale ids are ignored', () => {
    expect(soloSet(p, NO_SOLO)).toBeNull();
    expect(soloSet(p, ['gone'])).toBeNull();
    expect([...soloSet(p, [a.id, 'gone'])!]).toEqual([a.id]);
    expect(soloActive(p, ['gone'])).toBe(false);
    expect(soloActive(p, [b.id])).toBe(true);
    expect(soloActive(null, [b.id])).toBe(false);
  });
  it('mute wins over solo', () => {
    const solo = soloSet(p, [a.id]);
    expect(trackHeard({ ...a, muted: true }, solo)).toBe(false);
    expect(trackHeard(a, solo)).toBe(true);
    expect(trackHeard(b, solo)).toBe(false);
    expect(trackHeard(b, null)).toBe(true);
    expect(trackHeard({ ...b, muted: true }, null)).toBe(false);
  });
});

describe('clipMix', () => {
  const p0 = proj([]);
  const tid = p0.tracks[1]!.id;
  it('a neutral clip is keyed volume times fade, pan off', () => {
    const c = audio('a', tid, { volume: 0.8, fadeIn: 2, fadeOut: 3, keyframes: { volume: [{ t: 0, v: 0.2, ease: 'linear' }, { t: 10, v: 1, ease: 'linear' }] } });
    const p = proj([c], p0.tracks);
    for (let i = 0; i < 20; i++) {
      const time = (i / 19) * 10;
      const m = clipMix(p, c, time, null);
      expect(m.pan).toBe(false);
      expect(m.l).toBe(1);
      expect(m.r).toBe(1);
      expect(m.gain).toBe(Math.max(0, valueAt(c, 'volume', time) ?? c.volume) * fadeFactor(c, time) * 1);
    }
  });
  it('a track at 0.5 halves it', () => {
    const c = audio('a', tid, { volume: 0.8 });
    const tracks = p0.tracks.map((t) => (t.id === tid ? { ...t, volume: 0.5 } : t));
    const p = proj([c], tracks);
    expect(clipMix(p, c, 5, null).gain).toBeCloseTo(0.4, 12);
  });
  it('a muted clip or an unheard track gives 0', () => {
    const c = audio('a', tid);
    const p = proj([c], p0.tracks);
    expect(clipMix(p, { ...c, muted: true }, 5, null).gain).toBe(0);
    expect(clipMix(p, c, 5, new Set(['other'])).gain).toBe(0);
    expect(clipMix(p, c, 5, new Set([tid])).gain).toBe(1);
    const muted = proj([c], p0.tracks.map((t) => (t.id === tid ? { ...t, muted: true } : t)));
    expect(clipMix(muted, c, 5, null).gain).toBe(0);
    expect(clipMix(p, audio('x', 'nowhere'), 5, null).gain).toBe(0);
  });
  it('pan multiplies clip and track per side', () => {
    const c = audio('a', tid, { pan: 0.5 });
    const tracks = p0.tracks.map((t) => (t.id === tid ? { ...t, pan: 0.5 } : t));
    const m = clipMix(proj([c], tracks), c, 5, null);
    expect(m.pan).toBe(true);
    expect(m.l).toBeCloseTo(Math.cos(Math.PI / 4) ** 2, 12);
    expect(m.r).toBe(1);
  });
});

describe('patchTrack', () => {
  const t = createTrack('audio', 'a');
  it('an equal patch is no change', () => {
    expect(patchTrack(t, {})).toBeNull();
    expect(patchTrack(t, { name: 'a', muted: false, volume: 1, pan: 0 })).toBeNull();
    expect(patchTrack(t, { volume: null, pan: null })).toBeNull();
  });
  it('1 and pan 0 take the field away', () => {
    const v = patchTrack(t, { volume: 0.5, pan: 0.5 })!;
    expect(v.volume).toBe(0.5);
    expect(v.pan).toBe(0.5);
    const back = patchTrack(v, { volume: 1, pan: 0 })!;
    expect('volume' in back).toBe(false);
    expect('pan' in back).toBe(false);
    const near = patchTrack(v, { volume: 1 + 1e-6, pan: 1e-6 })!;
    expect('volume' in near).toBe(false);
    expect('pan' in near).toBe(false);
  });
  it('clamps', () => {
    expect(patchTrack(t, { volume: 50 })!.volume).toBe(MAX_TRACK_GAIN);
    expect(patchTrack(t, { volume: -3 })!.volume).toBe(0);
    expect(patchTrack(t, { volume: 1e-7 })!.volume).toBe(0);
    expect(patchTrack(t, { pan: 4 })!.pan).toBe(1);
    expect(patchTrack(t, { pan: -4 })!.pan).toBe(-1);
  });
  it('NaN is ignored', () => {
    expect(patchTrack(t, { volume: Number.NaN, pan: Number.NaN })).toBeNull();
  });
  it('name and muted pass', () => {
    const n = patchTrack(t, { name: 'drums', muted: true, hidden: true, locked: true })!;
    expect(n.name).toBe('drums');
    expect(n.muted).toBe(true);
    expect(n.hidden).toBe(true);
    expect(n.locked).toBe(true);
    expect(t.name).toBe('a');
  });
});

describe('patchOutput', () => {
  it('the same level gives prev itself', () => {
    const prev = { volume: 0.5 };
    expect(patchOutput(prev, { volume: 0.5 })).toBe(prev);
  });
  it('0 db gives null, and undefined stays undefined', () => {
    expect(patchOutput({ volume: 0.5 }, { volume: 1 })).toBeNull();
    expect(patchOutput({ volume: 0.5 }, null)).toBeNull();
    expect(patchOutput(undefined, { volume: 1 })).toBeUndefined();
    expect(patchOutput(undefined, null)).toBeUndefined();
    expect(patchOutput(null, null)).toBeNull();
  });
  it('a new level is a new object, clamped', () => {
    expect(patchOutput(undefined, { volume: 0.25 })).toEqual({ volume: 0.25 });
    expect(patchOutput(null, { volume: 9 })).toEqual({ volume: MAX_TRACK_GAIN });
    expect(patchOutput({ volume: 0.5 }, { volume: 1e-7 })).toEqual({ volume: 0 });
  });
});

describe('planMixerReset and isMixFlat', () => {
  it('a flat project has nothing to reset', () => {
    const p = proj([]);
    expect(isMixFlat(p)).toBe(true);
    expect(isMixFlat({ ...p, output: null })).toBe(true);
    expect(planMixerReset(p)).toBeNull();
  });
  it('a volume, a pan or an output is not flat', () => {
    const p = proj([]);
    expect(isMixFlat({ ...p, output: { volume: 0.5 } })).toBe(false);
    expect(isMixFlat({ ...p, tracks: [{ ...p.tracks[0]!, volume: 0.5 }, p.tracks[1]!] })).toBe(false);
    expect(isMixFlat({ ...p, tracks: [{ ...p.tracks[0]!, pan: 0.5 }, p.tracks[1]!] })).toBe(false);
  });
  it('a reset takes every level away and keeps mute and names', () => {
    const p = proj([]);
    const dirty: Project = { ...p, output: { volume: 0.5 }, tracks: [{ ...p.tracks[0]!, volume: 0.5, pan: -0.3, muted: true, name: 'keep' }, p.tracks[1]!] };
    const r = planMixerReset(dirty)!;
    expect(isMixFlat(r)).toBe(true);
    expect(r.tracks[0]).toMatchObject({ muted: true, name: 'keep' });
    expect('volume' in r.tracks[0]!).toBe(false);
    expect('output' in r).toBe(false);
    expect(r.tracks[1]).toBe(p.tracks[1]);
  });
});

describe('mixer lists', () => {
  const p0 = proj([]);
  const [v1, a1] = p0.tracks as [Track, Track];
  const v2 = createTrack('video', 'video 2');
  const v3 = createTrack('video', 'video 3');
  const tracks = [v1, v2, v3, a1];
  it('mixerTracks hides a video track without sound unless it has a level', () => {
    const clips = [video('a', v1.id, 'vid'), video('b', v2.id, 'mute')];
    const p = proj(clips, tracks);
    expect(mixerTracks(p).map((t) => t.id)).toEqual([v1.id, a1.id]);
    const lev = proj(clips, [v1, { ...v2, volume: 0.5 }, { ...v3, pan: 0.1 }, a1]);
    expect(mixerTracks(lev).map((t) => t.id)).toEqual([v1.id, v2.id, v3.id, a1.id]);
  });
  it('soundTracksOf lists the tracks of clips with sound in project order', () => {
    const clips = [video('a', v1.id, 'vid'), video('b', v2.id, 'mute'), audio('c', a1.id)];
    const p = proj(clips, tracks);
    expect(soundTracksOf(p, ['c', 'b', 'a'])).toEqual([v1.id, a1.id]);
    expect(soundTracksOf(p, ['b'])).toEqual([]);
    expect(soundTracksOf(p, new Set(['c', 'c']))).toEqual([a1.id]);
  });
  it('a picture with its sound apart has no strip and solos its sound track', () => {
    const clips = [video('a', v1.id, 'vid', { group: 'g', muted: true }), audio('c', a1.id, { assetId: 'vid', group: 'g' })];
    const p = proj(clips, tracks);
    expect(mixerTracks(p).map((t) => t.id)).toEqual([a1.id]);
    // a stored fader still shows the track
    expect(mixerTracks(proj(clips, [{ ...v1, volume: 0.5 }, v2, v3, a1])).map((t) => t.id)).toEqual([v1.id, a1.id]);
    expect(soundTracksOf(p, ['a'])).toEqual([a1.id]);
    expect(soundTracksOf(p, ['a', 'c'])).toEqual([a1.id]);
  });
  it('toggledSolo adds, removes and solos one alone', () => {
    expect(toggledSolo([], 'a', false)).toEqual(['a']);
    expect(toggledSolo(['a'], 'b', false)).toEqual(['a', 'b']);
    expect(toggledSolo(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(toggledSolo(['a', 'b'], 'c', true)).toEqual(['c']);
    expect(toggledSolo(['c'], 'c', true)).toEqual([]);
    expect(toggledSolo(['c', 'd'], 'c', true)).toEqual(['c']);
  });
  it('trackSoundLine is the level, else the pan, else nothing', () => {
    expect(trackSoundLine(a1)).toBe('');
    expect(trackSoundLine({ ...a1, volume: dbToGain(-6) })).toBe('-6 db');
    expect(trackSoundLine({ ...a1, pan: -0.3 })).toBe('pan l30');
    expect(trackSoundLine({ ...a1, volume: 0.5, pan: 0.3 })).toBe('-6 db');
  });
});

describe('db and text', () => {
  it('round trips over -60 to 12 and 0 db is exactly 1', () => {
    for (let db = -60; db <= 12; db += 0.5) expect(gainToDb(dbToGain(db))).toBeCloseTo(db, 9);
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-90)).toBe(0);
    expect(dbToGain(-200)).toBe(0);
    expect(dbToGain(30)).toBe(MAX_TRACK_GAIN);
    expect(dbToGain(FADER_MAX_DB)).toBe(MAX_TRACK_GAIN);
    expect(gainToDb(0)).toBe(-Infinity);
  });
  it('formatDb never writes -0.0', () => {
    expect(formatDb(-Infinity)).toBe('-inf db');
    expect(formatDb(-90)).toBe('-inf db');
    expect(formatDb(3.5)).toBe('+3.5 db');
    expect(formatDb(0)).toBe('0.0 db');
    expect(formatDb(-0.04)).toBe('0.0 db');
    expect(formatDb(-6)).toBe('-6.0 db');
  });
  it('formatDbShort has no trailing zero', () => {
    expect(formatDbShort(-Infinity)).toBe('-inf');
    expect(formatDbShort(0)).toBe('0');
    expect(formatDbShort(-0.04)).toBe('0');
    expect(formatDbShort(-6)).toBe('-6');
    expect(formatDbShort(3.5)).toBe('+3.5');
    expect(formatDbShort(6)).toBe('+6');
  });
  it('formatPan', () => {
    expect(formatPan(0)).toBe('middle');
    expect(formatPan(0.004)).toBe('middle');
    expect(formatPan(-0.3)).toBe('l30');
    expect(formatPan(1)).toBe('r100');
  });
  it('parseDb reads levels, off and percents', () => {
    expect(parseDb('-6')).toBe(-6);
    expect(parseDb('-6 db')).toBe(-6);
    expect(parseDb('+3db')).toBe(3);
    expect(parseDb(' OFF ')).toBe(-Infinity);
    expect(parseDb('-inf')).toBe(-Infinity);
    expect(parseDb('inf')).toBe(-Infinity);
    expect(parseDb('-∞')).toBe(-Infinity);
    expect(parseDb('50%')).toBeCloseTo(gainToDb(0.5), 12);
    expect(parseDb('20')).toBe(12);
    expect(parseDb('x')).toBeNull();
    expect(parseDb('')).toBeNull();
    expect(parseDb('1e3')).toBeNull();
  });
});
