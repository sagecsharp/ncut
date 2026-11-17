/**
 * the sync rule of a ripple (and later extract and insert): what starts at or after an edit point moves, a clip that spans it
 * stays, locked tracks stay and are listed. one place for which tracks move and by how much room. pure.
 */
import type { Clip, Project } from '../../types';
import { isVisualClip } from '../../types';
import type { ClipMove } from '../../store/editorStore';
import { clipEnd } from '../../lib/timelineOps';
import { SYNC_EPS, pairIndex, syncOffset } from '../../lib/soundPair';
import { syncTrackIds } from '../../lib/trackTools';
import { findFollowers } from './effectFollow';

const EPS = 1e-6;

export interface SyncShift {
  /** the clips that move with the edit: what starts at or after the edit point, plus the effects that follow them */
  moving: Clip[];
  /** how far they can move left: the smallest gap in front of the first mover of a track. Infinity when nothing moves */
  room: number;
  /** the first mover of the track with the smallest room */
  first: Clip | null;
  /** the clip in front of it that stops it (null: the timeline start does) */
  stay: Clip | null;
  /** locked tracks with a clip at or after the edit point, in track order */
  lockedBehind: string[];
  /** unlocked sync lock off tracks that keep a clip at or after the edit point, in track order */
  freeBehind: string[];
  /** clips that go out of sync: a pair in sync where one clip moves and its mate stays. the one that stays is named. project order */
  drift: string[];
}

/** the tracks that move with an edit: syncTrackIds, the one rule. `edited`: the tracks the edit is on */
export function movingTracks(tracks: Project['tracks'], edited: ReadonlySet<string>): Set<string> {
  return syncTrackIds(tracks, edited);
}

/** clips that go out of sync: a pair in sync (the badge's test) where one clip moves and its mate stays. the one that stays is named. edited clips never count. project order */
export function pairDrift(clips: readonly Clip[], moving: ReadonlySet<string>, skip: ReadonlySet<string>): string[] {
  const ix = pairIndex(clips);
  const out = new Set<string>();
  for (const c of clips) {
    const m = ix.mate.get(c.id);
    if (!m || skip.has(c.id) || skip.has(m) || moving.has(c.id) === moving.has(m)) continue;
    const off = syncOffset(clips, c.id);
    if (off !== null && Math.abs(off) < SYNC_EPS) out.add(moving.has(c.id) ? m : c.id);
  }
  return clips.filter((c) => out.has(c.id)).map((c) => c.id);
}

/** an effect that follows its target exactly (findFollowers' test) while that target is on a track outside `open`: it stays whole with its target */
export function staysWithTarget(c: Clip, clips: readonly Clip[], open: ReadonlySet<string>): boolean {
  if (c.type !== 'effect' || !c.target) return false;
  const t = clips.find((x) => x.id === c.target);
  if (!t || !isVisualClip(t) || open.has(t.trackId)) return false;
  return Math.abs(t.start - c.start) <= EPS && Math.abs(t.duration - c.duration) <= EPS;
}

/**
 * at: the edit point. skip: clip ids that are edited themselves (they neither move nor stay). edited: track ids of the edit.
 * atOf: an own edit point for a track. followers of the movers come along and never count for first, stay or room
 */
export function planSyncShift(
  p: Pick<Project, 'clips' | 'tracks'>,
  at: number,
  skip: ReadonlySet<string>,
  edited: ReadonlySet<string>,
  atOf: ReadonlyMap<string, number> = new Map(),
): SyncShift {
  const open = movingTracks(p.tracks, edited);
  const movers: Clip[] = [];
  const firstOn = new Map<string, Clip>();
  const stayOn = new Map<string, Clip>();
  const locked = new Set<string>();
  const lockedIds = new Set(p.tracks.filter((t) => t.locked).map((t) => t.id));
  const held: Clip[] = [];
  for (const c of p.clips) {
    if (skip.has(c.id)) continue;
    const edge = atOf.get(c.trackId) ?? at;
    if (c.start >= edge - EPS) {
      if (!open.has(c.trackId)) {
        if (lockedIds.has(c.trackId)) locked.add(c.trackId);
        else held.push(c);
        continue;
      }
      // an exact follower of a target that is held stays with it: it is no mover and not named as held
      if (staysWithTarget(c, p.clips, open)) continue;
      movers.push(c);
      const f = firstOn.get(c.trackId);
      if (!f || c.start < f.start) firstOn.set(c.trackId, c);
    } else if (open.has(c.trackId)) {
      const s = stayOn.get(c.trackId);
      if (!s || clipEnd(c) > clipEnd(s)) stayOn.set(c.trackId, c);
    }
  }
  let room = Infinity;
  let first: Clip | null = null;
  let stay: Clip | null = null;
  for (const t of p.tracks) {
    const f = firstOn.get(t.id);
    if (!f) continue;
    const s = stayOn.get(t.id) ?? null;
    const r = Math.max(0, f.start - (s ? clipEnd(s) : 0));
    if (r < room) { room = r; first = f; stay = s; }
  }
  let moving = movers;
  if (movers.length > 0) {
    const have = new Set(skip);
    for (const c of movers) have.add(c.id);
    const followers = findFollowers(p.clips, p.tracks, movers.map((c) => c.id), have);
    if (followers.length > 0) moving = [...movers, ...followers];
  }
  // a follower on a sync lock off track goes with its target: it is not held
  const goes = new Set(moving.map((c) => c.id));
  const free = new Set(held.filter((c) => !goes.has(c.id)).map((c) => c.trackId));
  return {
    moving, room, first, stay,
    lockedBehind: p.tracks.filter((t) => locked.has(t.id)).map((t) => t.id),
    freeBehind: p.tracks.filter((t) => free.has(t.id)).map((t) => t.id),
    drift: pairDrift(p.clips, goes, skip),
  };
}

/** every mover by `amount` (negative: left, never before 0). [] for no amount */
export function syncShiftMoves(s: SyncShift, amount: number): ClipMove[] {
  if (Math.abs(amount) < 1e-9) return [];
  return s.moving.map((c) => ({ id: c.id, trackId: c.trackId, start: Math.max(0, c.start + amount) }));
}
