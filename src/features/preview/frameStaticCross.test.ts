import { describe, expect, it } from 'vitest';
import type { Clip, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { frameInfo, isStaticAt } from './frameStatic';

const video = (id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId: 't1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'a', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const project = (clips: Clip[]): Project => ({
  id: 'p', name: 'p', createdAt: 0, updatedAt: 0, width: 1920, height: 1080, fps: 30, background: '#000', assets: [],
  tracks: [{ id: 't1', kind: 'video', name: 'v', muted: false, hidden: false, locked: false }],
  clips,
});

describe('frameStatic and the sound fields', () => {
  it('a crossfaded video is static', () => {
    const a = video('a', 0, 4);
    const b = video('b', 4, 4, { crossfade: { before: 0.25, after: 0.25, shape: 'smooth' } });
    const p = project([a, b]);
    expect(isStaticAt(p, b, 6)).toBe(true);
    // the sound crossfade does not touch the picture, even inside its span
    expect(isStaticAt(p, b, 4.1)).toBe(true);
    expect(isStaticAt(p, a, 3.9)).toBe(true);
    expect(frameInfo(p, 6).allStatic).toBe(true);
  });

  it('fade shapes keep a video static outside its fades', () => {
    const c = video('v', 0, 10, { fadeIn: 1, fadeOut: 1, fadeInShape: 'power', fadeOutShape: 'smooth' });
    const p = project([c]);
    expect(isStaticAt(p, c, 5)).toBe(true);
    expect(frameInfo(p, 5).allStatic).toBe(true);
    // a video clip with only a shape and no fade is static anywhere
    const d = video('d', 0, 10, { fadeInShape: 'smooth' });
    expect(isStaticAt(project([d]), d, 0.2)).toBe(true);
  });

  it('a picture fade with a shape still moves', () => {
    const c = video('v', 0, 10, { fadeIn: 1, fadeOut: 1, fadeInShape: 'power', fadeOutShape: 'smooth' });
    const p = project([c]);
    // the picture fades straight: inside a fade the frame changes
    expect(isStaticAt(p, c, 0.5)).toBe(false);
    expect(isStaticAt(p, c, 9.5)).toBe(false);
    expect(frameInfo(p, 0.5).allStatic).toBe(false);
  });
});
