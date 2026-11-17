/**
 * the playback clock. this store is the MASTER time source: media elements in the preview follow it.
 *
 * `time` changes every animation frame while playing. do not select it in big components:
 *   const playing = usePlayback(s => s.playing)          // fine
 *   usePlayback.subscribe(s => moveThePlayhead(s.time))  // preferred for per-frame visuals
 */
import { create } from 'zustand';
import type { Span } from '../lib/inOut';
import { inOutSpan, lastFrameStart } from '../lib/inOut';
import { projectDuration } from '../lib/timelineOps';
import { clamp, snapToFrame } from '../lib/time';
import { useEditor } from './editorStore';

export interface PlaybackState {
  /** current timeline time in seconds */
  time: number;
  playing: boolean;
  loop: boolean;
  /** master preview volume 0..1 */
  volume: number;
  muted: boolean;
  /** the preview speed the user picked, 0.25..4. plain play runs at this. */
  speed: number;
  /**
   * what the clock runs at right now: seconds of timeline per second. 1 = normal, 2 = double,
   * negative = backwards, never 0. equals `speed` unless the shuttle keys changed it; pause puts it back.
   */
  rate: number;
  /** play forward at `speed` (also ends a shuttle) */
  play(): void;
  pause(): void;
  toggle(): void;
  /** jump to a time. clamped to [0, project duration]. keeps the playing state. */
  seek(time: number): void;
  /** move by whole frames (negative = back). pauses. */
  stepFrames(frames: number): void;
  setLoop(loop: boolean): void;
  /** pick the preview speed (clamped to 0.25..4). applies at once when playing forward without a shuttle. */
  setSpeed(speed: number): void;
  /**
   * the j / l keys. dir 1 = forward, -1 = backwards. paused, or playing the other way: plays that
   * way at 1x. already going that way: twice as fast (1, 2, 4, 8, then it stays at 8).
   */
  shuttle(dir: 1 | -1): void;
  /** shift+space: play from the in point and stop on the out point (with loop on: again and again). a second press pauses. false when there is no range */
  playInToOut(): boolean;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
}

function duration(): number {
  const p = useEditor.getState().project;
  return p ? projectDuration(p) : 0;
}

/** the shuttle ladder: 1x, 2x, 4x, 8x, then it stays */
export const SHUTTLE_STEPS: readonly number[] = [1, 2, 4, 8];

/**
 * the rate after a j / l press. paused or going the other way: 1x that way. going that way already: the next
 * rung of the ladder above the current speed (so 1.5x goes to 2x, 0.5x goes to 1x), 8x stays 8x.
 */
export function nextShuttleRate(rate: number, playing: boolean, dir: 1 | -1): number {
  if (!playing || Math.sign(rate) !== dir) return dir;
  const mag = Math.abs(rate);
  for (const step of SHUTTLE_STEPS) if (step > mag + 1e-9) return dir * step;
  return dir * SHUTTLE_STEPS[SHUTTLE_STEPS.length - 1]!;
}

/**
 * move the clock by dt real seconds at `rate`. at either end it wraps (loop) or stops there. `start` is the lower
 * bound (the in point of an in to out play), 0 = the whole project.
 * pure: the tick uses it and the tests drive it directly.
 */
export function advanceClock(time: number, dt: number, rate: number, end: number, loop: boolean, start = 0): { time: number; ended: boolean } {
  const t = time + dt * rate;
  const len = end - start;
  if (rate > 0 && t >= end) {
    if (loop && len > 0) return { time: start + ((t - start) % len), ended: false };
    return { time: end, ended: true };
  }
  if (rate < 0 && t <= start) {
    if (loop && len > 0) return { time: end + ((t - start) % len), ended: false };
    return { time: start, ended: true };
  }
  return { time: t, ended: false };
}

export interface ClockBounds {
  start: number;
  end: number;
  ranged: boolean;
  fps: number;
}

/** in to out when shift+space plays it or loop is on with a range, else the whole project */
export function clockBounds(duration: number, loop: boolean, span: Span | null, toOut: boolean, fps: number): ClockBounds {
  if (span && (toOut || loop)) return { start: span.start, end: span.end, ranged: true, fps };
  return { start: 0, end: duration, ranged: false, fps };
}

/** smallest / largest playbackRate browsers accept without erroring or muting the element */
export const MEDIA_RATE_MIN = 0.0625;
export const MEDIA_RATE_MAX = 16;

/**
 * the playbackRate an element gets for a clip of `clipSpeed` under the clock rate `rate`, or 0 when the
 * element cannot follow by playing (backwards, or outside what browsers accept): then it is paused and seeked.
 */
export function mediaPlaybackRate(clipSpeed: number, rate: number): number {
  if (rate <= 0) return 0;
  const r = clipSpeed * rate;
  return r >= MEDIA_RATE_MIN && r <= MEDIA_RATE_MAX ? r : 0;
}

/** audio is heard up to 4x forward, silent above that (and always silent backwards) */
export function rateAudible(rate: number): boolean {
  return rate > 0 && rate <= 4;
}

