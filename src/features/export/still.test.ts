import { describe, expect, it } from 'vitest';
import { fontWarning, isStillContainer, jpegQuality, stillMime, stillSize } from './still';

describe('isStillContainer', () => {
  it('knows the picture formats and nothing else', () => {
    expect(isStillContainer('png')).toBe(true);
    expect(isStillContainer('jpg')).toBe(true);
    for (const c of ['gif', 'mp4', 'webm', 'wav', 'ogg', 'jpeg', 'PNG', '']) expect(isStillContainer(c)).toBe(false);
  });
});

describe('stillMime', () => {
  it('names the type the canvas encodes', () => {
    expect(stillMime('png')).toBe('image/png');
    expect(stillMime('jpg')).toBe('image/jpeg');
  });
});

describe('jpegQuality', () => {
  it('rises with the choice and stays inside 0..1', () => {
    const q = [jpegQuality('low'), jpegQuality('medium'), jpegQuality('high')];
    expect(q[0]).toBeLessThan(q[1]);
    expect(q[1]).toBeLessThan(q[2]);
    for (const v of q) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('stillSize', () => {
  it('is the project size at full scale, odd sides included (a video would round them to even)', () => {
    expect(stillSize({ width: 1920, height: 1080 }, 1)).toEqual({ width: 1920, height: 1080 });
    expect(stillSize({ width: 1081, height: 607 }, 1)).toEqual({ width: 1081, height: 607 });
  });
  it('scales and rounds', () => {
    expect(stillSize({ width: 1920, height: 1080 }, 0.5)).toEqual({ width: 960, height: 540 });
    expect(stillSize({ width: 1081, height: 607 }, 0.75)).toEqual({ width: 811, height: 455 });
  });
  it('never goes below 1 px and takes a broken scale as 1', () => {
    expect(stillSize({ width: 1, height: 1 }, 0.5)).toEqual({ width: 1, height: 1 });
    expect(stillSize({ width: 100, height: 50 }, Number.NaN)).toEqual({ width: 100, height: 50 });
    expect(stillSize({ width: 100, height: 50 }, 0)).toEqual({ width: 100, height: 50 });
    expect(stillSize({ width: 100, height: 50 }, -2)).toEqual({ width: 100, height: 50 });
  });
});

describe('fontWarning', () => {
  it('names the family and the fallback', () => {
    expect(fontWarning('Foo')).toBe('font "Foo" could not be loaded, its text is drawn in a fallback font');
  });
});
