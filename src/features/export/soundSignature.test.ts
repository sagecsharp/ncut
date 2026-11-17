import { describe, expect, it } from 'vitest';
import type { AudioClip, Clip, MediaAsset, Project, VideoClip } from '../../types';
import { createProject } from '../../lib/factory';
import { soundSignature } from './soundSignature';

const asset = (id: string, kind: 'video' | 'audio' | 'image'): MediaAsset => ({
  id, name: id, kind, mime: kind === 'audio' ? 'audio/wav' : 'video/mp4', size: 1000, duration: 30, width: 0, height: 0, hasAudio: kind !== 'image', createdAt: 0,
});

const video: VideoClip = {
  id: 'v', name: 'v', type: 'video', trackId: 'a', assetId: 'vid', start: 0, duration: 10, trimStart: 0, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
};
const audio: AudioClip = { id: 'a', name: 'a', type: 'audio', trackId: 'b', assetId: 'snd', start: 2, duration: 8, trimStart: 1, speed: 1, volume: 0.8, muted: false, fadeIn: 0, fadeOut: 0 };

function base(): Project {
  const p = createProject('sig');
  return {
    ...p,
    tracks: [{ ...p.tracks[0]!, id: 'a' }, { ...p.tracks[1]!, id: 'b' }],
    assets: [asset('vid', 'video'), asset('snd', 'audio'), asset('img', 'image')],
    clips: [{ ...video }, { ...audio }],
  };
}

const range = { start: 0, end: 10 };
const sig = (p: Project, r = range, rate = 48000, present: (id: string) => boolean = () => true): string => soundSignature(p, r, rate, present);

/** a project with a patch on one clip */
function withClip(p: Project, id: string, patch: Record<string, unknown>): Project {
  return { ...p, clips: p.clips.map((c) => (c.id === id ? ({ ...c, ...patch } as Clip) : c)) };
}
function withTrack(p: Project, id: string, patch: Record<string, unknown>): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

describe('soundSignature', () => {
  it('picture fields and names change nothing', () => {
    const p = base();
    const s = sig(p);
    expect(sig(JSON.parse(JSON.stringify(p)))).toBe(s);
    const same: Project[] = [
      withClip(p, 'v', { name: 'other', transform: { x: 5, y: 3, scale: 2, rotation: 10, opacity: 0.5 }, crop: { left: 0.1, top: 0, right: 0, bottom: 0 }, radius: 0.5, blend: 'multiply', grade: { exposure: 1 }, threeD: true, group: 'g' }),
      withClip(p, 'a', { name: 'other', group: 'g' }),
      withTrack(p, 'a', { name: 'renamed', hidden: true, locked: true, height: 120, syncLock: false }),
      { ...p, name: 'renamed project', width: 100 },
    ];
    for (const q of same) expect(sig(q)).toBe(s);
  });

  it('an image clip changes nothing', () => {
    const p = base();
    const img: Clip = { id: 'i', name: 'i', type: 'image', trackId: 'a', assetId: 'img', start: 0, duration: 5, fadeIn: 0, fadeOut: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 } };
    const q = { ...p, clips: [...p.clips, img] };
    expect(sig(q)).toBe(sig(p));
    expect(sig(withClip(q, 'i', { start: 3, duration: 1, fadeIn: 0.5 }))).toBe(sig(p));
  });

  it('every sound field changes it', () => {
    const p = base();
    const s = sig(p);
    const diff: Array<[string, string]> = [
      ['volume', sig(withClip(p, 'a', { volume: 0.5 }))],
      ['pan', sig(withClip(p, 'a', { pan: 0.5 }))],
      ['fadeIn', sig(withClip(p, 'a', { fadeIn: 1 }))],
      ['fadeOut', sig(withClip(p, 'v', { fadeOut: 1 }))],
      ['trimStart', sig(withClip(p, 'a', { trimStart: 2 }))],
      ['speed', sig(withClip(p, 'a', { speed: 2 }))],
      ['start', sig(withClip(p, 'a', { start: 3 }))],
      ['duration', sig(withClip(p, 'v', { duration: 9 }))],
      ['muted', sig(withClip(p, 'v', { muted: true }))],
      ['track volume', sig(withTrack(p, 'b', { volume: 0.5 }))],
      ['track muted', sig(withTrack(p, 'b', { muted: true }))],
      ['output volume', sig({ ...p, output: { volume: 0.5 } })],
      ['media size', sig({ ...p, assets: p.assets.map((a) => (a.id === 'snd' ? { ...a, size: 2000 } : a)) })],
      ['present', sig(p, range, 48000, (id) => id !== 'snd')],
      ['range start', sig(p, { start: 1, end: 10 })],
      ['range end', sig(p, { start: 0, end: 9 })],
      ['rate', sig(p, range, 44100)],
      ['volume key', sig(withClip(p, 'a', { keyframes: { volume: [{ t: 0, v: 1, ease: 'linear' }] } }))],
      ['transition', sig(withClip(p, 'v', { transition: { id: 'fade', duration: 1 } }))],
      ['unknown key', sig(withClip(p, 'a', { someNewSoundField: 1 }))],
      ['crossfade', sig(withClip(p, 'v', { crossfade: { before: 0.5, after: 0.5 } }))],
    ];
    for (const [name, v] of diff) expect(v, name).not.toBe(s);
    expect(new Set(diff.map((d) => d[1])).size).toBe(diff.length);
  });

  it('a matte changes it', () => {
    const p = base();
    expect(sig(withClip(p, 'v', { matte: { clip: 'x', mode: 'alpha' } }))).not.toBe(sig(p));
  });
});
