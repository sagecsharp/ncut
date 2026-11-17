import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Clip, ImageClip, MediaAsset, Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { clipEnd } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { TrimEdge } from '../../store/ui';
import { REASON_TEXT } from '../shell/reasons';
import { SHORTCUTS } from '../shell/shortcuts';
import { clearTrimEdge, hasTrimEdge, nudgeTrimEdge, rippleToPlayhead, selectEditAtPlayhead, slideBy, slipBy, toggleTrimMode } from './trimActions';
import { getTrimView, setTrimView } from './trimLive';
import { TRIM_TEXT, trimStopText } from './trimText';
import { interaction } from './view';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const get = (id: string): Clip => proj().clips.find((c) => c.id === id)!;
const span = (id: string): [number, number] => [get(id).start, clipEnd(get(id))];
const toasts = (): string[] => useUi.getState().toasts.map((t) => t.message);
const steps = (): number => ed().past.length;
const F = 1 / 30;

const track = (id: string, locked = false): Track => ({ id, kind: id.startsWith('a') ? 'audio' : 'video', name: id, muted: false, hidden: false, locked });
const asset = (id: string, duration: number): MediaAsset => ({ id, name: id, kind: 'video', mime: 'video/x', size: 1, duration, width: 100, height: 100, hasAudio: true, createdAt: 0 });
const video = (trackId: string, id: string, start: number, duration: number, o: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'long', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...o,
});
const audio = (trackId: string, id: string, start: number, duration: number, o: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'long', trimStart: 0, speed: 1, volume: 1, muted: false, ...o,
});
const image = (trackId: string, id: string, start: number, duration: number): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'pic', transform: { ...DEFAULT_TRANSFORM },
});

function open(clips: Clip[], o: { select?: string[]; time?: number; locked?: string[] } = {}): void {
  const p: Project = {
    ...createProject('actions'),
    tracks: ['v1', 'v2', 'a1'].map((t) => track(t, o.locked?.includes(t))),
    assets: [asset('long', 100)],
    clips,
  };
  useEditor.setState({ project: p, past: [], future: [], selection: o.select ?? [], clipboard: [] });
  usePlayback.setState({ time: o.time ?? 0 });
}

