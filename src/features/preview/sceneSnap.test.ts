import { describe, expect, it } from 'vitest';
import { ANGLE_STEP, GRID_STEP, GRID_STEP_FINE, gridStepFor, snapAngle, snapDelta, snapPosition, snapToStep } from './sceneSnap';

describe('snapToStep', () => {
  it('rounds to the nearest multiple', () => {
    expect(snapToStep(74, 50)).toBe(50);
    expect(snapToStep(76, 50)).toBe(100);
    expect(snapToStep(-26, 50)).toBe(-50);
    expect(snapToStep(-24, 50)).toBe(0);
  });
  it('never returns negative zero', () => {
    expect(Object.is(snapToStep(-1, 50), 0)).toBe(true);
  });
  it('leaves the value alone for a bad step or value', () => {
    expect(snapToStep(7.3, 0)).toBe(7.3);
    expect(snapToStep(7.3, -5)).toBe(7.3);
    expect(Number.isNaN(snapToStep(Number.NaN, 50))).toBe(true);
  });
});

describe('grid step', () => {
  it('is off without ctrl', () => {
    expect(gridStepFor(false, false)).toBe(0);
    expect(gridStepFor(false, true)).toBe(0);
  });
  it('is 50, or 10 with shift', () => {
    expect(gridStepFor(true, false)).toBe(GRID_STEP);
    expect(gridStepFor(true, true)).toBe(GRID_STEP_FINE);
  });
  it('snapPosition follows it', () => {
    expect(snapPosition(123, false, false)).toBe(123);
    expect(snapPosition(123, true, false)).toBe(100);
    expect(snapPosition(123, true, true)).toBe(120);
  });
});

describe('snapAngle', () => {
  it('snaps to 15 degrees with ctrl or shift', () => {
    expect(snapAngle(52, true, false)).toBe(45);
    expect(snapAngle(53, false, true)).toBe(60);
    expect(snapAngle(-8, true, true)).toBe(-15);
    expect(ANGLE_STEP).toBe(15);
  });
  it('leaves the angle alone without a modifier', () => {
    expect(snapAngle(52.4, false, false)).toBe(52.4);
  });
});

describe('snapDelta', () => {
  it('lands the end value on the grid', () => {
    // from 13, a drag of 40 ends at 53: the grid line is 50, so the movement is 37
    expect(snapDelta(13, 40, true, false)).toBe(37);
    expect(13 + snapDelta(13, 40, true, false)).toBe(50);
  });
  it('is the plain delta without ctrl', () => {
    expect(snapDelta(13, 40, false, false)).toBe(40);
  });
  it('uses the fine grid with shift', () => {
    expect(13 + snapDelta(13, 40, true, true)).toBe(50);
    expect(13 + snapDelta(13, 43, true, true)).toBe(60);
  });
});
