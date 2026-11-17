/**
 * the loop of the loudness strip, the pattern of meterLoop.ts: one meter, one animation frame loop while playing.
 * the first watcher holds the tap, the last one lets it go. paused, there is one draw and no next frame.
 * the integrated loudness and the range are worked out at most every 500 ms: they walk every block so far.
 */
import { LoudnessMeter } from '../../../lib/loudness';
import { useEditor } from '../../../store/editorStore';
import { usePlayback } from '../../../store/playback';
import { holdLoudness, loudnessTapRate, pauseLoudnessRead, readLoudness } from './loudnessTap';
import { NO_VIEW, sameView } from './loudnessView';
import type { LoudView } from './loudnessView';

const SLOW_MS = 500;
const hasFrames = typeof requestAnimationFrame === 'function';

const draws = new Set<(v: LoudView) => void>();
let release: (() => void) | null = null;
let meter: LoudnessMeter | null = null;
let view: LoudView = { ...NO_VIEW };
let raf = 0;
let slowAt = -1e9;
let slowI = -Infinity;
let slowLra = 0;

function emit(next: LoudView): void {
  if (sameView(next, view)) return;
  view = next;
  for (const d of [...draws]) d(view);
}

function frame(now: number): void {
  raf = 0;
  if (draws.size === 0) return;
  const playing = usePlayback.getState().playing;
  if (!playing) {
    // one last draw with the values kept, the next play starts from a fresh time
    pauseLoudnessRead();
    emit({ ...view, playing: false });
    return;
  }
  const rate = loudnessTapRate();
  if (rate !== null && (!meter || meter.rate !== rate)) {
    meter = new LoudnessMeter(rate);
    slowAt = -1e9;
    slowI = -Infinity;
    slowLra = 0;
    view = { ...NO_VIEW, playing: true };
    for (const d of [...draws]) d(view);
  }
  if (meter && rate !== null) {
    readLoudness(meter);
    if (now - slowAt >= SLOW_MS) {
      slowAt = now;
      slowI = meter.integrated();
      slowLra = meter.range();
    }
    emit({ momentary: meter.momentary(), shortTerm: meter.shortTerm(), integrated: slowI, lra: slowLra, truePeak: meter.truePeak(), playing: true });
  } else emit({ ...view, playing: true });
  if (draws.size > 0 && hasFrames) raf = requestAnimationFrame(frame);
}

function start(): void {
  if (!hasFrames || raf || draws.size === 0) return;
  raf = requestAnimationFrame(frame);
}

// playing wakes the loop
usePlayback.subscribe((s, prev) => {
  if (s.playing && !prev.playing) start();
});

/** draw is called now with the current numbers, then on every change. returns the stop function */
export function watchLoudness(draw: (v: LoudView) => void): () => void {
  if (draws.size === 0) release = holdLoudness();
  draws.add(draw);
  const playing = usePlayback.getState().playing;
  if (view.playing !== playing && !playing) view = { ...view, playing: false };
  draw(view);
  if (playing) start();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    draws.delete(draw);
    if (draws.size > 0) return;
    release?.();
    release = null;
    if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    raf = 0;
    pauseLoudnessRead();
  };
}

/** the reset button: the integrated, range and true peak start again */
export function resetLoudness(): void {
  meter?.reset();
  slowAt = -1e9;
  slowI = -Infinity;
  slowLra = 0;
  view = { ...NO_VIEW, playing: view.playing };
  for (const d of [...draws]) d(view);
}

// another project starts the numbers again. play and seek never do
useEditor.subscribe((s, prev) => {
  if (s.project?.id !== prev.project?.id) resetLoudness();
});