const row = (id: string) => SHORTCUTS.find((s) => s.id === id)!;
const key = (k: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent => ({ key: k, code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }) as KeyboardEvent;

beforeEach(() => {
  useEditor.setState({ project: null, past: [], future: [], selection: [], clipboard: [] });
  useUi.setState({ toasts: [], trimMode: false, trimEdge: null });
  usePlayback.setState({ time: 0 });
  interaction.gestureActive = false;
  setTrimView(null);
});

afterEach(() => {
  interaction.gestureActive = false;
  setTrimView(null);
});

describe('trim mode actions', () => {
  it('toggle and its toasts', () => {
    toggleTrimMode();
    expect(useUi.getState().trimMode).toBe(true);
    expect(toasts()).toEqual([TRIM_TEXT.modeOn]);
    const edge: TrimEdge = { clipId: 'a', edge: 'end', both: false, alone: false };
    useUi.getState().setTrimEdge(edge);
    expect(hasTrimEdge()).toBe(true);
    toggleTrimMode();
    expect(useUi.getState().trimMode).toBe(false);
    // turning the mode off drops the selected edge
    expect(hasTrimEdge()).toBe(false);
    expect(toasts()).toEqual([TRIM_TEXT.modeOn, TRIM_TEXT.modeOff]);
    expect(clearTrimEdge()).toBe(false);
    useUi.getState().setTrimEdge(edge);
    expect(clearTrimEdge()).toBe(true);
    expect(useUi.getState().trimEdge).toBeNull();
  });

  it('q is one step with the playhead at the clip start, w keeps it', () => {
    open([video('v1', 'a', 0, 4), video('v1', 'b', 4, 4), video('v2', 'x', 6, 2)], { time: 2 });
    const before = proj();
    rippleToPlayhead('start');
    expect(steps()).toBe(1);
    expect(span('a')).toEqual([0, 2]);
    expect((get('a') as VideoClip).trimStart).toBe(2);
    expect(span('b')).toEqual([2, 6]);
    expect(span('x')).toEqual([4, 6]);
    expect(usePlayback.getState().time).toBe(0);
    expect(getTrimView()).toEqual({ mode: 'ripple', clipId: 'a', edge: 'start' });
    expect(toasts()).toEqual([]);
    ed().undo();
    expect(proj().clips).toEqual(before.clips);
    usePlayback.setState({ time: 3 });
    rippleToPlayhead('end');
    expect(steps()).toBe(1);
    expect(span('a')).toEqual([0, 3]);
    expect(span('b')).toEqual([3, 7]);
    expect(usePlayback.getState().time).toBe(3);
    expect(getTrimView()).toEqual({ mode: 'ripple', clipId: 'a', edge: 'end' });
  });

  it('q tells the locked tracks that stayed', () => {
    open([video('v1', 'a', 0, 4), video('v1', 'b', 4, 4), video('v2', 'k', 6, 2)], { time: 2, locked: ['v2'] });
    rippleToPlayhead('end');
    expect(steps()).toBe(1);
    expect(span('k')).toEqual([6, 8]);
    expect(toasts()).toEqual([TRIM_TEXT.lockedStay.replace('{tracks}', 'v2')]);
  });

  it('a short q toasts and changes nothing', () => {
    // v2 starts 0.5 after the head: the start edge cannot go further than 3.5 without the clip before 0
    open([video('v1', 'h', 3, 5), video('v2', 'm', 3.5, 1.5)], { time: 7 });
    const before = proj();
    rippleToPlayhead('start');
    expect(proj()).toBe(before);
    expect(steps()).toBe(0);
    expect(toasts()).toEqual([trimStopText({ why: 'timeline-start', clipId: 'm' }, proj())]);
    expect(getTrimView()).toBeNull();
    // nothing under the playhead, the selection is elsewhere, no clips
    useUi.setState({ toasts: [] });
    usePlayback.setState({ time: 50 });
    rippleToPlayhead('end');
    expect(toasts()).toEqual([REASON_TEXT.noClipUnder]);
    useUi.setState({ toasts: [] });
    useEditor.setState({ selection: ['m'] });
    usePlayback.setState({ time: 7 });
    rippleToPlayhead('end');
    expect(toasts()).toEqual([REASON_TEXT.playheadOnClip]);
    useUi.setState({ toasts: [] });
    open([]);
    rippleToPlayhead('end');
    expect(toasts()).toEqual([REASON_TEXT.addClip]);
    expect(steps()).toBe(0);
  });

  it('nudges of 1 and 10 frames are one step each, all or nothing', () => {
    open([video('v1', 'a', 0, 4), video('v1', 'b', 4, 4), video('v2', 'x', 6, 2)]);
    useUi.getState().setTrimEdge({ clipId: 'a', edge: 'end', both: false, alone: false });
    usePlayback.setState({ time: 1 });
    nudgeTrimEdge(1);
    expect(steps()).toBe(1);
    expect(span('a')[1]).toBeCloseTo(4 + F, 9);
    expect(span('b')[0]).toBeCloseTo(4 + F, 9);
    expect(span('x')[0]).toBeCloseTo(6 + F, 9);
    expect(getTrimView()).toEqual({ mode: 'ripple', clipId: 'a', edge: 'end' });
    nudgeTrimEdge(-10);
    expect(steps()).toBe(2);
    expect(span('a')[1]).toBeCloseTo(4 + F - 10 * F, 9);
    // the playhead stays and the edge stays selected
    expect(usePlayback.getState().time).toBe(1);
    expect(useUi.getState().trimEdge?.clipId).toBe('a');
    // a stop is the whole answer: nothing is trimmed
    const before = proj();
    nudgeTrimEdge(-1000);
    expect(proj()).toBe(before);
    expect(steps()).toBe(2);
    expect(toasts().pop()).toBe(trimStopText({ why: 'min-length', clipId: 'a' }, proj()));
    // the edit between two clips
    open([video('v1', 'a', 0, 4), video('v1', 'b', 4, 4)]);
    useUi.getState().setTrimEdge({ clipId: 'a', edge: 'end', both: true, alone: false });
    nudgeTrimEdge(10);
    expect(steps()).toBe(1);
    expect(span('a')[1]).toBeCloseTo(4 + 10 * F, 9);
    expect(span('b')[0]).toBeCloseTo(4 + 10 * F, 9);
    expect(span('b')[1]).toBe(8);
    expect(getTrimView()).toEqual({ mode: 'move-edit', clipId: 'a', edge: 'end', otherId: 'b' });
  });

  it('a nudge takes the selected clips with it unless the edge was picked alone', () => {
    open([video('v1', 'a', 0, 4), video('v2', 'b', 0, 4)], { select: ['a', 'b'] });
    useUi.getState().setTrimEdge({ clipId: 'a', edge: 'end', both: false, alone: false });
    nudgeTrimEdge(-3);
    expect(span('a')[1]).toBeCloseTo(4 - 3 * F, 9);
    expect(span('b')[1]).toBeCloseTo(4 - 3 * F, 9);
    open([video('v1', 'a', 0, 4), video('v2', 'b', 0, 4)], { select: ['a', 'b'] });
    useUi.getState().setTrimEdge({ clipId: 'a', edge: 'end', both: false, alone: true });
    nudgeTrimEdge(-3);
    expect(span('a')[1]).toBeCloseTo(4 - 3 * F, 9);
    expect(span('b')[1]).toBe(4);
  });

  it('a gone clip clears the edge', () => {
    open([video('v1', 'a', 0, 4)]);
    useUi.getState().setTrimEdge({ clipId: 'gone', edge: 'end', both: false, alone: false });
    expect(hasTrimEdge()).toBe(true);
    nudgeTrimEdge(1);
    expect(hasTrimEdge()).toBe(false);
    expect(toasts()).toEqual([REASON_TEXT.pickEdge]);
    expect(steps()).toBe(0);
    // no edge: nothing at all
    useUi.setState({ toasts: [] });
    nudgeTrimEdge(1);
    expect(toasts()).toEqual([]);
  });

  it('u cycles', () => {
    open([video('v1', 'a', 0, 4), video('v1', 'b', 4, 4), video('v2', 'c', 9, 1)], { time: 4 });
    selectEditAtPlayhead();
    expect(useUi.getState().trimEdge).toEqual({ clipId: 'a', edge: 'end', both: true, alone: false });
    expect(useUi.getState().trimMode).toBe(true);
    expect([...ed().selection].sort()).toEqual(['a', 'b']);
    expect(toasts().pop()).toBe('selected the end of "a" and the start of "b"');
    selectEditAtPlayhead();
    expect(useUi.getState().trimEdge).toEqual({ clipId: 'a', edge: 'end', both: false, alone: false });
    expect(toasts().pop()).toBe('selected the end of "a"');
    selectEditAtPlayhead();
    expect(useUi.getState().trimEdge).toEqual({ clipId: 'b', edge: 'start', both: false, alone: false });
    expect(toasts().pop()).toBe('selected the start of "b"');
    selectEditAtPlayhead();
    expect(useUi.getState().trimEdge).toEqual({ clipId: 'a', edge: 'end', both: true, alone: false });
    // the selection stays the two clips on the way around
    expect([...ed().selection].sort()).toEqual(['a', 'b']);
    expect(steps()).toBe(0);
    // a lone edge, then nothing there
    usePlayback.setState({ time: 9 });
    selectEditAtPlayhead();
    expect(useUi.getState().trimEdge).toEqual({ clipId: 'c', edge: 'start', both: false, alone: false });
    expect(ed().selection).toEqual(['c']);
    useUi.setState({ toasts: [] });
    usePlayback.setState({ time: 6.5 });
    selectEditAtPlayhead();
    expect(toasts()).toEqual([REASON_TEXT.noEdgeHere]);
  });

  it('u picks the group of the edge clips', () => {
    open([video('v1', 'a', 0, 4), video('v1', 'b', 4, 4), audio('a1', 'g', 0, 4, { group: 'k' })], { time: 0 });
    useEditor.setState({ project: { ...proj(), clips: proj().clips.map((c) => (c.id === 'a' ? { ...c, group: 'k' } : c)) } });
    selectEditAtPlayhead();
    expect([...ed().selection].sort()).toEqual(['a', 'g']);
  });

  it('u leaves the selection alone when a group mate on a locked track cannot be selected', () => {
    open([video('v1', 'a', 0, 4), video('v1', 'b', 4, 4), audio('a1', 'g', 0, 4, { group: 'k' })], { time: 0, locked: ['a1'] });
    useEditor.setState({ project: { ...proj(), clips: proj().clips.map((c) => (c.id === 'a' ? { ...c, group: 'k' } : c)) } });
    selectEditAtPlayhead();
    expect(ed().selection).toEqual(['a']);
    const again = ed().selection;
    selectEditAtPlayhead();
    expect(ed().selection).toBe(again);
  });

  it('slipBy and slideBy', () => {
    open([video('v1', 'l', 0, 4), video('v1', 'c', 4, 4, { trimStart: 5 }), video('v1', 'r', 8, 4, { trimStart: 2 }), video('v2', 'f', 0, 4, { trimStart: 1, speed: 2 })], { select: ['c'] });
    slipBy(1);
    expect(steps()).toBe(1);
    expect((get('c') as VideoClip).trimStart).toBeCloseTo(5 + F, 9);
    expect(span('c')).toEqual([4, 8]);
    expect(getTrimView()).toEqual({ mode: 'slip', clipId: 'c' });
    slipBy(-10);
    expect(steps()).toBe(2);
    expect((get('c') as VideoClip).trimStart).toBeCloseTo(5 - 9 * F, 9);
    // a sped up clip slips by frames of the timeline: more media per frame
    useEditor.setState({ selection: ['f'] });
    slipBy(3);
    expect((get('f') as VideoClip).trimStart).toBeCloseTo(1 + 6 * F, 9);
    // a stop says why, no step
    useEditor.setState({ selection: ['l'] });
    const n = steps();
    slipBy(-1);
    expect(steps()).toBe(n);
    expect(toasts().pop()).toBe(trimStopText({ why: 'media-start', clipId: 'l' }, proj()));
    useUi.setState({ toasts: [] });
    useEditor.setState({ selection: [] });
    slipBy(1);
    expect(toasts()).toEqual([REASON_TEXT.timedFirst]);
    // slide
    useUi.setState({ toasts: [] });
    useEditor.setState({ selection: ['c'] });
    const m = steps();
    slideBy(2);
    expect(steps()).toBe(m + 1);
    expect(span('c')[0]).toBeCloseTo(4 + 2 * F, 9);
    expect(span('l')[1]).toBeCloseTo(4 + 2 * F, 9);
    expect(span('r')[0]).toBeCloseTo(8 + 2 * F, 9);
    expect(getTrimView()).toEqual({ mode: 'slide', clipId: 'c' });
    useEditor.setState({ selection: [] });
    slideBy(1);
    expect(toasts()).toEqual([REASON_TEXT.selectClip]);
    // a slide into a gap that is too small
    useUi.setState({ toasts: [] });
    open([video('v1', 'c', 0, 4), image('v1', 'n', 4.01, 2)], { select: ['c'] });
    slideBy(5);
    expect(steps()).toBe(0);
    expect(toasts()).toEqual([trimStopText({ why: 'overlap', clipId: 'c', otherId: 'n' }, proj())]);
  });

  it('without an edge , and . still seek', () => {
    open([video('v1', 'a', 0, 4), video('v1', 'b', 4, 4)], { time: 1 });
    expect(hasTrimEdge()).toBe(false);
    row('edge-next').run();
    expect(usePlayback.getState().time).toBe(4);
    row('edge-prev').run();
    expect(usePlayback.getState().time).toBe(0);
    expect(row('edge-next').match(key('.', { code: 'Period' }))).toBe(true);
    expect(steps()).toBe(0);
    // with an edge they trim it and the playhead stays
    usePlayback.setState({ time: 6 });
    useUi.getState().setTrimEdge({ clipId: 'a', edge: 'end', both: false, alone: false });
    row('edge-next').run();
    expect(usePlayback.getState().time).toBe(6);
    expect(span('a')[1]).toBeCloseTo(4 + F, 9);
    row('key-prev').run();
    expect(span('a')[1]).toBeCloseTo(4 + F - 10 * F, 9);
    expect(steps()).toBe(2);
  });

  it('a held key is one undo step per repeat', () => {
    open([video('v1', 'a', 0, 4), video('v1', 'b', 4, 4)]);
    useUi.getState().setTrimEdge({ clipId: 'a', edge: 'end', both: false, alone: false });
    for (let i = 0; i < 4; i++) nudgeTrimEdge(1);
    expect(steps()).toBe(4);
    ed().undo();
    expect(span('a')[1]).toBeCloseTo(4 + 3 * F, 9);
  });

  it('nothing during a gesture', () => {
    open([video('v1', 'a', 0, 4), video('v1', 'b', 4, 4)], { time: 2, select: ['b'] });
    useUi.getState().setTrimEdge({ clipId: 'a', edge: 'end', both: false, alone: false });
    const before = proj();
    interaction.gestureActive = true;
    rippleToPlayhead('start');
    rippleToPlayhead('end');
    selectEditAtPlayhead();
    nudgeTrimEdge(1);
    slipBy(1);
    slideBy(1);
    expect(proj()).toBe(before);
    expect(steps()).toBe(0);
    expect(toasts()).toEqual([]);
    expect(getTrimView()).toBeNull();
    expect(ed().selection).toEqual(['b']);
    expect(useUi.getState().trimEdge?.clipId).toBe('a');
    expect(usePlayback.getState().time).toBe(2);
  });

  it('nothing without a project', () => {
    rippleToPlayhead('start');
    selectEditAtPlayhead();
    nudgeTrimEdge(1);
    slipBy(1);
    slideBy(1);
    expect(toasts()).toEqual([]);
  });
});
