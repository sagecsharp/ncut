import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUi } from './ui';

beforeEach(() => {
  vi.useFakeTimers();
  useUi.setState({ toasts: [] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('toasts', () => {
  it('a toast without an action stays as it was', () => {
    useUi.getState().toast('a');
    const t = useUi.getState().toasts[0]!;
    expect(t).toEqual({ id: expect.any(String), kind: 'info', message: 'a' });
    expect('action' in t).toBe(false);
    vi.advanceTimersByTime(2999);
    expect(useUi.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useUi.getState().toasts).toHaveLength(0);
  });

  it('an error toast stays 6 s', () => {
    useUi.getState().toast('bad', 'error');
    vi.advanceTimersByTime(5999);
    expect(useUi.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useUi.getState().toasts).toHaveLength(0);
  });

  it('a toast with an action keeps it and stays 10 s', () => {
    const run = vi.fn();
    useUi.getState().toast('look', 'info', { label: 'use as sky', run });
    const t = useUi.getState().toasts[0]!;
    expect(t.action?.label).toBe('use as sky');
    t.action!.run();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(9999);
    expect(useUi.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useUi.getState().toasts).toHaveLength(0);
  });
});
