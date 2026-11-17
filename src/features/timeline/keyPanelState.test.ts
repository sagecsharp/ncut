import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = 'ncut.timeline.keyPanel';

describe('the keyframe panel prefs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('junk gives defaults', async () => {
    const { parseKeyPanelPrefs, DEFAULT_KEY_PANEL } = await import('./keyPanelState');
    for (const raw of [null, undefined, '', 'nope', '{', '[]', '7', 7, true, {}, { open: 'yes', mode: 'wide', height: 'tall', graphHeight: null }, { open: 1, height: NaN }]) {
      expect(parseKeyPanelPrefs(raw)).toEqual(DEFAULT_KEY_PANEL);
    }
    expect(DEFAULT_KEY_PANEL).toEqual({ open: false, mode: 'keys', height: 160, graphHeight: 260 });
  });

  it('height clamped, graph kept', async () => {
    const { parseKeyPanelPrefs } = await import('./keyPanelState');
    expect(parseKeyPanelPrefs({ open: true, mode: 'graph', height: 10, graphHeight: 5000 })).toEqual({ open: true, mode: 'graph', height: 72, graphHeight: 2000 });
    expect(parseKeyPanelPrefs({ height: 200.6 }).height).toBe(201);
    expect(parseKeyPanelPrefs(JSON.stringify({ open: true, mode: 'graph', height: 300 }))).toEqual({ open: true, mode: 'graph', height: 300, graphHeight: 260 });
    expect(parseKeyPanelPrefs({ height: Infinity }).height).toBe(160);
  });

  it('saves, blocked storage works', async () => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => m.get(key) ?? null, setItem: (key: string, v: string) => void m.set(key, v) });
    const a = await import('./keyPanelState');
    expect(a.useKeyPanel.getState().open).toBe(false);
    a.useKeyPanel.getState().toggle();
    a.useKeyPanel.getState().setMode('graph');
    a.useKeyPanel.getState().setHeight(400);
    expect(JSON.parse(m.get(KEY)!)).toEqual({ open: true, mode: 'graph', height: 160, graphHeight: 400 });
    a.useKeyPanel.getState().setHeight(Number.NaN);
    expect(a.useKeyPanel.getState().graphHeight).toBe(400);
    // a fresh start reads what was kept
    vi.resetModules();
    const b = await import('./keyPanelState');
    expect(b.useKeyPanel.getState().open).toBe(true);
    expect(b.useKeyPanel.getState().mode).toBe('graph');
    expect(b.useKeyPanel.getState().graphHeight).toBe(400);
    // blocked storage: nothing throws, the choice still holds
    vi.resetModules();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const c = await import('./keyPanelState');
    expect(c.useKeyPanel.getState().open).toBe(false);
    expect(() => c.useKeyPanel.getState().setOpen(true)).not.toThrow();
    expect(c.useKeyPanel.getState().open).toBe(true);
    // no localStorage at all
    vi.resetModules();
    vi.stubGlobal('localStorage', undefined);
    const d = await import('./keyPanelState');
    expect(() => d.useKeyPanel.getState().toggle()).not.toThrow();
    expect(d.useKeyPanel.getState().open).toBe(true);
  });

  it('resetHeight gives 160, keeps open and mode', async () => {
    const m = new Map<string, string>([[KEY, JSON.stringify({ open: true, mode: 'graph', height: 500, graphHeight: 600 })]]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => m.get(key) ?? null, setItem: (key: string, v: string) => void m.set(key, v) });
    const { useKeyPanel } = await import('./keyPanelState');
    expect(useKeyPanel.getState().height).toBe(500);
    useKeyPanel.getState().resetHeight();
    const s = useKeyPanel.getState();
    expect([s.open, s.mode, s.height, s.graphHeight]).toEqual([true, 'graph', 160, 260]);
    expect(JSON.parse(m.get(KEY)!)).toEqual({ open: true, mode: 'graph', height: 160, graphHeight: 260 });
  });
});
