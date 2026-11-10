import { describe, expect, it } from 'vitest';
import { formatTimecode } from './time';

describe('formatTimecode at high frame rates', () => {
  it('uses 3 frame digits above 100 fps', () => {
    expect(formatTimecode(0, 120)).toBe('00:00:000');
    expect(formatTimecode(0.5, 120)).toBe('00:00:060');
    expect(formatTimecode(1 + 5 / 144, 144)).toBe('00:01:005');
    expect(formatTimecode(1 + 164 / 165, 165)).toBe('00:01:164');
    expect(formatTimecode(2 + 100 / 240, 240)).toBe('00:02:100');
    expect(formatTimecode(61 + 7 / 240, 240)).toBe('01:01:007');
  });
  it('uses 2 frame digits at 100 fps and below', () => {
    expect(formatTimecode(1 + 99 / 100, 100)).toBe('00:01:99');
    expect(formatTimecode(1 + 5 / 100, 100)).toBe('00:01:05');
    expect(formatTimecode(1 + 59 / 60, 60)).toBe('00:01:59');
    expect(formatTimecode(1 + 23 / 24, 24)).toBe('00:01:23');
  });
  it('wraps the frame at 240 fps', () => {
    expect(formatTimecode(1 - 1 / 240, 240)).toBe('00:00:239');
    expect(formatTimecode(1, 240)).toBe('00:01:000');
    expect(formatTimecode(1 + 1 / 240, 240)).toBe('00:01:001');
    expect(formatTimecode(1 + 239 / 240, 240)).toBe('00:01:239');
    expect(formatTimecode(2, 240)).toBe('00:02:000');
  });
  it('carries into minutes and hours at 240 fps', () => {
    expect(formatTimecode(60 - 1 / 240, 240)).toBe('00:59:239');
    expect(formatTimecode(60, 240)).toBe('01:00:000');
    expect(formatTimecode(3600 - 1 / 240, 240)).toBe('59:59:239');
    expect(formatTimecode(3600, 240)).toBe('01:00:00:000');
  });
  it('clamps negatives at 240 fps', () => {
    expect(formatTimecode(-1, 240)).toBe('00:00:000');
  });
});
