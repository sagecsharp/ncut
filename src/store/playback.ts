/**
 * the playback clock. this store is the MASTER time source: media elements in the preview follow it.
 *
 * `time` changes every animation frame while playing. do not select it in big components:
 *   const playing = usePlayback(s => s.playing)          // fine
 *   usePlayback.subscribe(s => moveThePlayhead(s.time))  // preferred for per-frame visuals
 */
import { create } from 'zustand';
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
  play(): void;
  pause(): void;
  toggle(): void;
  /** jump to a time. clamped to [0, project duration]. keeps the playing state. */
  seek(time: number): void;
  /** move by whole frames (negative = back). pauses. */
  stepFrames(frames: number): void;
  setLoop(loop: boolean): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
}

function duration(): number {
  const p = useEditor.getState().project;
  return p ? projectDuration(p) : 0;
}

let raf = 0;
let lastTick = 0;

function tick(now: number): void {
  const state = usePlayback.getState();
  if (!state.playing) return;
  const dt = Math.min(0.25, (now - lastTick) / 1000);
  lastTick = now;
  const end = duration();
  let t = state.time + dt;
  if (t >= end) {
    if (state.loop && end > 0) {
      t = 0;
    } else {
      usePlayback.setState({ time: end, playing: false });
      return;
    }
  }
  usePlayback.setState({ time: t });
  raf = requestAnimationFrame(tick);
}

export const usePlayback = create<PlaybackState>()((set, get) => ({
  time: 0,
  playing: false,
  loop: false,
  volume: 1,
  muted: false,

  play() {
    if (get().playing) return;
    const end = duration();
    if (end <= 0) return;
    // restart from the top when sitting at the end
    const time = get().time >= end - 1e-3 ? 0 : get().time;
    set({ playing: true, time });
    lastTick = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  },
  pause() {
    if (!get().playing) return;
    cancelAnimationFrame(raf);
    set({ playing: false });
  },
  toggle() {
    if (get().playing) get().pause();
    else get().play();
  },
  seek(time) {
    const t = clamp(Number.isFinite(time) ? time : 0, 0, duration());
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
  usePlayback.setState({ time: 0, playing: false });
}

// keep the playhead inside the project when clips are removed
useEditor.subscribe((state, prev) => {
  if (state.project === prev.project) return;
  const end = state.project ? projectDuration(state.project) : 0;
  if (usePlayback.getState().time > end) usePlayback.setState({ time: end });
});
