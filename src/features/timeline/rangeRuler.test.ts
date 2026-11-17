import { describe, expect, it } from 'vitest';
import { RANGE_HIT_PX, dragTime, edgeSpeed, hitRangeHandle, liveRange, shadeSpan } from './rangeRuler';

describe('liveRange', () => {
  it('liveRange moves only the dragged mark', () => {
    expect(liveRange({ in: 1, out: 5 }, null)).toEqual({ in: 1, out: 5 });
    expect(liveRange({ in: 1, out: 5 }, { which: 'in', time: 2, snapped: false })).toEqual({ in: 2, out: 5 });
    expect(liveRange({ in: 1, out: 5 }, { which: 'out', time: 4, snapped: true })).toEqual({ in: 1, out: 4 });
    expect(liveRange(undefined, null)).toBeNull();
    expect(liveRange({}, null)).toBeNull();
    expect(liveRange({ in: 1 }, { which: 'in', time: 3, snapped: false })).toEqual({ in: 3 });
  });
});

describe('hitRangeHandle', () => {
  it('hitRangeHandle takes set marks within 5 px and the middle rule', () => {
    const r = { in: 1, out: 2 };
    expect(RANGE_HIT_PX).toBe(5);
    expect(hitRangeHandle(r, 100, 100)).toBe('in');
    expect(hitRangeHandle(r, 100, 105)).toBe('in');
    expect(hitRangeHandle(r, 100, 195)).toBe('out');
    expect(hitRangeHandle(r, 100, 120)).toBeNull();
    expect(hitRangeHandle(null, 100, 100)).toBeNull();
    expect(hitRangeHandle({ out: 2 }, 100, 100)).toBeNull();
    expect(hitRangeHandle({ in: 1 }, 100, 98)).toBe('in');
    // both in reach: left of the middle is the in, else the out
    const close = { in: 1, out: 1.05 };
    expect(hitRangeHandle(close, 100, 101)).toBe('in');
    expect(hitRangeHandle(close, 100, 104)).toBe('out');
  });
});

describe('shadeSpan', () => {
  it('shadeSpan for both, in only, out only and none', () => {
    expect(shadeSpan({ in: 1, out: 3 }, 10)).toEqual({ start: 1, end: 3 });
    expect(shadeSpan({ in: 1 }, 10)).toEqual({ start: 1, end: 10 });
    expect(shadeSpan({ in: 12 }, 10)).toEqual({ start: 12, end: 12 });
    expect(shadeSpan({ out: 3 }, 10)).toEqual({ start: 0, end: 3 });
    expect(shadeSpan(null, 10)).toBeNull();
  });
});

describe('dragTime', () => {
  it('dragTime snaps to a point, else to a frame', () => {
    expect(dragTime('in', 2.02, null, 30, [2], 8, 100, true)).toEqual({ time: 2, snapped: true });
    expect(dragTime('in', 2.5, null, 30, [2], 8, 100, true)).toEqual({ time: 2.5, snapped: false });
    expect(dragTime('in', 2.02, null, 30, [2], 8, 100, false).snapped).toBe(false);
    expect(dragTime('in', 2.02, null, 30, [2], 8, 100, false).time).toBeCloseTo(2 + 1 / 30, 9);
  });
  it('dragTime clamps a frame from the other mark and out never reaches 0', () => {
    const r = { in: 2, out: 4 };
    const a = dragTime('in', 5, r, 30, [], 8, 100, false);
    expect(a.time).toBeCloseTo(4 - 1 / 30, 9);
    expect(a.snapped).toBe(false);
    const b = dragTime('out', 1, r, 30, [], 8, 100, false);
    expect(b.time).toBeCloseTo(2 + 1 / 30, 9);
    expect(dragTime('in', -3, null, 30, [], 8, 100, false)).toEqual({ time: 0, snapped: false });
    expect(dragTime('out', 0, null, 30, [], 8, 100, false).time).toBeCloseTo(1 / 30, 9);
    // a hit the clamp moved is not snapped, a hit it left alone is
    expect(dragTime('in', 4, r, 30, [4], 8, 100, true).snapped).toBe(false);
    expect(dragTime('out', 4, r, 30, [4], 8, 100, true)).toEqual({ time: 4, snapped: true });
  });
});

describe('edgeSpeed', () => {
  it('edgeSpeed ramps at both edges and is 0 between', () => {
    expect(edgeSpeed(400, 800)).toBe(0);
    expect(edgeSpeed(36, 800)).toBe(0);
    expect(edgeSpeed(0, 800)).toBe(-22);
    expect(edgeSpeed(-10, 800)).toBe(-22);
    expect(edgeSpeed(18, 800)).toBe(-11);
    expect(edgeSpeed(800, 800)).toBe(22);
    expect(edgeSpeed(782, 800)).toBe(11);
    expect(edgeSpeed(764, 800)).toBe(0);
  });
});
