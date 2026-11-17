import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioClip, Clip, ImageClip, MediaAsset, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { EASINGS } from '../../lib/anim';
import { createProject } from '../../lib/factory';
import { beginExport, endExport, isExporting } from '../../engine/exportState';
import { MATTE_TEXT } from '../../engine/matte';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useSolo } from '../../store/solo';
import { useSource } from '../../store/source';
import { useUi } from '../../store/ui';
import { attachClips } from '../properties/attachActions';
import { GRADE_TEXT } from '../properties/gradeActions';
import { setKeyCopy } from '../properties/keyClipboard';
import { CROSS_TEXT } from '../timeline/crossfadeText';
import { EDIT_TEXT } from '../timeline/editText';
import { useKeyPanel } from '../timeline/keyPanelState';
import { clearKeysOf, closeGapsOnTrack, insertGapAt, selectEffectsOf, selectLike } from '../timeline/actions';
import { cutAtMarkers, fitToMarkers, makeRow } from '../timeline/sequenceActions';
import { paletteActions } from './paletteActions';
import { REASON_IDS, REASON_TEXT, reasonFor, reasonSnapshot } from './reasons';
import type { ReasonInput } from './reasons';
import { SHORTCUTS } from './shortcuts';

vi.mock('../../store/session', () => ({ closeProject: vi.fn(), exportProjectFile: vi.fn() }));

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

