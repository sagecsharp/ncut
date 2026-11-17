import { describe, expect, it } from 'vitest';
import type { AudioClip, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { fallbackVolume, soundOnlyChange } from './mixRoute';

const video = (id: string, trackId: string): VideoClip => ({
  id, name: id, type: 'video', trackId, assetId: 'vid', start: 0, duration: 5, trimStart: 0, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transform: { ...DEFAULT_TRANSFORM },
});
const audio = (id: string, trackId: string): AudioClip => ({
  id, name: id, type: 'audio', trackId, assetId: 'snd', start: 0, duration: 5, trimStart: 0, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0,
});

function base(): Project {
  const p = createProject('route');
  return { ...p, clips: [video('v', p.tracks[0]!.id), audio('a', p.tracks[1]!.id)] };
}
const withTrack = (p: Project, i: number, patch: object): Project => ({ ...p, tracks: p.tracks.map((t, k) => (k === i ? { ...t, ...patch } : t)) });
const withClip = (p: Project, i: number, patch: object): Project => ({ ...p, clips: p.clips.map((c, k) => (k === i ? ({ ...c, ...patch } as typeof c) : c)) });

describe('soundOnlyChange', () => {
  it('is true for a track volume, pan or muted', () => {
    const p = base();
    expect(soundOnlyChange(p, withTrack(p, 1, { volume: 0.5 }))).toBe(true);
    expect(soundOnlyChange(p, withTrack(p, 1, { pan: 0.5 }))).toBe(true);
    expect(soundOnlyChange(p, withTrack(p, 0, { muted: true }))).toBe(true);
  });
  it('is true for the output', () => {
    const p = base();
    expect(soundOnlyChange(p, { ...p, output: { volume: 0.5 } })).toBe(true);
  });
  it('is true for a clip volume, pan or muted, video or audio', () => {
    const p = base();
    expect(soundOnlyChange(p, withClip(p, 0, { volume: 0.5 }))).toBe(true);
    expect(soundOnlyChange(p, withClip(p, 0, { pan: 0.5 }))).toBe(true);
    expect(soundOnlyChange(p, withClip(p, 1, { muted: true }))).toBe(true);
    expect(soundOnlyChange(p, withClip(p, 1, { volume: 0.2, pan: -1 }))).toBe(true);
  });
  it('is false for a clip x', () => {
    const p = base();
    const moved = withClip(p, 0, { transform: { ...DEFAULT_TRANSFORM, x: 40 } });
    expect(soundOnlyChange(p, moved)).toBe(false);
    expect(soundOnlyChange(p, withClip(p, 1, { start: 1 }))).toBe(false);
  });
  it('is false for a keyframe', () => {
    const p = base();
    expect(soundOnlyChange(p, withClip(p, 1, { keyframes: { volume: [{ t: 0, v: 1, ease: 'linear' }] } }))).toBe(false);
    expect(soundOnlyChange(p, withClip(p, 0, { volume: 0.5, keyframes: { pan: [{ t: 0, v: 0, ease: 'linear' }] } }))).toBe(false);
  });
  it('is false for an added clip', () => {
    const p = base();
    expect(soundOnlyChange(p, { ...p, clips: [...p.clips, audio('b', p.tracks[1]!.id)] })).toBe(false);
  });
  it('is false for a reordered, renamed or hidden track', () => {
    const p = base();
    expect(soundOnlyChange(p, { ...p, tracks: [p.tracks[1]!, p.tracks[0]!] })).toBe(false);
    expect(soundOnlyChange(p, withTrack(p, 0, { name: 'other' }))).toBe(false);
    expect(soundOnlyChange(p, withTrack(p, 0, { hidden: true }))).toBe(false);
    expect(soundOnlyChange(p, withTrack(p, 0, { hidden: true, volume: 0.5 }))).toBe(false);
  });
  it('is false for a reordered clip list', () => {
    const p = base();
    expect(soundOnlyChange(p, { ...p, clips: [p.clips[1]!, p.clips[0]!] })).toBe(false);
  });
  it('is false for fog and for identical projects', () => {
    const p = base();
    expect(soundOnlyChange(p, { ...p, fog: null })).toBe(false);
    expect(soundOnlyChange(p, p)).toBe(false);
    expect(soundOnlyChange(p, { ...p })).toBe(false);
  });
});

describe('fallbackVolume', () => {
  it('multiplies the clip gain, the output and the preview volume, clamped to 0..1', () => {
    expect(fallbackVolume(0.5, 0.5, 0.5, false)).toBe(0.125);
    expect(fallbackVolume(3, 1, 1, false)).toBe(1);
    expect(fallbackVolume(-1, 1, 1, false)).toBe(0);
  });
  it('a muted preview is 0', () => {
    expect(fallbackVolume(1, 1, 1, true)).toBe(0);
  });
});
