import { describe, expect, it } from 'vitest';
import type { MediaAsset } from '../../types';
import { swapOptions } from './mediaSwap';

const a = (id: string, kind: MediaAsset['kind'], name: string): MediaAsset => ({
  id,
  kind,
  name,
  mime: '',
  size: 0,
  duration: 0,
  width: 0,
  height: 0,
  hasAudio: false,
  createdAt: 0,
});

describe('swapOptions', () => {
  const assets = [a('1', 'video', 'one.mp4'), a('2', 'video', 'two.mp4'), a('3', 'image', 'pic.png'), a('4', 'video', ' ')];
  it('lists the same kind without the current asset', () => {
    expect(swapOptions(assets, '1', 'video').map((o) => o.id)).toEqual(['2', '4']);
  });
  it('falls back to the kind for a blank name', () => {
    expect(swapOptions(assets, '1', 'video')[1]!.label).toBe('video');
  });
  it('is empty when there is nothing to swap to', () => {
    expect(swapOptions(assets, '3', 'image')).toEqual([]);
  });
});