let raf = 0;
let lastTick = 0;
/** true while a j / l shuttle owns the rate (so setSpeed leaves it alone) */
let shuttling = false;
/** true while shift+space plays in to out: the clock stops on the out point (or loops inside it) */
let toOut = false;

function bounds(): ClockBounds {
  const p = useEditor.getState().project;
  const d = p ? projectDuration(p) : 0;
  return clockBounds(d, usePlayback.getState().loop, p ? inOutSpan(p.range, d) : null, toOut, p?.fps ?? 30);
}

function tick(now: number): void {
  const state = usePlayback.getState();
  if (!state.playing) return;
  const dt = Math.min(0.25, Math.max(0, (now - lastTick) / 1000));
  lastTick = now;
  const b = bounds();
  let from = state.time;
  if (b.ranged && state.loop) {
    if (state.rate > 0 && from > b.end) from = b.start;
    else if (state.rate < 0 && from < b.start) from = b.end;
  }
  const next = advanceClock(from, dt, state.rate, b.end, state.loop, b.start);
  if (next.ended) {
    shuttling = false;
    // an in to out play stops on the last frame inside (o includes the frame under the playhead)
    const time = toOut && b.ranged && state.rate > 0 ? lastFrameStart(b.start, b.end, b.fps) : next.time;
    toOut = false;
    usePlayback.setState({ time, playing: false, rate: state.speed });
    return;
  }
  usePlayback.setState({ time: next.time });
  raf = requestAnimationFrame(tick);
}

export const usePlayback = create<PlaybackState>()((set, get) => ({
  time: 0,
  playing: false,
  loop: false,
  volume: 1,
  muted: false,
  speed: 1,
  rate: 1,

  play() {
    toOut = false;
    if (get().playing) {
      // space while shuttling: back to plain forward play
      shuttling = false;
      if (get().rate !== get().speed) set({ rate: get().speed });
      return;
    }
    const end = duration();
    if (end <= 0) return;
    // restart from the top (or the in point of a looped range) when sitting at the end
    const b = bounds();
    let time = get().time >= end - 1e-3 ? 0 : get().time;
    if (b.ranged && (get().time < b.start || get().time >= b.end - 1e-3)) time = b.start;
    shuttling = false;
    set({ playing: true, time, rate: get().speed });
    lastTick = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  },
  pause() {
    toOut = false;
    if (!get().playing) return;
    cancelAnimationFrame(raf);
    shuttling = false;
    set({ playing: false, rate: get().speed });
  },
  toggle() {
    if (get().playing) get().pause();
    else get().play();
  },
  seek(time) {
    const t = clamp(Number.isFinite(time) ? time : 0, 0, duration());
    if (toOut) {
      const b = bounds();
      if (t < b.start - 1e-6 || t > b.end + 1e-6) toOut = false;
    }
    set({ time: t });
  },
  stepFrames(frames) {
    const fps = useEditor.getState().project?.fps ?? 30;
    get().pause();
    get().seek(snapToFrame(get().time, fps) + frames / fps);
  },
  setLoop(loop) {
    set({ loop });
  },
  setSpeed(speed) {
    const next = clamp(Number.isFinite(speed) && speed > 0 ? speed : 1, 0.25, 4);
    // a shuttle in progress keeps its own rate
    set(shuttling ? { speed: next } : { speed: next, rate: next });
  },
  shuttle(dir) {
    const s = get();
    toOut = false;
    const end = duration();
    if (end <= 0) return;
    const b = bounds();
    let time = s.time;
    // nothing to play in that direction from the very end: start from the other end
    if (b.ranged) {
      if (dir === 1 && (time >= b.end - 1e-3 || time < b.start)) time = b.start;
      if (dir === -1 && (time <= b.start + 1e-3 || time > b.end)) time = b.end;
    } else {
      if (dir === 1 && time >= end - 1e-3) time = 0;
      if (dir === -1 && time <= 1e-3) time = end;
    }
    shuttling = true;
    set({ playing: true, rate: nextShuttleRate(s.rate, s.playing, dir), time });
    if (!s.playing) {
      lastTick = performance.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    }
  },
  playInToOut() {
    const p = useEditor.getState().project;
    const span = p ? inOutSpan(p.range, projectDuration(p)) : null;
    if (!span) return false;
    if (get().playing && toOut) {
      get().pause();
      return true;
    }
    toOut = true;
    shuttling = false;
    set({ playing: true, time: span.start, rate: get().speed });
    lastTick = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
    return true;
  },
  setVolume(volume) {
    set({ volume: clamp(volume, 0, 1) });
  },
  setMuted(muted) {
    set({ muted });
  },
}));

// the raf clock does not run in a background tab but the media elements would keep playing: stop instead
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) usePlayback.getState().pause();
  });
}

/** stop + rewind. called when a project is opened or closed. */
export function resetPlayback(): void {
  cancelAnimationFrame(raf);
  shuttling = false;
  toOut = false;
  usePlayback.setState({ time: 0, playing: false, rate: usePlayback.getState().speed });
}

// keep the playhead inside the project when clips are removed
useEditor.subscribe((state, prev) => {
  if (state.project === prev.project) return;
  const end = state.project ? projectDuration(state.project) : 0;
  if (usePlayback.getState().time > end) usePlayback.setState({ time: end });
});
