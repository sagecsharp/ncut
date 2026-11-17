import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Clip, ImageClip, MediaAsset, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { attachClips } from '../properties/attachActions';
import { clearKeysOf, closeGapsOnTrack, insertGapAt, selectEffectsOf, selectLike } from '../timeline/actions';
import { cutAtMarkers, fitToMarkers, makeRow } from '../timeline/sequenceActions';
import { REASON_IDS, REASON_TEXT, reasonFor, reasonSnapshot } from './reasons';
import type { ReasonInput } from './reasons';
import { SHORTCUTS } from './shortcuts';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;

const asset = (id: string, kind: 'image' | 'video' | 'audio' = 'image', duration = 0): MediaAsset => ({
  id, name: id, kind, mime: kind + '/x', size: 1, duration, width: 100, height: 100, hasAudio: kind !== 'image', createdAt: 0,
});
const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const video = (trackId: string, id: string, start: number, duration: number): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'vid1', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM },
});
const audio = (trackId: string, id: string, start: number, duration: number): AudioClip => ({
  id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'aud1', trimStart: 0, speed: 1, volume: 1, muted: false,
});

interface Setup {
  clips?: boolean;
  markers?: number[];
  select?: string[];
  time?: number;
  lock?: boolean;
  clipboard?: number;
  keys?: boolean;
}

/** t0, t1, t2 video tracks, t3 audio. clips: a (0..2) and b (3..5) images, v (6..8) video, au (0..5) audio */
function open(s: Setup = {}): string[] {
  const p = createProject('reasons');
  ed().openProject({ ...p, assets: [asset('img1'), asset('vid1', 'video', 10), asset('aud1', 'audio', 60)], clips: [] });
  for (let i = 0; i < 3; i++) ed().addTrack('video');
  const t = proj().tracks.map((x) => x.id);
  const a = image(t[0]!, 'a', 0, 2, s.keys ? { keyframes: { x: [{ t: 0, v: 0, ease: 'linear' }] } } : {});
  const clips: Clip[] = s.clips === false ? [] : [a, image(t[1]!, 'b', 3, 2), video(t[2]!, 'v', 6, 2), audio(t[3]!, 'au', 0, 5)];
  const markers = (s.markers ?? []).map((time, i) => ({ id: 'm' + i, time, name: '' }));
  const tracks = proj().tracks.map((x) => (s.lock && x.id === t[0] ? { ...x, locked: true } : x));
  useEditor.setState({ project: { ...proj(), clips, markers, tracks }, past: [], future: [], selection: s.select ?? [], clipboard: [] });
  if (s.clipboard) useEditor.setState({ clipboard: structuredClone(proj().clips.slice(0, s.clipboard)) });
  usePlayback.setState({ time: s.time ?? 0 });
  return t;
}

const input = (over: Partial<ReasonInput> = {}): ReasonInput => ({ ...reasonSnapshot(), ...over });

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  usePlayback.setState({ time: 0 });
  useUi.setState({ toasts: [] });
});

