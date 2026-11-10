import { describe, expect, it } from 'vitest';
import { INSET_INTERVAL_MS, INSET_WIDTH, insetBackingSize, insetCssSize, insetDelay, parseInsetOn } from './insetState';

describe('insetCssSize', () => {
  it('is 240 wide with the project aspect', () => {
    expect(insetCssSize(1920, 1080)).toEqual({ w: INSET_WIDTH, h: 135 });
    expect(insetCssSize(1080, 1920)).toEqual({ w: INSET_WIDTH, h: 427 });
  });
  it('survives a broken project size', () => {
    expect(insetCssSize(0, 0).h).toBe(135);
  });
});

describe('insetBackingSize', () => {
  it('scales with the pixel ratio (at most 2) and the quality', () => {
    expect(insetBackingSize(1920, 1080, 1, 'full')).toEqual({ w: 240, h: 135 });
    expect(insetBackingSize(1920, 1080, 3, 'full')).toEqual({ w: 480, h: 270 });
    expect(insetBackingSize(1920, 1080, 2, 'half')).toEqual({ w: 240, h: 135 });
  });
  it('never goes above the project size', () => {
    expect(insetBackingSize(120, 68, 2, 'full').w).toBeLessThanOrEqual(120);
  });
});

describe('insetDelay', () => {
  it('is zero while paused', () => {
    expect(insetDelay(1000, 999, false)).toBe(0);
  });
  it('waits for the rest of the interval while playing', () => {
    expect(insetDelay(1030, 1000, true)).toBe(INSET_INTERVAL_MS - 30);
    expect(insetDelay(1100, 1000, true)).toBe(0);
    expect(insetDelay(5000, 1000, true)).toBe(0);
  });
  it('never waits longer than the interval (a clock that went back)', () => {
    expect(insetDelay(0, 1000, true)).toBe(INSET_INTERVAL_MS);
  });
});

describe('parseInsetOn', () => {
  it('defaults to on', () => {
    expect(parseInsetOn(null)).toBe(true);
    expect(parseInsetOn('1')).toBe(true);
    expect(parseInsetOn('0')).toBe(false);
  });
});
