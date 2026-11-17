import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Clip, ImageClip, MediaAsset, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useSolo } from '../../store/solo';
import { useSource } from '../../store/source';
import { useUi } from '../../store/ui';
import { attachClips } from '../properties/attachActions';
import { GRADE_TEXT } from '../properties/gradeActions';
import { EDIT_TEXT } from '../timeline/editText';
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
  useUi.setState({ toasts: [], previewMode: 'output', programMode: 'output', trimEdge: null });
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
    expect(REASON_IDS.size).toBe(40 + 50);
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
