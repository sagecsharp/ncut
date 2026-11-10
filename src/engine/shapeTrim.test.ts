import { describe, expect, it } from 'vitest';
import { drawRange, flatten, fromPoints, trimPolyline } from './shapeTrim';

const square = () =>
  flatten((c) => {
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(10, 0);
    c.lineTo(10, 10);
    c.lineTo(0, 10);
    c.closePath();
  });

describe('flatten', () => {
  it('measures a closed square and keeps its start point', () => {
    const p = square();
    expect(p.length).toBeCloseTo(40, 9);
    expect(p.closed).toBe(true);
    expect([p.pts[0], p.pts[1]]).toEqual([0, 0]);
    expect([p.pts[p.pts.length - 2], p.pts[p.pts.length - 1]]).toEqual([0, 0]);
  });
  it('measures rect() and a line', () => {
    expect(flatten((c) => c.rect(0, 0, 6, 4)).length).toBeCloseTo(20, 9);
    const l = fromPoints([0, 0, 30, 0]);
    expect(l.length).toBe(30);
    expect(l.closed).toBe(false);
  });
  it('samples a full ellipse to about its circumference', () => {
    const p = flatten((c) => {
      c.beginPath();
      c.ellipse(0, 0, 100, 100, 0, 0, Math.PI * 2);
      c.closePath();
    });
    expect(p.length).toBeGreaterThan(2 * Math.PI * 100 * 0.999);
    expect(p.length).toBeLessThanOrEqual(2 * Math.PI * 100 + 1e-6);
  });
  it('rounds a corner with arcTo (quarter circle length)', () => {
    const p = flatten((c) => {
      c.beginPath();
      c.moveTo(0, 0);
      c.arcTo(10, 0, 10, 10, 5);
    });
    // 5 straight + a quarter circle of radius 5
    expect(p.length).toBeCloseTo(5 + (Math.PI * 5) / 2, 1);
    expect(p.pts[p.pts.length - 2]).toBeCloseTo(10, 6);
    expect(p.pts[p.pts.length - 1]).toBeCloseTo(5, 6);
  });
  it('survives an empty path and repeated points', () => {
    expect(flatten(() => {}).length).toBe(0);
    const p = flatten((c) => {
      c.moveTo(1, 1);
      c.lineTo(1, 1);
      c.lineTo(1, 1);
    });
    expect(p.length).toBe(0);
    expect(trimPolyline(p, 0, 1)).toEqual([]);
  });
});

describe('trimPolyline', () => {
  it('returns half of a line', () => {
    const l = fromPoints([0, 0, 100, 0]);
    expect(trimPolyline(l, 0, 0.5)).toEqual([0, 0, 50, 0]);
    expect(trimPolyline(l, 0.25, 0.75)).toEqual([25, 0, 75, 0]);
  });
  it('is the whole outline for 0..1', () => {
    expect(trimPolyline(square(), 0, 1)).toEqual([0, 0, 10, 0, 10, 10, 0, 10, 0, 0]);
  });
  it('crosses a corner and keeps it as a point', () => {
    // 0.3 of 40 = 12 (2 past the first corner), 0.6 = 24 (4 past the second corner)
    expect(trimPolyline(square(), 0.3, 0.6)).toEqual([10, 2, 10, 10, 6, 10]);
  });
  it('starts at the start point in drawing direction', () => {
    expect(trimPolyline(square(), 0, 0.125)).toEqual([0, 0, 5, 0]);
  });
  it('gives nothing when start >= end', () => {
    const p = square();
    expect(trimPolyline(p, 0.6, 0.3)).toEqual([]);
    expect(trimPolyline(p, 0.5, 0.5)).toEqual([]);
    expect(trimPolyline(p, 0, 0)).toEqual([]);
    expect(trimPolyline(p, 1, 1)).toEqual([]);
  });
  it('clamps and survives bad numbers', () => {
    const l = fromPoints([0, 0, 10, 0]);
    expect(trimPolyline(l, -3, 5)).toEqual([0, 0, 10, 0]);
    expect(trimPolyline(l, NaN, 0.5)).toEqual([0, 0, 5, 0]);
    expect(trimPolyline(fromPoints([3, 3]), 0, 1)).toEqual([]);
  });
  it('reuses the out array', () => {
    const out = [9, 9, 9];
    const r = trimPolyline(fromPoints([0, 0, 10, 0]), 0, 1, out);
    expect(r).toBe(out);
    expect(out).toEqual([0, 0, 10, 0]);
  });
  it('ends exactly on a vertex without a duplicate', () => {
    expect(trimPolyline(square(), 0, 0.25)).toEqual([0, 0, 10, 0]);
  });
});

describe('drawRange', () => {
  it('is null for everything', () => {
    expect(drawRange(undefined, undefined)).toBeNull();
    expect(drawRange(0, 1)).toBeNull();
    expect(drawRange(-1, 2)).toBeNull();
    expect(drawRange(NaN, NaN)).toBeNull();
  });
  it('clamps otherwise', () => {
    expect(drawRange(undefined, 0.5)).toEqual([0, 0.5]);
    expect(drawRange(0.2, undefined)).toEqual([0.2, 1]);
    expect(drawRange(-1, 0)).toEqual([0, 0]);
    expect(drawRange(0.9, 7)).toEqual([0.9, 1]);
  });
});
