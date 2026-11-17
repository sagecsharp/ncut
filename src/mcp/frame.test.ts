import { describe, expect, it } from 'vitest';
import { bytesToBase64, clampFrameTime, DEFAULT_MAX_SIZE, fontWarning, frameSize, frameTimeFor, levelsAnswer, LIMIT_MAX_SIZE, SCOPE_IMAGE_SIZE } from './frame';
import { lumaLevels } from '../features/preview/scopes';
import { SCOPE_KINDS } from '../features/preview/scopesState';
import { skyUsable } from '../engine/scene3d/sky';
import type { Project } from '../types';

describe('fontWarning', () => {
  it('names the family and the fallback', () => {
    expect(fontWarning('Foo')).toBe('font "Foo" could not be loaded, its text is drawn in a fallback font');
  });
});

describe('clampFrameTime', () => {
  it('keeps a time inside the project', () => {
    expect(clampFrameTime(3, 10, 30)).toBe(3);
    expect(clampFrameTime(-2, 10, 30)).toBe(0);
  });
  it('shows the last frame for the end and for a time past it', () => {
    expect(clampFrameTime(10, 10, 30)).toBeCloseTo(10 - 1 / 30, 9);
    expect(clampFrameTime(99, 10, 30)).toBeCloseTo(10 - 1 / 30, 9);
    expect(clampFrameTime(99, 0.01, 30)).toBe(0);
  });
  it('counts a time that is not a number as 0, and an empty project as 0', () => {
    expect(clampFrameTime(Number.NaN, 10, 30)).toBe(0);
    expect(clampFrameTime(Infinity, 10, 30)).toBe(0);
    expect(clampFrameTime(5, 0, 30)).toBe(0);
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

describe('frameTimeFor', () => {
  const base = { fps: 30, clips: [], tracks: [], assets: [] } as unknown as Project;
  const sky = { asset: 'a', turns: 0 };
  it('refuses a project without clips and without a usable sky', () => {
    expect(() => frameTimeFor(base, 2)).toThrow(/the project is empty, there is no picture to draw/);
    // a sky whose pictures are not in the project is not a picture
    expect(() => frameTimeFor({ ...base, sky } as unknown as Project, 2)).toThrow(/the project is empty/);
  });
  it('draws time 0 for a project with only a usable sky', () => {
    const assets = [{ id: 'a', kind: 'image', name: 'sky', width: 4000, height: 3000, duration: 0 }];
    const p = { ...base, sky, assets } as unknown as Project;
    expect(skyUsable(p)).toBe(true);
    expect(frameTimeFor(p, 5)).toBe(0);
  });
});

describe('levelsAnswer', () => {
  const histOf = (rgba: number[]) => lumaLevels(new Uint8ClampedArray(rgba), rgba.length / 4);
  it('rounds and names the fields, null for no pixels', () => {
    const gray = levelsAnswer(histOf([128, 128, 128, 255, 128, 128, 128, 255]), 2)!;
    expect(gray).toEqual({ luma_min: 50.2, luma_max: 50.2, luma_mean: 50.2, black: 0, white: 0, rgb_mean: { r: 50.2, g: 50.2, b: 50.2 } });
    const two = levelsAnswer(histOf([0, 0, 0, 255, 255, 255, 255, 255]), 2)!;
    expect(two).toMatchObject({ luma_min: 0, luma_max: 100, luma_mean: 50, black: 0.5, white: 0.5 });
    expect(levelsAnswer(new Uint32Array(1024), 0)).toBeNull();
    expect(levelsAnswer(new Uint32Array(1024), 4)).toBeNull();
  });
});

describe('SCOPE_IMAGE_SIZE', () => {
  it('has every kind', () => {
    expect(Object.keys(SCOPE_IMAGE_SIZE).sort()).toEqual([...SCOPE_KINDS].sort());
    expect(SCOPE_IMAGE_SIZE.waveform).toEqual({ width: 640, height: 360 });
    expect(SCOPE_IMAGE_SIZE.vectorscope).toEqual({ width: 480, height: 480 });
  });
});
