import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioClip, Clip, ImageClip, MediaAsset, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { REASON_TEXT } from '../shell/reasons';
import { NUDGE_TEXT } from './timeNudge';
import { applyNudge, keysOnTimeline, nudgeBy, nudgeKey, resetNudgeState, stepEdit } from './nudgeActions';
import { nudgeTrimEdge } from './trimActions';
import { interaction } from './view';

vi.mock('./trimActions', async (orig) => ({ ...(await orig<typeof import('./trimActions')>()), nudgeTrimEdge: vi.fn() }));

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const toasts = () => useUi.getState().toasts.map((t) => t.message);
const clip = (id: string) => proj().clips.find((c) => c.id === id)!;

const asset = (id: string, kind: 'image' | 'video' | 'audio'): MediaAsset => ({
  id, name: id, kind, mime: kind + '/x', size: 1, duration: kind === 'image' ? 0 : 60, width: 100, height: 100, hasAudio: kind !== 'image', createdAt: 0,
});
const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const video = (trackId: string, id: string, start: number, duration: number): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'vid1', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM },
});
const audio = (trackId: string, id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'aud1', trimStart: 0, speed: 1, volume: 1, muted: false, ...over,
});

/** t0, t1, t2 video tracks, t3 audio. a (0..2), b (3..5) images, v (6..8) video, au (0..5) audio */
function open(clips?: (t: string[]) => Clip[], lockLast = false): string[] {
  const p = createProject('nudge');
  ed().openProject({ ...p, assets: [asset('img1', 'image'), asset('vid1', 'video'), asset('aud1', 'audio')], clips: [] });
  for (let i = 0; i < 3; i++) ed().addTrack('video');
  const t = proj().tracks.map((x) => x.id);
  const list = clips ? clips(t) : [image(t[0]!, 'a', 0, 2), image(t[1]!, 'b', 3, 2), video(t[2]!, 'v', 6, 2), audio(t[3]!, 'au', 0, 5)];
  const tracks = proj().tracks.map((x) => (lockLast && x.id === t[3] ? { ...x, locked: true } : x));
  useEditor.setState({ project: { ...proj(), clips: list, tracks }, past: [], future: [], selection: [], clipboard: [] });
  usePlayback.setState({ time: 0, playing: false });
  return t;
}

beforeEach(() => {
  resetNudgeState();
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  usePlayback.setState({ time: 0, playing: false });
  useUi.setState({ toasts: [], trimEdge: null, previewMode: 'output', programMode: 'output' });
  interaction.gestureActive = false;
  vi.mocked(nudgeTrimEdge).mockClear();
});

