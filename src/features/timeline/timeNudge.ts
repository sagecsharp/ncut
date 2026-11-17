/** nudges in time and the edits that up / down step through. named apart from preview/nudge.ts, the 1 px nudge. pure */
import type { Clip, Project } from '../../types';
import type { ClipMove } from '../../store/editorStore';
import type { TrimEdge } from '../../store/ui';
import { clipEnd, getTrackClips, rangesOverlap } from '../../lib/timelineOps';
import { CUT_EPS } from '../../lib/transitions';
import { withFollowerMoves } from './followMoves';
import type { TrimStop } from './trimModes';

export type NP = Pick<Project, 'clips' | 'tracks' | 'fps'>;
export interface NudgePlan {
  moves: ClipMove[];      // the moving selected clips plus the followers that come along
  ids: string[];          // the selected clips that move (no followers), project order
  stop: TrimStop | null;  // nothing moves: 'locked' | 'timeline-start' | 'overlap'
  lockedStay: string[];   // locked track ids, track order, holding a selected clip or a group mate of a moving one
  frames: number;
}
export type EditScope = 'all' | 'selection' | 'edge';
export interface EditStep { scope: EditScope; time: number | null; edge: TrimEdge | null } // time null: no edit that way
export const NUDGE_ROWS: Readonly<Record<string, number>> = { 'nudge-left': -1, 'nudge-right': 1, 'nudge-left-big': -10, 'nudge-right-big': 10 };
export const NUDGE_TEXT = { previewKeys: 'the preview has the arrow keys: click the timeline, then alt+left / alt+right nudge in time' } as const;

/** t moved by frames. a start on the frame grid stays exactly on it */
export function nudgeTime(t: number, frames: number, fps: number): number {
  const k = t * fps;
  const r = Math.round(k);
  const s = Math.abs(k - r) < 1e-6 ? (r + frames) / fps : t + frames / fps;
  return s < 0 && s > -1e-9 ? 0 : s;
}

export function emptyNudge(frames: number, stop: TrimStop | null = null, lockedStay: string[] = []): NudgePlan {
  return { moves: [], ids: [], stop, lockedStay, frames };
}

/** an effect that sits on one clip follows that clip */
export function isFollowerClip(c: Clip): boolean {
  return c.type === 'effect' && !!c.target;
}

/** the edge when its clip still exists, else null */
export function liveEdge(p: Pick<Project, 'clips'>, e: TrimEdge | null): TrimEdge | null {
  return e && p.clips.some((c) => c.id === e.clipId) ? e : null;
}

/** moveClips' own check on the clips after `moves`: the first overlapping neighbours, track order */
function overlapStop(p: NP, moves: readonly ClipMove[]): TrimStop | null {
  const to = new Map(moves.map((m) => [m.id, m]));
  const sim = { clips: p.clips.map((c) => { const m = to.get(c.id); return m ? { ...c, trackId: m.trackId, start: m.start } : c; }) };
  const touched = new Set(moves.map((m) => m.trackId));
  for (const t of p.tracks) {
    if (!touched.has(t.id)) continue;
    const list = getTrackClips(sim, t.id); // moveClips' order: by start, ties in project order
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!;
      const b = list[i]!;
      if (!rangesOverlap(a.start, clipEnd(a), b.start, clipEnd(b))) continue;
      const hit = to.has(b.id) || !to.has(a.id) ? b : a; // the moved one, the later when both moved
      return { why: 'overlap', clipId: hit.id, otherId: hit === b ? a.id : b.id };
    }
  }
  return null;
}

