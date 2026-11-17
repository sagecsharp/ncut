import { describe, expect, it } from 'vitest';
import type { AudioClip, CameraClip, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { animProps, baseValue, resolveClip, withBaseValue } from './anim';

const video = (over: Partial<VideoClip> = {}): VideoClip => ({
  id: 'v', name: 'v', type: 'video', trackId: 't', assetId: 'a', start: 2, duration: 10, trimStart: 0, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (over: Partial<AudioClip> = {}): AudioClip => ({
  id: 'a', name: 'a', type: 'audio', trackId: 't', assetId: 'a', start: 2, duration: 10, trimStart: 0, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, ...over,
});
const camera = (over: Partial<CameraClip> = {}): CameraClip => ({
  id: 'c', name: 'c', type: 'camera', trackId: 't', start: 0, duration: 5, fadeIn: 0, fadeOut: 0, x: 0, y: 0, z: 5, pan: 12, tilt: 0, roll: 0, fov: 60, ...over,
}) as CameraClip;
const keys = { pan: [{ t: 0, v: -1, ease: 'linear' as const }, { t: 10, v: 1, ease: 'linear' as const }] };

describe('pan in anim', () => {
  it('pan is in animProps once for video and audio', () => {
    for (const c of [video(), audio()]) {
      const list = animProps(c).filter((x) => x.prop === 'pan');
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ min: -1, max: 1 });
    }
  });

  it('baseValue reads the stored pan, 0 when missing', () => {
    expect(baseValue(video(), 'pan')).toBe(0);
    expect(baseValue(video({ pan: 0.4 }), 'pan')).toBe(0.4);
    expect(baseValue(audio(), 'pan')).toBe(0);
    expect(baseValue(audio({ pan: -0.4 }), 'pan')).toBe(-0.4);
  });

  it('withBaseValue writes pan, 0 included', () => {
    expect(withBaseValue(video(), 'pan', 0.3).pan).toBe(0.3);
    expect(withBaseValue(audio(), 'pan', -0.3).pan).toBe(-0.3);
    expect(withBaseValue(audio(), 'pan', 0).pan).toBe(0);
  });

  it('resolveClip evaluates pan keys at the clip-local time', () => {
    expect(resolveClip(video({ keyframes: keys }), 7).pan).toBeCloseTo(0, 12);
    expect(resolveClip(audio({ keyframes: keys }), 2).pan).toBe(-1);
    expect(resolveClip(audio({ keyframes: keys }), 12).pan).toBe(1);
    expect(resolveClip(audio({ pan: 0.5, keyframes: { volume: [{ t: 0, v: 1, ease: 'linear' }] } }), 5).pan).toBe(0.5);
  });

  it('resolveClip equals withBaseValue of the evaluated value', () => {
    const c = audio({ keyframes: keys });
    expect(resolveClip(c, 4).pan).toEqual(withBaseValue(c, 'pan', resolveClip(c, 4).pan!).pan);
  });

  it('the camera pan is untouched', () => {
    const cam = camera();
    expect(animProps(cam).find((x) => x.prop === 'pan')).toMatchObject({ unit: 'deg' });
    expect(baseValue(cam, 'pan')).toBe(12);
    expect(withBaseValue(cam, 'pan', 30).pan).toBe(30);
    const keyed = camera({ keyframes: { pan: [{ t: 0, v: 0, ease: 'linear' }, { t: 5, v: 90, ease: 'linear' }] } });
    expect(resolveClip(keyed, 2.5).pan).toBeCloseTo(45, 9);
  });
});
