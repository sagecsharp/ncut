/**
 * the source view's clock: one media file played before it is on the timeline. its time is a time in the file.
 *
 * this store is not part of useUi on purpose: the engine redraws on any useUi change, and a playing source
 * must not redraw the output. only one of the two clocks (this and usePlayback) plays at a time.
 */
import { create } from 'zustand';
import { isExporting } from '../engine/exportState';
import { inOutSpan, lastFrameStart } from '../lib/inOut';
import { frameIndexAt, frameStart, marksOf, stepTime } from '../lib/marks';
import { clamp } from '../lib/time';
import type { MediaAsset } from '../types';
import { useEditor } from './editorStore';
import { nextShuttleRate, usePlayback } from './playback';
import { useUi } from './ui';

export interface SourceState {
  assetId: string | null;
  /** the time in the file, seconds */
  time: number;
  playing: boolean;
  /** seconds of media per second, negative = backwards, never 0 */
  rate: number;
  /** playing from the in mark to the out mark only (shift+space) */
  toOut: boolean;
  /** the source and the timeline side by side */
  split: boolean;
  /** new media: pause, time ?? where it was left ?? 0. a time always seeks. same media, no time: nothing */
  open(assetId: string, time?: number): void;
  close(): void;
  play(): void;
  pause(): void;
  toggle(): void;
  /** clamp [0, lastFrameStart(duration)] (pictures 0), exact, keeps playing */
  seek(time: number): void;
  /** pause, then stepTime */
  stepFrames(n: number): void;
  shuttle(dir: 1 | -1): void;
  /** from in, stops at out (loop: again). second call pauses. false without marks */
  playInToOut(): boolean;
  setSplit(on: boolean): void;
}

let raf = 0;
let lastTick = 0;
/** the element leads while playing forward (see setSourceMaster) */
let master: (() => number | null) | null = null;
/** where each media was left, until the project changes */
const lastTime = new Map<string, number>();

export const projectFps = (): number => useEditor.getState().project?.fps ?? 30;

/** the element leads while playing forward: its time, null while it cannot (time holds), Infinity when it ended */
export function setSourceMaster(read: (() => number | null) | null): void {
  master = read;
}

/** the open media, null when none or gone */
export function sourceAsset(): MediaAsset | null {
  const id = useSource.getState().assetId;
  if (!id) return null;
  return useEditor.getState().project?.assets.find((a) => a.id === id) ?? null;
}

/** is the source on screen: the active view, or side by side */
export function sourceVisible(): boolean {
  return useUi.getState().previewMode === 'source' || useSource.getState().split;
}

function bounds(a: MediaAsset, s: Pick<SourceState, 'toOut'>, loop: boolean): { start: number; end: number; ranged: boolean } {
  const span = inOutSpan(marksOf(a), a.duration);
  if (span && (s.toOut || loop)) return { start: span.start, end: span.end, ranged: true };
  return { start: 0, end: a.duration, ranged: false };
}

function stopAt(t: number): void {
  cancelAnimationFrame(raf);
  useSource.setState({ time: t, playing: false, rate: 1, toOut: false });
}

function tick(now: number): void {
  const s = useSource.getState();
  if (!s.playing) return;
  // an export started by anything but the dialog (mcp, bench) stops the source too
  if (isExporting()) return void s.pause();
  const a = sourceAsset();
  if (!a) return void s.pause();
  const fps = projectFps();
  const loop = usePlayback.getState().loop;
  const b = bounds(a, s, loop);
  const dt = Math.min(0.25, Math.max(0, (now - lastTick) / 1000));
  lastTick = now;
  let t: number;
  if (s.rate > 0 && master) {
    const m = master();
    if (m === null) {
      raf = requestAnimationFrame(tick);
      return;
    }
    t = m;
  } else t = s.time + dt * s.rate;
  if (s.rate > 0 && t >= b.end - 1e-6) {
    if (loop) t = b.start;
    else return void stopAt(lastFrameStart(0, b.end, fps));
  } else if (s.rate < 0 && t <= b.start + 1e-6) {
    if (loop) t = lastFrameStart(0, b.end, fps);
    else return void stopAt(b.start);
  }
  useSource.setState({ time: t });
  raf = requestAnimationFrame(tick);
}

/** media the clock can run on: not a picture, has a length, and no export running */
function playable(a: MediaAsset | null): a is MediaAsset {
  return !!a && a.kind !== 'image' && a.duration > 0 && !isExporting();
}

