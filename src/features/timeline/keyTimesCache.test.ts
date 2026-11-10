import { describe, expect, it } from 'vitest';
import type { Keyframes } from '../../types';
import { clipKeyTimes, keyAt } from './keyTimesCache';

const kf = (ts: number[]): Keyframes => ({ x: ts.map((t) => ({ t, v: 0, ease: 'linear' })) }) as unknown as Keyframes;

describe('clipKeyTimes', () => {
  it('leaves out keys outside the clip and reuses the result', () => {
    const k = kf([-1, 0.5, 1, 9]);
    const a = clipKeyTimes(k, 2);
    expect(a).toEqual([0.5, 1]);
    expect(clipKeyTimes(k, 2)).toBe(a);
    expect(clipKeyTimes(k, 0.8)).toEqual([0.5]);
  });
  it('keyAt finds a key near the playhead and ignores far playheads', () => {
    const k = kf([0.5, 1]);
    expect(keyAt(k, 2, 1.01, 0.02)).toBe(1);
    expect(keyAt(k, 2, 1.5, 0.02)).toBeNaN();
    expect(keyAt(k, 2, 50, 0.02)).toBeNaN();
    expect(keyAt(undefined, 2, 1, 0.02)).toBeNaN();
  });
});
