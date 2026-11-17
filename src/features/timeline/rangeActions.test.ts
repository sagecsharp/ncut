import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioClip, Clip, EffectClip, ImageClip, MediaAsset, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject, createTrack } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { REASON_TEXT, reasonFor, reasonSnapshot } from '../shell/reasons';
import { SHORTCUTS } from '../shell/shortcuts';
import { paletteActions } from '../shell/paletteActions';
import { extract, goOut, lift, markClip, markIn, markOut, runRangeEdit } from './rangeActions';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): Clip => proj().clips.find((c) => c.id === id)!;
const toasts = (): string[] => useUi.getState().toasts.map((t) => t.message);

const asset = (id: string, kind: 'image' | 'video' | 'audio', duration = 0): MediaAsset => ({
  id, name: id, kind, mime: kind + '/x', size: 1, duration, width: 100, height: 100, hasAudio: kind !== 'image', createdAt: 0,
});
const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const video = (trackId: string, id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'vid1', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (trackId: string, id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'vid1', trimStart: 0, speed: 1, volume: 1, muted: false, ...over,
});

const V0 = 'v0';
const V1 = 'v1';
const AU = 'au';
const LK = 'lk';

/** v0 and v1 video tracks, au audio, lk a locked video track */
function open(clips: Clip[], range?: Project['range'], selection: string[] = []): void {
  const p = createProject('range actions');
  const tracks = [
    { ...createTrack('video', 'v0'), id: V0 },
    { ...createTrack('video', 'v1'), id: V1 },
    { ...createTrack('audio', 'au'), id: AU },
    { ...createTrack('video', 'lk'), id: LK, locked: true },
  ];
  const next: Project = { ...p, tracks, clips, assets: [asset('img1', 'image'), asset('vid1', 'video', 60)] };
  if (range) next.range = range;
  ed().openProject(next);
  useEditor.setState({ selection, past: [], future: [], clipboard: [] });
  usePlayback.setState({ time: 0, playing: false });
}

const starts = (): Record<string, number> => Object.fromEntries(proj().clips.map((c) => [c.id, Math.round(c.start * 1e6) / 1e6]));

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useUi.setState({ toasts: [], previewMode: 'output', programMode: 'output', trimEdge: null });
  usePlayback.setState({ time: 0, playing: false });
});

describe('lift', () => {
  it('lift is one undo step and keeps the range', () => {
    open([image(V0, 'a', 0, 8), image(V1, 'b', 3, 1), image(V1, 'c', 5, 2)], { in: 2, out: 4 });
    const before = JSON.stringify(proj());
    const r = runRangeEdit('lift');
    expect(r).toMatchObject({ ok: true, in: 2, out: 4, removed: 1, splits: 1, moved: 0, slivers: 0, lockedTracks: 0 });
    expect(proj().range).toEqual({ in: 2, out: 4 });
    expect(proj().clips.some((c) => c.id === 'b')).toBe(false);
    expect(starts().c).toBe(5);
    expect(usePlayback.getState().time).toBe(2);
    expect(ed().past).toHaveLength(1);
    ed().undo();
    expect(JSON.stringify(proj())).toBe(before);
  });
  it('lift keeps the transition after out', () => {
    const tr = { id: 'fade', duration: 0.5 } as unknown as ImageClip['transition'];
    open([image(V0, 'a', 0, 8), image(V0, 'b', 8, 3, { transition: tr })], { in: 2, out: 5 });
    lift();
    expect(toasts().at(-1)).toContain('lifted');
    expect((clipOf('b') as ImageClip).transition).toEqual(tr);
  });
  it('lift drops a transition whose clip before is gone', () => {
    const tr = { id: 'fade', duration: 0.5 } as unknown as ImageClip['transition'];
    open([image(V0, 'a', 0, 8), image(V0, 'b', 8, 3, { transition: tr })], { in: 6, out: 8 });
    runRangeEdit('lift');
    expect((clipOf('b') as ImageClip).transition ?? null).toBeNull();
  });
});

