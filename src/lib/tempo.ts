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

/* ---------- effects that follow the tempo ---------- */

/** the tempo link of an effect clip (EffectClip.beat), see parseEffectBeat */
export interface EffectBeat {
  source: string | null;
  every: number;
  pulse: number;
  lock: boolean;
}

/** shortest and longest cycle of an effect, in beats */
export const BEAT_EVERY_MIN = 1 / 16;
export const BEAT_EVERY_MAX = 64;

/**
 * a stored or typed tempo link of an effect clip, cleaned: `every` clamped into range, `pulse` into 0..1, `lock`
 * a boolean, `source` a clip id or null. anything that is not an object with a number for `every` is "no link".
 */
export function parseEffectBeat(raw: unknown): EffectBeat | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.every !== 'number' || !Number.isFinite(r.every)) return null;
  const pulse = typeof r.pulse === 'number' && Number.isFinite(r.pulse) ? Math.min(1, Math.max(0, r.pulse)) : 0;
  return {
    source: typeof r.source === 'string' && r.source !== '' ? r.source : null,
    every: Math.min(BEAT_EVERY_MAX, Math.max(BEAT_EVERY_MIN, r.every)),
    pulse,
    lock: r.lock === true,
  };
}

/** two cleaned links say the same thing (a missing one and null are the same) */
export function sameEffectBeat(a: EffectBeat | null | undefined, b: EffectBeat | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.source === b.source && a.every === b.every && a.pulse === b.pulse && a.lock === b.lock;
}

/** how close to a whole cycle (as a share of the cycle) counts as being on the line. far below a frame, far above float noise */
const LINE_SNAP = 1e-6;
/**
 * a frame that is on a cycle line gets its time pushed this far (share of a cycle) past it. the shader sees the time
 * as a float32 and reads `u_time * rate` (rate = 1 / cycle): k cycles can come out as k - 1e-7 and fract() / floor()
 * would then show the end of the last cycle on the very frame the hit belongs to.
 */
export const LINE_NUDGE = 1e-4;

/** the cycle of a grid: `every` beats, in seconds */
export function cycleLength(grid: BeatGrid, every: number): number {
  return grid.step * every;
}

/** t as a number of cycles from the grid origin, a hair off a whole number snapped onto it */
function cyclesAt(grid: BeatGrid, cycle: number, t: number): number {
  const c = (t - grid.origin) / cycle;
  const r = Math.round(c);
  return Math.abs(c - r) < LINE_SNAP ? r : c;
}

/** where a time is in the cycles of a grid */
export interface CyclePhase {
  /** which cycle line that is: 0 = the grid origin, negative before it */
  index: number;
  /** the cycle line at or before the time: grid.origin + n * cycle (n may be negative) */
  line: number;
  /** position inside the cycle, 0 on the line up to just under 1 */
  phase: number;
  /** the time as cycles from the grid origin (snapped onto a whole number when it is on a line) */
  cycles: number;
}

/** the cycle line at or before t and the position of t between that line and the next. a time on a line is phase 0 */
export function cyclePhase(grid: BeatGrid, every: number, t: number): CyclePhase {
  const cycle = cycleLength(grid, every);
  const cycles = cyclesAt(grid, cycle, t);
  const n = Math.floor(cycles);
  return { index: n, line: grid.origin + n * cycle, phase: cycles - n, cycles };
}

/**
 * how strong an effect with a pulse is at a position in its cycle: 1 on the line, falling to 1 - pulse at the end. the fall is
 * quick and smooth, like a hit that rings out: 1 - pulse * (1 - (1 - ph)^2.5) (a quarter of the way in it is already 55 % down).
 */
export function pulseEnvelope(pulse: number, phase: number): number {
  const ph = Math.min(1, Math.max(0, phase));
  return 1 - pulse * (1 - Math.pow(1 - ph, 2.5));
}

/** what is needed to tell whether a clip carries sound. a video clip with an audio track counts */
export interface SoundProject {
  clips: readonly TempoPoolClip[];
  assets: readonly { id: string; hasAudio?: boolean }[];
}
/** the part of any clip the ranking reads. fields a clip type does not have are simply missing */
interface TempoPoolClip {
  id: string;
  type: string;
  start: number;
  duration: number;
  name?: string;
  assetId?: string;
  trimStart?: number;
  speed?: number;
  bpm?: number | null;
  beatOffset?: number | null;
}

/** a clip with sound and a tempo, as a candidate to follow */
export interface TempoSourceClip {
  clip: TempoPoolClip;
  grid: BeatGrid;
  /** seconds it plays together with the span it is ranked for */
  overlap: number;
  /** what is heard on the timeline: the tempo times the clip's speed (timelineBpm) */
  heard: number;
}

/**
 * every clip with sound and a bpm, ranked for a span of the timeline: the clip `selfId` first (if given and in the list), then
 * the longest overlap with the span first, then by start. pure. this is the order "the sound under it" is picked in.
 */
export function rankTempoClips(project: SoundProject, span: { start: number; duration: number }, selfId?: string): TempoSourceClip[] {
  const end = span.start + span.duration;
  const found: Array<TempoSourceClip & { rank: number }> = [];
  for (const c of project.clips) {
    if (c.type !== 'audio' && c.type !== 'video') continue;
    const timed: TempoClip = { start: c.start, trimStart: c.trimStart ?? 0, speed: c.speed ?? 1, bpm: c.bpm, beatOffset: c.beatOffset };
    const grid = clipGrid(timed);
    if (!grid) continue;
    if (c.type === 'video' && !project.assets.find((a) => a.id === c.assetId)?.hasAudio) continue;
    const overlap = Math.max(0, Math.min(end, c.start + c.duration) - Math.max(span.start, c.start));
    found.push({ clip: c, grid, overlap, heard: timelineBpm(timed) ?? 0, rank: selfId !== undefined && c.id === selfId ? Infinity : overlap });
  }
  found.sort((a, b) => b.rank - a.rank || a.clip.start - b.clip.start);
  return found.map(({ clip, grid, overlap, heard }) => ({ clip, grid, overlap, heard }));
}

/**
 * the grid an effect clip follows: the clip named by `beat.source` while it still has a tempo, else the sound under the effect
 * (the most overlap). null when the effect has no link or no clip has a tempo: it then runs as if the link was off.
 */
export function effectBeatGrid(
  project: SoundProject,
  effect: { start: number; duration: number; beat?: { source?: string | null } | null },
): BeatGrid | null {
  if (!effect.beat) return null;
  const ranked = rankTempoClips(project, effect);
  const wanted = effect.beat.source;
  const named = wanted ? ranked.find((r) => r.clip.id === wanted) : undefined;
  return (named ?? ranked[0])?.grid ?? null;
}
