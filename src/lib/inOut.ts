/**
 * the timeline in / out range: i and o marks. in is the first moment inside, out the first moment after: [in, out).
 * pure. every reader goes through here, so a broken or crossed range never reaches an edit.
 */
import type { Clip, InOutRange, Project } from '../types';
import { clipEnd, projectDuration } from './timelineOps';
import { syncTrackIds } from './trackTools';

/** the shape of export's TimeRange */
export interface Span {
  start: number;
  end: number;
}
export type RangeBlock = 'both' | 'nothing' | 'locked' | 'sync-off';
export type AnyRange = InOutRange | null | undefined;

const EPS = 1e-6;

const isMark = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** the range as it may be stored: bad marks dropped, a crossed out dropped. null when nothing is left. always a new object */
export function cleanRange(r: AnyRange): InOutRange | null {
  if (!r || typeof r !== 'object') return null;
  const i = isMark(r.in) ? r.in : undefined;
  let o = isMark(r.out) ? r.out : undefined;
  if (o !== undefined && o <= EPS) o = undefined;
  if (o !== undefined && i !== undefined && o <= i + EPS) o = undefined;
  if (i === undefined && o === undefined) return null;
  const out: InOutRange = {};
  if (i !== undefined) out.in = i;
  if (o !== undefined) out.out = o;
  return out;
}

export function sameRange(a: InOutRange | null, b: InOutRange | null): boolean {
  if (!a || !b) return !a && !b;
  return a.in === b.in && a.out === b.out;
}

/** the start of the frame on screen at t. forgives float noise just below a frame line */
export function frameAt(t: number, fps: number): number {
  return Math.floor(t * fps + 1e-6) / fps;
}

/** the out point that makes the frame on screen at t the last one inside */
export function markOutTime(t: number, fps: number, duration: number): number {
  return Math.min(duration, frameAt(t, fps) + 1 / fps);
}

/** the start of the last frame that begins before end (never before start) */
export function lastFrameStart(start: number, end: number, fps: number): number {
  return Math.max(start, (Math.ceil(end * fps - 1e-6) - 1) / fps);
}

/** the start of the last frame inside the range. null without an out point */
export function lastFrameIn(r: AnyRange, fps: number): number | null {
  const c = cleanRange(r);
  if (!c || c.out === undefined) return null;
  return lastFrameStart(c.in ?? 0, c.out, fps);
}

/** what play, loop and export use: the range cut to the project. null when there is no range or nothing is left inside */
export function inOutSpan(r: AnyRange, duration: number): Span | null {
  const c = cleanRange(r);
  if (!c || duration <= 0) return null;
  const start = Math.min(c.in ?? 0, duration);
  const end = Math.min(c.out ?? duration, duration);
  if (end - start <= EPS) return null;
  return { start, end };
}

/** what lift and extract use: both marks, not cut to the project. null when one is missing */
export function editSpan(r: AnyRange): Span | null {
  const c = cleanRange(r);
  if (!c || c.in === undefined || c.out === undefined) return null;
  return { start: c.in, end: c.out };
}

/** a new in point. the out point goes when it is not after it (dropped: true) */
export function withIn(r: AnyRange, t: number): { range: InOutRange; dropped: boolean } {
  const c = cleanRange(r);
  const range: InOutRange = { in: t };
  if (c && c.out !== undefined) {
    if (c.out <= t + EPS) return { range, dropped: true };
    range.out = c.out;
  }
  return { range, dropped: false };
}

/** a new out point. the in point goes when it is not before it (dropped: true) */
export function withOut(r: AnyRange, t: number): { range: InOutRange; dropped: boolean } {
  const c = cleanRange(r);
  const range: InOutRange = {};
  let dropped = false;
  if (c && c.in !== undefined) {
    if (c.in >= t - EPS) dropped = true;
    else range.in = c.in;
  }
  range.out = t;
  return { range, dropped };
}

/** the set marks, in order: the lines to draw and to snap to */
export function rangeTimes(r: AnyRange): number[] {
  const c = cleanRange(r);
  const out: number[] = [];
  if (c && c.in !== undefined) out.push(c.in);
  if (c && c.out !== undefined) out.push(c.out);
  return out;
}

