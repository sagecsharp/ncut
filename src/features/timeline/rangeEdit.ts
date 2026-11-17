/**
 * lift and extract, planned: what goes, what is trimmed, what moves up, which transitions stay. pure, no store value.
 * "unlocked" is always editableTrackIds (lib/inOut.ts): one place says which tracks an edit may change.
 */
import type { Clip, Project } from '../../types';
import { MIN_CLIP_DURATION, isVisualClip } from '../../types';
import type { Span } from '../../lib/inOut';
import { editableTrackIds } from '../../lib/inOut';
import { clipEnd, rangesOverlap } from '../../lib/timelineOps';
import { previousClipOnTrack } from '../../lib/transitions';
import type { ClipMove } from '../../store/editorStore';
import { withFollowerMoves } from './followMoves';

const EPS = 1e-6;

type Planned = Pick<Project, 'clips' | 'tracks'>;

/** the clips an edit at t may cut: on unlocked tracks, with room on both sides (what splitClips cuts) */
export function cuttableAt(p: Project, t: number): string[] {
  const open = editableTrackIds(p);
  const out: string[] = [];
  for (const c of p.clips) {
    if (open.has(c.trackId) && t > c.start + MIN_CLIP_DURATION && t < clipEnd(c) - MIN_CLIP_DURATION) out.push(c.id);
  }
  return out;
}

export interface RemovalPlan {
  deletes: string[];
  trims: { id: string; edge: 'start' | 'end'; time: number }[];
  /** pieces under MIN_CLIP_DURATION that were left outside the span and go too */
  slivers: number;
  /** a clip that cannot be split at the span: nothing may be written */
  blocked: Clip | null;
}

/** what leaves the span on unlocked tracks. run after the splits: a clip over a mark is cut there */
export function planRangeRemoval(p: Planned, span: Span): RemovalPlan {
  const open = editableTrackIds(p);
  const rank = new Map<string, number>();
  p.tracks.forEach((t, i) => rank.set(t.id, i));
  const plan: RemovalPlan = { deletes: [], trims: [], slivers: 0, blocked: null };
  const hit = p.clips
    .filter((c) => open.has(c.trackId) && c.start < span.end - EPS && clipEnd(c) > span.start + EPS)
    .sort((a, b) => (rank.get(a.trackId) ?? 0) - (rank.get(b.trackId) ?? 0) || a.start - b.start);
  for (const c of hit) {
    const end = clipEnd(c);
    if (span.start - EPS <= c.start && end <= span.end + EPS) {
      plan.deletes.push(c.id);
      continue;
    }
    const keepL = span.start - c.start;
    const keepR = end - span.end;
    const okL = keepL >= MIN_CLIP_DURATION - EPS;
    const okR = keepR >= MIN_CLIP_DURATION - EPS;
    if (okL && okR) {
      plan.blocked = c;
      return plan;
    }
    if (okL) {
      plan.trims.push({ id: c.id, edge: 'end', time: span.start });
      if (keepR > EPS) plan.slivers++;
    } else if (okR) {
      plan.trims.push({ id: c.id, edge: 'start', time: span.end });
      if (keepL > EPS) plan.slivers++;
    } else {
      plan.deletes.push(c.id);
      if (keepL > EPS) plan.slivers++;
      if (keepR > EPS) plan.slivers++;
    }
  }
  return plan;
}

export interface CloseUpPlan {
  moves: ClipMove[];
  /** a moved clip that would land on one that stays (a safety net: the plan should never make one) */
  clash: { clip: Clip; other: Clip } | null;
}

/** extract: every unlocked clip at or after the span end moves left by the span length, one amount for all tracks */
export function planCloseUp(p: Planned, span: Span): CloseUpPlan {
  const open = editableTrackIds(p);
  const amount = span.end - span.start;
  const base: ClipMove[] = [];
  for (const c of p.clips) {
    if (open.has(c.trackId) && c.start >= span.end - EPS) base.push({ id: c.id, trackId: c.trackId, start: Math.max(0, c.start - amount) });
  }
  const moves = withFollowerMoves(p.clips, p.tracks, base);
  const byId = new Map(p.clips.map((c) => [c.id, c]));
  const moving = new Map(moves.map((m) => [m.id, m]));
  for (const m of moves) {
    const c = byId.get(m.id);
    if (!c) continue;
    const end = m.start + c.duration;
    for (const other of p.clips) {
      if (other.trackId !== m.trackId || moving.has(other.id)) continue;
      if (rangesOverlap(m.start, end, other.start, clipEnd(other))) return { moves, clash: { clip: c, other } };
    }
  }
  return { moves, clash: null };
}

/** each clip of afterSplits that is not in before maps to the before clip it was cut from (the one it starts inside) */
export function splitOrigins(before: Project, afterSplits: Project): Map<string, string> {
  const known = new Set(before.clips.map((c) => c.id));
  const out = new Map<string, string>();
  for (const n of afterSplits.clips) {
    if (known.has(n.id)) continue;
    const from = before.clips.find((c) => c.trackId === n.trackId && c.start < n.start - EPS && clipEnd(c) > n.start + EPS);
    if (from) out.set(n.id, from.id);
  }
  return out;
}

/**
 * the clips whose transition has to go: the clip before it on the track (the render rule, previousClipOnTrack) is
 * now another clip. the same clip, or a right half cut from it, keeps the transition
 */
export function transitionsToDrop(before: Project, after: Project, origins: ReadonlyMap<string, string>): string[] {
  const was = new Map<string, string | null>();
  for (const c of before.clips) was.set(c.id, previousClipOnTrack(before, c)?.id ?? null);
  const out: string[] = [];
  for (const c of after.clips) {
    if (!isVisualClip(c) || !c.transition || !was.has(c.id)) continue;
    const now = previousClipOnTrack(after, c)?.id ?? null;
    const same = now === null ? was.get(c.id) === null : (origins.get(now) ?? now) === was.get(c.id);
    if (!same) out.push(c.id);
  }
  return out;
}

/** the locked tracks with a clip inside the span (extract: or at or after its end) */
export function lockedTracksHit(p: Project, span: Span, extract: boolean): number {
  const open = editableTrackIds(p);
  const hit = new Set<string>();
  for (const c of p.clips) {
    if (open.has(c.trackId)) continue;
    const inside = c.start < span.end - EPS && clipEnd(c) > span.start + EPS;
    const after = extract && c.start >= span.end - EPS;
    if (inside || after) hit.add(c.trackId);
  }
  return hit.size;
}
