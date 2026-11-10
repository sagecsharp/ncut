import { describe, expect, it } from 'vitest';
import type { Clip } from '../../types';
import { hasAnimatedPose, parentOptions } from './parentOptions';

const tf = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
const b = (id: string, start: number, name = id) => ({ id, trackId: 't', start, duration: 2, name, fadeIn: 0, fadeOut: 0 });
const img = (id: string, start: number, name?: string, parent?: string): Clip =>
  ({ ...b(id, start, name), type: 'image', assetId: 'a', transform: tf, parent }) as Clip;
const text = (id: string, start: number, name: string): Clip =>
  ({ ...b(id, start, name), type: 'text', text: name, transform: tf }) as unknown as Clip;
const cam = (id: string, start: number): Clip =>
  ({ ...b(id, start, 'camera'), type: 'camera', x: 0, y: 0, z: 0, pan: 0, tilt: 0, roll: 0, fov: 50 }) as Clip;
const audio = (id: string): Clip => ({ ...b(id, 0), type: 'audio', assetId: 'a' }) as unknown as Clip;

describe('parentOptions', () => {
  it('lists visual clips and cameras, not itself, audio or loops', () => {
    const clips = [img('a', 0), img('b', 0, 'b', 'a'), img('c', 0), cam('cam', 0), audio('au')];
    const ids = parentOptions({ clips }, ['a']).map((o) => o.id);
    // b is a child of a: attaching a to b would loop
    expect(ids.sort()).toEqual(['c', 'cam']);
  });
  it('puts overlapping clips first', () => {
    const clips = [img('a', 0), img('far', 10), img('near', 1)];
    expect(parentOptions({ clips }, ['a']).map((o) => o.id)).toEqual(['near', 'far']);
  });
  it('adds the type when names repeat, then a number', () => {
    const clips = [img('a', 0), text('t1', 0, 'title'), img('i1', 0, 'title'), img('i2', 0, 'title')];
    const labels = parentOptions({ clips }, ['a']).map((o) => o.label);
    expect(labels).toContain('title (text)');
    expect(labels).toContain('title (image) 1');
    expect(labels).toContain('title (image) 2');
  });
  it('keeps plain names and a lone camera as camera', () => {
    const clips = [img('a', 0), img('x', 0, 'logo'), cam('c', 0)];
    expect(parentOptions({ clips }, ['a']).map((o) => o.label).sort()).toEqual(['camera', 'logo']);
  });
  it('excludes every selected clip for several ids', () => {
    const clips = [img('a', 0), img('b', 0), img('c', 0)];
    expect(parentOptions({ clips }, ['a', 'b']).map((o) => o.id)).toEqual(['c']);
  });
  it('is empty when no visual clip is given', () => {
    expect(parentOptions({ clips: [audio('au'), img('a', 0)] }, ['au'])).toEqual([]);
  });
});

describe('hasAnimatedPose', () => {
  it('detects keys on x y scale rotation only', () => {
    const k = { t: 0, v: 1, ease: 'linear' as const };
    expect(hasAnimatedPose({ ...img('a', 0), keyframes: { x: [k] } })).toBe(true);
    expect(hasAnimatedPose({ ...img('a', 0), keyframes: { opacity: [k] } })).toBe(false);
    expect(hasAnimatedPose(img('a', 0))).toBe(false);
  });
});