/** where the playhead stops: the in point and the last frame inside, the set ones */
export function playheadStops(r: AnyRange, fps: number): number[] {
  const c = cleanRange(r);
  const out: number[] = [];
  if (c && c.in !== undefined) out.push(c.in);
  const last = lastFrameIn(c, fps);
  if (last !== null) out.push(last);
  return out;
}

/** where an edit starts: the in point, else the playhead */
export function editTime(r: AnyRange, playhead: number): number {
  return cleanRange(r)?.in ?? playhead;
}

/**
 * the span to mark at t: the clip under t (a selected one first, then the topmost picture, then any) or, over nothing,
 * the gap around t. null at or past the project end
 */
export function markClipSpan(p: Pick<Project, 'clips' | 'tracks'>, t: number, selection: readonly string[]): { start: number; end: number; clip: Clip | null } | null {
  const total = projectDuration(p);
  if (t >= total - EPS) return null;
  const rank = new Map<string, number>();
  p.tracks.forEach((tr, i) => rank.set(tr.id, i));
  const under: Clip[] = [];
  for (const c of p.clips) if (c.start <= t + EPS && t < clipEnd(c) - EPS) under.push(c);
  if (under.length > 0) {
    const top = (list: Clip[]): Clip | null => {
      let best: Clip | null = null;
      let bestRank = Infinity;
      for (const c of list) {
        const r = rank.get(c.trackId) ?? Infinity;
        if (best === null || r < bestRank) {
          best = c;
          bestRank = r;
        }
      }
      return best;
    };
    const picked =
      top(under.filter((c) => selection.includes(c.id))) ??
      top(under.filter((c) => c.type !== 'effect' && c.type !== 'camera')) ??
      top(under);
    if (picked) return { start: picked.start, end: clipEnd(picked), clip: picked };
  }
  let from = 0;
  let to = total;
  let hasNext = false;
  for (const c of p.clips) {
    const e = clipEnd(c);
    if (e <= t + EPS && e > from) from = e;
    if (c.start > t + EPS && (!hasNext || c.start < to)) {
      to = c.start;
      hasNext = true;
    }
  }
  return { start: from, end: to, clip: null };
}

/** first start to last end of the selected clips. null when none is selected */
export function selectionSpan(p: Pick<Project, 'clips'>, selection: readonly string[]): Span | null {
  let start = Infinity;
  let end = -Infinity;
  for (const c of p.clips) {
    if (!selection.includes(c.id)) continue;
    start = Math.min(start, c.start);
    end = Math.max(end, clipEnd(c));
  }
  return end === -Infinity ? null : { start, end };
}

/** the tracks an edit may change: the unlocked ones. the one place that says so, for the sync lock of a later round */
export function editableTrackIds(p: Pick<Project, 'tracks'>): Set<string> {
  const ids = new Set<string>();
  for (const t of p.tracks) if (!t.locked) ids.add(t.id);
  return ids;
}

/**
 * why lift or extract cannot work: 'both' (a mark is missing), 'nothing' (nothing unlocked in the way), 'locked' (only
 * locked tracks are in the way), 'sync-off' (extract: only unlocked tracks with sync lock off are in the way). null when it can work
 */
export function rangeEditBlock(p: Pick<Project, 'clips' | 'tracks' | 'range'>, extract: boolean): RangeBlock | null {
  const s = editSpan(p.range);
  if (!s) return 'both';
  const open = extract ? syncTrackIds(p.tracks, new Set()) : editableTrackIds(p);
  const unlocked = new Set(p.tracks.filter((t) => !t.locked).map((t) => t.id));
  let lockedInside = false;
  let offInside = false;
  for (const c of p.clips) {
    const inside = c.start < s.end - EPS && clipEnd(c) > s.start + EPS;
    const after = extract && c.start >= s.end - EPS;
    if (!inside && !after) continue;
    if (open.has(c.trackId)) return null;
    if (!inside) continue;
    if (unlocked.has(c.trackId)) offInside = true;
    else lockedInside = true;
  }
  return offInside ? 'sync-off' : lockedInside ? 'locked' : 'nothing';
}
