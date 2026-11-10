import { describe, expect, it } from 'vitest';
import type { Clip, MediaAsset } from '../../types';
import { canSwapInto, filterAssets, sortAssets, swapKind, usedAssetIds } from './mediaList';

const A = (id: string, name: string, kind: MediaAsset['kind'], duration: number, createdAt: number) =>
  ({ id, name, kind, duration, createdAt, mime: '', size: 1, width: 0, height: 0, hasAudio: false }) as MediaAsset;
const assets = [A('a', 'clip 10', 'video', 5, 100), A('b', 'Clip 2', 'video', 30, 300), A('c', 'song', 'audio', 30, 200), A('d', 'pic', 'image', 0, 400)];
const clip = (type: string, extra: Record<string, unknown> = {}) => ({ id: 'x', type, ...extra }) as unknown as Clip;

describe('usedAssetIds', () => {
  it('collects asset ids and ignores clips without media', () => {
    const used = usedAssetIds([clip('video', { assetId: 'a' }), clip('text'), clip('image', { assetId: 'd' }), clip('video', { assetId: 'a' })]);
    expect([...used].sort()).toEqual(['a', 'd']);
  });
});

describe('filterAssets', () => {
  const base = { kind: 'all' as const, query: '', unusedOnly: false, used: new Set<string>() };
  it('filters by kind and name', () => {
    expect(filterAssets(assets, { ...base, kind: 'video' }).map((a) => a.id)).toEqual(['a', 'b']);
    expect(filterAssets(assets, { ...base, query: ' CLIP ' }).map((a) => a.id)).toEqual(['a', 'b']);
  });
  it('unused only drops used assets', () => {
    expect(filterAssets(assets, { ...base, unusedOnly: true, used: new Set(['a', 'd']) }).map((a) => a.id)).toEqual(['b', 'c']);
  });
  it('used is ignored when unusedOnly is off', () => {
    expect(filterAssets(assets, { ...base, used: new Set(['a']) })).toHaveLength(4);
  });
});

describe('sortAssets', () => {
  it('added keeps the order and never mutates', () => {
    const copy = [...assets];
    expect(sortAssets(assets, 'added').map((a) => a.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(assets).toEqual(copy);
  });
  it('newest puts the latest import first', () => {
    expect(sortAssets(assets, 'newest').map((a) => a.id)).toEqual(['d', 'b', 'c', 'a']);
  });
  it('name sorts numbers naturally and ignores case', () => {
    expect(sortAssets(assets, 'name').map((a) => a.id)).toEqual(['b', 'a', 'd', 'c']);
  });
  it('longest sorts by duration, ties keep import order', () => {
    expect(sortAssets(assets, 'longest').map((a) => a.id)).toEqual(['b', 'c', 'a', 'd']);
  });
});

describe('swap', () => {
  it('only media clips can swap', () => {
    expect(swapKind(clip('video'))).toBe('video');
    expect(swapKind(clip('text'))).toBeNull();
    expect(swapKind(undefined)).toBeNull();
  });
  it('needs the same kind and a different asset', () => {
    const v = clip('video', { assetId: 'a' });
    expect(canSwapInto(v, assets[1]!)).toBe(true);
    expect(canSwapInto(v, assets[0]!)).toBe(false);
    expect(canSwapInto(v, assets[2]!)).toBe(false);
    expect(canSwapInto(clip('shape'), assets[1]!)).toBe(false);
  });
});
