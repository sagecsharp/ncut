import { describe, expect, it } from 'vitest';
import { backingSize, parseQuality, qualityScale } from './quality';

describe('preview quality', () => {
  it('parses saved values and falls back to full', () => {
    expect(parseQuality('half')).toBe('half');
    expect(parseQuality('quarter')).toBe('quarter');
    expect(parseQuality('nonsense')).toBe('full');
    expect(parseQuality(null)).toBe('full');
  });
  it('has a scale per quality', () => {
    expect(qualityScale('full')).toBe(1);
    expect(qualityScale('half')).toBe(0.5);
    expect(qualityScale('quarter')).toBe(0.25);
  });
  it('full keeps the old rule: css x dpr, capped at the project size', () => {
    expect(backingSize(800, 450, 1920, 1080, 2, 'full')).toEqual({ w: 1600, h: 900 });
    expect(backingSize(800, 450, 1280, 720, 2, 'full')).toEqual({ w: 1280, h: 720 });
  });
  it('half and quarter shrink the backing store only', () => {
    expect(backingSize(800, 450, 1920, 1080, 2, 'half')).toEqual({ w: 800, h: 450 });
    expect(backingSize(800, 450, 1920, 1080, 1, 'quarter')).toEqual({ w: 200, h: 113 });
  });
  it('never goes below one pixel', () => {
    expect(backingSize(2, 2, 1920, 1080, 1, 'quarter')).toEqual({ w: 1, h: 1 });
  });
});
