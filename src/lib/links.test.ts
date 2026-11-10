import { describe, expect, it } from 'vitest';
import type { CameraClip, Clip, EffectClip, ImageClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { repointSplitHalves } from './links';

const image = (id: string, over: Partial<ImageClip> = {}): ImageClip => ({
  id,
  type: 'image',
  trackId: 't',
  start: 0,
  duration: 4,
  name: id,
  fadeIn: 0,
  fadeOut: 0,
  assetId: 'a',
  transform: { ...DEFAULT_TRANSFORM },
  ...over,
});
const fx = (id: string, target: string | null): EffectClip => ({ id, type: 'effect', trackId: 't', start: 0, duration: 4, name: id, fadeIn: 0, fadeOut: 0, effect: 'shake', params: {}, amount: 1, seed: 1, target });
const cam = (id: string, target: string | null): CameraClip => ({ id, type: 'camera', trackId: 't', start: 0, duration: 4, name: id, fadeIn: 0, fadeOut: 0, target }) as unknown as CameraClip;

describe('repointSplitHalves', () => {
  const rightOf = new Map([
    ['p', 'p2'],
    ['c', 'c2'],
    ['e', 'e2'],
    ['k', 'k2'],
  ]);

  it('points the right halves at the right halves of what was cut too', () => {
    const clips: Clip[] = [
      image('c', { parent: 'p', lookTarget: 'p' }),
      image('c2', { parent: 'p', lookTarget: 'p' }),
      fx('e', 'p'),
      fx('e2', 'p'),
      cam('k', 'p'),
      cam('k2', 'p'),
    ];
    const out = repointSplitHalves(clips, rightOf);
    const by = (id: string) => out.find((c) => c.id === id)!;
    expect((by('c2') as ImageClip).parent).toBe('p2');
    expect((by('c2') as ImageClip).lookTarget).toBe('p2');
    expect((by('e2') as EffectClip).target).toBe('p2');
    expect((by('k2') as CameraClip).target).toBe('p2');
    // left halves keep pointing at the left half
    expect((by('c') as ImageClip).parent).toBe('p');
    expect((by('e') as EffectClip).target).toBe('p');
  });

  it('leaves unrelated clips and targets that were not cut alone', () => {
    const clips: Clip[] = [image('c', { parent: 'p' }), image('c2', { parent: 'other' }), fx('e2', null)];
    const out = repointSplitHalves(clips, rightOf);
    expect(out[0]).toBe(clips[0]);
    expect(out[1]).toBe(clips[1]);
    expect(out[2]).toBe(clips[2]);
  });

  it('returns the same array when nothing was cut', () => {
    const clips = [image('c')];
    expect(repointSplitHalves(clips, new Map())).toBe(clips);
  });
});
