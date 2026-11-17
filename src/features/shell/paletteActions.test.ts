import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EASINGS } from '../../lib/anim';
import { createProject, createShapeClip, createTextClip, createTrack } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { rankItem } from './paletteSearch';
import { paletteActions } from './paletteActions';
import { REASON_IDS, REASON_TEXT, reasonSnapshot } from './reasons';
import { SHORTCUTS } from './shortcuts';

vi.mock('../../store/session', () => ({ closeProject: vi.fn(), exportProjectFile: vi.fn() }));

const NEW_IDS = [
  'zoom-selection', 'split-all', 'clear-keys', 'detach', 'select-effects', 'insert-gap', 'close-gaps', 'marker-delete', 'mark-beats',
  'show-sky', 'show-fog', 'show-light', 'project-panel', 'guides', 'floor-grid', 'output-inset',
  'quality-full', 'quality-half', 'quality-quarter', 'tool-move', 'tool-rotate', 'tool-scale',
  'speed-quarter', 'speed-one-half', 'reset-layout',
  'scopes-waveform', 'scopes-parade', 'scopes-vectorscope', 'scopes-histogram', 'scopes-exact',
  'slip-earlier', 'slip-later', 'slide-left', 'slide-right',
  'side-by-side', 'media-skim', 'source-empty', 'source-add',
  'mark-selection', 'clear-in', 'clear-out',
  'join-sound', 'move-into-sync', 'slip-into-sync', 'select-sound', 'select-picture',
  'solo-selection', 'solo-off', 'mixer-reset', 'measure-loudness',
  'time-display-timecode', 'time-display-frames', 'time-display-seconds',
  'grade-show', 'grade-on-off', 'grade-reset', 'grade-copy', 'grade-paste', 'grade-add',
  'replace-edit', 'fit-edit', 'append-edit', 'edit-targets-auto', 'edit-targets-selected',
  'lut-import', 'lut-off', 'lut-save',
  'crossfade-track', 'crossfade-track-off', 'fade-shape-power', 'fade-shape-linear', 'fade-shape-smooth',
  'matte-show', 'matte-above', 'matte-remove', 'matte-select',
];

const KEY_IDS = [
  'keys-delete', 'keys-copy', 'keys-paste', 'keys-select-all', 'keys-nudge-left', 'keys-nudge-right',
  ...['linear', 'ease', 'ease-in', 'ease-out', 'back', 'bounce', 'elastic', 'hold'].map((e) => 'keys-ease-' + e),
];
const GRAPH_IDS = ['keys-ease-bezier', 'keys-join-handles', 'graph-value', 'graph-speed', 'graph-fit-all', 'graph-fit-selected', 'graph-auto-fit'];
const TRACK_IDS = ['tracks-normal', 'track-up', 'track-down', 'sync-lock-toggle'];
const EXPORT_IDS = [
  'export-transparent', 'export-codec', 'export-bitrate', 'export-interval', 'export-size', 'export-audio',
  'export-youtube', 'export-youtube-4k', 'export-vimeo', 'export-reels', 'export-master',
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
  it('the new rows come in the plan order, the scopes after the output inset', () => {
    const ids = paletteActions().map((a) => a.id);
    const inset = ids.indexOf('output-inset');
    expect(ids.slice(inset + 1, inset + 6)).toEqual(NEW_IDS.slice(25, 30));
    const bend = ids.indexOf('bend-together');
    expect(ids.slice(bend - 46, bend)).toEqual(NEW_IDS.slice(30));
    expect(NEW_IDS.length).toBe(25 + 5 + 33 + 13);
  });
  it('the new search rows with a reason id have a why', () => {
    let withReason = 0;
    for (const id of NEW_IDS.slice(25)) {
      const a = find(id);
      expect(a.keys, id).toEqual([]);
      if (!REASON_IDS.has(id) && !id.startsWith('time-display-')) {
        expect(a.why, id).toBeUndefined();
        continue;
      }
      expect(typeof a.why, id).toBe('function');
      withReason++;
    }
    expect(withReason).toBe(40);
    for (const id of ['slip-earlier', 'slip-later', 'slide-left', 'slide-right', 'source-add', 'mark-selection', 'clear-in', 'clear-out', 'join-sound', 'solo-selection', 'solo-off', 'mixer-reset', 'grade-show', 'grade-copy', 'grade-paste', 'replace-edit', 'fit-edit', 'append-edit']) {
      expect(REASON_IDS.has(id), id).toBe(true);
    }
  });
  it('the keyframe panel rows follow clear-keys', () => {
    const ids = paletteActions().map((a) => a.id);
    const at = ids.indexOf('clear-keys');
    expect(ids.slice(at + 1, at + 15)).toEqual(KEY_IDS);
    for (const id of KEY_IDS) {
      const a = find(id);
      expect(a.keys, id).toEqual([]);
      expect(a.group, id).toBe('animation');
      expect(typeof a.why, id).toBe('function');
    }
  });
  it('the easing rows are the EASINGS of the table', () => {
    expect(KEY_IDS.slice(6)).toEqual(EASINGS.map((e) => 'keys-ease-' + e.id));
  });
  it('the graph rows follow the keyframe panel rows', () => {
    const ids = paletteActions().map((a) => a.id);
    const at = ids.indexOf('keys-ease-hold');
    expect(ids.slice(at + 1, at + 8)).toEqual(GRAPH_IDS);
    for (const id of GRAPH_IDS) {
      const a = find(id);
      expect(a.keys, id).toEqual([]);
      expect(a.group, id).toBe('animation');
      expect(typeof a.why === 'function', id).toBe(REASON_IDS.has(id));
    }
  });
  it('the track rows come right after close-gaps and have a why', () => {
    const ids = paletteActions().map((a) => a.id);
    const at = ids.indexOf('close-gaps');
    expect(ids.slice(at + 1, at + 5)).toEqual(TRACK_IDS);
    for (const id of TRACK_IDS) {
      expect(find(id).keys, id).toEqual([]);
      expect(typeof find(id).why, id).toBe('function');
    }
    expect(find('sync-lock-toggle').group).toBe('editing');
    expect(find('insert-gap').title).toBe('insert a 1 second gap at the playhead (unlocked tracks with sync lock on)');
  });
  it('the export rows follow reset-layout and want a clip', () => {
    const ids = paletteActions().map((a) => a.id);
    const at = ids.indexOf('reset-layout');
    expect(ids.slice(at + 1, at + 12)).toEqual(EXPORT_IDS);
    useEditor.getState().openProject({ ...createProject('empty'), clips: [] });
    const snap = reasonSnapshot();
    for (const id of EXPORT_IDS) {
      const a = find(id);
      expect(a.group, id).toBe('app');
      expect(a.keys, id).toEqual([]);
      expect(a.why?.(snap), id).toBe(REASON_TEXT.addClip);
    }
  });
  it('export-loudness follows export-master and wants a clip', () => {
    const ids = paletteActions().map((a) => a.id);
    expect(ids[ids.indexOf('export-master') + 1]).toBe('export-loudness');
    useEditor.getState().openProject({ ...createProject('empty'), clips: [] });
    expect(find('export-loudness').why?.(reasonSnapshot())).toBe(REASON_TEXT.addClip);
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
