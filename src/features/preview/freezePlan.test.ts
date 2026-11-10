import { describe, expect, it } from 'vitest';
import type { Clip, Project, VideoClip } from '../../types';
import { freezeFileName, freezeSourceTime, pickFreezeTarget, planFreeze, shiftMoves, stillClipFrom } from './freezePlan';

const video = (id: string, trackId: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id,
  type: 'video',
  trackId,
  start,
  duration,
  name: id,
  fadeIn: 0,
  fadeOut: 0,
  assetId: 'a',
  trimStart: 0,
  speed: 1,
  volume: 1,
  muted: false,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  ...over,
});

const project = (clips: Clip[], hiddenTrack?: string): Project =>
  ({
    tracks: [
      { id: 't1', kind: 'video', name: 'v1', locked: false, hidden: hiddenTrack === 't1' },
      { id: 't2', kind: 'video', name: 'v2', locked: false, hidden: false },
    ],
    clips,
    assets: [],
  }) as unknown as Project;

describe('pickFreezeTarget', () => {
  const a = video('a', 't1', 0, 10);
  const b = video('b', 't2', 0, 10);
  it('takes the selected video clip when it is under the playhead', () => {
    expect(pickFreezeTarget(project([a, b]), ['b'], 5)?.id).toBe('b');
  });
  it('takes the topmost clip otherwise', () => {
    expect(pickFreezeTarget(project([a, b]), [], 5)?.id).toBe('a');
    expect(pickFreezeTarget(project([a, b]), ['a', 'b'], 5)?.id).toBe('a');
  });
  it('ignores a selected clip the playhead is not in', () => {
    const c = video('c', 't2', 20, 5);
    expect(pickFreezeTarget(project([a, c]), ['c'], 5)?.id).toBe('a');
  });
  it('skips hidden tracks and returns null for nothing', () => {
    expect(pickFreezeTarget(project([a, b], 't1'), [], 5)?.id).toBe('b');
    expect(pickFreezeTarget(project([a, b]), [], 50)).toBeNull();
  });
  it('the end of a clip is outside it', () => {
    expect(pickFreezeTarget(project([a]), [], 10)).toBeNull();
  });
});

describe('planFreeze', () => {
  const clip = { start: 2, duration: 4 };
  it('splits in the middle', () => {
    expect(planFreeze(clip, 3, 30)).toEqual({ split: true, stillStart: 3, shiftFrom: 3 });
  });
  it('does not split within one frame of the start', () => {
    expect(planFreeze(clip, 2, 30)).toEqual({ split: false, stillStart: 2, shiftFrom: 2 });
    expect(planFreeze(clip, 2.02, 30)).toEqual({ split: false, stillStart: 2, shiftFrom: 2 });
  });
  it('does not split within one frame of the end', () => {
    expect(planFreeze(clip, 5.99, 30)).toEqual({ split: false, stillStart: 6, shiftFrom: 6 });
  });
  it('splits exactly one frame in', () => {
    expect(planFreeze(clip, 2 + 1 / 30, 30).split).toBe(true);
  });
});

describe('shiftMoves', () => {
  const clips = [video('a', 't1', 0, 2), video('b', 't1', 2, 2), video('c', 't1', 5, 1), video('d', 't2', 3, 1)];
  it('moves every clip of the track from the point on, nothing else', () => {
    expect(shiftMoves(clips, 't1', 2, 2)).toEqual([
      { id: 'b', trackId: 't1', start: 4 },
      { id: 'c', trackId: 't1', start: 7 },
    ]);
  });
  it('is empty when nothing follows', () => {
    expect(shiftMoves(clips, 't1', 6, 2)).toEqual([]);
  });
});

describe('freezeSourceTime', () => {
  it('maps the playhead through trim and speed', () => {
    const c = video('a', 't1', 10, 4, { trimStart: 3, speed: 2 });
    expect(freezeSourceTime(c, 11, 30)).toBeCloseTo(5);
  });
  it('stays inside the picture at the very end', () => {
    const c = video('a', 't1', 0, 4);
    expect(freezeSourceTime(c, 4, 30)).toBeLessThan(4);
    expect(freezeSourceTime(c, 4, 30, 3)).toBeLessThan(3);
    expect(freezeSourceTime(c, -1, 30)).toBe(0);
  });
});

describe('freezeFileName', () => {
  it('has the clip name, frame and a safe timecode', () => {
    const n = freezeFileName('my: clip?', 61.5, 30);
    expect(n).toBe('my clip frame 01-01-15.png');
    expect(n).not.toMatch(/[:?]/);
  });
  it('falls back for an empty name', () => {
    expect(freezeFileName('///', 0, 30)).toBe('clip frame 00-00-00.png');
  });
});

describe('stillClipFrom', () => {
  it('copies the look but no keyframes, transition or motion', () => {
    const v = video('a', 't1', 0, 4, {
      threeD: true,
      lookAt: 'camera',
      shape: 'box',
      crop: { left: 0.1, top: 0, right: 0, bottom: 0 },
      radius: 0.3,
      blend: 'multiply',
      parent: 'p',
      keyframes: { x: [{ t: 0, v: 1, ease: 'linear' }] } as never,
      transition: { id: 'fade', duration: 1 } as never,
      motionIn: { id: 'pop', duration: 1 } as never,
      group: 'g',
    });
    const s = stillClipFrom(v, { x: 5, y: 6, scale: 2, rotation: 0, opacity: 1 }, 'img', 3, 2);
    expect(s).toMatchObject({ type: 'image', trackId: 't1', start: 3, duration: 2, assetId: 'img', threeD: true, lookAt: 'camera', shape: 'box', radius: 0.3, blend: 'multiply', parent: 'p' });
    expect(s.transform).toEqual({ x: 5, y: 6, scale: 2, rotation: 0, opacity: 1 });
    expect(s.crop).toEqual({ left: 0.1, top: 0, right: 0, bottom: 0 });
    expect(s.keyframes).toBeUndefined();
    expect(s.transition).toBeUndefined();
    expect(s.motionIn).toBeUndefined();
    expect(s.group).toBeUndefined();
  });
});
