/**
 * the effects that are put on one clip follow it in every way the clip can move, not only in a drag:
 * the clip inspector fields, close gaps, insert gap. pure planning on top of planEffectFollow, so all
 * of them do exactly what the drag does. the caller puts everything in ONE store call (one undo step).
 */
import type { Clip, Track } from '../../types';
import { isVisualClip } from '../../types';
import type { ClipMove } from '../../store/editorStore';
import { planEffectFollow } from './effectFollow';
import type { ClipSpan, FollowResult } from './effectFollow';

const EPS = 1e-6;

/** the new span of every changed visual clip (the changes only matter for visual clips) */
function visualChanges(clips: readonly Clip[], moves: readonly ClipMove[]): Map<string, ClipSpan> {
  const byId = new Map(clips.map((c) => [c.id, c]));
  const changes = new Map<string, ClipSpan>();
  for (const m of moves) {
    const c = byId.get(m.id);
    if (c && isVisualClip(c)) changes.set(c.id, { start: m.start, duration: c.duration, trackId: m.trackId });
  }
  return changes;
}

/** effect clips that sit exactly on a visual clip that stays where it is */
function orphanedEffects(clips: readonly Clip[], moves: readonly ClipMove[]): Set<string> {
  const byId = new Map(clips.map((c) => [c.id, c]));
  const moving = new Map(moves.map((m) => [m.id, m]));
  const out = new Set<string>();
  for (const m of moves) {
    const e = byId.get(m.id);
    if (!e || e.type !== 'effect' || !e.target) continue;
    const t = byId.get(e.target);
    if (!t || !isVisualClip(t)) continue;
    if (Math.abs(t.start - e.start) > EPS || Math.abs(t.duration - e.duration) > EPS) continue;
    const tm = moving.get(t.id);
    if (!tm || Math.abs(tm.start - t.start) <= EPS) out.add(e.id);
  }
  return out;
}

/**
 * `moves` plus the moves of the effects that follow the moved visual clips. a follower that has no
 * room stays where it is. with `dropOrphans` an effect that follows a clip which does not move is
 * taken out of `moves` (it would leave its clip behind).
 */
export function withFollowerMoves(
  clips: readonly Clip[],
  tracks: readonly Track[],
  moves: readonly ClipMove[],
  dropOrphans = false,
): ClipMove[] {
  const base = dropOrphans ? moves.filter((m) => !orphanedEffects(clips, moves).has(m.id)) : [...moves];
  const changes = visualChanges(clips, base);
  if (changes.size === 0) return base;
  const asked = new Set(base.map((m) => m.id));
  const byId = new Map(clips.map((c) => [c.id, c]));
  for (const r of planEffectFollow(clips, tracks, changes, asked)) {
    const e = byId.get(r.id);
    if (e && Math.abs(r.start - e.start) > EPS) base.push({ id: e.id, trackId: e.trackId, start: r.start });
  }
  return base;
}

/**
 * the followers of a visual clip whose span changed (a trim): where each one has to go. `clips` is the
 * project BEFORE the change. only followers that really change are listed.
 */
export function followerSpans(clips: readonly Clip[], tracks: readonly Track[], id: string, span: ClipSpan): FollowResult[] {
  const byId = new Map(clips.map((c) => [c.id, c]));
  return planEffectFollow(clips, tracks, new Map([[id, span]])).filter((r) => {
    const e = byId.get(r.id);
    return e && (Math.abs(r.start - e.start) > EPS || Math.abs(r.duration - e.duration) > EPS);
  });
}
