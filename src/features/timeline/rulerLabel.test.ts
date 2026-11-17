import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatAmount, formatDuration, formatTimeAs, formatTimecode } from '../../lib/time';
import { useTimeDisplay } from '../../store/timeDisplay';
import { rulerLabel, subscribeRulerLabel } from './rulerLabel';

describe('ruler labels', () => {
  beforeEach(() => useTimeDisplay.setState({ mode: 'timecode' }));
  afterEach(() => useTimeDisplay.setState({ mode: 'timecode' }));
  it('labels follow setMode', () => {
    expect(rulerLabel(1.5, 30, true)).toBe('00:01:15');
    expect(rulerLabel(90, 30, false)).toBe('1:30');
    useTimeDisplay.getState().setMode('frames');
    expect(rulerLabel(1.5, 30, true)).toBe('45');
    expect(rulerLabel(90, 30, false)).toBe('2700');
    expect(rulerLabel(1.5, 30, false)).toBe('45');
    useTimeDisplay.getState().setMode('seconds');
    expect(rulerLabel(1.5, 30, true)).toBe('1.5s');
    expect(rulerLabel(90, 30, false)).toBe('90s');
    expect(rulerLabel(1.5, 30, false)).toBe('1.5s');
    // timecode mode is today's expression
    useTimeDisplay.getState().setMode('timecode');
    for (const fps of [24, 30, 60]) {
      for (const f of [true, false]) {
        for (let t = 0; t < 4000; t += 7.3) expect(rulerLabel(t, fps, f)).toBe(f ? formatTimecode(t, fps) : formatDuration(t));
      }
    }
  });
  it('the subscriber runs once per change and unsubscribes', () => {
    const fn = vi.fn();
    const off = subscribeRulerLabel(fn);
    useTimeDisplay.getState().setMode('frames');
    expect(fn).toHaveBeenCalledTimes(1);
    useTimeDisplay.getState().setMode('frames');
    expect(fn).toHaveBeenCalledTimes(1);
    useTimeDisplay.setState({ mode: 'frames' });
    expect(fn).toHaveBeenCalledTimes(1);
    useTimeDisplay.getState().setMode('seconds');
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    useTimeDisplay.getState().setMode('timecode');
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('formatAmount and formatTimeAs', () => {
    expect(formatAmount(12, 30, 'timecode')).toBe('+12f');
    expect(formatAmount(-30, 30, 'timecode')).toBe('-00:01:00');
    expect(formatAmount(375, 30, 'frames')).toBe('+375f');
    expect(formatAmount(375, 30, 'seconds')).toBe('+12.50s');
    expect(formatAmount(0, 30, 'timecode')).toBe('0f');
    expect(formatTimeAs(1.5, 30, 'frames')).toBe('45');
    expect(formatTimeAs(1.5, 30, 'seconds')).toBe('1.50s');
    expect(formatTimeAs(1.5, 30, 'timecode')).toBe(formatTimecode(1.5, 30));
  });
});
