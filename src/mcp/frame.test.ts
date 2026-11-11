import { describe, expect, it } from 'vitest';
import { bytesToBase64, clampFrameTime, DEFAULT_MAX_SIZE, frameSize, LIMIT_MAX_SIZE } from './frame';

describe('clampFrameTime', () => {
  it('keeps a time inside the project', () => {
    expect(clampFrameTime(3, 10)).toBe(3);
    expect(clampFrameTime(-2, 10)).toBe(0);
    expect(clampFrameTime(99, 10)).toBe(10);
  });
  it('counts a time that is not a number as 0, and an empty project as 0', () => {
    expect(clampFrameTime(Number.NaN, 10)).toBe(0);
    expect(clampFrameTime(Infinity, 10)).toBe(0);
    expect(clampFrameTime(5, 0)).toBe(0);
  });
});

describe('frameSize', () => {
  it('scales the longest side down to the default and keeps the shape', () => {
    expect(frameSize(1920, 1080)).toEqual({ width: DEFAULT_MAX_SIZE, height: 540 });
    expect(frameSize(1080, 1920)).toEqual({ width: 540, height: DEFAULT_MAX_SIZE });
    expect(frameSize(1000, 1000, 500)).toEqual({ width: 500, height: 500 });
  });
  it('does not blow a small project up', () => {
    expect(frameSize(640, 360)).toEqual({ width: 640, height: 360 });
    expect(frameSize(640, 360, 1920)).toEqual({ width: 640, height: 360 });
  });
  it('never goes over the limit, never below 1 px', () => {
    expect(frameSize(7680, 4320, 99999).width).toBe(LIMIT_MAX_SIZE);
    expect(frameSize(4000, 2, 100)).toEqual({ width: 100, height: 1 });
    expect(frameSize(100, 100, Number.NaN)).toEqual({ width: 100, height: 100 });
  });
});

describe('bytesToBase64', () => {
  it('matches the reference for small and for sliced inputs', () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe('');
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
    const big = new Uint8Array(0x8000 * 3 + 17).map((_, i) => (i * 31 + 7) & 255);
    expect(bytesToBase64(big)).toBe(Buffer.from(big).toString('base64'));
  });
});