/** the selected clips (and what comes with them) moved by frames, as moveClips would do it. a stop says why nothing moves */
export function planNudge(p: NP, selection: readonly string[], frames: number): NudgePlan {
  const sel = new Set(selection);
  const picked = p.clips.filter((c) => sel.has(c.id));
  if (frames === 0 || picked.length === 0) return emptyNudge(frames);
  const locked = new Set(p.tracks.filter((t) => t.locked).map((t) => t.id));
  const movable = picked.filter((c) => !locked.has(c.trackId));
  const groups = new Set(movable.flatMap((c) => (c.group ? [c.group] : [])));
  const stay = new Set(p.clips.filter((c) => locked.has(c.trackId) && (sel.has(c.id) || (!!c.group && groups.has(c.group)))).map((c) => c.trackId));
  const lockedStay = p.tracks.filter((t) => stay.has(t.id)).map((t) => t.id);
  if (movable.length === 0) return emptyNudge(frames, { why: 'locked', clipId: picked[0]!.id }, lockedStay);
  const base: ClipMove[] = movable.map((c) => ({ id: c.id, trackId: c.trackId, start: nudgeTime(c.start, frames, p.fps) }));
  const order = new Map(p.tracks.map((t, i) => [t.id, i]));
  const neg = base.filter((m) => m.start < 0).sort((a, b) => a.start - b.start || order.get(a.trackId)! - order.get(b.trackId)!);
  if (neg.length > 0) return emptyNudge(frames, { why: 'timeline-start', clipId: neg[0]!.id }, lockedStay);
  const stop = overlapStop(p, base);
  if (stop) return emptyNudge(frames, stop, lockedStay);
  const all = withFollowerMoves(p.clips, p.tracks, base);
  // like the drag (gestures.ts applyMoves): followers that would overlap stay, the clips still move
  const moves = all.length > base.length && overlapStop(p, all) ? base : all;
  return { moves, ids: movable.map((c) => c.id), stop: null, lockedStay, frames };
}

/** every start and end, sorted, near duplicates dropped */
export function editTimes(clips: readonly Clip[]): number[] {
  const all = clips.flatMap((c) => [c.start, clipEnd(c)]).sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of all) if (out.length === 0 || t - out[out.length - 1]! > 1e-6) out.push(t);
  return out;
}

/** the nearest edit beyond from, that way, or null */
function nextEdit(times: readonly number[], from: number, dir: -1 | 1): number | null {
  if (dir > 0) {
    for (const t of times) if (t > from + CUT_EPS) return t;
    return null;
  }
  for (let i = times.length - 1; i >= 0; i--) if (times[i]! < from - CUT_EPS) return times[i]!;
  return null;
}

/**
 * the edit before or after: from the selected edge's own time on its track, else from the time on the tracks of the
 * selected clips, else on all tracks. an edge steps to an edit of the same kind where it can
 */
export function planEditStep(p: Pick<Project, 'clips' | 'tracks'>, selection: readonly string[], edge: TrimEdge | null, time: number, dir: -1 | 1, like: TrimEdge | null = edge): EditStep {
  const e = liveEdge(p, edge);
  if (e) {
    const c = p.clips.find((x) => x.id === e.clipId)!;
    const from = e.edge === 'start' ? c.start : clipEnd(c);
    const t = nextEdit(editTimes(p.clips.filter((x) => x.trackId === c.trackId && !isFollowerClip(x))), from, dir);
    return { scope: 'edge', time: t, edge: t === null ? null : edgeAt(p, c.trackId, t, like ?? e) };
  }
  const sel = new Set(selection);
  const tracks = new Set(p.clips.filter((c) => sel.has(c.id)).map((c) => c.trackId));
  if (tracks.size > 0) return { scope: 'selection', time: nextEdit(editTimes(p.clips.filter((c) => tracks.has(c.trackId))), time, dir), edge: null };
  return { scope: 'all', time: nextEdit(editTimes(p.clips), time, dir), edge: null };
}

/** the edge to select at an edit: the clip ending there, the one starting there, or both, by the kind of `like` */
export function edgeAt(p: Pick<Project, 'clips'>, trackId: string, t: number, like: TrimEdge): TrimEdge | null {
  const on = p.clips.filter((c) => c.trackId === trackId && !isFollowerClip(c));
  const L = on.find((c) => Math.abs(clipEnd(c) - t) <= CUT_EPS);
  const R = on.find((c) => Math.abs(c.start - t) <= CUT_EPS);
  if (like.both && L && R) return { clipId: L.id, edge: 'end', both: true, alone: like.alone };
  if (like.edge === 'start') {
    if (R) return { clipId: R.id, edge: 'start', both: false, alone: like.alone };
    return L ? { clipId: L.id, edge: 'end', both: false, alone: like.alone } : null;
  }
  if (L) return { clipId: L.id, edge: 'end', both: false, alone: like.alone };
  return R ? { clipId: R.id, edge: 'start', both: false, alone: like.alone } : null;
}
