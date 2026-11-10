import { describe, expect, it } from 'vitest';
import { pickPosterTime, pickSlotTime } from './stripPlan';

describe('pickSlotTime', () => {
  it('keeps the middle when no key frame is inside the slot', () => {
    expect(pickSlotTime(5, 0.5, 4, 6)).toBe(5);
    expect(pickSlotTime(5, 0.5, null, null)).toBe(5);
    expect(pickSlotTime(5, 0.5, 4.49, 5.5)).toBe(5); // the end of the slot is not part of it
  });
  it('takes the key frame inside the slot', () => {
    expect(pickSlotTime(5, 1, 4.2, 7)).toBe(4.2);
    expect(pickSlotTime(5, 1, 2, 5.7)).toBe(5.7);
    expect(pickSlotTime(5, 1, 5, 9)).toBe(5); // a key frame exactly in the middle
    expect(pickSlotTime(5, 1, 4, 9)).toBe(4); // the start of the slot is part of it
  });
  it('takes the nearer one when both are inside, the earlier one on a tie', () => {
    expect(pickSlotTime(5, 1, 4.2, 5.3)).toBe(5.3);
    expect(pickSlotTime(5, 1, 4.9, 5.3)).toBe(4.9);
    expect(pickSlotTime(5, 1, 4.5, 5.5)).toBe(4.5);
  });
  it('never leaves the slot', () => {
    for (let i = 0; i < 200; i++) {
      const center = 1 + i * 0.37;
      const half = 0.05 + (i % 7) * 0.2;
      const before = center - ((i * 13) % 50) / 10;
      const after = center + 0.01 + ((i * 7) % 40) / 10;
      const t = pickSlotTime(center, half, before, after);
      expect(t).toBeGreaterThanOrEqual(center - half);
      expect(t).toBeLessThan(center + half);
    }
  });
  it('gives the middle back for a broken slot', () => {
    expect(pickSlotTime(5, 0, 5, 5.1)).toBe(5);
    expect(pickSlotTime(5, Number.NaN, 5, 5.1)).toBe(5);
    expect(pickSlotTime(5, 1, Number.NaN, Number.POSITIVE_INFINITY)).toBe(5);
  });
});

describe('pickPosterTime', () => {
  it('takes the key frame before the wanted time', () => {
    expect(pickPosterTime(6, 0, 4)).toBe(4);
    expect(pickPosterTime(6, 0, 6)).toBe(6);
  });
  it('does not fall back to the first frame of the file', () => {
    expect(pickPosterTime(1.2, 0, 0)).toBe(1.2);
    expect(pickPosterTime(1.2, 0.5, 0.5)).toBe(1.2);
  });
  it('takes the first frame when that is the wanted one', () => {
    expect(pickPosterTime(0, 0, 0)).toBe(0);
  });
  it('keeps the wanted time without a usable key frame', () => {
    expect(pickPosterTime(3, 0, null)).toBe(3);
    expect(pickPosterTime(3, 0, 5)).toBe(3);
    expect(pickPosterTime(3, 0, Number.NaN)).toBe(3);
  });
});
