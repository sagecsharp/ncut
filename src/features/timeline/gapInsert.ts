/**
 * insert gap: push every clip that starts at or after a time to the right so a hole opens up.
 * pure planning, the store applies the moves in one all-or-nothing call.
 */
import type { Clip, Track } from '../../types';
import { syncTrackIds } from '../../lib/trackTools';
import type { ClipMove } from '../../store/editorStore';

/** the default size of the hole, in seconds */
export const GAP_SECONDS = 1;

/**
 * moves that shift every clip starting at or after `time` by `amount` seconds. clips on locked tracks and on tracks with
 * sync lock off stay, unless `trackId` names that track. `trackId` limits it to one track (nothing when that track is locked).
 * empty = nothing to move.
 * a clip that starts before `time` never moves, so nothing can end up overlapping.
 */
export function planInsertGap(
  clips: readonly Clip[],
  tracks: readonly Track[],
  time: number,
  amount = GAP_SECONDS,
  trackId?: string,
): ClipMove[] {
  if (!(amount > 0)) return [];
  const open = syncTrackIds(tracks, trackId !== undefined ? new Set([trackId]) : new Set());
  const moves: ClipMove[] = [];
  for (const c of clips) {
    if (trackId !== undefined && c.trackId !== trackId) continue;
    if (!open.has(c.trackId)) continue;
    if (c.start >= time - 1e-6) moves.push({ id: c.id, trackId: c.trackId, start: c.start + amount });
  }
  return moves;
}
