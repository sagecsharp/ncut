import { describe, expect, it } from 'vitest';
import { POSTER_MAX_CHARS, isPoster, loadPoster, posterSize, savePoster } from './posters';

describe('posterSize', () => {
  it('fits the longer side and keeps the shape', () => {
    expect(posterSize(1920, 1080)).toEqual({ w: 320, h: 180 });
    expect(posterSize(1080, 1920)).toEqual({ w: 180, h: 320 });
    expect(posterSize(1000, 1000, 100)).toEqual({ w: 100, h: 100 });
  });
  it('never upscales and never returns zero for a real picture', () => {
    expect(posterSize(200, 100)).toEqual({ w: 200, h: 100 });
    expect(posterSize(4000, 1)).toEqual({ w: 320, h: 1 });
  });
  it('is empty for bad sizes', () => {
    expect(posterSize(0, 100)).toEqual({ w: 0, h: 0 });
    expect(posterSize(NaN, 100)).toEqual({ w: 0, h: 0 });
    expect(posterSize(100, -5)).toEqual({ w: 0, h: 0 });
  });
});

describe('isPoster', () => {
  it('accepts small image data urls only', () => {
    expect(isPoster('data:image/jpeg;base64,abc')).toBe(true);
    expect(isPoster('data:text/html,hi')).toBe(false);
    expect(isPoster('https://example.com/a.jpg')).toBe(false);
    expect(isPoster(null)).toBe(false);
    expect(isPoster('data:image/jpeg;base64,' + 'a'.repeat(POSTER_MAX_CHARS))).toBe(false);
  });
});

describe('storage', () => {
  it('does nothing quietly where there is no localStorage', () => {
    // vitest runs in node: no localStorage
    expect(savePoster('p1', 'data:image/jpeg;base64,abc')).toBe(false);
    expect(loadPoster('p1')).toBeNull();
  });
});
