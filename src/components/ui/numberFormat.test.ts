import { describe, expect, it } from 'vitest';
import { formatNumber, roundShown } from './numberFormat';

describe('formatNumber', () => {
  it('shows up to two more decimals than the precision when the value has them', () => {
    expect(formatNumber(1.166667, 2)).toBe('1.1667');
    expect(formatNumber(1.17, 2)).toBe('1.17');
    expect(formatNumber(1, 2)).toBe('1.00');
    expect(formatNumber(37.5, 0)).toBe('37.5');
    expect(formatNumber(38, 0)).toBe('38');
    expect(formatNumber(12.3456, 0)).toBe('12.35');
    expect(formatNumber(2.5, 1)).toBe('2.5');
    expect(formatNumber(2.5123, 1)).toBe('2.512');
  });
  it('keeps the precision decimals', () => {
    expect(formatNumber(3, 1)).toBe('3.0');
    expect(formatNumber(3.1, 3)).toBe('3.100');
    expect(formatNumber(0, 2)).toBe('0.00');
  });
  it('hides float noise', () => {
    expect(formatNumber(0.1 + 0.2, 1)).toBe('0.3');
    expect(formatNumber(1.0000000001, 2)).toBe('1.00');
    expect(formatNumber(59.99999999, 0)).toBe('60');
  });
  it('never shows -0', () => {
    expect(formatNumber(-0, 0)).toBe('0');
    expect(formatNumber(-0, 2)).toBe('0.00');
    expect(formatNumber(-0.0001, 1)).toBe('0.0');
    expect(formatNumber(-0.004, 0)).toBe('0');
  });
  it('keeps the sign of real values', () => {
    expect(formatNumber(-1.166667, 2)).toBe('-1.1667');
    expect(formatNumber(-12, 0)).toBe('-12');
  });
  it('shows 0 for a value that is not a number', () => {
    expect(formatNumber(NaN, 2)).toBe('0');
    expect(formatNumber(Infinity, 2)).toBe('0');
  });
  it('a typed value reads back as itself', () => {
    expect(Number(formatNumber(1.1667, 2))).toBe(1.1667);
    expect(formatNumber(1.1667, 2)).toBe('1.1667');
  });
});

describe('roundShown', () => {
  it('rounds to precision + 2', () => {
    expect(roundShown(1.166667, 2)).toBe(1.1667);
    expect(roundShown(37.5, 0)).toBe(37.5);
    expect(roundShown(37.5004, 0)).toBe(37.5);
    expect(roundShown(0.1 + 0.2, 1)).toBe(0.3);
  });
  it('is never -0 or not finite', () => {
    expect(Object.is(roundShown(-0.00001, 0), 0)).toBe(true);
    expect(roundShown(NaN, 1)).toBe(0);
  });
  it('matches what formatNumber shows', () => {
    for (const v of [1.166667, 37.5, 12.3456, -4.987654]) {
      expect(formatNumber(roundShown(v, 1), 1)).toBe(formatNumber(v, 1));
    }
  });
});
