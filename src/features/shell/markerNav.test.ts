import { describe, expect, it } from 'vitest';
import { nextMarkerTime, prevMarkerTime } from './markerNav';

const ms = [1, 3, 5].map((time, i) => ({ id: `m${i}`, time, name: '' }));

describe('marker navigation', () => {
  it('finds the next marker strictly after the playhead', () => {
    expect(nextMarkerTime(ms, 0)).toBe(1);
    expect(nextMarkerTime(ms, 1)).toBe(3);
    expect(nextMarkerTime(ms, 2.5)).toBe(3);
    expect(nextMarkerTime(ms, 5)).toBeNull();
  });
  it('finds the previous marker strictly before the playhead', () => {
    expect(prevMarkerTime(ms, 6)).toBe(5);
    expect(prevMarkerTime(ms, 5)).toBe(3);
    expect(prevMarkerTime(ms, 1)).toBeNull();
  });
  it('ignores sub millisecond drift so a jump never sticks', () => {
    expect(nextMarkerTime(ms, 3 - 0.0005)).toBe(5);
    expect(prevMarkerTime(ms, 3 + 0.0005)).toBe(1);
  });
  it('handles no markers', () => {
    expect(nextMarkerTime(undefined, 0)).toBeNull();
    expect(prevMarkerTime([], 4)).toBeNull();
  });
});
