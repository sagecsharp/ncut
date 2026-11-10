import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportProgressToShell, resetExportProgress, shell } from './shell';

type G = { window?: unknown };
const g = globalThis as unknown as G;

afterEach(() => {
  delete g.window;
});

describe('shell in a plain browser', () => {
  it('is unavailable and every call is a harmless no-op', async () => {
    expect(shell.available).toBe(false);
    expect(shell.version).toBe('');
    expect(() => {
      shell.setProgress(0.5);
      shell.keepAwake(true);
      shell.attention();
      shell.ready();
    }).not.toThrow();
    expect(await shell.revealLastSave()).toBe(false);
    expect(await shell.lastSaveName()).toBeNull();
    const off = shell.onSaved(() => {});
    const off2 = shell.onOpenFile(() => {});
    expect(() => {
      off();
      off2();
    }).not.toThrow();
  });

  it('survives a window without the bridge or with a broken one', async () => {
    g.window = {};
    expect(shell.available).toBe(false);
    g.window = {
      ncutShell: {
        version: 7,
        setProgress: () => {
          throw new Error('x');
        },
        revealLastSave: () => Promise.reject(new Error('x')),
        onSaved: () => {
          throw new Error('x');
        },
      },
    };
    expect(shell.available).toBe(true);
    expect(shell.version).toBe('');
    expect(() => shell.setProgress(1)).not.toThrow();
    expect(await shell.revealLastSave()).toBe(false);
    expect(await shell.lastSaveName()).toBeNull();
    expect(() => shell.onSaved(() => {})()).not.toThrow();
  });
});

describe('shell with the bridge', () => {
  it('forwards calls and sanitizes arguments', async () => {
    const setProgress = vi.fn();
    const keepAwake = vi.fn();
    let saved: ((n: string) => void) | null = null;
    const off = vi.fn();
    g.window = {
      ncutShell: {
        version: '1.2.3',
        setProgress,
        keepAwake,
        revealLastSave: async () => true,
        lastSaveName: async () => 'a.mp4',
        onSaved: (cb: (n: string) => void) => {
          saved = cb;
          return off;
        },
      },
    };
    expect(shell.version).toBe('1.2.3');
    shell.setProgress(NaN);
    shell.setProgress(0.25);
    shell.keepAwake(true);
    shell.keepAwake('yes' as unknown as boolean);
    expect(setProgress.mock.calls).toEqual([[null], [0.25]]);
    expect(keepAwake.mock.calls).toEqual([[true], [false]]);
    expect(await shell.revealLastSave()).toBe(true);
    expect(await shell.lastSaveName()).toBe('a.mp4');
    const got: string[] = [];
    const unsub = shell.onSaved((n) => {
      got.push(n);
      throw new Error('listener bug');
    });
    expect(() => (saved as unknown as (n: string) => void)('a.mp4')).not.toThrow();
    expect(got).toEqual(['a.mp4']);
    unsub();
    expect(off).toHaveBeenCalledTimes(1);
  });
});

describe('exportProgressToShell', () => {
  const setProgress = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    setProgress.mockReset();
    resetExportProgress();
    g.window = { ncutShell: { setProgress } };
  });
  afterEach(() => {
    resetExportProgress();
    vi.useRealTimers();
  });

  it('sends at most ~10 a second and the newest value wins', () => {
    exportProgressToShell(0.1);
    exportProgressToShell(0.2);
    exportProgressToShell(0.3);
    expect(setProgress.mock.calls).toEqual([[0.1]]);
    vi.advanceTimersByTime(100);
    expect(setProgress.mock.calls).toEqual([[0.1], [0.3]]);
    for (let i = 0; i < 100; i++) {
      exportProgressToShell(0.3 + i / 1000);
      vi.advanceTimersByTime(10);
    }
    // 1 second of updates: about 10 calls more, never 100
    expect(setProgress.mock.calls.length).toBeLessThanOrEqual(2 + 11);
  });

  it('always delivers null at once and drops anything waiting', () => {
    exportProgressToShell(0.5);
    exportProgressToShell(0.6);
    exportProgressToShell(null);
    expect(setProgress.mock.calls).toEqual([[0.5], [null]]);
    vi.advanceTimersByTime(500);
    expect(setProgress.mock.calls).toEqual([[0.5], [null]]);
  });

  it('delivers null right after a value without waiting', () => {
    exportProgressToShell(1);
    exportProgressToShell(null);
    expect(setProgress.mock.calls).toEqual([[1], [null]]);
  });
});
