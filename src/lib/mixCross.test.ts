import { describe, expect, it } from 'vitest';
import type { AudioClip, Clip, Keyframe, MediaAsset, Project, Track, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from './factory';
import { valueAt } from './anim';
import { fadeFactor } from './timelineOps';
import { soundGainAt, soundIndex } from './audioCross';
import { clipMix, clipPanAt, panGains, trackPan, trackVolume } from './mix';

const track = (id: string, kind: 'video' | 'audio', over: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, ...over });
const asset = (id: string, kind: MediaAsset['kind'], hasAudio: boolean, duration = 60): MediaAsset => ({ id, name: id, kind, mime: '', size: 1, duration, width: 100, height: 100, hasAudio, createdAt: 0 });
const video = (id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId: 'v1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 5, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const lin = (...pairs: [number, number][]): Keyframe[] => pairs.map(([t, v]) => ({ t, v, ease: 'linear' as const }));

function proj(clips: Clip[], v1: Partial<Track> = {}): Project {
  return {
    ...createProject('mix'),
    assets: [asset('av', 'video', true)],
    tracks: [track('v1', 'video', v1), track('v2', 'video')],
    clips,
  };
}
const at = (p: Project, id: string): VideoClip | AudioClip => p.clips.find((c) => c.id === id) as VideoClip | AudioClip;

describe('clipMix and the sound rule', () => {
  it('clipMix without a sound keeps the old numbers', () => {
    const p = proj(
      [
        video('a', 0, 4, { volume: 1.2, fadeIn: 0.5, fadeOut: 0.7, pan: 0.4, keyframes: { volume: lin([0, 1], [1, 1.6], [3, 0.3]), pan: lin([0, -0.5], [2, 0.8]) } }),
        video('b', 4, 4, { volume: 0.6, fadeIn: 1 }),
      ],
      { volume: 0.5, pan: -0.3 },
    );
    const tr = p.tracks[0]!;
    for (const c of [at(p, 'a'), at(p, 'b')]) {
      for (let i = 0; i <= 200; i++) {
        const t = c.start - 0.5 + (c.duration + 1) * (i / 200);
        for (const sound of [undefined, null]) {
          const m = sound === undefined ? clipMix(p, c, t, null) : clipMix(p, c, t, null, sound);
          const gain = Math.max(0, valueAt(c, 'volume', t) ?? c.volume) * fadeFactor(c, t) * trackVolume(tr);
          expect(Object.is(m.gain, gain), `${c.id} at ${t}`).toBe(true);
          const [cl, cr] = panGains(clipPanAt(c, t));
          const [tl, trr] = panGains(trackPan(tr));
          expect(Object.is(m.l, cl * tl)).toBe(true);
          expect(Object.is(m.r, cr * trr)).toBe(true);
          expect(m.pan).toBe(true);
        }
      }
    }
    // a clip with no pan at all is the plain [1, 1]
    const q = proj([video('a', 0, 4)]);
    expect(clipMix(q, at(q, 'a'), 1, null)).toEqual({ gain: 1, l: 1, r: 1, pan: false });
  });

  it('clipMix with a sound is soundGainAt times the fader', () => {
    const p = proj(
      [
        video('a', 0, 4, { volume: 0.9, fadeOut: 0.5, keyframes: { volume: lin([0, 1], [2, 0.5]) } }),
        video('b', 4, 4, { volume: 1.1, fadeIn: 0.5, fadeInShape: 'smooth', crossfade: { before: 0.5, after: 0.5 } }),
      ],
      { volume: 0.7 },
    );
    const sounds = soundIndex(p);
    expect(sounds.size).toBe(2);
    const tr = p.tracks[0]!;
    for (const id of ['a', 'b']) {
      const c = at(p, id);
      const s = sounds.get(id)!;
      for (let i = 0; i <= 400; i++) {
        const t = c.start - 0.7 + (c.duration + 1.4) * (i / 400);
        const m = clipMix(p, c, t, null, s);
        expect(Object.is(m.gain, soundGainAt(c, s, t) * trackVolume(tr)), `${id} at ${t}`).toBe(true);
      }
    }
    // the handles play: a sounds after its end, b before its start
    expect(clipMix(p, at(p, 'a'), 4.3, null, sounds.get('a')!).gain).toBeGreaterThan(0);
    expect(clipMix(p, at(p, 'b'), 3.8, null, sounds.get('b')!).gain).toBeGreaterThan(0);
    // and without the entry they do not fade: the old rule runs on, a hard edge
    expect(clipMix(p, at(p, 'b'), 3.8, null).gain).toBe(0);
  });

  it('pan holds its edge value in the handles', () => {
    const p = proj([
      video('a', 0, 4, { keyframes: { pan: lin([0, -0.2], [4, 0.9]) } }),
      video('b', 4, 4, { crossfade: { before: 0.5, after: 0.5 }, keyframes: { pan: lin([0, -0.5], [2, 0.8]) } }),
    ]);
    const sounds = soundIndex(p);
    const b = at(p, 'b'), a = at(p, 'a');
    const first = panGains(-0.5);
    const early = clipMix(p, b, 3.8, null, sounds.get('b')!);
    expect(early.pan).toBe(true);
    expect(early.l).toBe(first[0]);
    expect(early.r).toBe(first[1]);
    const last = panGains(0.9);
    const late = clipMix(p, a, 4.3, null, sounds.get('a')!);
    expect(late.l).toBe(last[0]);
    expect(late.r).toBe(last[1]);
    // inside the clip the key still runs
    const mid = clipMix(p, b, 5, null, sounds.get('b')!);
    expect(mid.l).toBe(panGains(0.15)[0]);
  });

  it('mute, a muted track and solo still give 0', () => {
    const clips = [
      video('a', 0, 4, { muted: true }),
      video('b', 4, 4, { crossfade: { before: 0.5, after: 0.5 } }),
    ];
    const p = proj(clips);
    const sounds = soundIndex(p);
    const sa = sounds.get('a')!, sb = sounds.get('b')!;
    // a muted clip is 0 in its own range and in its handle, the other side still fades
    expect(clipMix(p, at(p, 'a'), 2, null, sa).gain).toBe(0);
    expect(clipMix(p, at(p, 'a'), 4.2, null, sa).gain).toBe(0);
    expect(clipMix(p, at(p, 'b'), 3.8, null, sb).gain).toBeGreaterThan(0);
    // a muted track
    const q = { ...p, tracks: p.tracks.map((t) => (t.id === 'v1' ? { ...t, muted: true } : t)) };
    expect(clipMix(q, at(q, 'b'), 5, null, soundIndex(q).get('b')!).gain).toBe(0);
    // solo on another track
    expect(clipMix(p, at(p, 'b'), 5, new Set(['v2']), sb).gain).toBe(0);
    expect(clipMix(p, at(p, 'b'), 5, new Set(['v1']), sb).gain).toBe(1);
  });
});
