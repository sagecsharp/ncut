import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioClip, MediaAsset, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject, createTrack } from '../../lib/factory';
import { rangeEditBlock } from '../../lib/inOut';
import { useEditor } from '../../store/editorStore';
import { planInsertGap } from '../timeline/gapInsert';
import { moveSelectedTrack, normalTrackHeights, stepTrackHeights, toggleSelectedSyncLock } from '../timeline/trackActions';
import { REASON_IDS, REASON_TEXT, reasonFor, reasonSnapshot } from './reasons';

// the real answers come with the sync lock edits: here the two answers are set by hand
vi.mock('../../lib/inOut', async (orig) => {
  const m = await orig<typeof import('../../lib/inOut')>();
  return { ...m, rangeEditBlock: vi.fn(m.rangeEditBlock) };
});
vi.mock('../timeline/gapInsert', async (orig) => {
  const m = await orig<typeof import('../timeline/gapInsert')>();
  return { ...m, planInsertGap: vi.fn(m.planInsertGap) };
});

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const T = REASON_TEXT;

const asset = (id: string, kind: 'video' | 'audio'): MediaAsset => ({
  id, name: id, kind, mime: kind + '/x', size: 1, duration: 10, width: 100, height: 100, hasAudio: true, createdAt: 0,
});
const video = (trackId: string, id: string, start = 0): VideoClip => ({
  id, type: 'video', trackId, start, duration: 2, name: id, fadeIn: 0, fadeOut: 0, assetId: 'vid', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM },
});
const audio = (trackId: string, id: string, start = 0): AudioClip => ({
  id, type: 'audio', trackId, start, duration: 2, name: id, fadeIn: 0, fadeOut: 0, assetId: 'aud', trimStart: 0, speed: 1, volume: 1, muted: false,
});

/** v1 (clip c1), v2 (clip c2), a1 (clip c3) */
let tracks: string[] = [];

beforeEach(() => {
  vi.mocked(rangeEditBlock).mockClear();
  vi.mocked(planInsertGap).mockClear();
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  const p = createProject('track reasons');
  const list = [createTrack('video', 'v1'), createTrack('video', 'v2'), createTrack('audio', 'a1')];
  tracks = list.map((t) => t.id);
  const clips = [video(tracks[0]!, 'c1'), video(tracks[1]!, 'c2'), audio(tracks[2]!, 'c3')];
  ed().openProject({ ...p, tracks: list, assets: [asset('vid', 'video'), asset('aud', 'audio')], clips });
});

const ask = (id: string, selection: string[] = [], time = 0) => reasonFor(id, { ...reasonSnapshot(), selection, time });
const heights = (h: number) => ed().setTrackHeights(Object.fromEntries(tracks.map((t) => [t, h])));

describe('the track reasons', () => {
  it('taller and shorter stop at the ladder ends', () => {
    expect(ask('tracks-taller')).toBeNull();
    expect(ask('tracks-shorter')).toBeNull();
    heights(240);
    expect(ask('tracks-taller')).toBe(T.tracksTallest);
    expect(ask('tracks-shorter')).toBeNull();
    heights(28);
    expect(ask('tracks-taller')).toBeNull();
    expect(ask('tracks-shorter')).toBe(T.tracksShortest);
    // one track still has room
    ed().setTrackHeights({ [tracks[1]!]: 36 });
    expect(ask('tracks-shorter')).toBeNull();
  });

  it('normal heights', () => {
    expect(ask('tracks-normal')).toBe(T.tracksNormal);
    ed().setTrackHeights({ [tracks[2]!]: 96 });
    expect(ask('tracks-normal')).toBeNull();
    ed().setTrackHeights({ [tracks[2]!]: null });
    expect(ask('tracks-normal')).toBe(T.tracksNormal);
  });

  it('track up and down at the ends and when locked', () => {
    expect(ask('track-up')).toBe(T.selectClip);
    expect(ask('track-down')).toBe(T.selectClip);
    // v1: the top of the video tracks
    expect(ask('track-up', ['c1'])).toBe(T.trackTop);
    expect(ask('track-down', ['c1'])).toBeNull();
    // v2: the bottom of the video tracks, audio stays below
    expect(ask('track-up', ['c2'])).toBeNull();
    expect(ask('track-down', ['c2'])).toBe(T.trackBottom);
    // a1: alone in its kind
    expect(ask('track-up', ['c3'])).toBe(T.trackTop);
    expect(ask('track-down', ['c3'])).toBe(T.trackBottom);
    // the first track in track order decides
    expect(ask('track-up', ['c2', 'c1'])).toBe(T.trackTop);
    // a locked track stays
    ed().updateTrack(tracks[1]!, { locked: true });
    expect(ask('track-up', ['c2'])).toBe(T.trackLocked);
    expect(ask('track-down', ['c2'])).toBe(T.trackLocked);
  });

  it('sync lock needs a selection', () => {
    expect(ask('sync-lock-toggle')).toBe(T.selectClip);
    expect(ask('sync-lock-toggle', ['c1'])).toBeNull();
    ed().updateTrack(tracks[0]!, { syncLock: false });
    expect(ask('sync-lock-toggle', ['c1'])).toBeNull();
  });

  it('the six ids are reason ids', () => {
    for (const id of ['tracks-taller', 'tracks-shorter', 'tracks-normal', 'track-up', 'track-down', 'sync-lock-toggle']) expect(REASON_IDS).toContain(id);
  });
});

