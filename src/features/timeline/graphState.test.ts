import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = 'ncut.timeline.graph';
const id = (clip: string, prop: string) => `${clip}\u0000${prop}`;

/** a storage in memory that counts its writes */
function storage(): { m: Map<string, string>; sets: () => number } {
  const m = new Map<string, string>();
  let n = 0;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => m.get(key) ?? null,
    setItem: (key: string, v: string) => {
      n++;
      m.set(key, v);
    },
  });
  return { m, sets: () => n };
}

describe('the graph state', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('junk gives defaults', async () => {
    const { parseGraphPrefs, DEFAULT_GRAPH } = await import('./graphState');
    for (const raw of [null, undefined, '', 'nope', '{', '[]', '7', 7, true, {}, { kind: 'wide' }, { kind: 3, autoFit: 'no' }]) {
      expect(parseGraphPrefs(raw)).toEqual(DEFAULT_GRAPH);
    }
    expect(DEFAULT_GRAPH).toEqual({ kind: 'value', autoFit: true });
    expect(parseGraphPrefs({ kind: 'speed', autoFit: false })).toEqual({ kind: 'speed', autoFit: false });
    expect(parseGraphPrefs(JSON.stringify({ kind: 'speed' }))).toEqual({ kind: 'speed', autoFit: true });
    // only false turns auto fit off
    expect(parseGraphPrefs({ autoFit: 0 }).autoFit).toBe(true);
  });

  it('kind and auto fit saved, the rest not', async () => {
    const s = storage();
    const a = await import('./graphState');
    expect(a.useGraph.getState().kind).toBe('value');
    expect(a.useGraph.getState().autoFit).toBe(true);
    a.useGraph.getState().setKind('speed');
    a.useGraph.getState().setAutoFit(false);
    expect(JSON.parse(s.m.get(KEY)!)).toEqual({ kind: 'speed', autoFit: false });
    const writes = s.sets();
    const g = a.useGraph.getState();
    g.toggleHidden(id('a', 'x'));
    g.setActive(id('a', 'x'));
    g.setActiveKey({ clipId: 'a', prop: 'x', t: 1 });
    g.setWindows({ 'px|1': { lo: 0, hi: 1 } });
    g.setPendingFit('all');
    expect(s.sets()).toBe(writes);
    // a fresh start reads the two prefs and nothing else
    vi.resetModules();
    const b = await import('./graphState');
    const st = b.useGraph.getState();
    expect(st.kind).toBe('speed');
    expect(st.autoFit).toBe(false);
    expect(st.hidden.size).toBe(0);
    expect(st.active).toBeNull();
    expect(st.activeKey).toBeNull();
    expect(st.windows).toBeNull();
    expect(st.pendingFit).toBeNull();
  });

  it('blocked storage works', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const a = await import('./graphState');
    expect(a.useGraph.getState().kind).toBe('value');
    expect(() => a.useGraph.getState().setKind('speed')).not.toThrow();
    expect(a.useGraph.getState().kind).toBe('speed');
    expect(() => a.useGraph.getState().setAutoFit(false)).not.toThrow();
    expect(a.useGraph.getState().autoFit).toBe(false);
    // no storage at all
    vi.resetModules();
    vi.stubGlobal('localStorage', undefined);
    const b = await import('./graphState');
    expect(b.useGraph.getState().autoFit).toBe(true);
    expect(() => b.useGraph.getState().setKind('speed')).not.toThrow();
    expect(b.useGraph.getState().kind).toBe('speed');
  });

  it('auto fit on clears the windows', async () => {
    storage();
    const { useGraph } = await import('./graphState');
    const g = useGraph.getState();
    g.setWindows({ 'px|1': { lo: 0, hi: 10 } });
    g.setAutoFit(false);
    expect(useGraph.getState().windows).toEqual({ 'px|1': { lo: 0, hi: 10 } });
    useGraph.getState().setAutoFit(true);
    expect(useGraph.getState().windows).toBeNull();
    // on already: turning it on again still drops the windows
    useGraph.getState().setWindows({ 'px|1': { lo: 0, hi: 10 } });
    useGraph.getState().setAutoFit(true);
    expect(useGraph.getState().windows).toBeNull();
  });

  it('showOnly, again shows all', async () => {
    storage();
    const { useGraph } = await import('./graphState');
    const ids = [id('a', 'x'), id('a', 'y'), id('b', 'x')];
    const hidden = () => [...useGraph.getState().hidden].sort();
    useGraph.getState().showOnly(ids[1]!, ids);
    expect(hidden()).toEqual([ids[0]!, ids[2]!].sort());
    // the same again: everything shows
    useGraph.getState().showOnly(ids[1]!, ids);
    expect(hidden()).toEqual([]);
    // another one while one is alone: that one alone
    useGraph.getState().showOnly(ids[1]!, ids);
    useGraph.getState().showOnly(ids[2]!, ids);
    expect(hidden()).toEqual([ids[0]!, ids[1]!].sort());
    // a hidden line shown alone
    useGraph.getState().showAll();
    expect(hidden()).toEqual([]);
    useGraph.getState().toggleHidden(ids[0]!);
    expect(hidden()).toEqual([ids[0]!]);
    useGraph.getState().toggleHidden(ids[0]!);
    expect(hidden()).toEqual([]);
    // two shown of three: only the pressed one stays
    useGraph.getState().toggleHidden(ids[0]!);
    useGraph.getState().showOnly(ids[1]!, ids);
    expect(hidden()).toEqual([ids[0]!, ids[2]!].sort());
  });

  it('pruneTo keeps the given clips', async () => {
    storage();
    const { useGraph } = await import('./graphState');
    const g = useGraph.getState();
    g.toggleHidden(id('a', 'x'));
    g.toggleHidden(id('b', 'y'));
    g.setActive(id('b', 'y'));
    g.setActiveKey({ clipId: 'b', prop: 'y', t: 2 });
    g.setWindows({ 'px|1': { lo: 0, hi: 1 } });
    useGraph.getState().pruneTo(['a']);
    const s = useGraph.getState();
    expect([...s.hidden]).toEqual([id('a', 'x')]);
    expect(s.active).toBeNull();
    expect(s.activeKey).toBeNull();
    // the windows stay
    expect(s.windows).toEqual({ 'px|1': { lo: 0, hi: 1 } });
    // a clip that stays keeps its line and its active key
    useGraph.getState().setActive(id('a', 'x'));
    useGraph.getState().setActiveKey({ clipId: 'a', prop: 'x', t: 1 });
    useGraph.getState().pruneTo(['a', 'c']);
    expect(useGraph.getState().active).toBe(id('a', 'x'));
    expect(useGraph.getState().activeKey).toEqual({ clipId: 'a', prop: 'x', t: 1 });
    useGraph.getState().pruneTo([]);
    expect(useGraph.getState().hidden.size).toBe(0);
    expect(useGraph.getState().active).toBeNull();
  });

  it('equal writes write nothing', async () => {
    const s = storage();
    const { useGraph } = await import('./graphState');
    const g = useGraph.getState();
    g.setActive(id('a', 'x'));
    g.setActiveKey({ clipId: 'a', prop: 'x', t: 1 });
    g.setPendingFit('all');
    g.setWindows({ 'px|1': { lo: 0, hi: 1 } });
    let changes = 0;
    const off = useGraph.subscribe(() => {
      changes++;
    });
    const before = s.sets();
    const t = useGraph.getState();
    t.setKind('value');
    t.setActive(id('a', 'x'));
    // the same key within a hair
    t.setActiveKey({ clipId: 'a', prop: 'x', t: 1 + 5e-5 });
    // the same windows, another object
    t.setWindows({ 'px|1': { lo: 0, hi: 1 } });
    t.setPendingFit('all');
    // everything shows already, and nothing is dropped
    t.showAll();
    t.pruneTo(['a']);
    expect(changes).toBe(0);
    expect(s.sets()).toBe(before);
    // a real change counts once, the same again nothing
    for (let i = 0; i < 2; i++) {
      const u = useGraph.getState();
      u.setWindows(null);
      u.setActive(null);
      u.setActiveKey(null);
      u.setPendingFit(null);
    }
    expect(changes).toBe(4);
    expect(s.sets()).toBe(before);
    off();
  });
});
