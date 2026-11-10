import { describe, expect, it } from 'vitest';
import { GIF_POOL_MAX_WORKERS, GIF_POOL_MIN_PIXELS, createGifPool, gifPoolDepth, gifWorkerCount } from './gifPool';

describe('gifWorkerCount', () => {
  it('stays on the calling thread for small machines and small gifs', () => {
    expect(gifWorkerCount(2, 960 * 540, 300)).toBe(1);
    expect(gifWorkerCount(3, 960 * 540, 300)).toBe(1);
    expect(gifWorkerCount(16, 100 * 100, 20)).toBe(1);
    expect(gifWorkerCount(16, 960 * 540, 3)).toBe(1);
    expect(gifWorkerCount(Number.NaN, 960 * 540, 300)).toBe(1);
  });
  it('leaves two cores free and never goes above the cap or the number of frames', () => {
    expect(gifWorkerCount(4, 960 * 540, 300)).toBe(2);
    expect(gifWorkerCount(8, 960 * 540, 300)).toBe(6);
    expect(gifWorkerCount(28, 960 * 540, 300)).toBe(GIF_POOL_MAX_WORKERS);
    expect(gifWorkerCount(28, 1920 * 1080, 5)).toBe(5);
  });
  it('starts at the work threshold', () => {
    const frames = 10;
    const px = GIF_POOL_MIN_PIXELS / frames;
    expect(gifWorkerCount(8, px - 1, frames)).toBe(1);
    expect(gifWorkerCount(8, px, frames)).toBeGreaterThan(1);
  });
});

describe('the pool', () => {
  it('keeps two frames per worker in flight at most', () => {
    expect(gifPoolDepth(1)).toBe(2);
    expect(gifPoolDepth(8)).toBe(16);
    expect(gifPoolDepth(0)).toBe(2);
  });
  it('is not made where there are no workers (node) or for one worker', () => {
    expect(createGifPool(4, 10, Uint8Array.of(0, 0, 0))).toBeNull();
    expect(createGifPool(1, 10, Uint8Array.of(0, 0, 0))).toBeNull();
  });
});