/** the states both reason cases run every row in */
const STATES: Setup[] = [
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

const input = (over: Partial<ReasonInput> = {}): ReasonInput => ({ ...reasonSnapshot(), ...over });

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  usePlayback.setState({ time: 0 });
  useUi.setState({ toasts: [], previewMode: 'output', programMode: 'output', trimEdge: null, keySel: [], keyFocus: false, crossfadePick: null });
  useKeyPanel.getState().setOpen(false);
  setKeyCopy(null);
  while (isExporting()) endExport();
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
    const states = STATES;
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

  /** the open() project with a range on it */
  const withRange = (range: Project['range']): void => {
    useEditor.setState({ project: { ...proj(), range } });
  };
  /** the open() project with marks on its video media */
  const markVideo = (marks: NonNullable<MediaAsset['marks']>): void => {
    useEditor.setState({ project: { ...proj(), assets: proj().assets.map((a) => (a.id === 'vid1' ? { ...a, marks } : a)) } });
  };
  const IN_OUT_IDS = ['mark-in', 'mark-out', 'mark-clip', 'mark-selection', 'clear-in-out', 'clear-in', 'clear-out', 'go-in', 'go-out', 'play-in-out', 'lift', 'extract'];
  const SOURCE_AND_EDIT_IDS = ['match-frame', 'source-add', 'insert-edit', 'overwrite-edit', 'replace-edit', 'fit-edit', 'append-edit', 'edit-targets-selected'];

  it('in and out texts', () => {
    const T = REASON_TEXT;
    expect(T.noInPoint).toBe('mark an in point first');
    expect(T.noOutPoint).toBe('mark an out point first');
    expect(T.noInOut).toBe('mark an in or out point first');
    expect(T.inOutBoth).toBe('mark both an in and an out point first');
    expect(T.inOutPast).toBe('the in point is after the end of the project');
    expect(T.inOutNothing).toBe('nothing between the in and out points');
    expect(T.inOutLocked).toBe('the clips between the in and out points are on locked tracks');
    open({ select: [], time: 100 });
    expect(reasonFor('clear-in-out', input())).toBe(T.noInOut);
    expect(reasonFor('clear-in', input())).toBe(T.noInPoint);
    expect(reasonFor('go-in', input())).toBe(T.noInPoint);
    expect(reasonFor('clear-out', input())).toBe(T.noOutPoint);
    expect(reasonFor('go-out', input())).toBe(T.noOutPoint);
    expect(reasonFor('play-in-out', input())).toBe(T.noInOut);
    expect(reasonFor('lift', input())).toBe(T.inOutBoth);
    expect(reasonFor('extract', input())).toBe(T.inOutBoth);
    expect(reasonFor('mark-clip', input())).toBe(T.noClipUnder);
    expect(reasonFor('mark-selection', input())).toBe(T.selectClip);
    expect(reasonFor('mark-in', input())).toBeNull();
    withRange({ in: 50 });
    expect(reasonFor('play-in-out', input())).toBe(T.inOutPast);
    withRange({ in: 20, out: 30 });
    expect(reasonFor('lift', input())).toBe(T.inOutNothing);
    expect(reasonFor('extract', input())).toBe(T.inOutNothing);
    // only a locked clip inside
    open({ select: [], time: 1, lock: true });
    useEditor.setState({ project: { ...proj(), clips: proj().clips.filter((c) => c.id === 'a'), range: { in: 0.5, out: 1.5 } } });
    expect(reasonFor('lift', input())).toBe(T.inOutLocked);
    expect(reasonFor('extract', input())).toBe(T.inOutLocked);
    open({ clips: false });
    for (const id of ['mark-in', 'mark-out', 'mark-clip', 'play-in-out']) expect(reasonFor(id, input()), id).toBe(T.addClip);
  });

  it('in and out ids can work', () => {
    open({ select: ['a'], time: 1 });
    withRange({ in: 0.5, out: 1.5 });
    for (const id of IN_OUT_IDS) expect(reasonFor(id, input()), id).toBeNull();
    expect(REASON_IDS.size).toBeGreaterThan(IN_OUT_IDS.length);
    for (const id of IN_OUT_IDS) expect(REASON_IDS.has(id), id).toBe(true);
  });

  it('source texts', () => {
    const T = REASON_TEXT;
    expect(T.sourceEmpty).toBe('click a media card first: it opens in the source view');
    expect(T.sourcePicture).toBe('a picture has no time to play or mark: its length is set on the timeline');
    expect(T.sourceMissing).toBe('this media could not be loaded');
    expect(T.sourceExport).toBe('the source view waits while the export runs');
    expect(T.noMediaUnder).toBe('no video, audio or picture clip under the playhead');
    expect(T.notOnTimeline).toBe('no clip on the timeline uses this frame of the media');
    expect(T.noSound).toBe('this media has no sound');
    expect(T.noPicture).toBe('this media has no picture');
    expect(T.previewNarrow).toBe('the preview is too narrow for two views: make it wider');
    expect(T.splitScene).toBe('side by side shows the output, not the scene view');
    open({ select: [], time: 1 });
    const on = (assetId: string | null, time = 0): Partial<ReasonInput> => ({ source: { active: true, assetId, time } });
    for (const id of ['mark-in', 'mark-out', 'mark-clip', 'clear-in-out', 'go-in', 'go-out', 'play-in-out', 'match-frame']) {
      expect(reasonFor(id, input(on(null))), id).toBe(T.sourceEmpty);
      expect(reasonFor(id, input(on('gone'))), id).toBe(T.sourceEmpty);
    }
    for (const id of ['mark-in', 'mark-out', 'mark-clip', 'clear-in-out', 'go-in', 'go-out', 'play-in-out']) {
      expect(reasonFor(id, input(on('img1'))), id).toBe(T.sourcePicture);
    }
    // a video with no marks
    expect(reasonFor('mark-in', input(on('vid1')))).toBeNull();
    expect(reasonFor('mark-out', input(on('vid1')))).toBeNull();
    expect(reasonFor('mark-clip', input(on('vid1')))).toBeNull();
    expect(reasonFor('go-in', input(on('vid1')))).toBe(T.noInPoint);
    expect(reasonFor('go-out', input(on('vid1')))).toBe(T.noOutPoint);
    expect(reasonFor('clear-in-out', input(on('vid1')))).toBe(T.noInOut);
    expect(reasonFor('play-in-out', input(on('vid1')))).toBe(T.noInOut);
    // with an in mark only
    markVideo({ in: 1 });
    expect(reasonFor('go-in', input(on('vid1')))).toBeNull();
    expect(reasonFor('go-out', input(on('vid1')))).toBe(T.noOutPoint);
    expect(reasonFor('clear-in-out', input(on('vid1')))).toBeNull();
    expect(reasonFor('play-in-out', input(on('vid1')))).toBeNull();
  });

  it('source branch only while active', () => {
    const T = REASON_TEXT;
    open({ select: [], time: 1 });
    markVideo({ in: 1, out: 2 });
    const src = (active: boolean) => input({ source: { active, assetId: 'vid1', time: 0 } });
    // the timeline has no range: its answers
    expect(reasonFor('go-in', src(false))).toBe(T.noInPoint);
    expect(reasonFor('go-out', src(false))).toBe(T.noOutPoint);
    expect(reasonFor('clear-in-out', src(false))).toBe(T.noInOut);
    expect(reasonFor('play-in-out', src(false))).toBe(T.noInOut);
    // the source has marks: its answers
    expect(reasonFor('go-in', src(true))).toBeNull();
    expect(reasonFor('go-out', src(true))).toBeNull();
    expect(reasonFor('clear-in-out', src(true))).toBeNull();
    expect(reasonFor('play-in-out', src(true))).toBeNull();
    // no source at all: the timeline's
    expect(reasonFor('go-in', input({ source: undefined }))).toBe(T.noInPoint);
    // the time keys are the timeline's too: the source view has them while it is active
    expect(reasonFor('go-to-time', src(false))).toBeNull();
    expect(reasonFor('go-to-time', src(true))).toBe(T.sourceHasKeys);
  });

  it('match-frame', () => {
    const T = REASON_TEXT;
    // c, the timeline: a is an image clip 0..2
    open({ select: [], time: 1 });
    expect(reasonFor('match-frame', input())).toBeNull();
    open({ select: [], time: 100 });
    expect(reasonFor('match-frame', input())).toBe(T.noMediaUnder);
    expect(reasonFor('match-frame', input({ source: { active: false, assetId: 'vid1', time: 0 } }))).toBe(T.noMediaUnder);
    // the source view: the timeline moment of the frame on screen. v uses vid1 from 0 s, 6..8 on the timeline
    open({ select: [], time: 100 });
    const on = (time: number): Partial<ReasonInput> => ({ source: { active: true, assetId: 'vid1', time } });
    expect(reasonFor('match-frame', input(on(1)))).toBeNull();
    expect(reasonFor('match-frame', input(on(5)))).toBe(T.notOnTimeline);
    expect(reasonFor('match-frame', input({ source: { active: true, assetId: null, time: 0 } }))).toBe(T.sourceEmpty);
  });

  it('source-add', () => {
    const T = REASON_TEXT;
    open({ select: [], time: 0 });
    expect(reasonFor('source-add', input())).toBe(T.sourceEmpty);
    expect(reasonFor('source-add', input({ source: { active: false, assetId: null, time: 0 } }))).toBe(T.sourceEmpty);
    expect(reasonFor('source-add', input({ source: { active: false, assetId: 'gone', time: 0 } }))).toBe(T.sourceEmpty);
    // the media does not have to be on screen
    expect(reasonFor('source-add', input({ source: { active: false, assetId: 'vid1', time: 0 } }))).toBeNull();
    expect(reasonFor('source-add', input({ source: { active: true, assetId: 'img1', time: 0 } }))).toBeNull();
  });

  it('grade texts', () => {
    const T = REASON_TEXT;
    expect(T.gradeFirst).toBe(GRADE_TEXT.gradeFirst);
    expect(T.noGrade).toBe(GRADE_TEXT.noGrade);
    expect(T.copyGradeFirst).toBe(GRADE_TEXT.copyGradeFirst);
    expect(T.trackLocked).toBe(GRADE_TEXT.trackLocked);
    const ids = ['grade-show', 'grade-on-off', 'grade-reset', 'grade-copy', 'grade-paste'];
    open({ select: [], time: 1 });
    for (const id of ids) expect(reasonFor(id, input({ gradeCopied: true })), id).toBe(T.gradeFirst);
    // a sound clip cannot carry a grade
    for (const id of ids) expect(reasonFor(id, input({ selection: ['au'], gradeCopied: true })), id).toBe(T.gradeFirst);
    // a picture with no grade
    const one = (over: Partial<ReasonInput> = {}) => input({ selection: ['a'], ...over });
    expect(reasonFor('grade-show', one())).toBeNull();
    expect(reasonFor('grade-copy', one())).toBe(T.noGrade);
    expect(reasonFor('grade-on-off', one())).toBe(T.noGrade);
    expect(reasonFor('grade-reset', one())).toBe(T.noGrade);
    expect(reasonFor('grade-paste', one())).toBe(T.copyGradeFirst);
    expect(reasonFor('grade-paste', one({ gradeCopied: true }))).toBeNull();
    // a graded one
    useEditor.setState({ project: { ...proj(), clips: proj().clips.map((c) => (c.id === 'a' ? ({ ...c, grade: { liftR: 0.2 } } as Clip) : c)) } });
    for (const id of ids) expect(reasonFor(id, one({ gradeCopied: true })), id).toBeNull();
    // on a locked track the ones that write wait, show and copy do not
    open({ select: ['a'], time: 1, lock: true });
    useEditor.setState({ project: { ...proj(), clips: proj().clips.map((c) => (c.id === 'a' ? ({ ...c, grade: { liftR: 0.2 } } as Clip) : c)) } });
    expect(reasonFor('grade-show', one({ gradeCopied: true }))).toBeNull();
    expect(reasonFor('grade-copy', one({ gradeCopied: true }))).toBeNull();
    for (const id of ['grade-on-off', 'grade-reset', 'grade-paste']) expect(reasonFor(id, one({ gradeCopied: true })), id).toBe(T.trackLocked);
  });

  it('edit ids are known', () => {
    const T = REASON_TEXT;
    for (const id of ['insert-edit', 'overwrite-edit', 'replace-edit', 'fit-edit', 'append-edit', 'edit-targets-selected']) expect(REASON_IDS.has(id), id).toBe(true);
    open({ select: [], time: 1 });
    // no media in the source view: nothing to place
    for (const id of ['insert-edit', 'overwrite-edit', 'replace-edit', 'fit-edit', 'append-edit']) expect(reasonFor(id, input()), id).toBe(T.sourceEmpty);
    expect(reasonFor('edit-targets-selected', input())).toBe(EDIT_TEXT.targetsNone);
    expect(reasonFor('edit-targets-selected', input({ selection: ['a'] }))).toBeNull();
  });

  it('every new id is known and none throws without a project', () => {
    const ids = [
      ...IN_OUT_IDS, ...SOURCE_AND_EDIT_IDS,
      'ripple-start', 'ripple-end', 'edit-select', 'edge-prev', 'edge-next', 'slip-earlier', 'slip-later', 'slide-left', 'slide-right',
      'separate-sound', 'join-sound', 'move-into-sync', 'slip-into-sync', 'select-sound', 'select-picture',
      'solo-selection', 'solo-off', 'mixer-reset',
      'go-to-time', 'edit-prev', 'edit-next', 'nudge-left', 'nudge-right', 'nudge-left-big', 'nudge-right-big',
      'grade-show', 'grade-on-off', 'grade-reset', 'grade-copy', 'grade-paste',
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(50);
    expect(REASON_IDS.size).toBe(40 + 50 + 54);
    for (const id of ids) {
      expect(REASON_IDS.has(id), id).toBe(true);
      expect(reasonFor(id, { project: null, selection: ['a'], time: 1, canUndo: false, canRedo: false, clipboard: 0, zoom: 4 }), id).toBeNull();
    }
    // and with a project every one answers a text or null
    open({ select: ['a'], time: 1 });
    for (const id of ids) expect(['string', 'object'], id).toContain(typeof reasonFor(id, input()));
  });

  it('the snapshot fills the new fields', () => {
    open({ select: ['a'], time: 1 });
    let s = reasonSnapshot();
    expect(s.trimEdge).toBeNull();
    expect(s.source).toEqual({ active: false, assetId: null, time: 0 });
    expect(s.solo).toEqual([]);
    expect(s.gradeCopied).toBe(false);
    expect(s.editTargets).toEqual({ picture: null, sound: null });
    const edge = { clipId: 'a', edge: 'end' as const, both: false, alone: false };
    useUi.setState({ trimEdge: edge, previewMode: 'source' });
    useSource.getState().open('vid1', 2);
    useUi.setState({ previewMode: 'source' });
    useSolo.setState({ solo: ['t1'] });
    s = reasonSnapshot();
    expect(s.trimEdge).toEqual(edge);
    expect(s.source).toEqual({ active: true, assetId: 'vid1', time: 2 });
    expect(s.solo).toEqual(['t1']);
    useSolo.setState({ solo: [] });
    useSource.getState().close();
  });

  it('the new rows: a reason means the row changes nothing', () => {
    type Variant = { s: Setup; range?: Project['range']; view?: 'source' };
    const variants: Variant[] = [
      ...STATES.map((x) => ({ s: x })),
      { s: { select: ['a'], time: 1 }, range: { in: 1, out: 4 } },
      { s: { select: ['a'], time: 1 }, view: 'source' },
    ];
    const ids = [
      'ripple-start', 'ripple-end', 'edit-select', 'edge-prev', 'edge-next', 'key-prev', 'key-next',
      'mark-in', 'mark-out', 'mark-clip', 'clear-in-out', 'go-in', 'go-out', 'play-in-out', 'lift', 'extract',
      'match-frame', 'separate-sound', 'go-to-time', 'edit-prev', 'edit-next', 'nudge-left', 'nudge-right', 'nudge-left-big', 'nudge-right-big',
      'insert-edit', 'overwrite-edit',
    ];
    const snap = () => JSON.stringify({
      project: proj(), selection: ed().selection, time: usePlayback.getState().time, clipboard: ed().clipboard.length,
      playing: usePlayback.getState().playing, view: useUi.getState().previewMode, trim: useUi.getState().trimMode, edge: useUi.getState().trimEdge,
    });
    let checked = 0;
    for (const id of ids) {
      const row = SHORTCUTS.find((s) => s.id === id);
      expect(row, id).toBeDefined();
      expect(REASON_IDS.has(id), id).toBe(true);
      for (const v of variants) {
        for (const edge of [false, true]) {
          open(v.s);
          if (v.range) withRange(v.range);
          useUi.setState({ previewMode: v.view ?? 'output', trimEdge: edge && proj().clips.length > 0 ? { clipId: 'a', edge: 'end', both: false, alone: false } : null });
          const why = reasonFor(id, reasonSnapshot());
          if (!why) continue;
          const before = snap();
          row!.run();
          expect(snap(), `${id} in ${JSON.stringify(v)} edge ${edge}: ${why}`).toBe(before);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe('round 2 reasons', () => {
  const NONE = { project: null, selection: ['a'], time: 1, canUndo: false, canRedo: false, clipboard: 0, zoom: 4 } satisfies ReasonInput;
  const ease = EASINGS.map((e) => 'keys-ease-' + e.id);
  const BY_FEATURE: Record<string, string[]> = {
    'key lanes': ['keys-delete', 'keys-copy', 'keys-nudge-left', 'keys-nudge-right', 'keys-paste', 'keys-select-all', ...ease],
    graph: ['key-easy-ease', 'key-ease-into', 'key-ease-out-of', 'key-value-up', 'key-value-down', 'keys-join-handles', 'keys-ease-bezier'],
    crossfade: ['crossfade', 'crossfade-track', 'crossfade-track-off', 'fade-shape-power', 'fade-shape-linear', 'fade-shape-smooth'],
    'track tools': ['tracks-taller', 'tracks-shorter', 'tracks-normal', 'track-up', 'track-down', 'sync-lock-toggle'],
    lut: ['lut-on', 'lut-off', 'lut-save'],
    delivery: ['export-advanced', 'export-transparent', 'export-codec', 'export-bitrate', 'export-interval', 'export-size', 'export-audio', 'export-youtube', 'export-youtube-4k', 'export-vimeo', 'export-reels', 'export-master'],
    loudness: ['measure-loudness', 'export-loudness'],
    mattes: ['matte-show', 'matte-above', 'matte-remove', 'matte-select'],
  };
  const withClips = (fn: (c: Clip) => Clip): void => {
    useEditor.setState({ project: { ...proj(), clips: proj().clips.map(fn) } });
  };

  it('round 2 ids are known', () => {
    const counts = Object.values(BY_FEATURE).map((l) => l.length);
    expect(counts).toEqual([14, 7, 6, 6, 3, 12, 2, 4]);
    const all = Object.values(BY_FEATURE).flat();
    expect(all.length).toBe(54);
    expect(new Set(all).size).toBe(54);
    open({ select: ['a'], time: 1 });
    for (const id of all) {
      expect(REASON_IDS.has(id), id).toBe(true);
      expect(reasonFor(id, NONE), id).toBeNull();
      expect(['string', 'object'], id).toContain(typeof reasonFor(id, input()));
    }
  });

  it('round 2 texts', () => {
    const T = REASON_TEXT;
    expect(T.noMixSound).toBe('no clip with sound to measure');
    expect(T.measureExport).toBe('an export is running: measure when it ends');
    expect(T.selectKeys).toBe('select keyframes first: click a diamond in the keyframe panel or drag a box around some');
    expect(T.openKeyPanel).toBe('open the keyframe panel first');
    expect(T.copyKeysFirst).toBe('copy keyframes first');
    expect(T.keysAtStart).toBe('the keyframes are at the start of their clip');
    expect(T.keysAtEnd).toBe('the keyframes are at the end of their clip');
    expect(T.keyInTheWay).toBe('another keyframe of that value is in the way: select it too, or go past it');
    expect(T.keysNotHere).toBe('the copied keyframes do not fit the selected clips');
    expect(T.noHandles).toBe('no handles to change there: bounce, elastic and hold have none, a first or last keyframe has one side only');
    expect(T.easeNothing).toBe('the selected keyframes have nothing to ease: each is alone in its value');
    expect(T.keysAtValueMin).toBe('a selected keyframe is at the lowest value it can have');
    expect(T.keysAtValueMax).toBe('a selected keyframe is at the highest value it can have');
    expect(T.tracksTallest).toBe('every track is as tall as it goes');
    expect(T.tracksShortest).toBe('every track is as short as it goes');
    expect(T.tracksNormal).toBe('every track has its normal height');
    expect(T.trackNormal).toBe('the track has its normal height');
    expect(T.trackTop).toBe('the track is as high as it goes (video tracks stay above audio tracks)');
    expect(T.trackBottom).toBe('the track is as low as it goes (audio tracks stay below video tracks)');
    expect(T.inOutSyncOff).toBe('the clips between the in and out points are on tracks with sync lock off');
    expect(T.gapSyncOff).toBe('the clips after the playhead are on tracks with sync lock off');
    expect(T.noLut).toBe('the selected clips have no lut');
    expect(T.nothingToSave).toBe('the selected clip has no color or grade to save');
    expect(T.lutNotClip).toBe('a lut is not a clip: drag it onto a clip, or pick it in the grade');
    expect(T.oneVisual).toBe('select one video, image, text or shape clip first');
    expect(T.noMatte).toBe('the selected clips have no matte');
    expect(T.noMatteHere).toBe('the selected clips have no matte and are not the matte of a clip');
    for (const [k, v] of Object.entries(CROSS_TEXT)) expect((T as Record<string, string>)[k], k).toBe(v);
  });

  it('key panel ids', () => {
    const T = REASON_TEXT;
    open({ select: ['a'], time: 1, keys: true });
    const ref = { clipId: 'a', prop: 'x', t: 0 };
    const four = ['keys-delete', 'keys-copy', 'keys-nudge-left', 'keys-nudge-right'];
    const panel = [...four, ...ease, ...BY_FEATURE.graph!];
    for (const id of panel) {
      // closed, open with nothing selected, open with a keyframe selected
      expect(reasonFor(id, input({ keyPanelOpen: false, keySel: [ref] })), id).toBe(T.openKeyPanel);
      expect(reasonFor(id, input({ keyPanelOpen: false })), id).toBe(T.openKeyPanel);
      expect(reasonFor(id, input({ keyPanelOpen: true, keySel: [] })), id).toBe(T.selectKeys);
      expect(reasonFor(id, input({ keyPanelOpen: true })), id).toBe(T.selectKeys);
      expect(reasonFor(id, input({ keyPanelOpen: true, keySel: [ref] })), id).toBeNull();
    }
    // paste: a copy first, then a selected clip
    expect(reasonFor('keys-paste', input({ keyCopied: false }))).toBe(T.copyKeysFirst);
    expect(reasonFor('keys-paste', input({ keyCopied: true, selection: [] }))).toBe(T.selectClip);
    expect(reasonFor('keys-paste', input({ keyCopied: true }))).toBeNull();
    // select all: a clip, then a clip with keyframes
    expect(reasonFor('keys-select-all', input({ selection: [] }))).toBe(T.selectClip);
    expect(reasonFor('keys-select-all', input({ selection: ['b'] }))).toBe(T.noKeys);
    expect(reasonFor('keys-select-all', input({ selection: ['a'] }))).toBeNull();
    expect(reasonFor('keys-select-all', input({ selection: ['a', 'b'] }))).toBeNull();
  });

  it('a picked crossfade keeps the edge and key rows alive', () => {
    open({ select: ['v'], time: 1 });
    withClips((c) => (c.id === 'v' ? ({ ...c, crossfade: { before: 0.25, after: 0.25 } } as Clip) : c));
    const sel = ['v'];
    expect(reasonFor('key-next', input({ selection: sel }))).toBe(REASON_TEXT.noKeys);
    expect(reasonFor('key-next', input({ selection: sel, crossfadePick: { clipId: 'v', selection: sel } }))).toBeNull();
    // a pick made for another selection array does not count
    expect(reasonFor('key-next', input({ selection: sel, crossfadePick: { clipId: 'v', selection: ['v'] } }))).toBe(REASON_TEXT.noKeys);
  });

  it('lut reasons', () => {
    const T = REASON_TEXT;
    const lut = { media: 'lut1', mix: 1 };
    open({ select: ['au'], time: 1 });
    for (const id of ['lut-on', 'lut-off', 'lut-save']) expect(reasonFor(id, input()), id).toBe(T.gradeFirst);
    // a picture with no lut, no grade and no adjust
    open({ select: ['a'], time: 1 });
    expect(reasonFor('lut-on', input())).toBeNull();
    expect(reasonFor('lut-off', input())).toBe(T.noLut);
    expect(reasonFor('lut-save', input())).toBe(T.nothingToSave);
    // an active adjust or a grade is something to save
    withClips((c) => (c.id === 'a' ? ({ ...c, adjust: { brightness: 0.4 } } as Clip) : c));
    expect(reasonFor('lut-save', input())).toBeNull();
    withClips((c) => (c.id === 'a' ? ({ ...c, adjust: undefined, grade: { liftR: 0.2 } } as Clip) : c));
    expect(reasonFor('lut-save', input())).toBeNull();
    // a lut: off works
    withClips((c) => (c.id === 'a' ? ({ ...c, grade: { lut } } as Clip) : c));
    expect(reasonFor('lut-off', input())).toBeNull();
    expect(reasonFor('lut-save', input())).toBeNull();
    // a locked track: on and off wait
    open({ select: ['a'], time: 1, lock: true });
    expect(reasonFor('lut-on', input())).toBe(T.trackLocked);
    withClips((c) => (c.id === 'a' ? ({ ...c, grade: { lut } } as Clip) : c));
    expect(reasonFor('lut-off', input())).toBe(T.trackLocked);
    expect(reasonFor('lut-save', input())).toBeNull();
    // one with a lut that is not locked and one locked without
    open({ select: ['a', 'b'], time: 1, lock: true });
    withClips((c) => (c.id === 'b' ? ({ ...c, grade: { lut } } as Clip) : c));
    expect(reasonFor('lut-off', input())).toBeNull();
    expect(reasonFor('lut-on', input())).toBeNull();
  });

  it('measure-loudness', () => {
    const T = REASON_TEXT;
    open({ clips: false });
    expect(reasonFor('measure-loudness', input())).toBe(T.addClip);
    // pictures only
    open({ select: [] });
    useEditor.setState({ project: { ...proj(), clips: proj().clips.filter((c) => c.type === 'image') } });
    expect(reasonFor('measure-loudness', input())).toBe(T.noMixSound);
    // a video without sound is no sound either
    useEditor.setState({ project: { ...proj(), clips: [video(proj().tracks[2]!.id, 'v', 6, 2)], assets: proj().assets.map((a) => (a.id === 'vid1' ? { ...a, hasAudio: false } : a)) } });
    expect(reasonFor('measure-loudness', input())).toBe(T.noMixSound);
    // an audio clip, and a video whose media has sound
    open({ select: [] });
    expect(reasonFor('measure-loudness', input())).toBeNull();
    useEditor.setState({ project: { ...proj(), clips: proj().clips.filter((c) => c.type === 'video') } });
    expect(reasonFor('measure-loudness', input())).toBeNull();
    // an export runs: the measure waits
    beginExport();
    try {
      expect(reasonFor('measure-loudness', input())).toBe(T.measureExport);
    } finally {
      endExport();
    }
    expect(reasonFor('measure-loudness', input())).toBeNull();
  });

  it('export ids answer like export', () => {
    const ids = [...BY_FEATURE.delivery!, 'export-loudness'];
    expect(ids.length).toBe(13);
    open({ clips: false });
    for (const id of ids) expect(reasonFor(id, input()), id).toBe(REASON_TEXT.addClip);
    expect(reasonFor('export', input())).toBe(REASON_TEXT.addClip);
    open({ select: [] });
    for (const id of ids) expect(reasonFor(id, input()), id).toBeNull();
    expect(reasonFor('export', input())).toBeNull();
    for (const id of ids) expect(reasonFor(id, NONE), id).toBeNull();
  });

  it('matte rows', () => {
    const T = REASON_TEXT;
    // t0 is the top track: a (0..2) is above b (3..5) in the project, but they never play together
    open({ select: [], time: 1 });
    expect(reasonFor('matte-show', input({ selection: ['a'] }))).toBeNull();
    expect(reasonFor('matte-show', input({ selection: ['a', 'b'] }))).toBe(T.oneVisual);
    expect(reasonFor('matte-show', input({ selection: ['au'] }))).toBe(T.oneVisual);
    expect(reasonFor('matte-show', input({ selection: [] }))).toBe(T.oneVisual);
    // above: one or two picture clips, then what the planner says
    expect(reasonFor('matte-above', input({ selection: [] }))).toBe(MATTE_TEXT.pickOneOrTwo);
    expect(reasonFor('matte-above', input({ selection: ['a'] }))).toBe(MATTE_TEXT.noneAbove);
    expect(reasonFor('matte-above', input({ selection: ['a', 'b'] }))).toBeNull();
    // remove: no matte, a matte, a matte on a locked track
    expect(reasonFor('matte-remove', input({ selection: ['b'] }))).toBe(T.noMatte);
    withClips((c) => (c.id === 'b' ? ({ ...c, matte: { clip: 'a', mode: 'alpha' } } as Clip) : c));
    expect(reasonFor('matte-remove', input({ selection: ['b'] }))).toBeNull();
    expect(reasonFor('matte-remove', input({ selection: ['a', 'b'] }))).toBeNull();
    // select: a clip, a pair, the pair on a locked track
    expect(reasonFor('matte-select', input({ selection: [] }))).toBe(T.selectClip);
    expect(reasonFor('matte-select', input({ selection: ['v'] }))).toBe(T.noMatteHere);
    expect(reasonFor('matte-select', input({ selection: ['b'] }))).toBeNull();
    expect(reasonFor('matte-select', input({ selection: ['a'] }))).toBeNull();
    open({ select: ['b'], time: 1, lock: true });
    withClips((c) => (c.id === 'b' ? ({ ...c, matte: { clip: 'a', mode: 'alpha' } } as Clip) : c));
    expect(reasonFor('matte-select', input())).toBe(T.trackLocked);
    expect(reasonFor('matte-select', input({ selection: ['a'] }))).toBeNull();
    // a locked matted clip: remove waits
    useEditor.setState({ project: { ...proj(), tracks: proj().tracks.map((t) => (t.id === proj().clips.find((c) => c.id === 'b')!.trackId ? { ...t, locked: true } : { ...t, locked: false })) } });
    expect(reasonFor('matte-remove', input({ selection: ['b'] }))).toBe(T.trackLocked);
  });

  it('the snapshot fills the round 2 fields', () => {
    open({ select: ['a'], time: 1 });
    let s = reasonSnapshot();
    expect(s.keySel).toEqual([]);
    expect(s.keyCopied).toBe(false);
    expect(s.keyPanelOpen).toBe(false);
    expect(s.crossfadePick).toBeNull();
    const ref = { clipId: 'a', prop: 'x', t: 0 };
    const pick = { clipId: 'a', selection: ['a'] };
    useUi.setState({ keySel: [ref], crossfadePick: pick });
    useKeyPanel.getState().setOpen(true);
    setKeyCopy({ items: [{ clipId: 'a', keys: { x: [{ t: 0, v: 1, ease: 'linear' }] } }] });
    s = reasonSnapshot();
    expect(s.keySel).toEqual([ref]);
    expect(s.keyCopied).toBe(true);
    expect(s.keyPanelOpen).toBe(true);
    expect(s.crossfadePick).toEqual(pick);
  });

  it('the round 2 rows: a reason means the row changes nothing', () => {
    // the two that wait for an async answer have no sync run to compare. lut-on has no row, the grade section does it
    const skip = new Set(['lut-save', 'measure-loudness', 'lut-on']);
    const ids = Object.values(BY_FEATURE).flat().filter((id) => !skip.has(id));
    expect(ids.length).toBe(51);
    const snap = () => JSON.stringify({ project: proj(), selection: ed().selection, time: usePlayback.getState().time, clipboard: ed().clipboard.length });
    let checked = 0;
    for (const id of ids) {
      for (const s of STATES) {
        open(s);
        const row = paletteActions().find((a) => a.id === id);
        expect(row, id).toBeDefined();
        const why = reasonFor(id, reasonSnapshot());
        if (!why) continue;
        const before = snap();
        row!.run();
        expect(snap(), `${id} in ${JSON.stringify(s)}: ${why}`).toBe(before);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});
