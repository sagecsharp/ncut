import { describe, expect, it } from 'vitest';
import { mayBeCached, needsTouch, planCleanup, thumbCacheKey, waveCacheKey } from './derivedCachePlan';

const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

describe('derived cache keys', () => {
  it('include everything that changes the result', () => {
    expect(thumbCacheKey('a', 320, 0.8)).not.toBe(thumbCacheKey('a', 160, 0.8));
    expect(thumbCacheKey('a', 320, 0.8)).not.toBe(thumbCacheKey('a', 320, 0.9));
    expect(thumbCacheKey('a', 320, 0.8)).not.toBe(thumbCacheKey('b', 320, 0.8));
    expect(waveCacheKey('a', 50)).not.toBe(waveCacheKey('a', 100));
    expect(thumbCacheKey('a', 320, 0.8)).not.toBe(waveCacheKey('a', 50));
  });
});

describe('planCleanup', () => {
  const now = 100 * DAY;
  it('drops entries unused for 30 days', () => {
    const out = planCleanup(
      [
        { key: 'old', bytes: 1, usedAt: now - 31 * DAY },
        { key: 'new', bytes: 1, usedAt: now - 29 * DAY },
      ],
      now,
    );
    expect(out).toEqual(['old']);
  });
  it('drops the oldest until the total fits', () => {
    const out = planCleanup(
      [
        { key: 'a', bytes: 100 * MB, usedAt: now - 3 * DAY },
        { key: 'b', bytes: 100 * MB, usedAt: now - 1 * DAY },
        { key: 'c', bytes: 100 * MB, usedAt: now - 2 * DAY },
      ],
      now,
    );
    expect(out).toEqual(['a']);
  });
  it('keeps everything that is young and small', () => {
    expect(planCleanup([{ key: 'a', bytes: 5, usedAt: now }], now)).toEqual([]);
  });
  it('treats a broken usedAt as stale', () => {
    expect(planCleanup([{ key: 'a', bytes: 5, usedAt: NaN }], now)).toEqual(['a']);
  });
});

describe('needsTouch', () => {
  it('only after half a day', () => {
    expect(needsTouch(1000, 1000 + 60_000)).toBe(false);
    expect(needsTouch(1000, 1000 + DAY)).toBe(true);
  });
});

describe('mayBeCached', () => {
  const start = 1_800_000_000_000;
  it('asks for an asset from before this session', () => {
    expect(mayBeCached(start - 1, start, false)).toBe(true);
    expect(mayBeCached(start - 86_400_000, start, false)).toBe(true);
  });
  it('does not ask for an asset imported in this session', () => {
    expect(mayBeCached(start, start, false)).toBe(false);
    expect(mayBeCached(start + 5000, start, false)).toBe(false);
  });
  it('asks for what this session stored itself', () => {
    expect(mayBeCached(start + 5000, start, true)).toBe(true);
  });
  it('asks when it cannot tell', () => {
    expect(mayBeCached(undefined, start, false)).toBe(true);
    expect(mayBeCached(Number.NaN, start, false)).toBe(true);
    expect(mayBeCached(start + 1, Number.NaN, false)).toBe(true);
  });
});
