import { describe, expect, it } from 'vitest';
import { DEFAULT_COUNTER, counterText, counterValue, formatCounter, hasCounter, resolveCounter } from './counter';
import type { TextCounter } from '../types';

const c = (o: Partial<TextCounter> = {}): TextCounter => ({ from: 0, to: 100, decimals: 0, ease: 'linear', hold: 0, ...o });

describe('counterValue', () => {
  it('is from at the start and to at the end', () => {
    for (const ease of ['linear', 'out', 'in-out'] as const) {
      const k = c({ ease, from: 10, to: 50 });
      expect(counterValue(k, 0, 4)).toBe(10);
      expect(counterValue(k, 4, 4)).toBe(50);
      expect(counterValue(k, -1, 4)).toBe(10);
      expect(counterValue(k, 9, 4)).toBe(50);
    }
  });
  it('holds the final number for the hold seconds', () => {
    const k = c({ hold: 1 });
    expect(counterValue(k, 3, 4)).toBe(100);
    expect(counterValue(k, 3.5, 4)).toBe(100);
    expect(counterValue(k, 1.5, 4)).toBeCloseTo(50, 6);
  });
  it('survives a hold longer than the clip and bad times', () => {
    expect(counterValue(c({ hold: 10 }), 0, 4)).toBe(0);
    expect(counterValue(c({ hold: 10 }), 0.5, 4)).toBe(100);
    expect(counterValue(c(), Number.NaN, 4)).toBe(0);
  });
  it('is monotonic for every ease, up and down', () => {
    for (const ease of ['linear', 'out', 'in-out'] as const) {
      let prev = -Infinity;
      let prevDown = Infinity;
      for (let i = 0; i <= 100; i++) {
        const up = counterValue(c({ ease }), i / 25, 4);
        const down = counterValue(c({ ease, from: 100, to: 0 }), i / 25, 4);
        expect(up).toBeGreaterThanOrEqual(prev);
        expect(down).toBeLessThanOrEqual(prevDown);
        prev = up;
        prevDown = down;
      }
    }
  });
  it('defaults to the out ease', () => {
    const k: TextCounter = { from: 0, to: 100, decimals: 0 };
    expect(counterValue(k, 1, 4)).toBeGreaterThan(25);
  });
});

describe('formatCounter', () => {
  it('uses 0..4 decimals', () => {
    for (let d = 0; d <= 4; d++) {
      const s = formatCounter(1.23456, { decimals: d, separator: false });
      expect(s.split('.')[1]?.length ?? 0).toBe(d);
    }
    expect(formatCounter(1.5, { decimals: 9, separator: false })).toBe('1.5000');
    expect(formatCounter(1.5, { decimals: -3, separator: false })).toBe('2');
  });
  it('groups thousands, also with negatives and decimals', () => {
    const s = { decimals: 2, separator: true };
    expect(formatCounter(1234567.891, s)).toBe('1,234,567.89');
    expect(formatCounter(-1234567.891, s)).toBe('-1,234,567.89');
    expect(formatCounter(-999, { decimals: 0, separator: true })).toBe('-999');
    expect(formatCounter(1000, { decimals: 0, separator: true })).toBe('1,000');
    expect(formatCounter(1000, { decimals: 0, separator: false })).toBe('1000');
  });
  it('never shows -0', () => {
    expect(formatCounter(-0.4, { decimals: 0, separator: false })).toBe('0');
    expect(formatCounter(-0.001, { decimals: 2, separator: true })).toBe('0.00');
    expect(formatCounter(-0, { decimals: 0, separator: false })).toBe('0');
    expect(formatCounter(-0.5, { decimals: 1, separator: false })).toBe('-0.5');
  });
  it('shows 0 for a number that is not finite', () => {
    expect(formatCounter(Number.NaN, { decimals: 0, separator: false })).toBe('0');
    expect(formatCounter(Infinity, { decimals: 1, separator: false })).toBe('0.0');
  });
});

describe('counterText / resolveCounter', () => {
  const clip = { text: '{n} of {n}!', start: 2, duration: 4, counter: c({ to: 8 }) };
  it('replaces every {n}', () => {
    expect(counterText(clip, 2)).toBe('0 of 0!');
    expect(counterText(clip, 6)).toBe('8 of 8!');
  });
  it('shows only the number when the text has no {n}', () => {
    expect(counterText({ ...clip, text: 'score' }, 6)).toBe('8');
  });
  it('leaves a clip without a counter alone', () => {
    const plain = { text: 'hi {n}', start: 0, duration: 1, counter: null };
    expect(counterText(plain, 0.5)).toBe('hi {n}');
    expect(hasCounter(plain)).toBe(false);
    expect(hasCounter(clip)).toBe(true);
  });
  it('resolves to the same object without a counter and a copy with one', () => {
    const plain = { text: 'x', start: 0, duration: 1 };
    expect(resolveCounter(plain, 0.5)).toBe(plain);
    const nul = { ...plain, counter: null };
    expect(resolveCounter(nul, 0.5)).toBe(nul);
    const out = resolveCounter(clip, 6);
    expect(out).not.toBe(clip);
    expect(out.counter).toBeNull();
    expect(out.text).toBe('8 of 8!');
    expect(clip.counter).not.toBeNull();
    expect(clip.text).toBe('{n} of {n}!');
  });
  it('has a sane default', () => {
    expect(DEFAULT_COUNTER.decimals).toBe(0);
    expect(DEFAULT_COUNTER.to).toBe(100);
  });
});
