import { describe, expect, it } from 'vitest';
import { clampRange, frameTime, lengthFrames, markerRange, rangeFrameCount, resolveRange } from './range';

const m = (time: number) => ({ id: String(time), time, name: '' });

describe('markerRange', () => {
  it('needs two markers at different times', () => {
    expect(markerRange(undefined)).toBeNull();
    expect(markerRange([m(1)])).toBeNull();
    expect(markerRange([m(2), m(2)])).toBeNull();
  });
  it('spans the first to the last marker', () => {
    expect(markerRange([m(1), m(4), m(2.5)])).toEqual({ start: 1, end: 4 });
  });
});

describe('clampRange', () => {
  it('missing range = the whole project', () => {
    expect(clampRange(undefined, 12)).toEqual({ start: 0, end: 12 });
  });
  it('clamps into the project', () => {
    expect(clampRange({ start: -3, end: 99 }, 12)).toEqual({ start: 0, end: 12 });
  });
  it('rejects empty, reversed and outside ranges', () => {
    expect(clampRange({ start: 5, end: 5 }, 12)).toBeNull();
    expect(clampRange({ start: 6, end: 2 }, 12)).toBeNull();
    expect(clampRange({ start: 20, end: 30 }, 12)).toBeNull();
    expect(clampRange({ start: Number.NaN, end: 3 }, 12)).toBeNull();
    expect(clampRange(undefined, 0)).toBeNull();
  });
});

describe('resolveRange', () => {
  const markers = [m(2), m(8)];
  it('picks the range for each mode', () => {
    expect(resolveRange('all', 10, markers, { start: 1, end: 2 })).toEqual({ start: 0, end: 10 });
    expect(resolveRange('markers', 10, markers, { start: 1, end: 2 })).toEqual({ start: 2, end: 8 });
    expect(resolveRange('custom', 10, markers, { start: 1, end: 2 })).toEqual({ start: 1, end: 2 });
  });
  it('markers mode without two markers gives nothing', () => {
    expect(resolveRange('markers', 10, [m(2)], { start: 0, end: 1 })).toBeNull();
  });
});

describe('frame math', () => {
  it('counts frames of a range', () => {
    expect(rangeFrameCount({ start: 2, end: 8 }, 30)).toBe(180);
    expect(rangeFrameCount({ start: 0, end: 0.5 }, 24)).toBe(12);
    expect(lengthFrames(0.001, 30)).toBe(1);
  });
  it('does not overshoot by a frame', () => {
    for (const len of [0.3, 3.3, 59.99, 600.1]) {
      for (const fps of [24, 30, 60, 240]) {
        const n = lengthFrames(len, fps);
        expect(n / fps).toBeGreaterThanOrEqual(len - 1e-9);
        expect(n / fps).toBeLessThan(len + 1 / fps + 1e-9);
      }
    }
  });
  it('frame times start at the range start', () => {
    expect(frameTime(2.5, 0, 30)).toBe(2.5);
    expect(frameTime(2.5, 30, 30)).toBe(3.5);
  });
});

describe('resolveRange inout', () => {
  const none = { start: 0, end: 0 };
  it('inout with both marks', () => {
    expect(resolveRange('inout', 10, undefined, none, { in: 2, out: 6 })).toEqual({ start: 2, end: 6 });
  });
  it('inout with only an in or only an out', () => {
    expect(resolveRange('inout', 10, undefined, none, { in: 3 })).toEqual({ start: 3, end: 10 });
    expect(resolveRange('inout', 10, undefined, none, { out: 4 })).toEqual({ start: 0, end: 4 });
  });
  it('inout without a range gives nothing', () => {
    expect(resolveRange('inout', 10, undefined, none)).toBeNull();
    expect(resolveRange('inout', 10, undefined, none, {})).toBeNull();
  });
  it('inout past the end of the project', () => {
    expect(resolveRange('inout', 10, undefined, none, { in: 12 })).toBeNull();
    expect(resolveRange('inout', 10, undefined, none, { in: 8, out: 15 })).toEqual({ start: 8, end: 10 });
  });
});
