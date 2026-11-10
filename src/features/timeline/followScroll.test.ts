import { describe, expect, it } from 'vitest';
import { followScrollLeft, nearestScrollDelta, revealScrollLeft } from './followScroll';

describe('follow scroll', () => {
  it('stays when the playhead is in view', () => {
    expect(followScrollLeft(500, 400, 800, true, 1)).toBeNull();
    expect(followScrollLeft(500, 400, 800, true, -2)).toBeNull();
  });
  it('forward: the page puts the playhead near the left edge', () => {
    expect(followScrollLeft(1300, 400, 800, true, 1)).toBe(1260);
    expect(followScrollLeft(1300, 400, 800, true, 4)).toBe(1260);
  });
  it('backwards: the page puts the playhead near the right edge', () => {
    const next = followScrollLeft(1990, 2000, 800, true, -1)!;
    expect(next).toBeLessThan(1990);
    expect(1990 - next).toBeGreaterThan(700);
    expect(followScrollLeft(10, 400, 800, true, -1)).toBe(0);
  });
  it('paused: centers', () => {
    expect(followScrollLeft(2000, 0, 800, false, 1)).toBe(1600);
    expect(followScrollLeft(2000, 0, 800, false, -1)).toBe(1600);
  });
  it('reveal brings a range into view', () => {
    expect(revealScrollLeft(100, 200, 0, 800)).toBeNull();
    expect(revealScrollLeft(2000, 2200, 0, 800)).toBe(1700);
    expect(revealScrollLeft(2000, 4000, 0, 800)).toBe(1960);
    expect(revealScrollLeft(100, 200, 500, 800)).toBe(0);
  });
});

describe('nearest scroll delta', () => {
  it('no move when inside or covering the port', () => {
    expect(nearestScrollDelta(10, 50, 0, 100)).toBe(0);
    expect(nearestScrollDelta(-10, 200, 0, 100)).toBe(0);
  });
  it('brings the nearest edge in', () => {
    expect(nearestScrollDelta(-20, 20, 0, 100)).toBe(-20);
    expect(nearestScrollDelta(80, 130, 0, 100)).toBe(30);
  });
  it('a box bigger than the port shows its start edge', () => {
    expect(nearestScrollDelta(-20, 150, 0, 100)).toBe(0);
    expect(nearestScrollDelta(50, 250, 0, 100)).toBe(50);
  });
});
