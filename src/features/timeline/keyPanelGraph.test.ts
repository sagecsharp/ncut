import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImageClip, Keyframe, MediaAsset, Project } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import type { KeyRef } from '../../store/ui';
import { REASON_TEXT } from '../shell/reasons';
import { keyRefFilter, keyStopText, selectAllKeysNow } from './keyLaneActions';
import { DEFAULT_KEY_PANEL, GRAPH_H_DEFAULT, KEY_PANEL_H_DEFAULT, keyPanelHeight, parseKeyPanelPrefs, useKeyPanel } from './keyPanelState';
import { planAddKey, planGraphMove, planHandleSet } from './graphPlan';
import { laneId } from './keySelection';
import { interaction } from './view';

const k = (t: number, v = 0): Keyframe => ({ t, v, ease: 'linear' });
const asset: MediaAsset = { id: 'img1', name: 'img1', kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 };
const image = (trackId: string, id: string, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start: 0, duration: 10, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});

beforeEach(() => {
  useKeyPanel.setState({ ...DEFAULT_KEY_PANEL });
  useUi.setState({ toasts: [], keySel: [], keyFocus: false });
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  keyRefFilter.shows = undefined;
  interaction.gestureActive = false;
});

afterEach(() => {
  keyRefFilter.shows = undefined;
});

describe('the keyframe panel in graph mode', () => {
  it('graph height clamped', () => {
    expect(parseKeyPanelPrefs({ graphHeight: 10 }).graphHeight).toBe(72);
    expect(parseKeyPanelPrefs({ graphHeight: 5000 }).graphHeight).toBe(2000);
    expect(parseKeyPanelPrefs({ graphHeight: 300.4 }).graphHeight).toBe(300);
    expect(parseKeyPanelPrefs({ graphHeight: 'tall' }).graphHeight).toBe(GRAPH_H_DEFAULT);
    expect(parseKeyPanelPrefs({ graphHeight: NaN }).graphHeight).toBe(260);
    // the rows height is its own
    expect(parseKeyPanelPrefs({ height: 100, graphHeight: 500 })).toEqual({ open: false, mode: 'keys', height: 100, graphHeight: 500 });
  });

  it('keyPanelHeight follows the mode', () => {
    const p = { open: true, mode: 'keys' as const, height: 120, graphHeight: 330 };
    expect(keyPanelHeight(p)).toBe(120);
    expect(keyPanelHeight({ ...p, mode: 'graph' })).toBe(330);
    expect(keyPanelHeight(DEFAULT_KEY_PANEL)).toBe(KEY_PANEL_H_DEFAULT);
    expect(keyPanelHeight({ ...DEFAULT_KEY_PANEL, mode: 'graph' })).toBe(GRAPH_H_DEFAULT);
  });

  it('setHeight writes the shown mode', () => {
    useKeyPanel.getState().setHeight(200);
    expect(useKeyPanel.getState().height).toBe(200);
    expect(useKeyPanel.getState().graphHeight).toBe(260);
    useKeyPanel.getState().setMode('graph');
    useKeyPanel.getState().setHeight(400);
    expect(useKeyPanel.getState().graphHeight).toBe(400);
    expect(useKeyPanel.getState().height).toBe(200);
    expect(keyPanelHeight(useKeyPanel.getState())).toBe(400);
    // too small or too big: clamped, not a number: nothing
    useKeyPanel.getState().setHeight(5);
    expect(useKeyPanel.getState().graphHeight).toBe(72);
    useKeyPanel.getState().setHeight(NaN);
    expect(useKeyPanel.getState().graphHeight).toBe(72);
  });

  it('resetHeight gives 160 and 260', () => {
    useKeyPanel.setState({ open: true, mode: 'graph', height: 300, graphHeight: 500 });
    useKeyPanel.getState().resetHeight();
    const s = useKeyPanel.getState();
    expect(s.height).toBe(160);
    expect(s.graphHeight).toBe(260);
    expect(s.open).toBe(true);
    expect(s.mode).toBe('graph');
  });

  it('keyStopText for value and handle stops', () => {
    expect(keyStopText({ kind: 'valueMin', clipId: 'a' })).toBe(REASON_TEXT.keysAtValueMin);
    expect(keyStopText({ kind: 'valueMax', clipId: 'a' })).toBe(REASON_TEXT.keysAtValueMax);
    expect(keyStopText({ kind: 'noHandles', clipId: 'a' })).toBe(REASON_TEXT.noHandles);
    expect(REASON_TEXT.keysAtValueMin).toMatch(/lowest value/);
    expect(REASON_TEXT.keysAtValueMax).toMatch(/highest value/);
    expect(REASON_TEXT.noHandles).toMatch(/bounce, elastic and hold/);
    // the stops the graph planners give say these
    const p: Project = { ...createProject('stops', undefined, 30), clips: [] };
    const clip = image(p.tracks[0]!.id, 'a', { keyframes: { opacity: [k(0, 0.9), k(1, 0.5)], x: [{ t: 0, v: 0, ease: 'hold' }, k(1, 5)] } });
    const q = { ...p, clips: [clip] };
    const up = planGraphMove(q, [{ clipId: 'a', prop: 'opacity', t: 0 }], 0, -50, new Map([[laneId('a', 'opacity'), 0.01]]));
    expect(keyStopText(up.stop!)).toBe(REASON_TEXT.keysAtValueMax);
    const flat = planHandleSet(q, [{ clipId: 'a', prop: 'x', t: 0 }], 'out', { speed: 1 }, true);
    expect(keyStopText(flat.stop!)).toBe(REASON_TEXT.noHandles);
    const locked = planAddKey({ ...q, tracks: q.tracks.map((t) => ({ ...t, locked: true })) }, 'a', 'x', 0.5);
    expect(keyStopText(locked.stop!)).toBe(REASON_TEXT.trackLocked);
  });

  it('select all keeps shown lines', () => {
    setup();
    useEditor.getState().select(['a']);
    const all = (): KeyRef[] => useUi.getState().keySel;
    selectAllKeysNow();
    expect(all().map((r) => `${r.prop}@${r.t}`).sort()).toEqual(['opacity@1', 'x@1', 'x@2', 'x@3']);
    // a hidden line has no selectable key
    keyRefFilter.shows = (r) => r.prop !== 'x';
    useUi.getState().setKeySel([]);
    selectAllKeysNow();
    expect(all()).toEqual([{ clipId: 'a', prop: 'opacity', t: 1 }]);
    // every line hidden: nothing to select, it says so
    keyRefFilter.shows = () => false;
    useUi.getState().setKeySel([]);
    selectAllKeysNow();
    expect(all()).toEqual([]);
    expect(useUi.getState().toasts.at(-1)?.message).toBe(REASON_TEXT.noKeys);
  });
});

/** a project with clip a: x keyed at 1, 2, 3 and opacity at 1 */
function setup(): void {
  useEditor.getState().openProject({ ...createProject('graphkeys'), assets: [asset], clips: [] });
  const t = useEditor.getState().project!.tracks[0]!.id;
  const clip = image(t, 'a', { keyframes: { x: [k(1, 10), k(2, 20), k(3, 30)], opacity: [k(1, 0.5)] } });
  useEditor.setState({ project: { ...useEditor.getState().project!, clips: [clip] }, past: [], future: [], selection: [] });
}
