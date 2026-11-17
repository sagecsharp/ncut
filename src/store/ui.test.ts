import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sameIds, sameKeyRefs, useUi } from './ui';

beforeEach(() => {
  vi.useFakeTimers();
  useUi.setState({ toasts: [], previewMode: 'output', programMode: 'output', trimMode: false, trimEdge: null, mediaTab: 'media', mixerFocus: null, keySel: [], keyFocus: false, crossfadePick: null, exportAsk: null, dialog: null });
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

describe('trim state', () => {
  const edge = { clipId: 'a', edge: 'end' as const, both: true, alone: false };

  it('trim setters skip equal writes', () => {
    let calls = 0;
    const off = useUi.subscribe(() => calls++);
    useUi.getState().setTrimMode(false);
    useUi.getState().setTrimEdge(null);
    expect(calls).toBe(0);
    useUi.getState().setTrimMode(true);
    useUi.getState().setTrimMode(true);
    expect(calls).toBe(1);
    useUi.getState().setTrimEdge(edge);
    expect(calls).toBe(2);
    useUi.getState().setTrimEdge({ ...edge });
    expect(calls).toBe(2);
    useUi.getState().setTrimEdge({ ...edge, alone: true });
    expect(calls).toBe(3);
    off();
  });

  it('an edge turns trim mode on and trim mode off clears a stray edge', () => {
    useUi.getState().setTrimEdge(edge);
    expect(useUi.getState().trimMode).toBe(true);
    useUi.getState().setTrimMode(false);
    expect(useUi.getState().trimMode).toBe(false);
    expect(useUi.getState().trimEdge).toBeNull();
    useUi.setState({ trimMode: false, trimEdge: edge });
    useUi.getState().setTrimMode(false);
    expect(useUi.getState().trimEdge).toBeNull();
    useUi.getState().setTrimEdge(edge);
    useUi.getState().setTrimEdge(null);
    expect(useUi.getState().trimEdge).toBeNull();
    expect(useUi.getState().trimMode).toBe(true);
  });
});

describe('source and program', () => {
  it('activateSource keeps programMode and activateProgram goes back', () => {
    useUi.getState().setPreviewMode('scene');
    expect(useUi.getState().programMode).toBe('scene');
    useUi.getState().activateSource();
    expect(useUi.getState().previewMode).toBe('source');
    expect(useUi.getState().programMode).toBe('scene');
    useUi.getState().activateProgram();
    expect(useUi.getState().previewMode).toBe('scene');
  });

  it('setPreviewMode of output or scene sets both and an equal set writes nothing', () => {
    useUi.getState().setPreviewMode('scene');
    expect(useUi.getState().previewMode).toBe('scene');
    expect(useUi.getState().programMode).toBe('scene');
    let calls = 0;
    const off = useUi.subscribe(() => calls++);
    useUi.getState().setPreviewMode('scene');
    useUi.getState().activateProgram();
    expect(calls).toBe(0);
    useUi.getState().activateSource();
    useUi.getState().activateSource();
    expect(calls).toBe(1);
    off();
  });
});

describe('media tab and mixer', () => {
  it('setMediaTab with an equal tab writes nothing', () => {
    let calls = 0;
    const off = useUi.subscribe(() => calls++);
    useUi.getState().setMediaTab('media');
    expect(calls).toBe(0);
    useUi.getState().setMediaTab('effects');
    expect(calls).toBe(1);
    off();
  });

  it('showMixer opens the tab and counts up', () => {
    useUi.getState().showMixer('trk_1');
    expect(useUi.getState().mediaTab).toBe('mixer');
    expect(useUi.getState().mixerFocus).toEqual({ track: 'trk_1', n: 1 });
    useUi.getState().showMixer();
    expect(useUi.getState().mixerFocus).toEqual({ track: null, n: 2 });
  });
});

describe('key selection', () => {
  const a = { clipId: 'c1', prop: 'x', t: 1 };
  const b = { clipId: 'c1', prop: 'y', t: 2 };

  it('key selection setters skip equal writes', () => {
    let calls = 0;
    const off = useUi.subscribe(() => calls++);
    const sel = [a, b];
    useUi.getState().setKeySel(sel);
    expect(calls).toBe(1);
    expect(useUi.getState().keySel).not.toBe(sel);
    expect(useUi.getState().keySel).toEqual(sel);
    useUi.getState().setKeySel([{ ...b, t: b.t + 5e-5 }, { ...a }]);
    expect(calls).toBe(1);
    useUi.getState().setKeySel([a, { ...b, t: b.t + 1e-3 }]);
    expect(calls).toBe(2);
    useUi.getState().setKeyFocus(true);
    useUi.getState().setKeyFocus(true);
    expect(calls).toBe(3);
    expect(useUi.getState().keyFocus).toBe(true);
    off();
  });

  it('sameKeyRefs ignores order and tiny t', () => {
    expect(sameKeyRefs([a, b], [b, a])).toBe(true);
    expect(sameKeyRefs([a], [{ ...a, t: a.t + 9e-5 }])).toBe(true);
    expect(sameKeyRefs([a], [{ ...a, t: a.t + 2e-4 }])).toBe(false);
    expect(sameKeyRefs([a], [a, b])).toBe(false);
    expect(sameKeyRefs([a], [{ ...a, prop: 'z' }])).toBe(false);
    expect(sameKeyRefs([a], [{ ...a, clipId: 'c2' }])).toBe(false);
    expect(sameKeyRefs([], [])).toBe(true);
    const x = [b, a];
    const y = [b, a];
    sameKeyRefs(x, y);
    expect(x).toEqual([b, a]);
    expect(y).toEqual([b, a]);
  });
});

describe('crossfade pick', () => {
  const edge = { clipId: 'a', edge: 'end' as const, both: true, alone: false };
  const sel = ['a', 'b'];

  it('crossfade pick', () => {
    let calls = 0;
    const off = useUi.subscribe(() => calls++);
    useUi.getState().setCrossfadePick(null);
    expect(calls).toBe(0);
    useUi.getState().setCrossfadePick({ clipId: 'b', selection: sel });
    expect(calls).toBe(1);
    useUi.getState().setCrossfadePick({ clipId: 'b', selection: sel });
    expect(calls).toBe(1);
    useUi.getState().setCrossfadePick({ clipId: 'b', selection: [...sel] });
    expect(calls).toBe(2);
    useUi.getState().setCrossfadePick(null);
    useUi.getState().setCrossfadePick(null);
    expect(calls).toBe(3);
    off();
  });

  it('a pick clears the trim edge and keeps trim mode, an edge clears the pick', () => {
    useUi.getState().setTrimEdge(edge);
    expect(useUi.getState().trimMode).toBe(true);
    useUi.getState().setCrossfadePick({ clipId: 'b', selection: sel });
    expect(useUi.getState().trimEdge).toBeNull();
    expect(useUi.getState().trimMode).toBe(true);
    useUi.getState().setTrimEdge(edge);
    expect(useUi.getState().crossfadePick).toBeNull();
    expect(useUi.getState().trimEdge).toEqual(edge);
  });
});

describe('export ask', () => {
  it('askExport opens export and counts up', () => {
    useUi.getState().askExport({ preset: 'web' });
    expect(useUi.getState().dialog).toBe('export');
    expect(useUi.getState().exportAsk).toEqual({ advanced: false, preset: 'web', focus: null, n: 1 });
    useUi.getState().closeDialog();
    expect(useUi.getState().exportAsk?.n).toBe(1);
    useUi.getState().askExport({ focus: 'codec' });
    expect(useUi.getState().exportAsk).toEqual({ advanced: true, preset: null, focus: 'codec', n: 2 });
    useUi.getState().askExport({ advanced: true });
    expect(useUi.getState().exportAsk).toEqual({ advanced: true, preset: null, focus: null, n: 3 });
    useUi.getState().askExport({});
    expect(useUi.getState().exportAsk).toEqual({ advanced: false, preset: null, focus: null, n: 4 });
  });

  it('a loudness focus leaves advanced off', () => {
    useUi.getState().askExport({ focus: 'loudness' });
    expect(useUi.getState().exportAsk?.advanced).toBe(false);
    expect(useUi.getState().exportAsk?.focus).toBe('loudness');
    useUi.getState().askExport({ focus: 'codec' });
    expect(useUi.getState().exportAsk?.advanced).toBe(true);
  });
});
