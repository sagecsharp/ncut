import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaAsset, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import type { MatchTarget } from '../../lib/matchFrame';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { setSourceMaster, useSource } from '../../store/source';
import { useUi } from '../../store/ui';
import { REASON_TEXT } from '../shell/reasons';
import { insertMedia } from '../timeline/insertMedia';
import { addMedia, applyMatch, emptySource, onView, openInSource, runMatchFrame, runSourceKey, sourceAdd, sourceAddPart, toggleSource } from './sourceKeys';

vi.mock('../timeline/insertMedia', async (orig) => {
  const m = await orig<typeof import('../timeline/insertMedia')>();
  return { ...m, insertMedia: vi.fn(m.insertMedia) };
});

const ed = () => useEditor.getState();
const src = () => useSource.getState();
const FPS = 30;

let frames: Array<(now: number) => void> = [];
let clock = 0;
function frame(ms = 16): void {
  clock += ms;
  const run = frames;
  frames = [];
  for (const cb of run) cb(clock);
}

const asset = (id: string, kind: MediaAsset['kind'], duration: number, hasAudio: boolean): MediaAsset => ({
  id, name: id, kind, mime: kind + '/x', size: 1, duration, width: 100, height: 100, hasAudio, createdAt: 0,
});

/** va: 10 s video with sound, sv: silent video, au: sound, img: picture. c1 shows va 2..6 on the timeline 0..4 */
function open(): Project {
  const p = createProject('source keys', undefined, FPS);
  const clip: VideoClip = {
    id: 'c1', type: 'video', trackId: p.tracks[0]!.id, start: 0, duration: 4, name: 'c', fadeIn: 0, fadeOut: 0, assetId: 'va',
    trimStart: 2, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM },
  };
  const project = { ...p, assets: [asset('va', 'video', 10, true), asset('sv', 'video', 8, false), asset('au', 'audio', 6, true), asset('img', 'image', 0, false)], clips: [clip] };
  ed().openProject(project);
  return project;
}

const toasts = (): string[] => useUi.getState().toasts.map((t) => t.message);
const marks = (id = 'va') => ed().project!.assets.find((a) => a.id === id)!.marks;

beforeEach(() => {
  frames = [];
  clock = 1000;
  vi.stubGlobal('requestAnimationFrame', (cb: (n: number) => void) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = [];
  });
  vi.stubGlobal('performance', { now: () => clock });
  setSourceMaster(null);
  open();
  useUi.setState({ previewMode: 'output', programMode: 'output', dialog: null, toasts: [] });
  useSource.setState({ assetId: null, time: 0, playing: false, rate: 1, toOut: false, split: false });
  usePlayback.setState({ time: 0, playing: false, loop: false, speed: 1, rate: 1 });
  vi.mocked(insertMedia).mockClear();
});

afterEach(() => {
  src().pause();
  usePlayback.getState().pause();
  vi.unstubAllGlobals();
});