describe('nudgeBy', () => {
  it('one press one step', () => {
    open();
    ed().select(['a'], 'replace');
    const before = JSON.stringify(proj());
    nudgeBy(1);
    expect(clip('a').start).toBeCloseTo(1 / proj().fps, 9);
    expect(ed().past.length).toBe(1);
    ed().undo();
    expect(JSON.stringify(proj())).toBe(before);
  });

  it('five repeats one step', () => {
    open();
    ed().select(['a'], 'replace');
    const before = JSON.stringify(proj());
    nudgeBy(1);
    for (let i = 0; i < 4; i++) nudgeBy(1, true);
    expect(clip('a').start).toBeCloseTo(5 / proj().fps, 9);
    expect(ed().past.length).toBe(1);
    ed().undo();
    expect(JSON.stringify(proj())).toBe(before);
  });

  it('another edit or an undo between presses starts a new step', () => {
    open();
    ed().select(['a'], 'replace');
    nudgeBy(1);
    ed().moveClips([{ id: 'b', trackId: clip('b').trackId, start: 4 }]);
    nudgeBy(1, true);
    expect(ed().past.length).toBe(3);
    ed().undo();
    ed().undo();
    expect(ed().past.length).toBe(1);
    nudgeBy(1, true);
    expect(ed().past.length).toBe(2);
    expect(clip('a').start).toBeCloseTo(2 / proj().fps, 9);
  });

  it('blocked: same project, one toast for ten repeats', () => {
    open((t) => [image(t[0]!, 'a', 0, 2), image(t[0]!, 'b', 2.1, 2)]);
    ed().select(['a'], 'replace');
    const p = proj();
    for (let i = 0; i < 10; i++) nudgeBy(10, i > 0);
    expect(proj()).toBe(p);
    expect(toasts().length).toBe(1);
    expect(toasts()[0]).toContain('b');
  });

  it('the locked toast', () => {
    open((t) => [image(t[0]!, 'a', 1, 2, { group: 'g' }), audio(t[3]!, 'au', 1, 2, { group: 'g' })], true);
    ed().select(['a'], 'replace');
    nudgeBy(1);
    expect(clip('a').start).toBeCloseTo(1 + 1 / proj().fps, 9);
    expect(clip('au').start).toBe(1);
    expect(toasts().length).toBe(1);
    expect(toasts()[0]).toContain('locked tracks did not move');
    expect(toasts()[0]).toContain(proj().tracks[3]!.name);
  });

  it('nothing selected, no clips', () => {
    open();
    nudgeBy(1);
    expect(toasts()).toEqual([REASON_TEXT.selectClip]);
    useUi.setState({ toasts: [] });
    resetNudgeState();
    open(() => []);
    nudgeBy(1);
    expect(toasts()).toEqual([REASON_TEXT.addClip]);
  });

  it('a live edge calls nudgeTrimEdge, a blocked one toasts once', () => {
    open();
    ed().select(['v'], 'replace');
    useUi.setState({ trimEdge: { clipId: 'v', edge: 'end', both: false, alone: false } });
    const p = proj();
    nudgeBy(-1);
    expect(nudgeTrimEdge).toHaveBeenCalledWith(-1);
    expect(proj()).toBe(p);
    expect(toasts()).toEqual([]);
    vi.mocked(nudgeTrimEdge).mockClear();
    // the video starts at media 0: its start edge cannot go left
    useUi.setState({ trimEdge: { clipId: 'v', edge: 'start', both: false, alone: false } });
    for (let i = 0; i < 3; i++) nudgeBy(-1, i > 0);
    expect(nudgeTrimEdge).not.toHaveBeenCalled();
    expect(toasts().length).toBe(1);
  });

  it('a gone edge is cleared', () => {
    open();
    ed().select(['a'], 'replace');
    useUi.setState({ trimEdge: { clipId: 'ghost', edge: 'end', both: false, alone: false } });
    nudgeBy(1);
    expect(useUi.getState().trimEdge).toBeNull();
    expect(nudgeTrimEdge).not.toHaveBeenCalled();
    expect(clip('a').start).toBeCloseTo(1 / proj().fps, 9);
  });

  it('nothing in a gesture', () => {
    open();
    ed().select(['a'], 'replace');
    interaction.gestureActive = true;
    const p = proj();
    nudgeBy(1);
    expect(applyNudge({ moves: [{ id: 'a', trackId: clip('a').trackId, start: 1 }], ids: ['a'], stop: null, lockedStay: [], frames: 1 }, false)).toBe(false);
    expect(proj()).toBe(p);
    expect(toasts()).toEqual([]);
    usePlayback.setState({ time: 0 });
    stepEdit(1);
    expect(usePlayback.getState().time).toBe(0);
    expect(toasts()).toEqual([]);
  });

  it('the source view has the keys', () => {
    open();
    ed().select(['a'], 'replace');
    useUi.setState({ previewMode: 'source' });
    const p = proj();
    nudgeBy(1);
    expect(proj()).toBe(p);
    expect(toasts()).toEqual([REASON_TEXT.sourceHasKeys]);
    useUi.setState({ toasts: [] });
    resetNudgeState();
    stepEdit(1);
    expect(toasts()).toEqual([REASON_TEXT.sourceHasKeys]);
    expect(usePlayback.getState().time).toBe(0);
  });
});

