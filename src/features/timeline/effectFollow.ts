/**
 * effects that are put on one clip follow it: when the clip is moved or trimmed, an effect clip that
 * pointed at it and had exactly its start and duration before the gesture gets the same new start and
 * duration, but only if its own track has room. pure planning, the gestures apply the result.
 */
import type { Clip, EffectClip, Track } from '../../types';
import { isVisualClip } from '../../types';
import { rangesOverlap } from '../../lib/timelineOps';

const EPS = 1e-6;

/** where a visual clip is after the gesture */
export interface ClipSpan {
  start: number;
  duration: number;
  trackId?: string;
}

export interface FollowResult {
  id: string;
  start: number;
  duration: number;
}

/**
 * the effect clips that follow when these clips change: they point at one of `targetIds` (a visual
 * clip), have exactly its start and duration, sit on an unlocked track and are not in `skip`
 * (clips that already move on their own).
 */
export function findFollowers(
  clips: readonly Clip[],
  tracks: readonly Track[],
  targetIds: Iterable<string>,
  skip: ReadonlySet<string> = new Set(),
): EffectClip[] {
  const want = new Set(targetIds);
  const out: EffectClip[] = [];
  let byId: Map<string, Clip> | null = null;
  for (const e of clips) {
    if (e.type !== 'effect' || !e.target || !want.has(e.target) || skip.has(e.id)) continue;
    byId ??= new Map(clips.map((c) => [c.id, c]));
    const t = byId.get(e.target);
    if (!t || !isVisualClip(t)) continue;
    if (Math.abs(t.start - e.start) > EPS || Math.abs(t.duration - e.duration) > EPS) continue;
    const track = tracks.find((x) => x.id === e.trackId);
    if (!track || track.locked) continue;
    out.push(e);
  }
  return out;
}

/**
 * the new place of every follower. `clips` is the project BEFORE the gesture (so a gesture can be
 * re-planned every frame), `changes` the new span of each changed visual clip. a follower whose
 * track has no room for the new span (or that would start before 0) is listed with its old span,
 * so the caller can put it back.
 */
export function placeFollowers(
  clips: readonly Clip[],
  followers: readonly EffectClip[],
  changes: ReadonlyMap<string, ClipSpan>,
): FollowResult[] {
  if (followers.length === 0) return [];
  const final = new Map<string, { trackId: string; start: number; duration: number }>();
  for (const c of clips) {
    const ch = changes.get(c.id);
    final.set(
      c.id,
      ch ? { trackId: ch.trackId ?? c.trackId, start: ch.start, duration: ch.duration } : { trackId: c.trackId, start: c.start, duration: c.duration },
    );
  }
  // every follower is tried at its new place; those that collide with something are put back and
  // the rest is checked again (a follower may take the place another one just left)
  const wanted = new Map<string, ClipSpan>();
  const results: FollowResult[] = [];
  for (const e of followers) {
    const ch = e.target ? changes.get(e.target) : undefined;
    if (ch && ch.start >= -EPS && ch.duration > 0) wanted.set(e.id, ch);
  }
  for (let pass = 0; pass <= followers.length && wanted.size > 0; pass++) {
    for (const f of followers) {
      const ch = wanted.get(f.id);
      final.set(f.id, ch ? { trackId: f.trackId, start: ch.start, duration: ch.duration } : { trackId: f.trackId, start: f.start, duration: f.duration });
    }
    const failed: string[] = [];
    for (const f of followers) {
      const ch = wanted.get(f.id);
      if (!ch) continue;
      for (const [id, o] of final) {
        if (id === f.id || o.trackId !== f.trackId) continue;
        if (rangesOverlap(ch.start, ch.start + ch.duration, o.start, o.start + o.duration)) {
          failed.push(f.id);
          break;
        }
      }
    }
    if (failed.length === 0) break;
    for (const id of failed) wanted.delete(id);
  }
  for (const f of followers) {
    const ch = wanted.get(f.id);
    results.push(ch ? { id: f.id, start: ch.start, duration: ch.duration } : { id: f.id, start: f.start, duration: f.duration });
  }
  return results;
}

/** both steps in one call, for a one-shot change */
export function planEffectFollow(
  clips: readonly Clip[],
  tracks: readonly Track[],
  changes: ReadonlyMap<string, ClipSpan>,
  skip: ReadonlySet<string> = new Set(),
): FollowResult[] {
  return placeFollowers(clips, findFollowers(clips, tracks, changes.keys(), skip), changes);
}
