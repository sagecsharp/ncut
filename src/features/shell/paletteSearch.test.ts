import { describe, expect, it } from 'vitest';
import { rankItem, searchItems, wordTier } from './paletteSearch';

const items = [
  { title: 'split at playhead', group: 'editing' },
  { title: 'play / pause', group: 'playback' },
  { title: 'toggle snapping', group: 'timeline' },
  { title: 'export', group: 'app' },
  { title: 'add text at playhead', group: 'editing' },
];

describe('paletteSearch', () => {
  it('tiers: prefix, word start, substring, scattered, group', () => {
    expect(wordTier('spl', 'split at playhead')).toBe(0);
    expect(wordTier('play', 'split at playhead')).toBe(1);
    expect(wordTier('lit', 'split at playhead')).toBe(2);
    expect(wordTier('sph', 'split at playhead')).toBe(3);
    expect(wordTier('timeline', 'toggle snapping', 'timeline')).toBe(4);
    expect(wordTier('zzz', 'export', 'app')).toBeNull();
  });
  it('empty query keeps everything in order', () => {
    expect(searchItems('  ', items)).toEqual(items);
  });
  it('every word must match', () => {
    expect(searchItems('at play', items).map((i) => i.title)).toEqual(['split at playhead', 'add text at playhead']);
    expect(searchItems('split zzz', items)).toEqual([]);
  });
  it('prefix beats word start beats substring beats scattered', () => {
    const list = [{ title: 'xxsplit' }, { title: 'a split' }, { title: 's p l i t' }, { title: 'split' }];
    expect(searchItems('split', list).map((i) => i.title)).toEqual(['split', 'a split', 'xxsplit', 's p l i t']);
  });
  it('ties keep table order', () => {
    expect(searchItems('playhead', items).map((i) => i.title)).toEqual(['split at playhead', 'add text at playhead']);
  });
  it('is case insensitive and matches the group', () => {
    expect(searchItems('EXPORT', items)[0]?.title).toBe('export');
    expect(rankItem('playback', items[1]!)).not.toBeNull();
  });
});
