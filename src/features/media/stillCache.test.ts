import { describe, expect, it, vi } from 'vitest';
import { STILL_RETAIN_MS, createStillCache } from './stillCache';

const bmp = () => ({ closed: 0, close() { this.closed++; } });

describe('still cache', () => {
  it('keeps a finished still and refuses a second save of the same one', () => {
    const c = createStillCache<ReturnType<typeof bmp>>();
    const t = c.begin('a');
    expect(t).not.toBeNull();
    expect(c.begin('a')).toBeNull();
    const b = bmp();
    c.finish('a', t!, b);
    expect(c.get('a')).toBe(b);
    expect(c.has('a')).toBe(true);
    expect(c.begin('a')).toBeNull();
    expect(b.closed).toBe(0);
  });

  it('a duplicate result is closed, the first one stays', () => {
    const c = createStillCache<ReturnType<typeof bmp>>();
    const t = c.begin('a')!;
    const first = bmp();
    c.finish('a', t, first);
    const second = bmp();
    c.finish('a', t, second);
    expect(c.get('a')).toBe(first);
    expect(second.closed).toBe(1);
  });

  it('a failed save can be tried again', () => {
    const c = createStillCache<ReturnType<typeof bmp>>();
    expect(c.begin('a')).not.toBeNull();
    c.fail('a');
    expect(c.begin('a')).not.toBeNull();
  });

  it('release closes everything and drops late results of older saves', () => {
    const c = createStillCache<ReturnType<typeof bmp>>();
    const done = bmp();
    c.finish('a', c.begin('a')!, done);
    const lateTicket = c.begin('b')!;
    c.release();
    expect(done.closed).toBe(1);
    expect(c.size).toBe(0);
    const late = bmp();
    c.finish('b', lateTicket, late);
    expect(late.closed).toBe(1);
    expect(c.has('b')).toBe(false);
    // and the id can be saved again
    expect(c.begin('b')).not.toBeNull();
  });

  it('keeps the stills after the tab closed, releases them after the retain time', () => {
    vi.useFakeTimers();
    try {
      const c = createStillCache<ReturnType<typeof bmp>>();
      const b = bmp();
      c.finish('a', c.begin('a')!, b);
      c.close(false);
      vi.advanceTimersByTime(STILL_RETAIN_MS - 1);
      expect(c.has('a')).toBe(true);
      vi.advanceTimersByTime(1);
      expect(c.has('a')).toBe(false);
      expect(b.closed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opening the tab again cancels the release', () => {
    vi.useFakeTimers();
    try {
      const c = createStillCache<ReturnType<typeof bmp>>();
      const b = bmp();
      c.finish('a', c.begin('a')!, b);
      c.close(false);
      vi.advanceTimersByTime(STILL_RETAIN_MS / 2);
      c.open();
      vi.advanceTimersByTime(STILL_RETAIN_MS * 2);
      expect(c.get('a')).toBe(b);
      expect(b.closed).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closing with the project releases at once, a save running at close is released by the timer', () => {
    vi.useFakeTimers();
    try {
      const c = createStillCache<ReturnType<typeof bmp>>();
      const b = bmp();
      c.finish('a', c.begin('a')!, b);
      c.close(true);
      expect(b.closed).toBe(1);
      expect(c.size).toBe(0);
      // a save that was still running when the tab closed is covered by the timer too
      const pending = c.begin('p')!;
      c.close(false);
      c.finish('p', pending, bmp());
      expect(c.has('p')).toBe(true);
      vi.advanceTimersByTime(STILL_RETAIN_MS);
      expect(c.has('p')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
