import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sameIds, useUi } from './ui';

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

describe('project panel and reveal', () => {
  it('showProjectPanel sets and clears the flag and skips an equal set', () => {
    useUi.setState({ projectPanel: false });
    let calls = 0;
    const off = useUi.subscribe(() => calls++);
    useUi.getState().showProjectPanel(false);
    expect(calls).toBe(0);
    useUi.getState().showProjectPanel(true);
    expect(useUi.getState().projectPanel).toBe(true);
    useUi.getState().showProjectPanel(true);
    expect(calls).toBe(1);
    useUi.getState().showProjectPanel(false);
    expect(useUi.getState().projectPanel).toBe(false);
    off();
  });

  it('revealSection counts up, so the same section can be revealed twice', () => {
    useUi.setState({ reveal: null });
    useUi.getState().revealSection('sky');
    expect(useUi.getState().reveal).toEqual({ id: 'sky', n: 1 });
    useUi.getState().revealSection('sky');
    expect(useUi.getState().reveal).toEqual({ id: 'sky', n: 2 });
    useUi.getState().revealSection('fog');
    expect(useUi.getState().reveal).toEqual({ id: 'fog', n: 3 });
  });

  it('sameIds ignores order and array identity', () => {
    expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameIds([], [])).toBe(true);
    expect(sameIds(['a'], ['a', 'b'])).toBe(false);
    expect(sameIds(['a', 'b'], ['a', 'c'])).toBe(false);
    expect(sameIds(['a', 'a'], ['a', 'b'])).toBe(false);
  });
});