describe('extract', () => {
it('extract keeps the transition when the clip before is the same clip', () => {    const tr = { id: 'fade', duration: 0.5 } as unknown as ImageClip['transition'];    open([image(V0, 'a', 0, 6), image(V0, 'b', 6, 2, { transition: tr })], { in: 2, out: 6 });    runRangeEdit('extract');    expect(starts()).toEqual({ a: 0, b: 2 });    expect((clipOf('b') as ImageClip).transition).toEqual(tr);  });
  it('extract moves every unlocked track by one amount', () => {
    open([image(V0, 'a', 0, 2.02), image(V0, 'b', 5, 2), image(V1, 'c', 4, 2), audio(AU, 'd', 6, 2)], { in: 2, out: 4 });
    const r = runRangeEdit('extract');
    expect(r).toMatchObject({ ok: true, moved: 3, removed: 0, trimmed: 1 });
    expect(starts()).toEqual({ a: 0, b: 3, c: 2, d: 4 });
    expect(clipOf('a').duration).toBeCloseTo(2, 9);
    expect(ed().past).toHaveLength(1);
  });
  it('a clip over both marks becomes two touching at in', () => {
    open([video(V0, 'a', 0, 8, { trimStart: 1, keyframes: { x: [{ t: 0, v: 0, ease: 'linear' }, { t: 6, v: 10, ease: 'linear' }] } })], { in: 2, out: 4 });
    expect(runRangeEdit('extract')).toMatchObject({ ok: true, splits: 1 });
    const left = clipOf('a') as VideoClip;
    const right = proj().clips.find((c) => c.id !== 'a') as VideoClip;
    expect(left.start + left.duration).toBe(2);
    expect(right.start).toBe(2);
    expect(right.duration).toBe(4);
    expect(right.trimStart).toBe(5);
    expect(right.keyframes?.x?.some((k) => Math.abs(k.t - 2) < 1e-6 && k.v === 10)).toBe(true);
  });
  it('effect timeOffset carries on', () => {
    const fx = { id: 'fx', type: 'effect', trackId: V1, start: 0, duration: 8, name: 'fx', fadeIn: 0, fadeOut: 0, effect: 'blur', target: 'a', params: {} } as unknown as EffectClip;
    open([image(V0, 'a', 0, 8), fx], { in: 2, out: 4 });
    expect(runRangeEdit('extract').ok).toBe(true);
    const right = proj().clips.find((c) => c.type === 'effect' && c.id !== 'fx') as EffectClip;
    expect(right.start).toBe(2);
    expect(right.timeOffset).toBe(4);
    expect((clipOf('fx') as EffectClip).duration).toBe(2);
  });
  it('attached clips and group mates on unlocked tracks move', () => {
    open([
      image(V0, 'p', 5, 2),
      image(V1, 'k', 5, 2, { parent: 'p' }),
      image(V0, 'g1', 8, 1, { group: 'G' }),
      image(V1, 'g2', 8, 1, { group: 'G' }),
    ], { in: 2, out: 4 });
    expect(runRangeEdit('extract').ok).toBe(true);
    expect(starts()).toEqual({ p: 3, k: 3, g1: 6, g2: 6 });
  });
  it('a locked track stays and the toast says so', () => {
    open([image(V0, 'a', 5, 2), image(LK, 'x', 5, 2), image(LK, 'y', 3, 0.5), image(V1, 'g', 6, 1, { group: 'G' }), image(LK, 'm', 6, 1, { group: 'G' })], { in: 2, out: 4 });
    extract();
    expect(starts()).toMatchObject({ a: 3, x: 5, y: 3, g: 4, m: 6 });
    expect(toasts().at(-1)).toContain('1 locked track stayed where it was');
  });
  it('after extract only the in stays, a second extract says inOutBoth', () => {
    open([image(V0, 'a', 0, 8)], { in: 2, out: 4 });
    extract();
    expect(proj().range).toEqual({ in: 2 });
    const before = JSON.stringify(proj());
    extract();
    expect(toasts().at(-1)).toBe(REASON_TEXT.inOutBoth);
    expect(JSON.stringify(proj())).toBe(before);
    expect(runRangeEdit('extract')).toMatchObject({ ok: false, reason: REASON_TEXT.inOutBoth, in: 0, out: 0 });
  });
  it('extract with nothing after out works', () => {
    open([image(V0, 'a', 0, 2.02)], { in: 2, out: 4 });
    expect(runRangeEdit('extract')).toMatchObject({ ok: true, moved: 0, trimmed: 1 });
    expect(clipOf('a').duration).toBeCloseTo(2, 9);
    expect(proj().range).toEqual({ in: 2 });
  });
  it('video and audio of one media stay in sync', () => {
    open([video(V0, 'v', 0, 10, { trimStart: 3, speed: 2 }), audio(AU, 'a', 0, 10, { trimStart: 3, speed: 2 })], { in: 2, out: 5 });
    expect(runRangeEdit('extract').ok).toBe(true);
    const sync = (c: Clip): number => c.start - (c as VideoClip).trimStart / (c as VideoClip).speed;
    const vs = proj().clips.filter((c) => c.type === 'video');
    const as = proj().clips.filter((c) => c.type === 'audio');
    expect(vs).toHaveLength(2);
    for (const v of vs) {
      const mate = as.find((a) => Math.abs(a.start - v.start) < 1e-9)!;
      expect(mate).toBeDefined();
      expect(sync(mate)).toBeCloseTo(sync(v), 9);
    }
  });
});

