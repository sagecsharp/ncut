import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip, Easing, ImageClip, Keyframe, MediaAsset, Project } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { KeyRef } from '../../store/ui';
import { REASON_TEXT } from '../shell/reasons';
import { findShortcut } from '../shell/shortcuts';
import { addKeyOnLine, easeKeysNow, fitGraphAll, fitGraphSelected, graphCommands, joinHandlesNow, showGraph, stepKeyValuesBy, toggleAutoFit, toggleGraphView } from './graphActions';
import { useGraph } from './graphState';
import { keyRefFilter, openKeyPanel } from './keyLaneActions';
import { useKeyPanel } from './keyPanelState';
import { interaction } from './view';

const ed = () => useEditor.getState();
const ui = () => useUi.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): ImageClip => proj().clips.find((c) => c.id === id) as ImageClip;
const keysOf = (id: string, prop = 'x'): Keyframe[] => clipOf(id).keyframes?.[prop] ?? [];
const toasts = (): string[] => ui().toasts.map((t) => t.message);
const lastToast = (): string => toasts().at(-1) ?? '';
const k = (t: number, v = 0, ease: Easing = 'linear'): Keyframe => ({ t, v, ease });
const ref = (clipId: string, prop: string, t: number): KeyRef => ({ clipId, prop, t });
const key = (name: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent => ({ key: name, code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }) as KeyboardEvent;

const asset: MediaAsset = { id: 'img1', name: 'img1', kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 };
const image = (trackId: string, id: string, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start: 0, duration: 10, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});

/** a: x keyed at 1, 2, 3 and opacity at 1 and 2. h: x keyed at 1 (hold), 2, 3. all 10 s */
function open(): void {
  ed().openProject({ ...createProject('graphactions'), assets: [asset], clips: [] });
  ed().addTrack('video');
  const t = proj().tracks.map((x) => x.id);
  const clips: Clip[] = [
    image(t[0]!, 'a', { keyframes: { x: [k(1, 10), k(2, 20), k(3, 40)], opacity: [k(1, 0.5), k(2, 0.995)] } }),
    image(t[1]!, 'h', { keyframes: { x: [k(1, 0, 'hold'), k(2, 10), k(3, 20)] } }),
  ];
  useEditor.setState({ project: { ...proj(), clips }, past: [], future: [], selection: [] });
}

/** the panel open and focused, these clips selected, these keys selected */
function arm(sel: KeyRef[], clips: string[] = ['a']): void {
  openKeyPanel();
  ed().select(clips);
  ui().setKeyFocus(true);
  ui().setKeySel(sel);
}

/** each test starts at its own time: the 3 s toast memory of one never reaches the next */
let clock = 5_000_000;

beforeEach(() => {
  clock += 60_000;
  vi.useFakeTimers();
  vi.setSystemTime(clock);
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useUi.setState({ toasts: [], keySel: [], keyFocus: false });
  useKeyPanel.setState({ open: false, mode: 'keys' });
  useGraph.setState({ kind: 'value', autoFit: true, hidden: new Set<string>(), active: null, activeKey: null, windows: null, pendingFit: null });
  usePlayback.setState({ time: 0 });
  delete graphCommands.frameAll;
  delete graphCommands.frameSelected;
  keyRefFilter.shows = undefined;
  interaction.gestureActive = false;
  open();
});

afterEach(() => {
  interaction.gestureActive = false;
  keyRefFilter.shows = undefined;
  vi.useRealTimers();
});

