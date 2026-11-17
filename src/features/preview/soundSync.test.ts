import { describe, expect, it } from 'vitest';
import type { AudioClip, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import type { ClipSound } from '../../lib/audioCross';
import { needsTwin, soundActive, soundInWindow, twinKey } from './soundSync';

const video = (over: Partial<VideoClip> = {}): VideoClip => ({
  id: 'v', type: 'video', trackId: 'v1', start: 10, duration: 4, name: 'v', fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (over: Partial<AudioClip> = {}): AudioClip => ({
  id: 'x', type: 'audio', trackId: 'a1', start: 10, duration: 4, name: 'x', fadeIn: 0, fadeOut: 0, assetId: 'song', trimStart: 0, speed: 1, volume: 1, muted: false, ...over,
});
const snd = (head: number, tail: number): ClipSound => ({ head, tail, xin: null, xout: null, inShape: 'linear', outShape: 'linear' });

describe('soundSync', () => {
  it('twinKey adds ~sound', () => {
    expect(twinKey('clp_1')).toBe('clp_1~sound');
    expect(twinKey('a')).not.toBe('a');
  });

  it('needsTwin wants a video with a head or tail, muted too', () => {
    expect(needsTwin(video(), snd(0.25, 0))).toBe(true);
    expect(needsTwin(video(), snd(0, 0.25))).toBe(true);
    expect(needsTwin(video({ muted: true }), snd(0.25, 0.25))).toBe(true);
    // no handles: the video's own element plays it
    expect(needsTwin(video(), snd(0, 0))).toBe(false);
    // an audio clip's element plays the widened span itself
    expect(needsTwin(audio(), snd(0.25, 0.25))).toBe(false);
  });

  it('soundActive with no sound is the old range', () => {
    const c = video();
    for (const t of [9.999, 10, 12, 13.999, 14, 15]) expect(soundActive(c, null, t)).toBe(t >= 10 && t < 14);
    // a sound without handles is the same range
    for (const t of [9.999, 10, 12, 13.999, 14, 15]) expect(soundActive(c, snd(0, 0), t)).toBe(t >= 10 && t < 14);
  });

  it('soundActive widens by head and tail', () => {
    const c = audio();
    const s = snd(0.5, 0.25);
    expect(soundActive(c, s, 9.49)).toBe(false);
    expect(soundActive(c, s, 9.5)).toBe(true);
    expect(soundActive(c, s, 10)).toBe(true);
    expect(soundActive(c, s, 14.2)).toBe(true);
    expect(soundActive(c, s, 14.25)).toBe(false);
  });

  it('soundInWindow adds before and after', () => {
    const c = video();
    const s = snd(0.5, 0.25);
    // the window is [start - head - before, end + tail + after)
    expect(soundInWindow(c, s, 8, 1, 1)).toBe(false);
    expect(soundInWindow(c, s, 8.5, 1, 1)).toBe(true);
    expect(soundInWindow(c, s, 12, 1, 1)).toBe(true);
    expect(soundInWindow(c, s, 15.24, 1, 1)).toBe(true);
    expect(soundInWindow(c, s, 15.25, 1, 1)).toBe(false);
    expect(soundInWindow(c, s, 9.4, 0, 0)).toBe(false);
    expect(soundInWindow(c, s, 9.5, 0, 0)).toBe(true);
  });
});
