import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip, ImageClip, Keyframe, MediaAsset, Project } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { KeyRef } from '../../store/ui';
import { getKeyCopy, hasKeyCopy, setKeyCopy } from '../properties/keyClipboard';
import { REASON_TEXT } from '../shell/reasons';
import { SHORTCUTS } from '../shell/shortcuts';
import { useKeyPanel } from './keyPanelState';
import {
  clearKeySel, closeKeyPanel, copyKeysNow, cutKeysNow, deleteKeysNow, followKeySel, keyPanelHasKeys as reexported, keyStopText, nudgeKeysBy, openKeyPanel, pasteKeysNow, selectAllKeysNow, setKeysEaseNow, shownKeyClipIds, toggleKeyPanel,
} from './keyLaneActions';
import { keyPanelHasKeys } from './keyPanelState';
import { interaction } from './view';

const ed = () => useEditor.getState();
const ui = () => useUi.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): ImageClip => proj().clips.find((c) => c.id === id) as ImageClip;
const timesOf = (id: string, prop = 'x'): number[] => (clipOf(id).keyframes?.[prop] ?? []).map((k) => k.t);
const toasts = (): string[] => ui().toasts.map((t) => t.message);
const lastToast = (): string => toasts().at(-1) ?? '';
const k = (t: number, v = 0): Keyframe => ({ t, v, ease: 'linear' });
const ref = (clipId: string, prop: string, t: number): KeyRef => ({ clipId, prop, t });

const asset: MediaAsset = { id: 'img1', name: 'img1', kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 };
const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});

/** a: keys x at 1, 2, 3. b: no keys. c: one key. all 10 s on two video tracks */
function open(): void {
  ed().openProject({ ...createProject('keyactions'), assets: [asset], clips: [] });
  ed().addTrack('video');
  const t = proj().tracks.map((x) => x.id);
  const clips: Clip[] = [
    image(t[0]!, 'a', 0, 10, { keyframes: { x: [k(1, 10), k(2, 20), k(3, 30)] } }),
    image(t[1]!, 'b', 0, 10),
    image(t[1]!, 'c', 20, 10, { keyframes: { x: [k(1, 5)] } }),
  ];
  useEditor.setState({ project: { ...proj(), clips }, past: [], future: [], selection: [] });
}

/** each test starts at its own time: the 3 s toast memory of one never reaches the next */
let clock = 1_000_000;
let off: (() => void) | null = null;

beforeEach(() => {
  clock += 60_000;
  vi.useFakeTimers();
  vi.setSystemTime(clock);
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useUi.setState({ toasts: [], keySel: [], keyFocus: false });
  useKeyPanel.setState({ open: false });
  usePlayback.setState({ time: 0 });
  setKeyCopy(null);
  interaction.gestureActive = false;
  open();
});

afterEach(() => {
  off?.();
  off = null;
  interaction.gestureActive = false;
  vi.useRealTimers();
});

/** the panel open and focused, the clips selected, these keys selected */
function arm(sel: KeyRef[], clips: string[] = ['a']): void {
  openKeyPanel();
  ed().select(clips);
  ui().setKeyFocus(true);
  ui().setKeySel(sel);
}

