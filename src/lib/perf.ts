/**
 * tiny frame-time monitor for the editor. measures how often the main thread manages to produce
 * a frame (requestAnimationFrame cadence) and how long the worst frame took.
 * the loop only runs while something is subscribed, so it costs nothing when the counter is hidden.
 */

export interface PerfSample {
  /** frames per second averaged over the last window */
  fps: number;
  /** average frame time in ms over the window */
  frameMs: number;
  /** longest single frame in the window, ms. spikes here = jank. */
  worstMs: number;
}

type Listener = (sample: PerfSample) => void;

const WINDOW_MS = 500;
const listeners = new Set<Listener>();
let raf = 0;
let last = 0;
let windowStart = 0;
let frames = 0;
let worst = 0;

function loop(now: number): void {
  if (last > 0) {
    const dt = now - last;
    frames++;
    if (dt > worst) worst = dt;
    const span = now - windowStart;
    if (span >= WINDOW_MS) {
      const sample: PerfSample = { fps: (frames * 1000) / span, frameMs: span / frames, worstMs: worst };
      for (const l of listeners) l(sample);
      windowStart = now;
      frames = 0;
      worst = 0;
    }
  } else {
    windowStart = now;
  }
  last = now;
  raf = requestAnimationFrame(loop);
}

/** start receiving samples (about twice a second). returns an unsubscribe function. */
export function subscribePerf(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    last = 0;
    frames = 0;
    worst = 0;
    raf = requestAnimationFrame(loop);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) cancelAnimationFrame(raf);
  };
}
