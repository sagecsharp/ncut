/**
 * the sync rule of a ripple (and later extract and insert): what starts at or after an edit point moves, a clip that spans it
 * stays, locked tracks stay and are listed. one place for which tracks move and by how much room. pure.
 */
import type { Clip, Project } from '../../types';
import type { ClipMove } from '../../store/editorStore';
import { editableTrackIds } from '../../lib/inOut';
import { clipEnd } from '../../lib/timelineOps';
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
}

/** the tracks that move with an edit. round 1: every unlocked track. round 2 sync lock narrows it here, with `edited` (the tracks the edit is on) */
export function movingTracks(tracks: Project['tracks'], edited: ReadonlySet<string>): Set<string> {
  void edited;
  return editableTrackIds({ tracks });
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
  for (const c of p.clips) {
    if (skip.has(c.id)) continue;
    const edge = atOf.get(c.trackId) ?? at;
    if (c.start >= edge - EPS) {
      if (!open.has(c.trackId)) { locked.add(c.trackId); continue; }
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
  return { moving, room, first, stay, lockedBehind: p.tracks.filter((t) => locked.has(t.id)).map((t) => t.id) };
}

/** every mover by `amount` (negative: left, never before 0). [] for no amount */
export function syncShiftMoves(s: SyncShift, amount: number): ClipMove[] {
  if (Math.abs(amount) < 1e-9) return [];
  return s.moving.map((c) => ({ id: c.id, trackId: c.trackId, start: Math.max(0, c.start + amount) }));
}
