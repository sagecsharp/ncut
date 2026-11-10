/**
 * close gaps on a track: clips keep their order and sit end to end, starting where the first clip
 * starts. pure planning, the store applies the moves.
 */
import type { Clip } from '../../types';
import type { ClipMove } from '../../store/editorStore';

/** moves that close every gap between the clips of one track. only clips that change are listed. */
export function planCloseGaps(clips: readonly Clip[], trackId: string): ClipMove[] {
  const onTrack = clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
  if (onTrack.length < 2) return [];
  const moves: ClipMove[] = [];
  let cursor = onTrack[0]!.start;
  for (const c of onTrack) {
    if (Math.abs(c.start - cursor) > 1e-6) moves.push({ id: c.id, trackId, start: cursor });
    cursor += c.duration;
  }
  return moves;
}