export const useSource = create<SourceState>()((set, get) => ({
  assetId: null,
  time: 0,
  playing: false,
  rate: 1,
  toOut: false,
  split: false,

  open(assetId, time) {
    const project = useEditor.getState().project;
    if (!project || !project.assets.some((a) => a.id === assetId)) return;
    const s = get();
    if (s.assetId === assetId) {
      if (time !== undefined) get().seek(time);
      return;
    }
    if (s.assetId) lastTime.set(s.assetId, s.time);
    get().pause();
    set({ assetId, toOut: false, rate: 1, time: 0 });
    get().seek(time ?? lastTime.get(assetId) ?? 0);
  },
  close() {
    const s = get();
    get().pause();
    if (s.assetId) lastTime.set(s.assetId, get().time);
    set({ assetId: null, time: 0 });
  },

  play() {
    const a = sourceAsset();
    if (!playable(a)) return;
    const s = get();
    if (s.playing) {
      // space while shuttling or playing to out: back to plain play
      if (s.rate !== 1 || s.toOut) set({ rate: 1, toOut: false });
      return;
    }
    const fps = projectFps();
    const b = bounds(a, { toOut: false }, usePlayback.getState().loop);
    const last = lastFrameStart(0, b.end, fps);
    let time = s.time;
    if (b.ranged) {
      if (time < b.start - 1e-6 || time >= last - 1e-6) time = b.start;
    } else if (time >= last - 1e-6) time = 0;
    set({ playing: true, rate: 1, toOut: false, time });
    lastTick = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  },
  pause() {
    const s = get();
    if (!s.playing) return;
    cancelAnimationFrame(raf);
    set({ playing: false, rate: 1, toOut: false, time: frameStart(frameIndexAt(s.time, projectFps()), projectFps()) });
  },
  toggle() {
    if (get().playing) get().pause();
    else get().play();
  },
  seek(time) {
    const a = sourceAsset();
    if (!a) return;
    const t = a.kind === 'image' ? 0 : clamp(Number.isFinite(time) ? time : 0, 0, lastFrameStart(0, a.duration, projectFps()));
    let toOut = get().toOut;
    if (toOut) {
      const span = inOutSpan(marksOf(a), a.duration);
      if (!span || t < span.start - 1e-6 || t >= span.end - 1e-6) toOut = false;
    }
    set({ time: t, toOut });
  },
  stepFrames(n) {
    const a = sourceAsset();
    if (!a || a.kind === 'image') return;
    get().pause();
    get().seek(stepTime(get().time, n, projectFps(), a.duration));
  },
  shuttle(dir) {
    const a = sourceAsset();
    if (!playable(a)) return;
    const s = get();
    const fps = projectFps();
    const b = bounds(a, { toOut: false }, usePlayback.getState().loop);
    const last = lastFrameStart(0, b.end, fps);
    let time = s.time;
    if (b.ranged) {
      if (dir === 1 && (time >= last - 1e-6 || time < b.start - 1e-6)) time = b.start;
      if (dir === -1 && (time <= b.start + 1e-6 || time > b.end + 1e-6)) time = last;
    } else {
      if (dir === 1 && time >= last - 1e-6) time = 0;
      if (dir === -1 && time <= 1e-6) time = last;
    }
    set({ playing: true, rate: nextShuttleRate(s.rate, s.playing, dir), toOut: false, time });
    if (!s.playing) {
      lastTick = performance.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    }
  },
  playInToOut() {
    const a = sourceAsset();
    const span = a ? inOutSpan(marksOf(a), a.duration) : null;
    if (!a || !span || isExporting()) return false;
    const s = get();
    if (s.playing && s.toOut) {
      s.pause();
      return true;
    }
    set({ toOut: true, playing: true, rate: 1, time: span.start });
    lastTick = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
    return true;
  },
  setSplit(on) {
    if (get().split !== on) set({ split: on });
  },
}));

// one plays at a time: the source starting stops the timeline, the timeline starting stops the source
useSource.subscribe((s, p) => {
  if (s.playing && !p.playing) usePlayback.getState().pause();
  if (p.split && !s.split) {
    if (useUi.getState().previewMode === 'source') usePlayback.getState().pause(); // timeline side hidden now
    else useSource.getState().pause(); // source pane hidden now
  }
});
usePlayback.subscribe((s, p) => {
  if (s.playing && !p.playing) useSource.getState().pause();
});
useUi.subscribe((s, p) => {
  if (s.dialog === 'export' && p.dialog !== 'export') useSource.getState().pause();
  if (s.previewMode === p.previewMode || useSource.getState().split) return;
  if (s.previewMode === 'source') usePlayback.getState().pause();
  else useSource.getState().pause();
});
useEditor.subscribe((s, p) => {
  if (s.project === p.project) return;
  if (s.project?.id !== p.project?.id) {
    // close remembers where it was: clear after it, or the old project's media time would follow into the new one
    useSource.getState().close();
    lastTime.clear();
    useUi.getState().activateProgram();
    return;
  }
  const id = useSource.getState().assetId;
  if (id && !s.project?.assets.some((a) => a.id === id)) useSource.getState().close();
});
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) useSource.getState().pause();
  });
}