describe('a stop', () => {
  it('a blocked split changes nothing and names the clip', () => {
    // a solid on a locked track shows a: a cannot be cut without it
    const solid = image(LK, 's', 0, 10, { threeD: true, shape: 'box', faces: { front: { clip: 'a' } } } as Partial<ImageClip>);
    open([image(V0, 'a', 0, 10), solid], { in: 2, out: 4 });
    const before = JSON.stringify(proj());
    const r = runRangeEdit('lift');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('lift stopped: "a" could not be split at the in or out point');
    expect(r).toMatchObject({ in: 2, out: 4, removed: 0, splits: 0 });
    expect(JSON.stringify(proj())).toBe(before);
    expect(ed().past).toHaveLength(0);
    lift();
    expect(useUi.getState().toasts.at(-1)).toMatchObject({ kind: 'error' });
    expect(JSON.stringify(proj())).toBe(before);
  });
  it('a block says why before anything is written', () => {
    open([image(LK, 'x', 3, 1)], { in: 2, out: 4 });
    expect(runRangeEdit('lift')).toMatchObject({ ok: false, reason: REASON_TEXT.inOutLocked });
    open([image(V0, 'x', 6, 1)], { in: 2, out: 4 });
    expect(runRangeEdit('lift')).toMatchObject({ ok: false, reason: REASON_TEXT.inOutNothing });
  });
});

describe('the keys', () => {
  const rows = ['mark-in', 'mark-out', 'mark-clip', 'clear-in-out', 'go-in', 'go-out', 'play-in-out', 'lift', 'extract'];
  const search = ['mark-selection', 'clear-in', 'clear-out'];
  const setups: { clips: Clip[]; range?: Project['range']; select: string[]; time: number }[] = [
    { clips: [], select: [], time: 0 },
    { clips: [image(V0, 'a', 0, 5)], select: [], time: 100 },
    { clips: [image(V0, 'a', 0, 5)], select: ['a'], time: 1 },
    { clips: [image(V0, 'a', 0, 5)], select: [], time: 1, range: { in: 1 } },
    { clips: [image(V0, 'a', 0, 5)], select: [], time: 1, range: { out: 3 } },
    { clips: [image(V0, 'a', 0, 5)], select: [], time: 1, range: { in: 20, out: 30 } },
    { clips: [image(LK, 'a', 0, 5)], select: ['a'], time: 1, range: { in: 1, out: 3 } },
    { clips: [image(V0, 'a', 0, 2)], select: [], time: 1, range: { in: 3, out: 4 } },
    { clips: [image(V0, 'a', 0, 5)], select: ['a'], time: 1, range: { in: 1, out: 3 } },
  ];
  const snap = () => JSON.stringify({ project: ed().project, selection: ed().selection, time: usePlayback.getState().time, playing: usePlayback.getState().playing, past: ed().past.length, future: ed().future.length });

  it('a reason means the run changes nothing', () => {
    let checked = 0;
    for (const id of [...rows, ...search]) {
      for (const s of setups) {
        open(s.clips, s.range, s.select);
        usePlayback.setState({ time: s.time });
        const why = reasonFor(id, reasonSnapshot());
        if (!why) continue;
        const run = rows.includes(id) ? SHORTCUTS.find((r) => r.id === id)!.run : paletteActions().find((a) => a.id === id)!.run;
        const before = snap();
        run();
        expect(snap(), `${id}: ${why}`).toBe(before);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
  it('i, o and x add no history', () => {
    open([image(V0, 'a', 0, 5)]);
    usePlayback.setState({ time: 1 });
    markIn();
    usePlayback.setState({ time: 2 });
    markOut();
    markClip();
    expect(ed().past).toHaveLength(0);
    expect(ed().future).toHaveLength(0);
    expect(proj().range).toEqual({ in: 0, out: 5 });
  });
  it('o includes the frame, go out lands on the last frame inside', () => {
    open([image(V0, 'a', 0, 5)]);
    usePlayback.setState({ time: 1.01 });
    markOut();
    expect(proj().range?.out).toBeCloseTo(1 + 1 / 30, 9);
    usePlayback.setState({ time: 4 });
    goOut();
    expect(usePlayback.getState().time).toBeCloseTo(1, 9);
  });
});

describe('the i hint', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  });
  afterEach(() => vi.unstubAllGlobals());
  const hints = () => toasts().filter((m) => m.startsWith('i marks the in point now')).length;

  it('shows at most 3 times', () => {
    open([image(V0, 'a', 0, 5)], undefined, ['a']);
    for (let i = 0; i < 6; i++) markIn();
    expect(hints()).toBe(3);
  });
  it('shows only with a visual or camera clip selected', () => {
    open([image(V0, 'a', 0, 5), audio(AU, 'b', 0, 5)], undefined, ['b']);
    markIn();
    markIn();
    expect(hints()).toBe(0);
  });
  it('shows nothing without storage', () => {
    vi.unstubAllGlobals();
    open([image(V0, 'a', 0, 5)], undefined, ['a']);
    markIn();
    expect(hints()).toBe(0);
  });
});
