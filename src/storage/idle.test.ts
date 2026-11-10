import { describe, expect, it, vi } from 'vitest';
import { whenIdle, type IdleEnv } from './idle';

describe('whenIdle', () => {
  it('uses requestIdleCallback with the timeout and can be cancelled', () => {
    const cbs: (() => void)[] = [];
    const cancel = vi.fn();
    const request = vi.fn((cb: () => void, _opts?: { timeout: number }) => cbs.push(cb));
    const env = { requestIdleCallback: request, cancelIdleCallback: cancel, setTimeout: vi.fn(), clearTimeout: vi.fn() } as unknown as IdleEnv;
    const fn = vi.fn();
    whenIdle(fn, 1000, env);
    expect(request.mock.calls[0]![1]).toEqual({ timeout: 1000 });
    cbs[0]!();
    expect(fn).toHaveBeenCalledTimes(1);

    const fn2 = vi.fn();
    const stop = whenIdle(fn2, 1000, env);
    stop();
    expect(cancel).toHaveBeenCalledTimes(1);
    cbs[1]!(); // even if the browser still calls back
    expect(fn2).not.toHaveBeenCalled();
  });

  it('falls back to a timeout', () => {
    vi.useFakeTimers();
    try {
      const env: IdleEnv = { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (h) => clearTimeout(h) };
      const fn = vi.fn();
      whenIdle(fn, 1000, env);
      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
      const fn2 = vi.fn();
      whenIdle(fn2, 1000, env)();
      vi.advanceTimersByTime(10);
      expect(fn2).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
