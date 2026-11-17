/**
 * one animation loop for every meter on screen. a meter watches a tap key; the first watcher of a key holds its tap,
 * the last one lets it go. levels are read only while playing: paused, the bars fall on zero levels with no read, and
 * the loop stops once every bar is at the floor.
 */
import { clearOver, meterAtFloor, newMeter, stepMeter } from '../../../lib/meter';
import type { MeterState } from '../../../lib/meter';
import { holdTap, readTap } from '../../preview/meterTaps';
import type { TapLevels } from '../../preview/meterTaps';
import { usePlayback } from '../../../store/playback';

interface Entry {
  state: MeterState;
  draws: Set<(s: MeterState) => void>;
  release: () => void;
}

const entries = new Map<string, Entry>();
const ZERO: TapLevels = { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0 };
const scratch: TapLevels = { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0 };
const hasFrames = typeof requestAnimationFrame === 'function';

let raf = 0;
let last = 0;

function frame(now: number): void {
  raf = 0;
  const dt = last ? (now - last) / 1000 : 0;
  last = now;
  const playing = usePlayback.getState().playing;
  let busy = playing;
  for (const [key, e] of entries) {
    const levels = playing && readTap(key, scratch) ? scratch : ZERO;
    e.state = stepMeter(e.state, levels, dt);
    for (const draw of e.draws) draw(e.state);
    if (!meterAtFloor(e.state)) busy = true;
  }
  if (busy && entries.size > 0) raf = requestAnimationFrame(frame);
  else last = 0;
}

function start(): void {
  if (!hasFrames || raf || entries.size === 0) return;
  last = 0;
  raf = requestAnimationFrame(frame);
}

// playing again wakes a stopped loop
usePlayback.subscribe((s, prev) => {
  if (s.playing && !prev.playing) start();
});

/** draw is called now with the current state, then on every frame while the loop runs. returns the stop function */
export function watchMeter(key: string, draw: (s: MeterState) => void): () => void {
  let e = entries.get(key);
  if (!e) {
    e = { state: newMeter(), draws: new Set(), release: holdTap(key) };
    entries.set(key, e);
  }
  e.draws.add(draw);
  draw(e.state);
  start();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const cur = entries.get(key);
    if (!cur) return;
    cur.draws.delete(draw);
    if (cur.draws.size > 0) return;
    cur.release();
    entries.delete(key);
    if (entries.size === 0 && raf && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    }
  };
}

/** the over light of a meter was clicked */
export function clearMeterOver(key: string): void {
  const e = entries.get(key);
  if (!e || !e.state.over) return;
  e.state = clearOver(e.state);
  for (const draw of e.draws) draw(e.state);
}
