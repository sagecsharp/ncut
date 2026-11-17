import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSoundApart } from './soundSetting';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('soundSetting', () => {
  it('only on turns it on', () => {
    expect(parseSoundApart('on')).toBe(true);
    for (const raw of ['off', 'ON', 'true', '', null, undefined, 1, true, {}]) expect(parseSoundApart(raw)).toBe(false);
  });

  it('is off without storage', async () => {
    const mod = await import('./soundSetting');
    expect(mod.useSoundApart.getState().apart).toBe(false);
  });

  it('reads and writes the stored word', async () => {
    const store = new Map<string, string>([['ncut.sound.apart', 'on']]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    vi.resetModules();
    const mod = await import('./soundSetting');
    expect(mod.useSoundApart.getState().apart).toBe(true);
    mod.useSoundApart.getState().setApart(false);
    expect(store.get('ncut.sound.apart')).toBe('off');
    expect(mod.useSoundApart.getState().apart).toBe(false);
    mod.useSoundApart.getState().setApart(true);
    expect(store.get('ncut.sound.apart')).toBe('on');
    // the same value writes nothing
    store.set('ncut.sound.apart', 'x');
    mod.useSoundApart.getState().setApart(true);
    expect(store.get('ncut.sound.apart')).toBe('x');
  });

  it('off when storage is blocked', async () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    vi.stubGlobal('localStorage', blocked);
    vi.resetModules();
    const mod = await import('./soundSetting');
    expect(mod.useSoundApart.getState().apart).toBe(false);
    // the choice still works for this page
    expect(() => mod.useSoundApart.getState().setApart(true)).not.toThrow();
    expect(mod.useSoundApart.getState().apart).toBe(true);
  });
});
