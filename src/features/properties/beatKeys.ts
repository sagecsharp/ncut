/**
 * keyframes on the beat. pure functions over a Keyframes record (clip-local seconds, see keyTools.ts) and a
 * beat grid that is already clip-local (lib/tempo.ts: shiftGrid). nothing here mutates its input.
 *
 * - snap: every key moves to the nearest grid line.
 * - fit: the whole animation is stretched to a number of beats, starting on a beat.
 * - loop: the animation starts on a beat, its first N beats repeat until the clip ends. nothing is stretched:
 *   a shorter animation rests for the remainder of each round, what lies after the first N beats is replaced by
 *   the repeats. so pressing loop again after editing the first round carries the edit into every round, and
 *   loop and ping pong can be pressed one after the other: each reads the first round back from the last result.
 *   without ping pong the value jumps back at the seam: the last key of a round holds ('hold' ease) until the
 *   next round starts.
 */
import { evalKeys } from '../../lib/anim';
import type { Keyframe, Keyframes } from '../../types';
import type { BeatGrid } from '../../lib/tempo';
import { nearestLine } from '../../lib/tempo';
import { MAX_KEYS_PER_PROP, MIN_GAP, fitKeys, keySpan, mirrorEase, normalizeKeys, shiftKeys } from './keyTools';

const TOL = 1e-9;
/** two values this close are the same value (no jump key is needed between them) */
const SAME = 1e-12;

/**
 * the same animation: the same values, the same keys, times equal to a billionth of a second. a loop that is
 * run on its own result gives these back (the times only differ in their last bits).
 */
export function sameKeys(a: Keyframes, b: Keyframes): boolean {
  const props = Object.keys(a).filter((p) => a[p]!.length > 0);
  if (props.length !== Object.keys(b).filter((p) => b[p]!.length > 0).length) return false;
  for (const prop of props) {
    const x = a[prop]!;
    const y = b[prop];
    if (!y || y.length !== x.length) return false;
    for (let i = 0; i < x.length; i++) {
      if (Math.abs(x[i]!.t - y[i]!.t) > TOL || x[i]!.v !== y[i]!.v || x[i]!.ease !== y[i]!.ease) return false;
    }
  }
  return true;
}

function countKeys(kf: Keyframes): number {
  let n = 0;
  for (const prop of Object.keys(kf)) n += kf[prop]!.length;
  return n;
}

export interface SnapResult {
  keys: Keyframes;
  /** keys that sit on another time now */
  moved: number;
  /** keys that stayed: already on a line, outside the clip, or the line was taken by a nearer key */
  stayed: number;
}

/**
 * move every key to the nearest grid line (`perBeat` lines per beat) that lies inside the clip. when several
 * keys of one value want the same line the nearest one gets it and the others stay where they are (and it
 * stays too when the line is less than 1 ms from a key that stays), so no key is lost and their order never
 * changes.
 */
export function snapKeysToGrid(kf: Keyframes, grid: BeatGrid, perBeat: number, duration: number): SnapResult {
  const out: Keyframes = {};
  let moved = 0;
  let stayed = 0;
  const step = grid.step / Math.max(1, perBeat);
  const usable = step >= MIN_GAP * 2 && Number.isFinite(grid.origin);
  for (const prop of Object.keys(kf)) {
    const keys = normalizeKeys(kf[prop]!);
    if (keys.length === 0) continue;
    // the line each key wants (as a line number), null = it stays
    const want: (number | null)[] = keys.map((k) => {
      if (!usable || k.t < -TOL || k.t > duration + TOL) return null;
      const n = Math.round((k.t - grid.origin) / step);
      const line = grid.origin + n * step;
      return line < -TOL || line > duration + TOL ? null : n;
    });
    const next = keys.map((k) => ({ ...k }));
    let i = 0;
    while (i < keys.length) {
      const n = want[i];
      if (n === null || n === undefined) {
        stayed++;
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < keys.length && want[j + 1] === n) j++;
      const line = Math.min(duration, Math.max(0, grid.origin + n * step));
      let best = i;
      for (let q = i + 1; q <= j; q++) if (Math.abs(keys[q]!.t - line) < Math.abs(keys[best]!.t - line)) best = q;
      for (let q = i; q <= j; q++) {
        if (q === best && Math.abs(keys[q]!.t - line) > TOL) {
          next[q]!.t = line;
          moved++;
        } else stayed++;
      }
      i = j + 1;
    }
    // a key that would land closer than MIN_GAP to a neighbour stays where it is: the two would merge into one
    for (let q = 0; q < next.length; q++) {
      if (next[q]!.t === keys[q]!.t) continue;
      const lo = q > 0 ? next[q - 1]!.t : -Infinity;
      const hi = q + 1 < next.length ? next[q + 1]!.t : Infinity;
      if (next[q]!.t - lo < MIN_GAP - TOL || hi - next[q]!.t < MIN_GAP - TOL) {
        next[q]!.t = keys[q]!.t;
        moved--;
        stayed++;
      }
    }
    out[prop] = normalizeKeys(next);
  }
  return { keys: out, moved, stayed };
}