describe('reasons', () => {
  it('no project: every id gives null and nothing throws', () => {
    for (const id of REASON_IDS) {
      expect(reasonFor(id, { project: null, selection: ['a'], time: 1, canUndo: false, canRedo: false, clipboard: 0, zoom: 4 }), id).toBeNull();
    }
    expect(reasonFor('not-an-id', input())).toBeNull();
  });

  it('each text in a typical state', () => {
    const T = REASON_TEXT;
    open({ select: [], time: 100 });
    expect(reasonFor('undo', input({ canUndo: false }))).toBe(T.noUndo);
    expect(reasonFor('redo', input({ canRedo: false }))).toBe(T.noRedo);
    expect(reasonFor('split', input())).toBe(T.noClipUnder);
    expect(reasonFor('split', input({ selection: ['a'] }))).toBe(T.playheadOnClip);
    expect(reasonFor('split-all', input())).toBe(T.noClipUnder);
    expect(reasonFor('trim-start', input())).toBe(T.noClipUnder);
    expect(reasonFor('trim-start', input({ selection: ['a'], time: 1000 }))).toBe(T.playheadOnClip);
    expect(reasonFor('delete', input())).toBe(T.selectClip);
    expect(reasonFor('ripple-delete', input())).toBe(T.selectClip);
    expect(reasonFor('duplicate', input())).toBe(T.selectClip);
    expect(reasonFor('copy', input())).toBe(T.selectClip);
    expect(reasonFor('cut', input())).toBe(T.selectClip);
    expect(reasonFor('clip-menu', input())).toBe(T.selectClip);
    expect(reasonFor('zoom-selection', input())).toBe(T.selectClip);
    expect(reasonFor('select-like', input())).toBe(T.selectClip);
    expect(reasonFor('paste', input())).toBe(T.copyFirst);
    expect(reasonFor('group', input({ selection: ['a'] }))).toBe(T.selectTwo);
    expect(reasonFor('ungroup', input({ selection: ['a'] }))).toBe(T.nothingGrouped);
    expect(reasonFor('ungroup', input())).toBe(T.selectClip);
    expect(reasonFor('freeze-frame', input({ time: 1 }))).toBe(T.playheadOnVideo);
    expect(reasonFor('key-add', input({ selection: ['au'] }))).toBe(T.keyTarget);
    expect(reasonFor('key-add', input({ selection: ['a'] }))).toBe(T.playheadOnClip);
    expect(reasonFor('toggle-3d', input({ selection: ['au'] }))).toBe(T.visualFirst);
    expect(reasonFor('mute', input({ selection: ['a'] }))).toBe(T.timedFirst);
    expect(reasonFor('key-prev', input({ selection: ['a'] }))).toBe(T.noKeys);
    expect(reasonFor('key-next', input())).toBe(T.selectClip);
    expect(reasonFor('clear-keys', input({ selection: ['a'] }))).toBe(T.noKeysToClear);
    expect(reasonFor('marker-prev', input())).toBe(T.noMarkers);
    expect(reasonFor('marker-next', input())).toBe(T.noMarkers);
    expect(reasonFor('fit-markers-1', input())).toBe(T.noMarkers);
    expect(reasonFor('fit-markers-2', input())).toBe(T.noMarkers);
    expect(reasonFor('fit-markers-4', input())).toBe(T.noMarkers);
    expect(reasonFor('clips-in-a-row', input({ selection: ['a'] }))).toBe(T.selectTwo);
    expect(reasonFor('cut-at-markers', input({ selection: ['a'] }))).toBe(T.noMarkers);
    expect(reasonFor('zoom-in', input({ zoom: 600 }))).toBe(T.zoomedIn);
    expect(reasonFor('zoom-out', input({ zoom: 4 }))).toBe(T.zoomedOut);
    expect(reasonFor('detach', input({ selection: ['a'] }))).toBe(T.notAttached);
    expect(reasonFor('select-effects', input({ selection: ['a'] }))).toBe(T.noEffects);
    expect(reasonFor('insert-gap', input())).toBe(T.noClipsAfter);
    expect(reasonFor('close-gaps', input({ selection: ['a'] }))).toBe(T.noGaps);
    expect(reasonFor('close-gaps', input())).toBe(T.selectClip);
    expect(reasonFor('marker-delete', input())).toBe(T.noMarkerHere);
    expect(reasonFor('mark-beats', input({ selection: ['a'] }))).toBe(T.soundFirst);
    expect(reasonFor('export', input())).toBeNull();
    open({ clips: false });
    expect(reasonFor('export', input())).toBe(T.addClip);
    expect(reasonFor('split', input())).toBe(T.addClip);
    expect(reasonFor('split-all', input())).toBe(T.addClip);
    expect(reasonFor('trim-end', input())).toBe(T.addClip);
    expect(reasonFor('freeze-frame', input())).toBe(T.addClip);
    open({ markers: [20], select: ['a'], time: 1 });
    expect(reasonFor('cut-at-markers', input())).toBe(T.noMarkerInside);
    expect(reasonFor('fit-markers-2', input())).toBe(T.selectTwo);
  });

  it('null when the action can work', () => {
    open({ select: ['a'], time: 1, markers: [1], keys: true, clipboard: 1 });
    const ok = (id: string, over: Partial<ReasonInput> = {}) => expect(reasonFor(id, input({ canUndo: true, canRedo: true, ...over })), id).toBeNull();
    ok('undo');
    ok('redo');
    ok('split');
    ok('split-all');
    ok('trim-start');
    ok('trim-end');
    ok('delete');
    ok('paste');
    ok('group', { selection: ['a', 'b'] });
    ok('key-add');
    ok('toggle-3d');
    ok('mute', { selection: ['au'] });
    ok('key-prev');
    ok('clear-keys');
    ok('marker-prev');
    ok('clips-in-a-row', { selection: ['a', 'b'] });
    ok('fit-markers-1', { selection: ['a', 'b'] });
    ok('zoom-in', { zoom: 100 });
    ok('zoom-out', { zoom: 100 });
    ok('marker-delete');
    ok('mark-beats', { selection: ['au'] });
    ok('export');
    ok('freeze-frame', { time: 7 });
    ok('insert-gap');
    useEditor.setState({ project: { ...proj(), clips: [...proj().clips, image(proj().tracks[1]!.id, 'c', 8, 1)] } });
    ok('close-gaps', { selection: ['b'] });
    ok('select-like');
    ok('clip-menu');
  });

  it('a reason means the action changes nothing', () => {
    const states: Setup[] = [
      { clips: false },
      { select: [], time: 100 },
      { select: ['a'], time: 100 },
      { select: ['a'], time: 1, lock: true },
      { select: ['a', 'b'], time: 1.5 },
      { select: ['a'], time: 1, markers: [10] },
      { select: [], time: 1, clipboard: 1 },
      { select: ['au'], time: 20 },
      { select: ['v'], time: 1 },
      { select: ['a', 'au'], time: 50, markers: [20] },
    ];
    const snap = () => JSON.stringify({ project: proj(), selection: ed().selection, time: usePlayback.getState().time, clipboard: ed().clipboard.length });
    const row = (id: string) => () => SHORTCUTS.find((s) => s.id === id)!.run();
    const runs: Record<string, () => void> = {
      split: () => ed().splitClips(usePlayback.getState().time),
      'split-all': () => ed().splitClips(usePlayback.getState().time, proj().clips.map((c) => c.id)),
      'trim-start': row('trim-start'),
      'trim-end': row('trim-end'),
      delete: row('delete'),
      'ripple-delete': row('ripple-delete'),
      duplicate: row('duplicate'),
      copy: row('copy'),
      cut: row('cut'),
      paste: row('paste'),
      group: row('group'),
      ungroup: row('ungroup'),
      'key-add': row('key-add'),
      'toggle-3d': row('toggle-3d'),
      mute: row('mute'),
      'key-prev': row('key-prev'),
      'key-next': row('key-next'),
      'clear-keys': () => clearKeysOf(ed().selection),
      'clips-in-a-row': () => makeRow(ed().selection),
      'fit-markers-1': () => fitToMarkers(ed().selection, 1),
      'cut-at-markers': () => cutAtMarkers(ed().selection),
      detach: () => attachClips(ed().selection, null),
      'select-effects': () => selectEffectsOf(ed().selection),
      'insert-gap': () => insertGapAt(),
      'close-gaps': () => {
        const first = proj().clips.find((c) => ed().selection.includes(c.id));
        if (first) closeGapsOnTrack(first.trackId);
      },
      'marker-delete': () => {
        const t = usePlayback.getState().time;
        const m = proj().markers?.find((x) => Math.abs(x.time - t) <= 0.5 / proj().fps);
        if (m) ed().removeMarker(m.id);
      },
      'select-like': selectLike,
    };
    let checked = 0;
    for (const id of Object.keys(runs)) {
      for (const s of states) {
        open(s);
        const why = reasonFor(id, reasonSnapshot());
        if (!why) continue;
        const before = snap();
        runs[id]!();
        expect(snap(), `${id} in ${JSON.stringify(s)}: ${why}`).toBe(before);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it('the split key toasts its reason and leaves the project alone', () => {
    open({ select: [], time: 100 });
    const before = JSON.stringify(proj());
    SHORTCUTS.find((s) => s.id === 'split')!.run();
    expect(JSON.stringify(proj())).toBe(before);
    expect(useUi.getState().toasts.at(-1)?.message).toBe(REASON_TEXT.noClipUnder);
  });
});
