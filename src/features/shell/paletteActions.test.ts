import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, createShapeClip, createTextClip, createTrack } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { rankItem } from './paletteSearch';
import { paletteActions } from './paletteActions';
import { REASON_TEXT, reasonSnapshot } from './reasons';
import { SHORTCUTS } from './shortcuts';

vi.mock('../../store/session', () => ({ closeProject: vi.fn(), exportProjectFile: vi.fn() }));

const NEW_IDS = [
  'zoom-selection', 'split-all', 'clear-keys', 'detach', 'select-effects', 'insert-gap', 'close-gaps', 'marker-delete', 'mark-beats',
  'show-sky', 'show-fog', 'show-light', 'project-panel', 'guides', 'floor-grid', 'output-inset',
  'quality-full', 'quality-half', 'quality-quarter', 'tool-move', 'tool-rotate', 'tool-scale',
  'speed-quarter', 'speed-one-half', 'reset-layout',
];

const find = (id: string) => paletteActions().find((a) => a.id === id)!;

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  usePlayback.setState({ time: 0 });
});

describe('palette actions', () => {
  it('ids are unique and the extras do not reuse a table id', () => {
    const ids = paletteActions().map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const table = new Set(SHORTCUTS.map((s) => s.id));
    const extras = ids.slice(SHORTCUTS.filter((s) => !s.info && s.id !== 'palette').length);
    for (const id of extras) expect(table.has(id), id).toBe(false);
  });

  it('every new row is there', () => {
    const ids = new Set(paletteActions().map((a) => a.id));
    for (const id of [...NEW_IDS, 'clip-menu', 'zoom-fit']) expect(ids.has(id), id).toBe(true);
  });

  it('every why gives a string or null, with no project and on an empty project', () => {
    for (const a of paletteActions()) {
      if (!a.why) continue;
      const none = a.why(reasonSnapshot());
      expect(none === null || typeof none === 'string', a.id).toBe(true);
    }
    useEditor.getState().openProject({ ...createProject('empty'), clips: [] });
    for (const a of paletteActions()) {
      if (!a.why) continue;
      const r = a.why(reasonSnapshot());
      expect(r === null || typeof r === 'string', a.id).toBe(true);
    }
  });

  it('an empty selection gives the reasons of zoom-selection, clear-keys, detach, select-effects, close-gaps', () => {
    useEditor.getState().openProject({ ...createProject('empty'), clips: [] });
    const snap = reasonSnapshot();
    for (const id of ['zoom-selection', 'clear-keys', 'detach', 'select-effects', 'close-gaps']) {
      expect(find(id).why?.(snap), id).toBe(REASON_TEXT.selectClip);
    }
    expect(find('split-all').why?.(snap)).toBe(REASON_TEXT.addClip);
  });

  it('cut at the markers is now split, and cut at the markers still finds it', () => {
    const a = find('cut-at-markers');
    expect(a.title).toBe('split the selected clips at the markers');
    expect(rankItem('cut at the markers', a)).not.toBeNull();
    expect(rankItem('split at the markers', a)).not.toBeNull();
  });

  it('the bend and pivot rows come last, in order, and need no why', () => {
    const all = paletteActions();
    const last = all.slice(-4);
    expect(last.map((a) => a.id)).toEqual(['bend-together', 'bend-flat', 'move-pivot', 'pivot-middle']);
    for (const a of last) expect(a.why).toBeUndefined();
  });
  it('bend together on a keyed leader only fits: no new key at the playhead', () => {
    const base = createProject('bend');
    const t1 = base.tracks[0]!.id;
    const keys = [
      { t: 0, v: 0, ease: 'linear' as const },
      { t: 2, v: 90, ease: 'linear' as const },
    ];
    const a = createShapeClip(t1, 0, { id: 'a', width: 100, height: 100, duration: 4, keyframes: { 'bend.angle': keys } });
    const b = createShapeClip(t1, 0, { id: 'b', width: 100, height: 100, duration: 4 });
    useEditor.getState().openProject({ ...base, clips: [a, b] });
    useEditor.setState({ selection: ['a', 'b'] });
    usePlayback.setState({ time: 1 });
    find('bend-together').run();
    for (const c of useEditor.getState().project!.clips) expect(c.keyframes?.['bend.angle']?.map((k) => k.t)).toEqual([0, 2]);
  });

  it('close-gaps takes the track from project order, so a shown reason means no change', () => {
    const base = createProject('gaps');
    const t1 = base.tracks[0]!.id;
    const t2 = createTrack('video', 'video 2');
    const a = { ...createTextClip(t1, 0), id: 'a', duration: 2 };
    const b = { ...createTextClip(t2.id, 0), id: 'b', duration: 2 };
    const c = { ...createTextClip(t2.id, 5), id: 'c', duration: 2 };
    useEditor.getState().openProject({ ...base, tracks: [...base.tracks, t2], clips: [a, b, c] });
    for (const sel of [['b', 'a'], ['a', 'b']]) {
      useEditor.setState({ selection: sel });
      const before = JSON.stringify(useEditor.getState().project);
      const act = find('close-gaps');
      if (act.why?.(reasonSnapshot())) {
        act.run();
        expect(JSON.stringify(useEditor.getState().project)).toBe(before);
      }
    }
  });
});
