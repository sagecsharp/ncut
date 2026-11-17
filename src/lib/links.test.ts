import { describe, expect, it } from 'vitest';
import type { CameraClip, Clip, EffectClip, ImageClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { relinkCopies, repointSplitHalves, unlinkRemoved } from './links';

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

describe('mattes in links', () => {
  it('split halves and copies repoint a matte', () => {
    const clips: Clip[] = [image('c', { matte: { clip: 'm', mode: 'luma' } }), image('c2', { matte: { clip: 'm', mode: 'luma' } }), image('m')];
    const split = repointSplitHalves(clips, new Map([['m', 'm2'], ['c', 'c2']]));
    expect((split[1] as ImageClip).matte).toEqual({ clip: 'm2', mode: 'luma' });
    // the left half keeps pointing at the left half
    expect(split[0]).toBe(clips[0]);
    const copies = relinkCopies([image('x', { matte: { clip: 'm', mode: 'alpha-inv' } })], new Map([['m', 'mc']]), [clips[2]!]);
    expect((copies[0] as ImageClip).matte).toEqual({ clip: 'mc', mode: 'alpha-inv' });
    // a matte clip that was not copied stays the original
    const kept = relinkCopies([image('y', { matte: { clip: 'm', mode: 'alpha' } })], new Map([['q', 'qc']]), []);
    expect((kept[0] as ImageClip).matte).toEqual({ clip: 'm', mode: 'alpha' });
  });
  it('unlinkRemoved drops a matte whose clip is gone', () => {
    const a = image('a', { matte: { clip: 'm', mode: 'alpha' } });
    const b = image('b', { matte: { clip: 'other', mode: 'alpha' } });
    const out = unlinkRemoved([a, b, image('m')], new Set(['m']));
    expect('matte' in out[0]!).toBe(false);
    expect(out[1]).toBe(b);
    // the matte goes even when the parent is gone too
    const c = image('c', { parent: 'p', matte: { clip: 'm', mode: 'alpha' } });
    const gone = unlinkRemoved([c], new Set(['m', 'p']))[0] as ImageClip;
    expect(gone.matte).toBeUndefined();
    expect(gone.parent).toBeNull();
  });
});
