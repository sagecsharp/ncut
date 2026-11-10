import { describe, expect, it } from 'vitest';
import { DEFAULT_COUNTER, counterText, digitRangesOf, counterValue, formatCounter, hasCounter, resolveCounter } from './counter';
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
  it('carries on across a cut: offset and fullDuration', () => {
    const whole = { text: '{n}', start: 0, duration: 10, counter: c({ to: 100 }) };
    const left = { ...whole, duration: 5, counter: c({ to: 100, fullDuration: 10 }) };
    const right = { ...whole, start: 5, duration: 5, counter: c({ to: 100, offset: 5, fullDuration: 10 }) };
    for (const t of [0, 2.5, 4.9]) expect(counterText(left, t)).toBe(counterText(whole, t));
    for (const t of [5, 7.5, 9.9]) expect(counterText(right, t)).toBe(counterText(whole, t));
    expect(counterText(right, 5)).toBe('50');
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

describe('time format', () => {
  const t = (v: number, o: Partial<TextCounter> = {}) => formatCounter(v, { decimals: 0, format: 'time', from: 0, to: 100, ...o });
  it('writes m:ss and h:mm:ss', () => {
    expect(t(0)).toBe('0:00');
    expect(t(5)).toBe('0:05');
    expect(t(59)).toBe('0:59');
    expect(t(60)).toBe('1:00');
    expect(t(90)).toBe('1:30');
    expect(t(600)).toBe('10:00');
    expect(t(3599)).toBe('59:59');
    expect(t(3600)).toBe('1:00:00');
    expect(t(3661)).toBe('1:01:01');
    expect(t(36000 + 61)).toBe('10:01:01');
  });
  it('writes decimals as fractions of a second', () => {
    expect(t(5.3, { decimals: 1 })).toBe('0:05.3');
    expect(t(65.25, { decimals: 2 })).toBe('1:05.25');
    expect(t(0.05, { decimals: 2 })).toBe('0:00.05');
    expect(t(3600.5, { decimals: 1 })).toBe('1:00:00.5');
    expect(t(7, { decimals: 1 })).toBe('0:07.0');
  });
  it('puts a minus in front of negative times, never -0:00', () => {
    expect(t(-5)).toBe('-0:05');
    expect(t(-65, { decimals: 1 })).toBe('-1:05.0');
    expect(t(-0)).toBe('0:00');
    expect(t(-0.0000001, { from: 5, to: 0 })).toBe('0:00');
  });
  it('counting up floors: a stopwatch never shows a second before it is there', () => {
    expect(t(9.99)).toBe('0:09');
    expect(t(9.99, { decimals: 1 })).toBe('0:09.9');
    expect(t(59.999)).toBe('0:59');
    expect(t(8.9999999999)).toBe('0:09');
  });
  it('counting down rounds up: 0:00 only when the value is 0', () => {
    const d = { from: 10, to: 0 };
    expect(t(10, d)).toBe('0:10');
    expect(t(9.5, d)).toBe('0:10');
    expect(t(9.0000000001, d)).toBe('0:09');
    expect(t(8.9999999999, d)).toBe('0:09');
    expect(t(0.4, d)).toBe('0:01');
    expect(t(0, d)).toBe('0:00');
    expect(t(0.54, { ...d, decimals: 1 })).toBe('0:00.6');
  });
  it('ignores the separator and keeps the number format as it was', () => {
    expect(t(3661, { separator: true })).toBe('1:01:01');
    expect(formatCounter(1234.5, { decimals: 1, separator: true, format: 'number' })).toBe('1,234.5');
    expect(formatCounter(1234.5, { decimals: 1, separator: true })).toBe('1,234.5');
  });
  it('survives bad values', () => {
    expect(t(Number.NaN)).toBe('0:00');
    expect(t(Infinity)).toMatch(/^\d+:/);
  });
  it('a 10 second count down with a linear ease reads 0:10, 0:09 after a second, 0:00 only at the end', () => {
    const clip = { text: '{n}', start: 0, duration: 10, counter: { from: 10, to: 0, decimals: 0, ease: 'linear' as const, format: 'time' as const } };
    expect(counterText(clip, 0)).toBe('0:10');
    expect(counterText(clip, 0.5)).toBe('0:10');
    expect(counterText(clip, 1)).toBe('0:09');
    expect(counterText(clip, 1.01)).toBe('0:09');
    expect(counterText(clip, 5)).toBe('0:05');
    expect(counterText(clip, 9)).toBe('0:01');
    expect(counterText(clip, 9.99)).toBe('0:01');
    expect(counterText(clip, 10)).toBe('0:00');
    let prev = 10;
    for (let f = 0; f < 300; f++) {
      const sec = Number(counterText(clip, f / 30).split(':')[1]);
      expect(sec).toBeLessThanOrEqual(prev);
      expect(sec).toBeGreaterThan(0);
      prev = sec;
    }
  });
  it('a count up reads 0:00 at the start and the end value at the end', () => {
    const clip = { text: 'time {n}', start: 2, duration: 4, counter: { from: 0, to: 90, decimals: 0, ease: 'linear' as const, format: 'time' as const } };
    expect(counterText(clip, 2)).toBe('time 0:00');
    expect(counterText(clip, 6)).toBe('time 1:30');
  });
});

describe('digitRangesOf', () => {
  it('finds the number in the resolved text, counting letters', () => {
    expect(digitRangesOf('{n}', '1,234')).toEqual([[0, 5]]);
    expect(digitRangesOf('$ {n}', '10')).toEqual([[2, 4]]);
    expect(digitRangesOf('{n} of {n}!', '5')).toEqual([
      [0, 1],
      [5, 6],
    ]);
    expect(digitRangesOf('no token', '42')).toEqual([[0, 2]]);
  });
});