describe('sourceKeys', () => {
  it('onView', () => {
    const timeline = vi.fn();
    onView('frame-forward', timeline);
    expect(timeline).toHaveBeenCalledTimes(1);
    src().open('va');
    useUi.getState().activateSource();
    onView('frame-forward', timeline);
    onView('frames-forward', timeline);
    expect(timeline).toHaveBeenCalledTimes(1);
    expect(src().time).toBeCloseTo(11 / FPS, 9);
    onView('frames-back', timeline);
    onView('frame-back', timeline);
    expect(src().time).toBeCloseTo(0, 9);
    onView('seek-end', timeline);
    expect(src().time).toBeCloseTo(299 / FPS, 9);
    onView('seek-start', timeline);
    expect(src().time).toBe(0);
    // play goes to the source clock, not the timeline's
    onView('play-pause', timeline);
    expect(src().playing).toBe(true);
    expect(usePlayback.getState().playing).toBe(false);
    frame(100);
    expect(src().time).toBeGreaterThan(0);
    onView('pause', timeline);
    expect(src().playing).toBe(false);
    onView('shuttle-forward', timeline);
    expect(src().playing).toBe(true);
    expect(src().rate).toBe(1);
    onView('shuttle-back', timeline);
    expect(src().rate).toBe(-1);
    src().pause();
    expect(timeline).toHaveBeenCalledTimes(1);
    // back on the timeline side the timeline runs
    useUi.getState().activateProgram();
    onView('pause', timeline);
    expect(timeline).toHaveBeenCalledTimes(2);
  });

  it('i and o', () => {
    src().open('va');
    useUi.getState().activateSource();
    const past = ed().past.length;
    src().seek(2.51);
    runSourceKey('mark-in');
    expect(marks()).toEqual({ in: 2.5 });
    src().seek(3.51);
    runSourceKey('mark-out');
    // o includes the frame on screen: the out point is the end of that frame
    expect(marks()).toEqual({ in: 2.5, out: 3.5 + 1 / FPS });
    // while playing the frame on screen counts, not the clock's raw time
    useSource.setState({ playing: true, time: 5.02 });
    runSourceKey('mark-out');
    expect(marks()!.out).toBeCloseTo(5 + 1 / FPS, 9);
    src().pause();
    // an out before the in clears the in, and says so
    useUi.setState({ toasts: [] });
    src().seek(1);
    runSourceKey('mark-out');
    expect(marks()).toEqual({ out: 1 + 1 / FPS });
    expect(toasts()).toEqual(['out point set, the in point after it was cleared']);
    useUi.setState({ toasts: [] });
    src().seek(8);
    runSourceKey('mark-in');
    runSourceKey('mark-in');
    expect(marks()).toEqual({ in: 8 });
    expect(toasts()).toEqual(['in point set, the out point before it was cleared']);
    // marks are not a project edit
    expect(ed().past.length).toBe(past);
    expect(ed().project!.range).toBeUndefined();
    // the end of the file is the last frame
    src().seek(299 / FPS);
    runSourceKey('mark-out');
    expect(marks()).toEqual({ in: 8, out: 10 });
  });

  it('x and shift+x keep the timeline range', () => {
    ed().setRange({ in: 1, out: 2 });
    src().open('va');
    useUi.getState().activateSource();
    const past = ed().past.length;
    runSourceKey('mark-clip');
    expect(marks()).toEqual({ in: 0, out: 10 });
    runSourceKey('clear-in-out');
    expect(marks()).toBeUndefined();
    expect(ed().project!.range).toEqual({ in: 1, out: 2 });
    expect(ed().past.length).toBe(past);
    // nothing to clear
    useUi.setState({ toasts: [] });
    runSourceKey('clear-in-out');
    expect(toasts()).toEqual([REASON_TEXT.noInOut]);
    // go to the marks
    useUi.setState({ toasts: [] });
    runSourceKey('go-in');
    runSourceKey('go-out');
    expect(toasts()).toEqual([REASON_TEXT.noInPoint, REASON_TEXT.noOutPoint]);
    ed().setMediaMarks('va', { in: 2, out: 4 });
    runSourceKey('go-in');
    expect(src().time).toBe(2);
    runSourceKey('go-out');
    expect(src().time).toBeCloseTo(4 - 1 / FPS, 9);
    expect(ed().project!.range).toEqual({ in: 1, out: 2 });
  });

  it('play in to out plays the marks of the media only', () => {
    src().open('va');
    useUi.getState().activateSource();
    runSourceKey('play-in-out');
    expect(toasts()).toEqual([REASON_TEXT.noInOut]);
    expect(src().playing).toBe(false);
    ed().setMediaMarks('va', { in: 2, out: 4 });
    runSourceKey('play-in-out');
    expect(src().playing).toBe(true);
    expect(src().toOut).toBe(true);
    expect(src().time).toBe(2);
    expect(usePlayback.getState().playing).toBe(false);
    runSourceKey('play-in-out');
    expect(src().playing).toBe(false);
  });

  it('empty source', () => {
    useUi.getState().activateSource();
    // held keys say nothing
    for (const k of ['frame-back', 'frame-forward', 'frames-back', 'frames-forward', 'seek-start', 'seek-end'] as const) runSourceKey(k);
    expect(toasts()).toEqual([]);
    for (const k of ['play-pause', 'shuttle-back', 'pause', 'shuttle-forward', 'mark-in', 'mark-out', 'mark-clip', 'clear-in-out', 'go-in', 'go-out', 'play-in-out'] as const) {
      useUi.setState({ toasts: [] });
      runSourceKey(k);
      expect(toasts(), k).toEqual([REASON_TEXT.sourceEmpty]);
    }
    expect(src().playing).toBe(false);
    // a picture has no time: playback keys do nothing, the mark keys say so
    src().open('img');
    useUi.setState({ toasts: [] });
    for (const k of ['play-pause', 'shuttle-back', 'pause', 'shuttle-forward', 'frame-back', 'seek-end'] as const) runSourceKey(k);
    expect(toasts()).toEqual([]);
    expect(src().playing).toBe(false);
    for (const k of ['mark-in', 'mark-out', 'mark-clip', 'clear-in-out', 'go-in', 'go-out', 'play-in-out'] as const) {
      useUi.setState({ toasts: [] });
      runSourceKey(k);
      expect(toasts(), k).toEqual([REASON_TEXT.sourcePicture]);
    }
    expect(marks('img')).toBeUndefined();
  });

  it('match frame', () => {
    usePlayback.setState({ time: 1 });
    runMatchFrame();
    // c1 plays va from 2 s: timeline 1 s is media 3 s, the clip's part of the media is marked
    expect(src().assetId).toBe('va');
    expect(src().time).toBe(3);
    expect(marks()).toEqual({ in: 2, out: 6 });
    expect(useUi.getState().previewMode).toBe('source');
    expect(usePlayback.getState().playing).toBe(false);
    // nothing under the playhead
    useUi.getState().activateProgram();
    usePlayback.setState({ time: 100 });
    useUi.setState({ toasts: [] });
    runMatchFrame();
    expect(toasts()).toEqual([REASON_TEXT.noMediaUnder]);
    expect(useUi.getState().previewMode).toBe('output');
  });

  it('replaced toast', () => {
    const clip = ed().project!.clips[0] as VideoClip;
    const asset = ed().project!.assets.find((a) => a.id === 'va')!;
    const m: MatchTarget = { clip, asset, time: 3, marks: { in: 2, out: 6 } };
    // no marks before: nothing replaced
    expect(applyMatch(m)).toEqual({ replaced: false });
    expect(toasts()).toEqual([]);
    expect(marks()).toEqual({ in: 2, out: 6 });
    // the same marks again: nothing replaced
    expect(applyMatch(m)).toEqual({ replaced: false });
    expect(toasts()).toEqual([]);
    // other marks: replaced, once, and said
    ed().setMediaMarks('va', { in: 1, out: 3 });
    expect(applyMatch(m)).toEqual({ replaced: true });
    expect(toasts()).toEqual(["the media's in and out now match the clip"]);
    expect(marks()).toEqual({ in: 2, out: 6 });
    // a picture has no marks to write
    const img = ed().project!.assets.find((a) => a.id === 'img')!;
    expect(applyMatch({ clip, asset: img, time: 0, marks: null })).toEqual({ replaced: false });
    expect(src().assetId).toBe('img');
  });

  it('reverse match', () => {
    src().open('va', 3);
    useUi.getState().activateSource();
    ed().select(['c1']);
    usePlayback.setState({ time: 9 });
    runMatchFrame();
    // media 3 s is the timeline 1 s: the playhead goes there, the program is back, the selection stays
    expect(usePlayback.getState().time).toBe(1);
    expect(useUi.getState().previewMode).toBe('output');
    expect(src().playing).toBe(false);
    expect(ed().selection).toEqual(['c1']);
    // a moment no clip uses
    src().seek(9);
    useUi.getState().activateSource();
    useUi.setState({ toasts: [] });
    runMatchFrame();
    expect(toasts()).toEqual([REASON_TEXT.notOnTimeline]);
    expect(useUi.getState().previewMode).toBe('source');
    // no media in the source
    src().close();
    useUi.setState({ toasts: [] });
    runMatchFrame();
    expect(toasts()).toEqual([REASON_TEXT.sourceEmpty]);
  });

  it('addMedia parts', () => {
    const call = vi.mocked(insertMedia);
    expect(addMedia('nope')).toBeNull();
    expect(call).not.toHaveBeenCalled();
    // no marks, both parts, no options: nothing but the id goes through
    const id = addMedia('va')!;
    expect(id).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith('va', {});
    // only the set keys
    addMedia('va', { start: 12, trackId: ed().project!.tracks[0]!.id, skipHistory: true });
    expect(call.mock.lastCall![1]).toStrictEqual({ start: 12, trackId: ed().project!.tracks[0]!.id, skipHistory: true });
    // the marks are the range
    ed().setMediaMarks('va', { in: 1, out: 3 });
    const marked = addMedia('va', { start: 20 })!;
    expect(call.mock.lastCall![1]).toStrictEqual({ start: 20, range: { in: 1, out: 3 } });
    const clip = ed().project!.clips.find((c) => c.id === marked) as VideoClip;
    expect(clip.trimStart).toBe(1);
    expect(clip.duration).toBe(2);
    // parts only when not both
    const sound = addMedia('va', { start: 30, parts: 'sound' })!;
    expect(call.mock.lastCall![1]).toStrictEqual({ start: 30, range: { in: 1, out: 3 }, parts: 'sound' });
    expect(ed().project!.clips.find((c) => c.id === sound)!.type).toBe('audio');
    addMedia('va', { parts: 'both' });
    expect(call.mock.lastCall![1]).toStrictEqual({ range: { in: 1, out: 3 } });
    // a picture has no marks
    addMedia('img', { start: 40 });
    expect(call.mock.lastCall![1]).toStrictEqual({ start: 40 });
    // a part the media does not have
    call.mockClear();
    useUi.setState({ toasts: [] });
    expect(addMedia('sv', { parts: 'sound' })).toBeNull();
    expect(addMedia('au', { parts: 'picture' })).toBeNull();
    expect(toasts()).toEqual([REASON_TEXT.noSound, REASON_TEXT.noPicture]);
    expect(call).not.toHaveBeenCalled();
    // the source's own add: at the playhead, with the marks
    useUi.setState({ toasts: [] });
    sourceAdd();
    expect(toasts()).toEqual([REASON_TEXT.sourceEmpty]);
    sourceAddPart('sound');
    expect(toasts()).toEqual([REASON_TEXT.sourceEmpty, REASON_TEXT.sourceEmpty]);
    src().open('va');
    usePlayback.setState({ time: 50 });
    sourceAdd();
    expect(call.mock.lastCall![1]).toStrictEqual({ start: 50, range: { in: 1, out: 3 } });
    sourceAddPart('picture');
    expect(call.mock.lastCall![1]).toStrictEqual({ start: 50, range: { in: 1, out: 3 }, parts: 'picture' });
  });

  it('emptySource', () => {
    openInSource('va', 4);
    expect(src().assetId).toBe('va');
    expect(src().time).toBe(4);
    expect(useUi.getState().previewMode).toBe('source');
    toggleSource();
    expect(useUi.getState().previewMode).toBe('output');
    toggleSource();
    expect(useUi.getState().previewMode).toBe('source');
    emptySource();
    expect(src().assetId).toBeNull();
    expect(useUi.getState().previewMode).toBe('output');
    // closed while the timeline is the active view: the view stays
    src().open('va');
    expect(useUi.getState().previewMode).toBe('output');
    emptySource();
    expect(src().assetId).toBeNull();
    expect(useUi.getState().previewMode).toBe('output');
  });
});
