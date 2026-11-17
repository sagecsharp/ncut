import { afterEach, describe, expect, it, vi } from 'vitest';

describe('the time display setting', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });
  it('parseTimeDisplay keeps frames and seconds, anything else is timecode', async () => {
    const { parseTimeDisplay } = await import('./timeDisplay');
    expect(parseTimeDisplay('frames')).toBe('frames');
    expect(parseTimeDisplay('seconds')).toBe('seconds');
    expect(parseTimeDisplay('timecode')).toBe('timecode');
    for (const raw of [null, undefined, '', 'Frames', ' frames', 1, {}]) expect(parseTimeDisplay(raw)).toBe('timecode');
  });
  it('starts as timecode with no localStorage, and still switches', async () => {
    vi.stubGlobal('localStorage', undefined);
    const a = await import('./timeDisplay');
    expect(a.useTimeDisplay.getState().mode).toBe('timecode');
    expect(() => a.useTimeDisplay.getState().setMode('frames')).not.toThrow();
    expect(a.useTimeDisplay.getState().mode).toBe('frames');
    vi.resetModules();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const b = await import('./timeDisplay');
    expect(b.useTimeDisplay.getState().mode).toBe('timecode');
    expect(() => b.useTimeDisplay.getState().setMode('frames')).not.toThrow();
    expect(b.useTimeDisplay.getState().mode).toBe('frames');
  });
  it('starts with what the browser kept', async () => {
    const m = new Map<string, string>([['ncut.time.display', 'seconds']]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) });
    const { useTimeDisplay } = await import('./timeDisplay');
    expect(useTimeDisplay.getState().mode).toBe('seconds');
  });
  it('setMode saves once and not when equal', async () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem });
    const { useTimeDisplay } = await import('./timeDisplay');
    useTimeDisplay.getState().setMode('frames');
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledWith('ncut.time.display', 'frames');
    useTimeDisplay.getState().setMode('frames');
    expect(setItem).toHaveBeenCalledTimes(1);
    useTimeDisplay.getState().setMode('timecode');
    expect(setItem).toHaveBeenCalledTimes(2);
  });
});
