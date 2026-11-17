import { describe, expect, it } from 'vitest';
import type { Clip, MediaAsset, SceneSky } from '../../types';
import { canSwapInto, filterAssets, lutSizeText, lutUses, removeLutText, sortAssets, swapKind, usedAssetIds } from './mediaList';

const A = (id: string, name: string, kind: MediaAsset['kind'], duration: number, createdAt: number) =>
  ({ id, name, kind, duration, createdAt, mime: '', size: 1, width: 0, height: 0, hasAudio: false }) as MediaAsset;
const assets = [A('a', 'clip 10', 'video', 5, 100), A('b', 'Clip 2', 'video', 30, 300), A('c', 'song', 'audio', 30, 200), A('d', 'pic', 'image', 0, 400)];
const clip = (type: string, extra: Record<string, unknown> = {}) => ({ id: 'x', type, ...extra }) as unknown as Clip;

describe('usedAssetIds', () => {
  it('collects asset ids and ignores clips without media', () => {
    const used = usedAssetIds([clip('video', { assetId: 'a' }), clip('text'), clip('image', { assetId: 'd' }), clip('video', { assetId: 'a' })]);
    expect([...used].sort()).toEqual(['a', 'd']);
  });

  it('usedAssetIds counts the pictures of the sky', () => {
    const one = { asset: 'x', turn: 0, brightness: 1, blur: 0 } as unknown as SceneSky;
    const six = { faces: ['a', 'b', 'c', 'd', 'e', 'f'], turn: 0, brightness: 1, blur: 0 } as unknown as SceneSky;
    expect([...usedAssetIds([], one)]).toEqual(['x']);
    expect([...usedAssetIds([clip('video', { assetId: 'a' }), clip('image', { assetId: 'z' })], six)].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'z']);
    expect([...usedAssetIds([clip('video', { assetId: 'a' })], null)]).toEqual(['a']);
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

const withLut = (type: string, media: string, extra: Record<string, unknown> = {}, grade: Record<string, unknown> = {}) =>
  clip(type, { grade: { lut: { media, ...extra }, ...grade } });

describe('luts', () => {
  it('usedAssetIds counts luts in grades', () => {
    const used = usedAssetIds([withLut('video', 'l1'), withLut('image', 'l2', { mix: 0 }), withLut('video', 'l3', {}, { off: true }), clip('video', { assetId: 'a' })]);
    expect([...used].sort()).toEqual(['a', 'l1', 'l2', 'l3']);
    expect([...usedAssetIds([withLut('audio', 'l9')])]).toEqual([]);
  });

  it('the lut filter', () => {
    const l = A('l', 'warm', 'lut', 0, 500);
    const all = [...assets, l];
    const base = { kind: 'all' as const, query: '', unusedOnly: false, used: new Set<string>() };
    expect(filterAssets(all, { ...base, kind: 'lut' }).map((a) => a.id)).toEqual(['l']);
    expect(filterAssets(all, { ...base, kind: 'image' }).map((a) => a.id)).toEqual(['d']);
    expect(filterAssets(all, { ...base, unusedOnly: true, used: usedAssetIds([withLut('video', 'l')]) }).map((a) => a.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('lutUses', () => {
    const clips = [withLut('video', 'l1'), withLut('video', 'l1', { mix: 0 }), withLut('image', 'l1', {}, { off: true }), withLut('video', 'l2'), withLut('audio', 'l1'), clip('video', { assetId: 'a' })];
    expect(lutUses(clips, 'l1')).toBe(3);
    expect(lutUses(clips, 'l2')).toBe(1);
    expect(lutUses(clips, 'none')).toBe(0);
    expect(lutUses([], 'l1')).toBe(0);
  });

  it('removeLutText', () => {
    expect(removeLutText('warm', 1)).toBe('"warm" is the lut of 1 clip. removing it takes it off their grade.');
    expect(removeLutText('warm', 2)).toBe('"warm" is the lut of 2 clips. removing it takes it off their grade.');
  });

  it('lutSizeText', () => {
    expect(lutSizeText({ size3: 33, size1: 4096 })).toBe('1d and 3d, 33 points');
    expect(lutSizeText({ size3: 33, size1: 0 })).toBe('3d, 33 points');
    expect(lutSizeText({ size3: 0, size1: 4096 })).toBe('1d, 4096 points');
    expect(lutSizeText({ size3: 0, size1: 0 })).toBe('');
    expect(lutSizeText(undefined)).toBe('');
  });
});
