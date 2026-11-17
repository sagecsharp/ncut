import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePref } from './sourcePrefs';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parsePref', () => {
  it('on is true and off is false', () => {
    expect(parsePref('on', false)).toBe(true);
    expect(parsePref('off', true)).toBe(false);
  });

  it('anything else gives the fallback', () => {
    for (const fallback of [true, false]) {
      for (const raw of [null, undefined, 'yes', true, 1]) expect(parsePref(raw, fallback)).toBe(fallback);
    }
  });
});

describe('throwing storage', () => {
  it('uses the defaults and the toggles still flip', async () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    });
    vi.resetModules();
    const { useSourcePrefs } = await import('./sourcePrefs');
    expect(useSourcePrefs.getState().sideBySide).toBe(false);
    expect(useSourcePrefs.getState().skim).toBe(true);
    expect(() => useSourcePrefs.getState().toggleSideBySide()).not.toThrow();
    expect(() => useSourcePrefs.getState().toggleSkim()).not.toThrow();
    expect(useSourcePrefs.getState().sideBySide).toBe(true);
    expect(useSourcePrefs.getState().skim).toBe(false);
  });
});

describe('loads and saves the two keys', () => {
  it('reads on and off, writes on a change and not for an equal value', async () => {
    const store = new Map<string, string>([['ncut.preview.sideBySide', 'on'], ['ncut.media.skim', 'off']]);
    const sets: string[] = [];
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        sets.push(`${k}=${v}`);
        store.set(k, v);
      },
    });
    vi.resetModules();
    const { useSourcePrefs } = await import('./sourcePrefs');
    expect(useSourcePrefs.getState().sideBySide).toBe(true);
    expect(useSourcePrefs.getState().skim).toBe(false);
    useSourcePrefs.getState().setSideBySide(true);
    useSourcePrefs.getState().setSkim(false);
    expect(sets).toEqual([]);
    useSourcePrefs.getState().toggleSideBySide();
    useSourcePrefs.getState().setSkim(true);
    expect(sets).toEqual(['ncut.preview.sideBySide=off', 'ncut.media.skim=on']);
  });
});
