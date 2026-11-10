import { describe, expect, it } from 'vitest';
import { clamp, formatBytes, formatDuration, formatTimecode, snapToFrame } from './time';

describe('clamp', () => {
  it('limits to the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(0, 0, 0)).toBe(0);
  });
});

describe('snapToFrame', () => {
  it('rounds to the nearest frame boundary', () => {
    expect(snapToFrame(1.01, 30)).toBeCloseTo(1, 9);
    expect(snapToFrame(1.02, 30)).toBeCloseTo(31 / 30, 9);
    expect(snapToFrame(0, 24)).toBe(0);
    expect(snapToFrame(0.5, 24)).toBeCloseTo(0.5, 9);
  });
  it('is idempotent', () => {
    for (const fps of [24, 30, 60]) {
      const once = snapToFrame(3.337, fps);
      expect(snapToFrame(once, fps)).toBeCloseTo(once, 9);
    }
  });
});

describe('formatTimecode', () => {
  it('formats mm:ss:ff when under an hour', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00');
    expect(formatTimecode(1, 30)).toBe('00:01:00');
    expect(formatTimecode(61.5, 30)).toBe('01:01:15');
  });
  it('adds hours when needed', () => {
    expect(formatTimecode(3600, 30)).toBe('01:00:00:00');
    expect(formatTimecode(3723 + 2 / 30, 30)).toBe('01:02:03:02');
  });
  it('works for 24/30/60 fps', () => {
    expect(formatTimecode(1 + 23 / 24, 24)).toBe('00:01:23');
    expect(formatTimecode(1 + 29 / 30, 30)).toBe('00:01:29');
    expect(formatTimecode(1 + 59 / 60, 60)).toBe('00:01:59');
  });
  it('rounds to the nearest frame and carries into seconds', () => {
    expect(formatTimecode(0.99999, 30)).toBe('00:01:00');
    expect(formatTimecode(59.999, 30)).toBe('01:00:00');
    expect(formatTimecode(1 - 0.4 / 30, 30)).toBe('00:01:00');
    expect(formatTimecode(1 - 0.6 / 30, 30)).toBe('00:00:29');
  });
  it('clamps negatives to zero', () => {
    expect(formatTimecode(-5, 30)).toBe('00:00:00');
  });
});

describe('formatDuration', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(83)).toBe('1:23');
    expect(formatDuration(3723)).toBe('1:02:03');
    expect(formatDuration(-4)).toBe('0:00');
  });
  it('rounds to whole seconds', () => {
    expect(formatDuration(59.6)).toBe('1:00');
    expect(formatDuration(1.4)).toBe('0:01');
  });
});

describe('formatBytes', () => {
  it('uses b, kb, mb, gb', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 ** 2)).toBe('1.0 MB');
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.00 GB');
  });
  // regression: values just under a unit boundary round up to "1024.0 KB" instead of rolling over to "1.0 MB".
  it('rolls over at unit boundaries after rounding (kb -> mb)', () => {
    expect(formatBytes(1024 ** 2 - 1)).toBe('1.0 MB');
  });
  it('rolls over at unit boundaries after rounding (mb -> gb)', () => {
    expect(formatBytes(1024 ** 3 - 1)).toBe('1.00 GB');
  });
});