describe('keyLaneActions', () => {
  it('keyPanelHasKeys needs focus and open', () => {
    expect(reexported).toBe(keyPanelHasKeys);
    expect(keyPanelHasKeys()).toBe(false);
    ui().setKeyFocus(true);
    expect(keyPanelHasKeys()).toBe(false);
    openKeyPanel();
    expect(keyPanelHasKeys()).toBe(true);
    ui().setKeyFocus(false);
    expect(keyPanelHasKeys()).toBe(false);
    toggleKeyPanel();
    expect(useKeyPanel.getState().open).toBe(false);
    toggleKeyPanel();
    expect(useKeyPanel.getState().open).toBe(true);
  });

  it('delete removes keys, never clips', () => {
    arm([ref('a', 'x', 1), ref('a', 'x', 2)]);
    deleteKeysNow();
    expect(proj().clips.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(timesOf('a')).toEqual([3]);
    expect(lastToast()).toBe('2 keyframes deleted');
    expect(ui().keySel).toEqual([]);
    expect(ed().past).toHaveLength(1);
    ui().setKeySel([ref('a', 'x', 3)]);
    deleteKeysNow();
    expect(lastToast()).toBe('1 keyframe deleted');
    // the value lost its last key: it keeps its value at the playhead
    expect(clipOf('a').keyframes).toBeUndefined();
    expect(ed().selection).toEqual(['a']);
  });

  it('nothing selected says why', () => {
    arm([]);
    const before = proj();
    deleteKeysNow();
    expect(lastToast()).toBe(REASON_TEXT.selectKeys);
    copyKeysNow();
    expect(lastToast()).toBe(REASON_TEXT.selectKeys);
    cutKeysNow();
    setKeysEaseNow('hold');
    expect(proj()).toBe(before);
    expect(ed().past).toHaveLength(0);
    expect(hasKeyCopy()).toBe(false);
    pasteKeysNow();
    expect(lastToast()).toBe(REASON_TEXT.copyKeysFirst);
    setKeyCopy({ items: [{ clipId: 'a', keys: { x: [k(0, 1)] } }] });
    ed().select([]);
    pasteKeysNow();
    expect(lastToast()).toBe(REASON_TEXT.selectClip);
    selectAllKeysNow();
    expect(lastToast()).toBe(REASON_TEXT.selectClip);
    ed().select(['b']);
    selectAllKeysNow();
    expect(lastToast()).toBe(REASON_TEXT.noKeys);
    // keys of clips that are no longer shown do not count
    ui().setKeySel([ref('c', 'x', 1)]);
    deleteKeysNow();
    expect(lastToast()).toBe(REASON_TEXT.selectKeys);
    // a busy pointer gesture: nothing happens, nothing is said
    interaction.gestureActive = true;
    useUi.setState({ toasts: [] });
    deleteKeysNow();
    selectAllKeysNow();
    expect(toasts()).toEqual([]);
  });

  it('copy, paste onto another clip', () => {
    arm([ref('a', 'x', 1), ref('a', 'x', 3)]);
    copyKeysNow();
    expect(lastToast()).toBe('2 keyframes copied');
    expect(getKeyCopy()!.items[0]!.keys.x!.map((x) => x.t)).toEqual([0, 2]);
    ed().select(['b']);
    usePlayback.setState({ time: 4 });
    pasteKeysNow();
    expect(lastToast()).toBe('2 keyframes pasted');
    expect(timesOf('b')).toEqual([4, 6]);
    expect(clipOf('b').keyframes!.x!.map((x) => x.v)).toEqual([10, 30]);
    expect(ui().keySel.map((r) => [r.clipId, r.t])).toEqual([['b', 4], ['b', 6]]);
    expect(ed().past).toHaveLength(1);
    expect(timesOf('a')).toEqual([1, 2, 3]);
    // the playhead off the clip
    usePlayback.setState({ time: 50 });
    pasteKeysNow();
    expect(lastToast()).toBe(REASON_TEXT.playheadOnClip);
    // onto two clips, and what the clip cannot animate is said
    setKeyCopy({ items: [{ clipId: 'gone', keys: { x: [k(0, 1)], volume: [k(0, 1)] } }] });
    ed().select(['a', 'b']);
    usePlayback.setState({ time: 8 });
    pasteKeysNow();
    expect(lastToast()).toBe('2 keyframes pasted on 2 clips. left out: volume, the clip cannot animate them');
    // a copy nothing fits
    setKeyCopy({ items: [{ clipId: 'gone', keys: { volume: [k(0, 1)] } }] });
    pasteKeysNow();
    expect(lastToast()).toBe(REASON_TEXT.keysNotHere);
  });

  it('cut is one step', () => {
    arm([ref('a', 'x', 1), ref('a', 'x', 2)]);
    const before = proj();
    cutKeysNow();
    expect(lastToast()).toBe('2 keyframes copied and deleted');
    expect(timesOf('a')).toEqual([3]);
    expect(hasKeyCopy()).toBe(true);
    expect(ed().past).toHaveLength(1);
    ed().undo();
    expect(proj().clips).toEqual(before.clips);
    // paste what was cut onto b
    ed().select(['b']);
    usePlayback.setState({ time: 1 });
    pasteKeysNow();
    expect(timesOf('b')).toEqual([1, 2]);
  });

  it('select all opens the panel', () => {
    ed().select(['a', 'c']);
    expect(useKeyPanel.getState().open).toBe(false);
    selectAllKeysNow();
    expect(useKeyPanel.getState().open).toBe(true);
    expect(ui().keySel.map((r) => r.clipId + r.t)).toEqual(['a1', 'a2', 'a3', 'c1']);
    expect(shownKeyClipIds()).toEqual(['a', 'c']);
    // open already: the same, no toast
    ui().setKeySel([]);
    selectAllKeysNow();
    expect(ui().keySel).toHaveLength(4);
    expect(toasts()).toEqual([]);
  });

  it('esc in the panel clears keys only', () => {
    arm([ref('a', 'x', 1)]);
    const deselect = SHORTCUTS.find((s) => s.id === 'deselect')!;
    deselect.run();
    expect(ui().keySel).toEqual([]);
    expect(ed().selection).toEqual(['a']);
    // nothing selected: nothing happens, the clips stay
    deselect.run();
    expect(ed().selection).toEqual(['a']);
    expect(clearKeySel()).toBe(false);
    ui().setKeySel([ref('a', 'x', 1)]);
    expect(clearKeySel()).toBe(true);
    expect(ui().keySel).toEqual([]);
    // the focus is not in the panel: esc clears the clips as before
    ui().setKeyFocus(false);
    deselect.run();
    expect(ed().selection).toEqual([]);
  });

  it('held nudge is one step', () => {
    arm([ref('a', 'x', 1)]);
    const before = proj();
    nudgeKeysBy(1);
    nudgeKeysBy(1, true);
    nudgeKeysBy(1, true);
    expect(timesOf('a')[0]).toBeCloseTo(1 + 3 / 30, 9);
    expect(ed().past).toHaveLength(1);
    expect(ui().keySel[0]!.t).toBeCloseTo(1 + 3 / 30, 9);
    ed().undo();
    expect(proj().clips).toEqual(before.clips);
    // another step in between: a repeat starts its own
    ui().setKeySel([ref('a', 'x', 1)]);
    nudgeKeysBy(1);
    ed().setClipKeyframes('c', { x: [k(1, 6)] });
    nudgeKeysBy(1, true);
    expect(ed().past).toHaveLength(3);
  });

  it('refused nudge toasts once', () => {
    arm([ref('a', 'x', 1)]);
    const before = proj();
    nudgeKeysBy(-60);
    expect(toasts()).toEqual([REASON_TEXT.keysAtStart]);
    nudgeKeysBy(-60, true);
    nudgeKeysBy(-60, true);
    expect(toasts()).toEqual([REASON_TEXT.keysAtStart]);
    expect(proj()).toBe(before);
    expect(ed().past).toHaveLength(0);
    // 3 s later the same refusal speaks again
    vi.setSystemTime(clock + 3001);
    nudgeKeysBy(-60);
    expect(toasts()).toEqual([REASON_TEXT.keysAtStart, REASON_TEXT.keysAtStart]);
    // a nudge into a key
    ui().setKeySel([ref('a', 'x', 1)]);
    nudgeKeysBy(30);
    expect(lastToast()).toBe(REASON_TEXT.keyInTheWay);
    expect(keyStopText({ kind: 'end', clipId: 'a' })).toBe(REASON_TEXT.keysAtEnd);
    expect(keyStopText({ kind: 'locked', clipId: 'a' })).toBe(REASON_TEXT.trackLocked);
  });

  it('followKeySel prunes on a selection change', () => {
    off = followKeySel();
    arm([ref('a', 'x', 1), ref('a', 'x', 2)], ['a', 'c']);
    ui().setKeySel([ref('a', 'x', 1), ref('c', 'x', 1)]);
    ed().select(['a']);
    expect(ui().keySel).toEqual([ref('a', 'x', 1)]);
    // a key that is gone goes from the selection when the clip changes
    ed().setClipKeyframes('a', { x: [k(2, 20), k(3, 30)] });
    expect(ui().keySel).toEqual([]);
    // closing the project clears it
    ui().setKeySel([ref('a', 'x', 2)]);
    useEditor.setState({ project: null });
    expect(ui().keySel).toEqual([]);
  });

  it('undo and redo restore the key selection', () => {
    off = followKeySel();
    arm([ref('a', 'x', 1), ref('a', 'x', 2)]);
    deleteKeysNow();
    expect(ui().keySel).toEqual([]);
    ed().undo();
    expect(ui().keySel).toEqual([ref('a', 'x', 1), ref('a', 'x', 2)]);
    ed().redo();
    expect(ui().keySel).toEqual([]);
    ed().undo();
    // a nudge: the moved keys are selected, undo selects them where they were
    ui().setKeySel([ref('a', 'x', 3)]);
    nudgeKeysBy(3);
    expect(ui().keySel[0]!.t).toBeCloseTo(3.1, 9);
    ed().undo();
    expect(ui().keySel).toEqual([ref('a', 'x', 3)]);
    ed().redo();
    expect(ui().keySel[0]!.t).toBeCloseTo(3.1, 9);
  });

  it('close clears selection and focus', () => {
    arm([ref('a', 'x', 1)]);
    expect(ui().keyFocus).toBe(true);
    closeKeyPanel();
    expect(useKeyPanel.getState().open).toBe(false);
    expect(ui().keySel).toEqual([]);
    expect(ui().keyFocus).toBe(false);
    expect(keyPanelHasKeys()).toBe(false);
    expect(ed().selection).toEqual(['a']);
  });
});
