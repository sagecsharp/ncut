import { describe, expect, it } from 'vitest';
import type { Clip, EffectClip, VideoClip } from '../../types';
import { freezeEffectCopies, freezeHandover, planFreeze, stillClipFrom } from './freezePlan';

const video = (over: Partial<VideoClip> = {}): VideoClip => ({
  id: 'v',
  type: 'video',
  trackId: 't1',
  start: 10,
  duration: 10,
  name: 'v',
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

const fx = (over: Partial<EffectClip> = {}): EffectClip => ({
  id: 'e',
  type: 'effect',
  trackId: 't2',
  start: 10,
  duration: 10,
  name: 'blur',
  fadeIn: 0,
  fadeOut: 0,
  effect: 'blur',
  amount: 1,
  params: { radius: 4 },
  seed: 1,
  target: 'v',
  ...over,
});

describe('stillClipFrom copies the look', () => {
  it('copies mask, lookAt + lookTarget and the other visual fields', () => {
    const mask = { shape: 'ellipse' as const, x: 0, y: 0, width: 0.5, height: 0.5, rotation: 0, feather: 0.1, invert: false };
    const v = video({
      mask,
      lookAt: 'clip',
      lookTarget: 'other',
      threeD: true,
      shape: 'box',
      shapeDepth: 30,
      radius: 0.2,
      crop: { left: 0.1, top: 0, right: 0, bottom: 0 },
      blend: 'screen',
      parent: 'p',
      group: 'g',
      motionLoop: { id: 'float', duration: 2 },
      keyframes: { x: [{ t: 0, v: 1, ease: 'linear' }] },
    });
    const s = stillClipFrom(v, { ...v.transform, z: 5 }, 'img', 12, 2);
    expect(s.mask).toEqual(mask);
    expect(s.mask).not.toBe(mask);
    expect(s.lookAt).toBe('clip');
    expect(s.lookTarget).toBe('other');
    expect(s.threeD).toBe(true);
    expect(s.shape).toBe('box');
    expect(s.shapeDepth).toBe(30);
    expect(s.radius).toBe(0.2);
    expect(s.crop).toEqual({ left: 0.1, top: 0, right: 0, bottom: 0 });
    expect(s.blend).toBe('screen');
    expect(s.parent).toBe('p');
    expect(s.transform.z).toBe(5);
    expect(s.group).toBeUndefined();
    expect(s.motionLoop).toBeUndefined();
    expect(s.keyframes).toBeUndefined();
  });
  it('adds nothing for a plain clip', () => {
    const s = stillClipFrom(video(), video().transform, 'img', 12, 2);
    expect(Object.keys(s).sort()).toEqual(['assetId', 'duration', 'fadeIn', 'fadeOut', 'id', 'name', 'start', 'trackId', 'transform', 'type']);
  });
});

describe('freezeHandover', () => {
  const v = video({ fadeIn: 1, fadeOut: 2, transition: { id: 'fade', duration: 1 }, motionIn: { id: 'pop', duration: 0.5 }, motionOut: { id: 'pop', duration: 0.5 } });
  it('does nothing in the middle', () => {
    const h = freezeHandover(v, planFreeze(v, 15, 30));
    expect(h.where).toBe('middle');
    expect(h.videoPatch).toBeNull();
    expect(stillClipFrom(v, v.transform, 'i', 15, 2, h).fadeIn).toBe(0);
  });
  it('head: the still takes the entrance, the video loses it', () => {
    const plan = planFreeze(v, 10, 30);
    expect(plan.split).toBe(false);
    const h = freezeHandover(v, plan);
    expect(h.where).toBe('head');
    expect(h.videoPatch).toEqual({ fadeIn: 0, transition: null, motionIn: null });
    const s = stillClipFrom(v, v.transform, 'i', plan.stillStart, 2, h);
    expect(s.fadeIn).toBe(1);
    expect(s.fadeOut).toBe(0);
    expect(s.transition).toEqual({ id: 'fade', duration: 1 });
    expect(s.transition).not.toBe(v.transition);
    expect(s.motionIn).toEqual({ id: 'pop', duration: 0.5 });
    expect(s.motionOut).toBeUndefined();
  });
  it('tail: the still takes the exit, the video loses it', () => {
    const plan = planFreeze(v, 19.99, 30);
    expect(plan.split).toBe(false);
    expect(plan.stillStart).toBe(20);
    const h = freezeHandover(v, plan);
    expect(h.where).toBe('tail');
    expect(h.videoPatch).toEqual({ fadeOut: 0, motionOut: null });
    const s = stillClipFrom(v, v.transform, 'i', 20, 2, h);
    expect(s.fadeOut).toBe(2);
    expect(s.fadeIn).toBe(0);
    expect(s.motionOut).toEqual({ id: 'pop', duration: 0.5 });
    expect(s.transition).toBeUndefined();
  });
  it('no patch when there is nothing to take', () => {
    expect(freezeHandover(video(), planFreeze(video(), 10, 30)).videoPatch).toBeNull();
    expect(freezeHandover(video(), planFreeze(video(), 19.99, 30)).videoPatch).toBeNull();
  });
});

describe('freezeEffectCopies', () => {
  it('copies only the effects on the video that are active at the time', () => {
    const clips: Clip[] = [
      fx({ id: 'on' }),
      fx({ id: 'other', target: 'x' }),
      fx({ id: 'later', start: 16, duration: 2 }),
      fx({ id: 'layer', target: null }),
      video(),
    ];
    const out = freezeEffectCopies(clips, 'v', 15, 'still', 15, 2);
    expect(out).toHaveLength(1);
    expect(out[0]!.target).toBe('still');
    expect(out[0]!.start).toBe(15);
    expect(out[0]!.duration).toBe(2);
    expect(out[0]!.trackId).toBe('t2');
    expect(out[0]!.effect).toBe('blur');
  });
  it('bakes keyframes and fades at the freeze time', () => {
    const e = fx({
      fadeIn: 4,
      keyframes: {
        'p.radius': [
          { t: 0, v: 0, ease: 'linear' },
          { t: 10, v: 10, ease: 'linear' },
        ],
      },
    });
    const [c] = freezeEffectCopies([e], 'v', 12, 's', 12, 2);
    expect(c!.params.radius).toBeCloseTo(2);
    expect(c!.keyframes).toBeUndefined();
    expect(c!.amount).toBeCloseTo(0.5);
    expect(c!.fadeIn).toBe(0);
    expect(c!.fadeOut).toBe(0);
    expect(e.params.radius).toBe(4);
  });
  it('starts the look at the moment of the freeze', () => {
    const [c] = freezeEffectCopies([fx({ timeOffset: 3 })], 'v', 14, 's', 14, 2);
    expect(c!.timeOffset).toBe(7);
    expect(c!.fullDuration).toBe(10);
  });
  it('the effect at the head and tail edges is still copied', () => {
    expect(freezeEffectCopies([fx()], 'v', 10, 's', 10, 2)).toHaveLength(1);
    expect(freezeEffectCopies([fx()], 'v', 19.99, 's', 20, 2)).toHaveLength(1);
  });
});
