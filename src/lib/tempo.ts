/**
 * the tempo of a clip's sound: `bpm` (beats per minute of the source at normal speed, detected or typed) and
 * `beatOffset` (source seconds where a beat falls). together they give a beat grid that runs both ways from
 * that beat, so it also covers the time before the sound starts. pure: no dom, no store.
 *
 * the grid on the timeline follows the clip: its start, its trim and its speed (a clip at 2x has its beats
 * twice as close). keyframes are clip-local, so a grid is shifted into the clip it is used on (`shiftGrid`).
 */

export const BPM_MIN = 20;
export const BPM_MAX = 400;

/**
 * a stored or typed bpm: a number inside the range. anything else is "no tempo". kept to four decimals: two
 * are shown, the rest keeps a detected tempo from drifting off the beat over a long song.
 */
export function parseBpm(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw < BPM_MIN || raw > BPM_MAX) return null;
  return Math.round(raw * 10000) / 10000;
}

/** a bpm as it is shown: two decimals at most */
export function showBpm(bpm: number): string {
  return String(Math.round(bpm * 100) / 100);
}

/** a stored or typed beat offset in source seconds, to the millisecond. anything else is 0 */
export function parseBeatOffset(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.round(Math.max(-86400, Math.min(86400, raw)) * 1000) / 1000;
}

/** half or double time, null when that leaves the range (the detector often lands an octave off) */
export function scaleBpm(bpm: number, factor: number): number | null {
  return parseBpm(bpm * factor);
}

/**
 * a detected tempo, settled: music is nearly always made at a whole bpm, and a detector that listened to
 * `seconds` of sound at `perSecond` samples cannot tell a whole number from its close neighbours (the shorter
 * the sound, the less). so a result that is a whole number within what it can resolve becomes that number.
 * without this a 30 s clip at 120 reads 120.03 and the grid drifts off the hits over a long song.
 */
export function settleBpm(bpm: number, seconds: number, perSecond: number): number | null {
  const raw = parseBpm(bpm);
  if (raw === null) return null;
  const whole = Math.round(raw);
  const resolves = seconds > 0 && perSecond > 0 ? (1.5 * raw) / (perSecond * seconds) : 0;
  const tol = Math.min(0.15, Math.max(0.02, resolves));
  return Math.abs(raw - whole) <= tol ? (parseBpm(whole) ?? raw) : raw;
}

/** the part of a clip the grid needs */
export interface TempoClip {
  start: number;
  trimStart: number;
  speed: number;
  bpm?: number | null;
  beatOffset?: number | null;
}

/** beats at origin + k * step (seconds), for every whole k */
export interface BeatGrid {
  origin: number;
  step: number;
}

/** the beat grid of a clip in timeline seconds, null without a tempo */
export function clipGrid(clip: TempoClip): BeatGrid | null {
  const bpm = parseBpm(clip.bpm);
  if (bpm === null) return null;
  const speed = clip.speed > 0 && Number.isFinite(clip.speed) ? clip.speed : 1;
  const start = Number.isFinite(clip.start) ? clip.start : 0;
  const trim = Number.isFinite(clip.trimStart) ? clip.trimStart : 0;
  return { origin: start + (parseBeatOffset(clip.beatOffset) - trim) / speed, step: 60 / (bpm * speed) };
}

/** what is heard on the timeline: the tempo times the clip's speed */
export function timelineBpm(clip: TempoClip): number | null {
  const grid = clipGrid(clip);
  return grid ? Math.round((60 / grid.step) * 100) / 100 : null;
}

/** the same grid seen from a clip that starts at `clipStart` (timeline seconds -> clip-local seconds) */
export function shiftGrid(grid: BeatGrid, clipStart: number): BeatGrid {
  return { origin: grid.origin - clipStart, step: grid.step };
}

/** the grid line nearest to t. `perBeat` lines per beat (2 = half beats, 4 = quarter beats) */
export function nearestLine(grid: BeatGrid, t: number, perBeat = 1): number {
  const s = grid.step / Math.max(1, perBeat);
  return grid.origin + Math.round((t - grid.origin) / s) * s;
}

export interface GridLine {
  time: number;
  /** which beat it is: 0 = the beat at the offset, negative before it */
  index: number;
}

/** the whole beats from `from` to `to` (both included), at most `max` of them */
export function gridLines(grid: BeatGrid, from: number, to: number, max = 4000): GridLine[] {
  const out: GridLine[] = [];
  if (!(grid.step > 0) || !(to >= from)) return out;
  const eps = 1e-9;
  let k = Math.ceil((from - grid.origin) / grid.step - eps);
  for (; out.length < max; k++) {
    const time = grid.origin + k * grid.step;
    if (time > to + eps) break;
    out.push({ time, index: k });
  }
  return out;
}

/** longest pause between two taps that still counts as the same run (ms). 2.5 s = 24 bpm */
export const TAP_GAP_MS = 2500;
/** taps that are averaged */
export const TAP_KEEP = 8;

/**
 * tap tempo: the times of the taps (ms, ascending). the last run of taps without a long pause is used, the
 * tempo is its average spacing. null until there are three taps in a run or when the result is out of range.
 */
export function tapBpm(times: readonly number[]): number | null {
  let from = times.length - 1;
  while (from > 0 && times[from]! - times[from - 1]! <= TAP_GAP_MS && times[from]! > times[from - 1]!) from--;
  const run = times.slice(Math.max(from, times.length - TAP_KEEP));
  if (run.length < 3) return null;
  const span = run[run.length - 1]! - run[0]!;
  if (!(span > 0)) return null;
  const bpm = 60000 / (span / (run.length - 1));
  // a tapped tempo is never exact: whole numbers read better and are what songs are made at
  return parseBpm(Math.round(bpm));
}