describe('stepEdit', () => {
  it('stepEdit seeks without pausing', () => {
    open();
    usePlayback.setState({ playing: true, time: 0 });
    stepEdit(1);
    expect(usePlayback.getState().time).toBe(2);
    expect(usePlayback.getState().playing).toBe(true);
    stepEdit(1);
    expect(usePlayback.getState().time).toBe(3);
    stepEdit(-1);
    expect(usePlayback.getState().time).toBe(2);
    expect(usePlayback.getState().playing).toBe(true);
    usePlayback.setState({ playing: false });
    expect(toasts()).toEqual([]);
  });

  it('stepEdit toasts at the ends', () => {
    open();
    usePlayback.setState({ time: 100 });
    stepEdit(1);
    expect(toasts()).toEqual([REASON_TEXT.noEditAfter]);
    usePlayback.setState({ time: 0 });
    stepEdit(-1);
    expect(toasts()).toEqual([REASON_TEXT.noEditAfter, REASON_TEXT.noEditBefore]);
    ed().select(['a'], 'replace');
    stepEdit(-1);
    expect(toasts()[2]).toBe(REASON_TEXT.noEditBeforeSel);
    useUi.setState({ trimEdge: { clipId: 'a', edge: 'start', both: false, alone: false } });
    stepEdit(-1);
    expect(toasts()[3]).toBe(REASON_TEXT.noEditBeforeEdge);
    expect(usePlayback.getState().time).toBe(0);
  });

  it('stepEdit keeps the edge kind', () => {
    open((t) => [image(t[0]!, 'a', 0, 2), image(t[0]!, 'b', 2, 2)]);
    useUi.setState({ trimEdge: { clipId: 'b', edge: 'start', both: false, alone: false } });
    ed().select(['b'], 'replace');
    // 2 -> 4: nothing starts at 4, the end of b is the free end
    stepEdit(1);
    expect(useUi.getState().trimEdge).toEqual({ clipId: 'b', edge: 'end', both: false, alone: false });
    expect(usePlayback.getState().time).toBe(4);
    // back: 4 -> 2, the kind is a start again
    stepEdit(-1);
    expect(useUi.getState().trimEdge).toEqual({ clipId: 'b', edge: 'start', both: false, alone: false });
    expect(usePlayback.getState().time).toBe(2);
    expect(ed().selection).toEqual(['b']);
  });

  it('stepEdit keeps both, selects both clips and the group', () => {
    open((t) => [image(t[0]!, 'a', 0, 2), image(t[0]!, 'b', 2, 2), image(t[0]!, 'c', 4, 2)]);
    useUi.setState({ trimEdge: { clipId: 'a', edge: 'end', both: true, alone: false } });
    ed().select(['a', 'b'], 'replace');
    stepEdit(1);
    expect(useUi.getState().trimEdge).toEqual({ clipId: 'b', edge: 'end', both: true, alone: false });
    expect(new Set(ed().selection)).toEqual(new Set(['b', 'c']));
    expect(usePlayback.getState().time).toBe(4);
  });
});

describe('keysOnTimeline and nudgeKey', () => {
  const stage = { closest: (s: string) => (s.includes('.preview-stage') ? {} : null) };
  const free = { closest: () => null };

  it('keysOnTimeline and nudgeKey', () => {
    expect(keysOnTimeline(null)).toBe(true);
    expect(keysOnTimeline(undefined)).toBe(true);
    expect(keysOnTimeline({} as EventTarget)).toBe(true);
    expect(keysOnTimeline(free as unknown as EventTarget)).toBe(true);
    expect(keysOnTimeline(stage as unknown as EventTarget)).toBe(false);
    open();
    ed().select(['a'], 'replace');
    nudgeKey(1, { target: free, repeat: false } as unknown as KeyboardEvent);
    expect(clip('a').start).toBeCloseTo(1 / proj().fps, 9);
    const p = proj();
    nudgeKey(1, { target: stage, repeat: false } as unknown as KeyboardEvent);
    expect(proj()).toBe(p);
    expect(toasts()).toEqual([NUDGE_TEXT.previewKeys]);
    useUi.setState({ previewMode: 'source', toasts: [] });
    resetNudgeState();
    nudgeKey(1, { target: stage, repeat: false } as unknown as KeyboardEvent);
    expect(toasts()).toEqual([REASON_TEXT.sourceHasKeys]);
  });
});