/**
 * the beat an animation that begins at `lo` starts on: the nearest one inside the clip. null when no beat
 * falls inside the clip (a clip shorter than a beat, between two of them).
 */
export function startBeat(grid: BeatGrid, lo: number, duration: number): number | null {
  if (!(grid.step >= MIN_GAP * 2) || !Number.isFinite(grid.origin) || !(duration > 0)) return null;
  let s = nearestLine(grid, lo);
  while (s < -TOL) s += grid.step;
  while (s > duration - MIN_GAP) s -= grid.step;
  if (s < -TOL) return null;
  return Math.max(0, s);
}

export type BeatKeysError = 'no keys' | 'one moment' | 'no beat' | 'too many';

export interface FitResult {
  keys: Keyframes;
  from: number;
  to: number;
}

/**
 * stretch (or squeeze) the whole animation so it starts on the beat nearest to its first key and lasts
 * exactly `beats` beats. the end may lie after the clip's end.
 */
export function fitKeysToBeats(kf: Keyframes, grid: BeatGrid, beats: number, duration: number): FitResult | BeatKeysError {
  const span = keySpan(kf);
  if (!span) return 'no keys';
  if (span.hi - span.lo < MIN_GAP - TOL) return 'one moment';
  const len = beats * grid.step;
  const from = startBeat(grid, span.lo, duration);
  if (from === null || !(len >= MIN_GAP * 2)) return 'no beat';
  return { keys: fitKeys(kf, from, from + len), from, to: from + len };
}

export interface LoopResult {
  keys: Keyframes;
  /** where the first round starts (clip-local seconds, on a beat) */
  from: number;
  /** length of one round in seconds */
  period: number;
  /** rounds that start before the clip ends, the last one may run past it */
  rounds: number;
}

interface Step {
  /** seconds from the start of the round, 0 .. period */
  o: number;
  v: number;
  ease: Keyframe['ease'];
}

/**
 * the end of a round falls inside a curve: the keys that end the round there, on the curve. a straight line
 * only needs the end key, any other ease is followed with a few straight pieces (the ease itself would
 * be squeezed into the shorter span and bend the curve).
 */
function cutCurve(first: Step[], keys: readonly Keyframe[], from: number, period: number): void {
  const open = first[first.length - 1]!;
  const span = period - open.o;
  if (open.ease !== 'linear') {
    const want = open.ease === 'bounce' || open.ease === 'elastic' ? 24 : 8;
    const n = Math.max(1, Math.min(want, Math.floor(span / (4 * MIN_GAP))));
    open.ease = 'linear';
    for (let i = 1; i < n; i++) {
      const o = open.o + (span * i) / n;
      first.push({ o, v: evalKeys(keys, from + o), ease: 'linear' });
    }
  }
  first.push({ o: period, v: evalKeys(keys, from + period), ease: 'linear' });
}

/** how many rounds of `period` start before the clip ends (the last one may run past it) */
export function loopRounds(from: number, period: number, duration: number): number {
  return Math.max(1, Math.ceil((duration - from) / period - 1e-6));
}

/**
 * loop the animation on the beat: it is moved (not stretched) so its first key sits on the nearest beat, then
 * what it does in the first `beats` beats repeats until the clip ends. `pingPong` plays every second round
 * backwards, without it the value jumps back at the seam. a value with a single key just keeps it. running it
 * on its own result gives the same keys again (sameKeys).
 */