describe('graphActions', () => {
  it('f9 eases in the key panel, inserts elsewhere', () => {
    const f9 = findShortcut(key('F9'))!;
    expect(f9.id).toBe('insert-edit');
    arm([ref('a', 'x', 2)]);
    f9.run();
    const keys = keysOf('a');
    expect(keys[1]!.in).toEqual({ speed: 0, influence: 1 / 3 });
    expect(keys[1]!.out).toEqual({ speed: 0, influence: 1 / 3 });
    expect(keys[0]!.ease).toBe('bezier');
    expect(lastToast()).toBe('1 keyframe eased');
    expect(ed().past.length).toBe(1);
    // the panel has no focus: it inserts from the source view, and there is none
    ui().setKeyFocus(false);
    const before = proj();
    f9.run();
    expect(lastToast()).toBe(REASON_TEXT.sourceEmpty);
    expect(proj()).toBe(before);
    // closed: the same
    useKeyPanel.setState({ open: false });
    ui().setKeyFocus(true);
    useUi.setState({ toasts: [] });
    f9.run();
    expect(lastToast()).toBe(REASON_TEXT.sourceEmpty);
    expect(proj()).toBe(before);
    expect(ed().past.length).toBe(1);
  });

  it('shift+e, shift+f9, ctrl+shift+f9', () => {
    const easy = findShortcut(key('E', { shiftKey: true }))!;
    const into = findShortcut(key('F9', { shiftKey: true }))!;
    const outOf = findShortcut(key('F9', { ctrlKey: true, shiftKey: true }))!;
    expect([easy.id, into.id, outOf.id]).toEqual(['key-easy-ease', 'key-ease-into', 'key-ease-out-of']);
    expect([easy.mutates, into.mutates, outOf.mutates]).toEqual([true, true, true]);
    arm([ref('a', 'x', 2)]);
    easy.run();
    expect(keysOf('a')[1]!.in).toBeDefined();
    expect(keysOf('a')[1]!.out).toBeDefined();
    open();
    arm([ref('a', 'x', 2)]);
    into.run();
    expect(keysOf('a')[1]!.in).toEqual({ speed: 0, influence: 1 / 3 });
    expect(keysOf('a')[1]!.out).toBeUndefined();
    expect(lastToast()).toBe('1 keyframe eased');
    open();
    arm([ref('a', 'x', 2)]);
    outOf.run();
    expect(keysOf('a')[1]!.out).toEqual({ speed: 0, influence: 1 / 3 });
    expect(keysOf('a')[1]!.in).toBeUndefined();
    // the two ends of the value: easing into the first key has no side to ease
    open();
    arm([ref('a', 'x', 1)]);
    into.run();
    expect(lastToast()).toBe(REASON_TEXT.easeNothing);
    expect(ed().past.length).toBe(0);
    // join: the straight keys 1, 2, 3 of x have different speeds
    arm([ref('a', 'x', 2)]);
    joinHandlesNow();
    expect(lastToast()).toBe('1 keyframe joined');
    expect(keysOf('a')[1]!.in!.speed).toBe(keysOf('a')[1]!.out!.speed);
  });

  it('held step is one undo step', () => {
    arm([ref('a', 'x', 2)]);
    const before = JSON.stringify(proj());
    const up = findShortcut(key('ArrowUp', { altKey: true }))!;
    expect(up.id).toBe('key-value-up');
    up.runKey!(key('ArrowUp', { altKey: true }));
    expect(keysOf('a')[1]!.v).toBe(21);
    for (let i = 0; i < 4; i++) up.runKey!(key('ArrowUp', { altKey: true, repeat: true }));
    expect(keysOf('a')[1]!.v).toBe(25);
    expect(ed().past.length).toBe(1);
    ed().undo();
    expect(JSON.stringify(proj())).toBe(before);
    // an undo between: the next press is a step of its own
    stepKeyValuesBy(1, true);
    expect(ed().past.length).toBe(1);
    stepKeyValuesBy(-1, true);
    expect(ed().past.length).toBe(1);
    expect(keysOf('a')[1]!.v).toBe(20);
    // shift: ten
    const down = findShortcut(key('ArrowDown', { altKey: true, shiftKey: true }))!;
    expect(down.id).toBe('key-value-down');
    down.runKey!(key('ArrowDown', { altKey: true, shiftKey: true }));
    expect(keysOf('a')[1]!.v).toBe(10);
    // the step of a value is its feel: opacity moves by 1 %
    arm([ref('a', 'opacity', 1)]);
    stepKeyValuesBy(2);
    expect(keysOf('a', 'opacity')[0]!.v).toBeCloseTo(0.52, 9);
  });

  it('a refused step toasts once per 3 s', () => {
    // every toast that ever showed (they leave the store after 3 s)
    const seen: string[] = [];
    const ids = new Set<string>();
    const off = useUi.subscribe((s) => {
      for (const t of s.toasts) if (!ids.has(t.id)) {
        ids.add(t.id);
        seen.push(t.message);
      }
    });
    const said = () => seen.filter((m) => m === REASON_TEXT.keysAtValueMax).length;
    // 0.995 + 1 % passes 100 %
    arm([ref('a', 'opacity', 2)]);
    stepKeyValuesBy(1);
    expect(said()).toBe(1);
    for (let i = 0; i < 5; i++) stepKeyValuesBy(1, true);
    expect(said()).toBe(1);
    expect(keysOf('a', 'opacity')[1]!.v).toBe(0.995);
    expect(ed().past.length).toBe(0);
    vi.advanceTimersByTime(2900);
    stepKeyValuesBy(1, true);
    expect(said()).toBe(1);
    vi.advanceTimersByTime(300);
    stepKeyValuesBy(1, true);
    expect(said()).toBe(2);
    off();
    // down at the other end: its own text
    arm([ref('a', 'opacity', 1)]);
    stepKeyValuesBy(-100);
    expect(lastToast()).toBe(REASON_TEXT.keysAtValueMin);
  });

  it('next to a hold says so', () => {
    arm([ref('h', 'x', 2)], ['h']);
    const before = proj();
    easeKeysNow('into');
    expect(lastToast()).toBe('the selected keyframes sit next to holds: a hold has no handles');
    expect(proj()).toBe(before);
    easeKeysNow('easy');
    expect(lastToast()).toBe('1 keyframe eased. 1 next to a hold kept as they are');
    expect(keysOf('h')[0]!.ease).toBe('hold');
    expect(keysOf('h')[1]!.out).toEqual({ speed: 0, influence: 1 / 3 });
    expect(keysOf('h')[1]!.in).toBeUndefined();
    // a hold has no handles to join either
    open();
    arm([ref('h', 'x', 1)], ['h']);
    joinHandlesNow();
    expect(lastToast()).toBe(REASON_TEXT.noHandles);
  });

  it('closed panel and no keys say why', () => {
    const before = proj();
    ed().select(['a']);
    easeKeysNow('easy');
    expect(lastToast()).toBe(REASON_TEXT.openKeyPanel);
    joinHandlesNow();
    stepKeyValuesBy(1);
    addKeyOnLine('a', 'x', 1.5);
    expect(toasts()).toEqual([REASON_TEXT.openKeyPanel, REASON_TEXT.openKeyPanel, REASON_TEXT.openKeyPanel, REASON_TEXT.openKeyPanel]);
    expect(proj()).toBe(before);
    // open, nothing selected
    useUi.setState({ toasts: [] });
    openKeyPanel();
    easeKeysNow('easy');
    joinHandlesNow();
    expect(toasts()).toEqual([REASON_TEXT.selectKeys, REASON_TEXT.selectKeys]);
    stepKeyValuesBy(1);
    expect(lastToast()).toBe(REASON_TEXT.selectKeys);
    expect(proj()).toBe(before);
    // keys of a clip that is not selected are not shown
    ui().setKeySel([ref('h', 'x', 2)]);
    easeKeysNow('easy');
    expect(lastToast()).toBe(REASON_TEXT.selectKeys);
    // a drag in progress: nothing happens, nothing is said
    arm([ref('a', 'x', 2)]);
    useUi.setState({ toasts: [] });
    interaction.gestureActive = true;
    easeKeysNow('easy');
    stepKeyValuesBy(1);
    addKeyOnLine('a', 'x', 1.5);
    expect(toasts()).toEqual([]);
    expect(proj()).toBe(before);
    interaction.gestureActive = false;
    // a key on a line: a key
    addKeyOnLine('a', 'x', 1.5);
    expect(keysOf('a').map((x) => x.t)).toEqual([1, 1.5, 2, 3]);
    expect(ed().past.length).toBe(1);
    ui().setKeySel([]);
    expect(ui().keySel).toEqual([]);
  });

  it('a key on a locked line is refused with its text', () => {
    arm([ref('a', 'x', 2)]);
    const t = proj().tracks[0]!;
    useEditor.setState({ project: { ...proj(), tracks: proj().tracks.map((x) => (x.id === t.id ? { ...x, locked: true } : x)) } });
    addKeyOnLine('a', 'x', 1.5);
    expect(lastToast()).toBe(REASON_TEXT.trackLocked);
    expect(keysOf('a').length).toBe(3);
  });

  it('graph view toggles', () => {
    const kp = () => useKeyPanel.getState();
    toggleGraphView();
    expect(kp().open).toBe(true);
    expect(kp().mode).toBe('graph');
    toggleGraphView();
    expect(kp().open).toBe(true);
    expect(kp().mode).toBe('keys');
    toggleGraphView();
    expect(kp().mode).toBe('graph');
    // the kind
    showGraph('speed');
    expect(useGraph.getState().kind).toBe('speed');
    showGraph();
    expect(useGraph.getState().kind).toBe('speed');
    showGraph('value');
    expect(useGraph.getState().kind).toBe('value');
    // from the rows: graph
    kp().setMode('keys');
    showGraph();
    expect(kp().mode).toBe('graph');
    // auto fit
    expect(useGraph.getState().autoFit).toBe(true);
    toggleAutoFit();
    expect(useGraph.getState().autoFit).toBe(false);
    toggleAutoFit();
    expect(useGraph.getState().autoFit).toBe(true);
  });

  it('fit waits for the plot', () => {
    // nothing mounted: the fit is kept for the plot to run
    fitGraphAll();
    expect(useKeyPanel.getState().open).toBe(true);
    expect(useKeyPanel.getState().mode).toBe('graph');
    expect(useGraph.getState().pendingFit).toBe('all');
    expect(useGraph.getState().autoFit).toBe(true);
    useGraph.getState().setPendingFit(null);
    useGraph.getState().setAutoFit(false);
    fitGraphSelected();
    expect(useGraph.getState().pendingFit).toBe('selected');
    // selected keeps auto fit as it was, all turns it on
    expect(useGraph.getState().autoFit).toBe(false);
    useGraph.getState().setPendingFit(null);
    fitGraphAll();
    expect(useGraph.getState().autoFit).toBe(true);
    // mounted: it runs now
    useGraph.getState().setPendingFit(null);
    const frameAll = vi.fn();
    const frameSelected = vi.fn();
    graphCommands.frameAll = frameAll;
    graphCommands.frameSelected = frameSelected;
    fitGraphAll();
    expect(frameAll).toHaveBeenCalledTimes(1);
    expect(useGraph.getState().pendingFit).toBeNull();
    fitGraphSelected();
    expect(frameSelected).toHaveBeenCalledTimes(1);
    expect(frameAll).toHaveBeenCalledTimes(1);
    expect(useGraph.getState().pendingFit).toBeNull();
  });
});
