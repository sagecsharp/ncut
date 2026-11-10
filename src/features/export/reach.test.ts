import { describe, expect, it } from 'vitest';
import type { AudioClip, EffectClip, ImageClip, Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { clipsInReach, neededForFrame } from './reach';

let seq = 0;
function video(trackId: string, start: number, duration: number): VideoClip {
  return {
    id: `v${++seq}`, type: 'video', trackId, start, duration, name: 'v', fadeIn: 0, fadeOut: 0,
    assetId: 'vid', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM },
  };
}
function image(trackId: string, start: number, duration: number): ImageClip {
  return {
    id: `i${++seq}`, type: 'image', trackId, start, duration, name: 'i', fadeIn: 0, fadeOut: 0,
    assetId: 'img', transform: { ...DEFAULT_TRANSFORM },
  };
}
function audio(trackId: string, start: number, duration: number): AudioClip {
  return {
    id: `a${++seq}`, type: 'audio', trackId, start, duration, name: 'a', fadeIn: 0, fadeOut: 0,
    assetId: 'aud', trimStart: 0, speed: 1, volume: 1, muted: false,
  };
}
function effect(trackId: string, start: number, duration: number, id: string): EffectClip {
  return {
    id: `e${++seq}`, type: 'effect', trackId, start, duration, name: 'fx', fadeIn: 0, fadeOut: 0,
    effect: id, amount: 1, params: {}, seed: 7,
  };
}
function track(id: string, kind: 'video' | 'audio', hidden = false): Track {
  return { id, kind, name: id, muted: false, hidden, locked: false };
}
function project(clips: Project['clips'], tracks: Track[]): Project {
  return { id: 'p', name: 'p', createdAt: 0, updatedAt: 0, width: 1920, height: 1080, fps: 30, background: '#000', assets: [], tracks, clips };
}

describe('clipsInReach', () => {
  const tracks = [track('a', 'video'), track('b', 'video'), track('h', 'video', true), track('au', 'audio')];
  it('is empty when there is no reach', () => {
    expect(clipsInReach(project([video('a', 0, 5)], tracks), 2, null)).toEqual([]);
  });
  it('finds a short clip that sits only between the echo copies', () => {
    // echo reaching 5.5 s back from t = 6: the 1 s clip at 2..3 is in none of the copies at 6, 3, 0.5 ...
    const blip = video('b', 2, 1);
    const far = video('a', 20, 1);
    const p = project([blip, far], tracks);
    const got = clipsInReach(p, 6, { back: 5.5, ahead: 0 });
    expect(got).toEqual([blip]);
  });
  it('includes clips that touch the ends and skips ones that end at the start of the interval', () => {
    const endsAtLo = video('a', 0, 1);
    const startsAtHi = video('a', 3, 1);
    const inside = image('b', 1.5, 0.2);
    const p = project([endsAtLo, startsAtHi, inside], tracks);
    const got = clipsInReach(p, 2, { back: 1, ahead: 1 });
    expect(got).toContain(startsAtHi);
    expect(got).toContain(inside);
    expect(got).not.toContain(endsAtLo);
  });
  it('looks ahead too', () => {
    const next = video('a', 4, 2);
    expect(clipsInReach(project([next], tracks), 3, { back: 0, ahead: 1.5 })).toEqual([next]);
    expect(clipsInReach(project([next], tracks), 3, { back: 0, ahead: 0.5 })).toEqual([]);
  });
  it('ignores hidden tracks, audio tracks and audio clips', () => {
    const hid = video('h', 0, 5);
    const aud = audio('a', 0, 5);
    const onAudioTrack = video('au', 0, 5);
    expect(clipsInReach(project([hid, aud, onAudioTrack], tracks), 2, { back: 3, ahead: 3 })).toEqual([]);
  });
});

describe('neededForFrame', () => {
  const tracks = [track('fx', 'video'), track('a', 'video')];
  it('echo keeps the clips that show only in the copies', async () => {
    const { EFFECTS } = await import('../../engine/effects/registry');
    expect(EFFECTS.some((e) => e.id === 'echo')).toBe(true);
    // 12 copies, 0.5 s apart: the copies sit at 8, 7.5 ... 2.5. the blip (5.1 to 5.4) is in none of them
    const blip = video('a', 5.1, 0.3);
    const main = video('a', 7, 10);
    const fx = { ...effect('fx', 7, 10, 'echo'), params: { count: 12, spacing: 0.5, decay: 100 } };
    const p = project([blip, main, fx], tracks);
    const needed = neededForFrame(p, 8);
    expect(needed).toContain(main);
    expect(needed).toContain(blip);
  });
  it('without a temporal effect it is just what is on screen', () => {
    const a = video('a', 0, 5);
    const b = video('a', 5, 5);
    expect(neededForFrame(project([a, b], tracks), 1)).toEqual([a]);
  });
});
