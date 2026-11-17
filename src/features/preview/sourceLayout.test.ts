import { describe, expect, it } from 'vitest';
import { SPLIT_MIN_W, paneLayout, splitBlock } from './sourceLayout';
import type { LayoutIn } from './sourceLayout';

const base: LayoutIn = { mode: 'output', programMode: 'output', sideBySide: true, hasMedia: true, width: 900 };

describe('paneLayout', () => {
  it('scene never splits', () => {
    expect(paneLayout({ ...base, mode: 'scene', programMode: 'scene' }).split).toBe(false);
    expect(paneLayout({ ...base, mode: 'source', programMode: 'scene' }).split).toBe(false);
    expect(paneLayout({ ...base, mode: 'scene', programMode: 'scene' })).toEqual({ source: false, main: true, split: false });
  });

  it('split needs all four', () => {
    expect(paneLayout(base)).toEqual({ source: true, main: true, split: true });
    expect(paneLayout({ ...base, sideBySide: false }).split).toBe(false);
    expect(paneLayout({ ...base, hasMedia: false }).split).toBe(false);
    expect(paneLayout({ ...base, width: SPLIT_MIN_W - 1 }).split).toBe(false);
    expect(paneLayout({ ...base, width: SPLIT_MIN_W }).split).toBe(true);
    // the source as the active view still splits
    expect(paneLayout({ ...base, mode: 'source' }).split).toBe(true);
  });

  it('single shows the active', () => {
    expect(paneLayout({ ...base, sideBySide: false, mode: 'source' })).toEqual({ source: true, main: false, split: false });
    expect(paneLayout({ ...base, sideBySide: false, mode: 'output' })).toEqual({ source: false, main: true, split: false });
    expect(paneLayout({ ...base, width: 400, mode: 'source' })).toEqual({ source: true, main: false, split: false });
  });
});

describe('splitBlock', () => {
  it('splitBlock order', () => {
    expect(splitBlock(base)).toBeNull();
    expect(splitBlock({ ...base, sideBySide: false, hasMedia: false, mode: 'scene', programMode: 'scene' })).toBeNull();
    // scene first, then empty, then narrow
    expect(splitBlock({ ...base, mode: 'scene', programMode: 'scene', hasMedia: false, width: 100 })).toBe('scene');
    expect(splitBlock({ ...base, mode: 'source', programMode: 'scene', hasMedia: false, width: 100 })).toBe('scene');
    expect(splitBlock({ ...base, hasMedia: false, width: 100 })).toBe('empty');
    expect(splitBlock({ ...base, width: 100 })).toBe('narrow');
  });
});
