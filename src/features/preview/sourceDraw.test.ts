import { describe, expect, it } from 'vitest';
import { gripTime, markHit, markRect, peakColumns, timeAtX, xAtTime } from './sourceDraw';

describe('sourceDraw', () => {
  it('peakColumns', () => {
    // 4 peaks per second, 2 s: 8 peaks
    const peaks = Float32Array.from([0.1, 0.5, 0.2, 0.3, 0.9, 0.4, 0.1, 0.2]);
    const four = peakColumns(peaks, 4, 2, 4);
    expect(four.length).toBe(4);
    expect(Array.from(four)).toEqual([0.5, 0.3, 0.9, 0.2].map((v) => Math.fround(v)));
    // more columns than peaks: each column still reads at least one
    const many = peakColumns(peaks, 4, 2, 16);
    expect(many.length).toBe(16);
    expect(Math.max(...many)).toBe(Math.fround(0.9));
    expect(many[0]).toBe(Math.fround(0.1));
    // a fraction of a pixel is dropped
    expect(peakColumns(peaks, 4, 2, 4.9).length).toBe(4);
    // past the data: zero
    const past = peakColumns(peaks, 4, 4, 4);
    expect(Array.from(past.slice(2))).toEqual([0, 0]);
    expect(peakColumns(peaks, 4, 0, 5).length).toBe(5);
    expect(peakColumns(peaks, 4, 2, 0).length).toBe(0);
  });

  it('xAtTime', () => {
    expect(xAtTime(5, 200, 10)).toBe(100);
    expect(xAtTime(-1, 200, 10)).toBe(0);
    expect(xAtTime(11, 200, 10)).toBe(200);
    expect(xAtTime(1, 200, 0)).toBe(0);
  });

  it('timeAtX', () => {
    // 10 s at 30 fps over 300 px: 1 px = 1 frame
    expect(timeAtX(0, 300, 10, 30)).toBe(0);
    expect(timeAtX(30.4, 300, 10, 30)).toBeCloseTo(1, 9);
    expect(timeAtX(31.9, 300, 10, 30)).toBeCloseTo(31 / 30, 9);
    // clamped to the last frame start
    expect(timeAtX(900, 300, 10, 30)).toBeCloseTo(299 / 30, 9);
    expect(timeAtX(-50, 300, 10, 30)).toBe(0);
  });

  it('gripTime', () => {
    expect(gripTime(30.6, 300, 10, 30)).toBeCloseTo(31 / 30, 9);
    expect(gripTime(30.4, 300, 10, 30)).toBeCloseTo(1, 9);
    // the end of the media is a boundary
    expect(gripTime(300, 300, 10, 30)).toBe(10);
    expect(gripTime(-10, 300, 10, 30)).toBe(0);
    // a length that is no whole frame: never past it
    expect(gripTime(300, 300, 10.01, 30)).toBeLessThanOrEqual(10.01);
  });

  it('markRect', () => {
    expect(markRect(null, 10, 200)).toBeNull();
    expect(markRect({ in: 2, out: 6 }, 10, 200)).toEqual({ x: 40, w: 80 });
    // one mark: to the other end
    expect(markRect({ in: 5 }, 10, 200)).toEqual({ x: 100, w: 100 });
    expect(markRect({ out: 5 }, 10, 200)).toEqual({ x: 0, w: 100 });
    // cut to the media
    expect(markRect({ in: 8, out: 20 }, 10, 200)).toEqual({ x: 160, w: 40 });
  });

  it('markHit', () => {
    const m = { in: 2, out: 6 };
    expect(markHit(40, m, 10, 200)).toBe('in');
    expect(markHit(120, m, 10, 200)).toBe('out');
    expect(markHit(44, m, 10, 200)).toBe('in');
    expect(markHit(50, m, 10, 200)).toBeNull();
    // set marks only
    expect(markHit(40, { out: 6 }, 10, 200)).toBeNull();
    expect(markHit(120, { in: 2 }, 10, 200)).toBeNull();
    expect(markHit(40, null, 10, 200)).toBeNull();
    // the nearer one wins, a tie is in
    expect(markHit(22, { in: 0.9, out: 1.2 }, 10, 200)).toBe('out');
    expect(markHit(21, { in: 0.9, out: 1.2 }, 10, 200)).toBe('in');
  });
});