describe('the sync lock off reasons', () => {
  it('extract says sync-off', () => {
    vi.mocked(rangeEditBlock).mockReturnValueOnce('sync-off');
    expect(ask('extract')).toBe(T.inOutSyncOff);
    // lift reads the same answer
    vi.mocked(rangeEditBlock).mockReturnValueOnce('sync-off');
    expect(ask('lift')).toBe(T.inOutSyncOff);
  });

  it('insert gap says sync-off', () => {
    // no track would move
    vi.mocked(planInsertGap).mockReturnValueOnce([]);
    expect(ask('insert-gap')).toBe(T.noClipsAfter);
    // a clip after the playhead on an unlocked sync lock off track
    ed().updateTrack(tracks[2]!, { syncLock: false });
    vi.mocked(planInsertGap).mockReturnValueOnce([]);
    expect(ask('insert-gap')).toBe(T.gapSyncOff);
    // past that clip nothing is left
    vi.mocked(planInsertGap).mockReturnValueOnce([]);
    expect(ask('insert-gap', [], 5)).toBe(T.noClipsAfter);
    // a locked track does not count
    ed().updateTrack(tracks[2]!, { locked: true });
    vi.mocked(planInsertGap).mockReturnValueOnce([]);
    expect(ask('insert-gap')).toBe(T.noClipsAfter);
  });
});

describe('a reason means nothing changes', () => {
  const run: Record<string, () => void> = {
    'tracks-taller': () => stepTrackHeights(1),
    'tracks-shorter': () => stepTrackHeights(-1),
    'tracks-normal': () => normalTrackHeights(),
    'track-up': () => moveSelectedTrack(-1),
    'track-down': () => moveSelectedTrack(1),
    'sync-lock-toggle': () => toggleSelectedSyncLock(),
  };

  it('a reason means the track action changes nothing', () => {
    // [id, selection, setup]
    const cases: [string, string[], () => void][] = [
      ['tracks-taller', [], () => void heights(240)],
      ['tracks-shorter', [], () => void heights(28)],
      ['tracks-normal', [], () => undefined],
      ['track-up', [], () => undefined],
      ['track-down', [], () => undefined],
      ['track-up', ['c1'], () => undefined],
      ['track-down', ['c2'], () => undefined],
      ['track-up', ['c3'], () => undefined],
      ['track-down', ['c3'], () => undefined],
      ['track-up', ['c2'], () => ed().updateTrack(tracks[1]!, { locked: true })],
      ['track-down', ['c2'], () => ed().updateTrack(tracks[1]!, { locked: true })],
      ['sync-lock-toggle', [], () => undefined],
    ];
    for (const [id, selection, setup] of cases) {
      beforeEachCase();
      setup();
      useEditor.setState({ selection });
      const reason = ask(id, selection);
      expect(reason, id).not.toBeNull();
      const before = proj();
      const past = ed().past.length;
      run[id]!();
      expect(proj(), id).toBe(before);
      expect(ed().past.length, id).toBe(past);
    }
  });

  /** a fresh project for each case */
  function beforeEachCase(): void {
    useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
    const p = createProject('track reasons');
    const list = [createTrack('video', 'v1'), createTrack('video', 'v2'), createTrack('audio', 'a1')];
    tracks = list.map((t) => t.id);
    const clips = [video(tracks[0]!, 'c1'), video(tracks[1]!, 'c2'), audio(tracks[2]!, 'c3')];
    ed().openProject({ ...p, tracks: list, assets: [asset('vid', 'video'), asset('aud', 'audio')], clips });
  }

  it('without a reason the track action changes the project', () => {
    expect(ask('tracks-taller')).toBeNull();
    const before = proj();
    stepTrackHeights(1);
    expect(proj()).not.toBe(before);
    expect(ed().past).toHaveLength(0);
    useEditor.setState({ selection: ['c2'] });
    moveSelectedTrack(-1);
    expect(proj().tracks.map((t) => t.id)).toEqual([tracks[1], tracks[0], tracks[2]]);
    expect(ed().past).toHaveLength(1);
    toggleSelectedSyncLock();
    expect(proj().tracks.find((t) => t.id === tracks[1])!.syncLock).toBe(false);
    expect(ed().past).toHaveLength(2);
  });
});
