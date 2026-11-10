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

import { GIF_PARTS_MAX_WORKERS, GIF_PARTS_MIN_FRAMES, gifPartWorkers, planGifParts } from './gifPool';
import { packGifFrames, unpackGifFrames } from './segment';

describe('gif in parts', () => {
  it('covers every frame once, in order, with no tiny part', () => {
    for (const total of [1, 7, 8, 9, 24, 25, 100, 299, 300, 301, 1500]) {
      for (const workers of [1, 2, 3, 6, 8]) {
        const parts = planGifParts(total, workers);
        expect(parts[0]!.from).toBe(0);
        expect(parts[parts.length - 1]!.to).toBe(total);
        for (let k = 0; k < parts.length; k++) {
          if (k > 0) expect(parts[k]!.from).toBe(parts[k - 1]!.to);
          expect(parts[k]!.to).toBeGreaterThan(parts[k]!.from);
          if (parts.length > 1) expect(parts[k]!.to - parts[k]!.from).toBeGreaterThanOrEqual(4);
        }
      }
    }
    expect(planGifParts(0, 4)).toEqual([]);
  });
  it('gives each worker about three parts', () => {
    expect(planGifParts(300, 6).length).toBe(18);
    expect(planGifParts(30, 6).length).toBe(4);
  });
  it('picks workers by cores and work', () => {
    expect(gifPartWorkers(2, 960 * 540, 300)).toBe(1);
    expect(gifPartWorkers(16, 960 * 540, GIF_PARTS_MIN_FRAMES - 1)).toBe(1);
    expect(gifPartWorkers(16, 100 * 100, 300)).toBe(1);
    expect(gifPartWorkers(4, 960 * 540, 300)).toBe(2);
    expect(gifPartWorkers(28, 960 * 540, 300)).toBe(GIF_PARTS_MAX_WORKERS);
    expect(gifPartWorkers(28, 1920 * 1080, 24)).toBe(3);
  });
  it('packs frames into one buffer and gets the same bytes back', () => {
    const frames = [Uint8Array.of(1, 2, 3), Uint8Array.of(), Uint8Array.from({ length: 700 }, (_, i) => i & 255), Uint8Array.of(9)];
    const back = unpackGifFrames(packGifFrames(frames));
    expect(back.length).toBe(frames.length);
    back.forEach((f, k) => expect(Array.from(f)).toEqual(Array.from(frames[k]!)));
    expect(unpackGifFrames(packGifFrames([]))).toEqual([]);
  });
  it('refuses a buffer that is not a packed part', () => {
    expect(() => unpackGifFrames(new ArrayBuffer(2))).toThrow();
    const good = new Uint8Array(packGifFrames([Uint8Array.of(1, 2, 3)]));
    expect(() => unpackGifFrames(good.slice(0, good.length - 1).buffer)).toThrow();
    const longer = new Uint8Array(good.length + 1);
    longer.set(good);
    expect(() => unpackGifFrames(longer.buffer)).toThrow();
  });
});
