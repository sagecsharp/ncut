import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sameIds, useUi } from './ui';

beforeEach(() => {
  vi.useFakeTimers();
  useUi.setState({ toasts: [], previewMode: 'output', programMode: 'output', trimMode: false, trimEdge: null, mediaTab: 'media', mixerFocus: null });
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