export function loopKeysOnBeats(kf: Keyframes, grid: BeatGrid, beats: number, duration: number, pingPong: boolean): LoopResult | BeatKeysError {
  const span = keySpan(kf);
  if (!span) return 'no keys';
  if (span.hi - span.lo < MIN_GAP - TOL) return 'one moment';
  const period = beats * grid.step;
  const from = startBeat(grid, span.lo, duration);
  if (from === null || !(period >= MIN_GAP * 4)) return 'no beat';
  const rounds = loopRounds(from, period, duration);
  // on the beat: the whole animation moves, its own timing stays
  const moved = shiftKeys(kf, from - span.lo, -Infinity, Infinity);
  const out: Keyframes = {};
  for (const prop of Object.keys(moved)) {
    const keys = moved[prop]!;
    if (keys.length === 0) continue;
    // the first round of this value: its keys inside from .. from + period
    const first: Step[] = [];
    for (const k of keys) if (k.t <= from + period + TOL) first.push({ o: Math.min(period, Math.max(0, k.t - from)), v: k.v, ease: k.ease });
    if (first.length === 0) {
      // it only moves later than the first round: it holds what it shows there
      out[prop] = [{ t: from, v: keys[0]!.v, ease: keys[0]!.ease }];
      continue;
    }
    // pressed again on a loop: a key on the end of the round can be the first key of the next round, not a part
    // of this one. it is when it comes right after a jump, or when it only repeats the value the round rests on
    // and starts with (then dropping it changes nothing)
    let seam = false;
    if (first.length >= 2) {
      const end = first[first.length - 1]!;
      const prev = first[first.length - 2]!;
      if (end.o >= period - TOL) {
        const afterJump = prev.ease === 'hold' || prev.o >= period - MIN_GAP - TOL;
        const rest = !pingPong && first[0]!.o <= TOL && Math.abs(prev.v - end.v) <= SAME && Math.abs(end.v - first[0]!.v) <= SAME;
        if (afterJump || rest) {
          first.pop();
          seam = true;
        }
      }
    }
    // a curve that runs past the end of the round is cut there, at the value it has there. a value that only
    // rests there (the next key has the same value, or this one holds its value) needs no key for that
    const next = keys[first.length];
    const open = first[first.length - 1]!;
    if (!seam && next && open.ease !== 'hold' && open.o < period - MIN_GAP - TOL && Math.abs(next.v - open.v) > SAME) cutCurve(first, keys, from, period);
    if (first.length < 2) {
      out[prop] = [{ t: from + first[0]!.o, v: first[0]!.v, ease: first[0]!.ease }];
      continue;
    }
    const tail = first[first.length - 1]!;
    const jump = !pingPong && Math.abs(tail.v - first[0]!.v) > SAME;
    if (jump) {
      // the value jumps back when the next round starts: until then the last key holds. a key on the very end
      // of the round steps 1 ms back, so it is not the same moment as the first key of the next round
      tail.ease = 'hold';
      if (tail.o > period - MIN_GAP) tail.o = Math.max(period - MIN_GAP, first[first.length - 2]!.o + MIN_GAP);
    }
    if (first.length * rounds > MAX_KEYS_PER_PROP) return 'too many';
    const seqs: Step[][] = [];
    for (let r = 0; r < rounds; r++) {
      const flip = pingPong && r % 2 === 1;
      const seq: Step[] = [];
      for (let j = 0; j < first.length; j++) {
        const i = flip ? first.length - 1 - j : j;
        const s = first[i]!;
        if (!flip) {
          seq.push({ ...s });
          continue;
        }
        const prev = i > 0 ? first[i - 1]! : null;
        const o = period - s.o;
        if (prev && prev.ease === 'hold' && Math.abs(prev.v - s.v) > SAME && s.o - prev.o > 2 * MIN_GAP + TOL) {
          // a step played backwards: this key's value for a moment, then the value that was held BEFORE the step
          seq.push({ o, v: s.v, ease: 'hold' }, { o: o + MIN_GAP, v: prev.v, ease: 'linear' });
        } else {
          // the reversed key starts the segment that used to end at it: the one the key before it described
          seq.push({ o, v: s.v, ease: mirrorEase(prev ? prev.ease : s.ease) });
        }
      }
      // a round that does not begin with a key shows its first value from the start of the round. that only
      // takes a key where the value jumps: everywhere else the round before ends on that same value
      if (r > 0 && jump && seq[0]!.o > TOL) seq.unshift({ o: 0, v: seq[0]!.v, ease: 'linear' });
      // the key on the very end of the round before is the same moment as this round's first key. this one
      // says how it goes on, so the other one goes (left to the sort, float noise would pick the winner)
      const before = seqs[r - 1];
      if (before && before.length > 1 && seq[0]!.o <= TOL && before[before.length - 1]!.o >= period - TOL) before.pop();
      seqs.push(seq);
    }
    const all: Keyframe[] = [];
    seqs.forEach((seq, r) => {
      for (const s of seq) all.push({ t: from + r * period + s.o, v: s.v, ease: s.ease });
    });
    // the last round is kept whole, also where it runs past the end of the clip (keys may lie outside a clip,
    // a split leaves them there too): cutting it would bend the curve, and a longer clip shows the rest of it
    const looped = normalizeKeys(all);
    if (looped.length > MAX_KEYS_PER_PROP) return 'too many';
    // nothing follows the last key, so its ease says nothing: always the same one, so a second run gives the same keys
    looped[looped.length - 1]!.ease = 'linear';
    out[prop] = looped;
  }
  if (countKeys(out) === 0) return 'no keys';
  return { keys: out, from, period, rounds };
}
