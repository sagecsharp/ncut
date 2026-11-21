import type { Clip, ClipType, Track, TrackKind } from '../../types';
import { trackKindForClip } from '../../types';
import { gapAllows } from './layout';

/** the vertical pointer travel (px) before a move may open a track at a border */
export const GAP_MOVE_PX = 8;

export interface GapItem {
  id: string;
  type: ClipType;
  trackId: string;
}

/** the one track every moved clip sits on, and its kind. null when they sit on several */
export function singleTrack(tracks: Pick<Track, 'id'>[], items: GapItem[]): { index: number; kind: TrackKind } | null {
  const first = items[0];
  if (!first) return null;
  for (const o of items) if (o.trackId !== first.trackId) return null;
  const index = tracks.findIndex((t) => t.id === first.trackId);
  if (index < 0) return null;
  return { index, kind: trackKindForClip(first.type) };
}

/**
 * the tracks the moved clips sit on, top to bottom, when they are all of one kind (all video tracks or all audio
 * tracks). null when the clips mix both kinds (no one border can take them) or nothing moves
 */
export function moveTracks(tracks: Pick<Track, 'id'>[], items: GapItem[]): { trackIds: string[]; indexes: number[]; kind: TrackKind } | null {
  const first = items[0];
  if (!first) return null;
  const kind = trackKindForClip(first.type);
  const at = new Map<string, number>();
  for (const o of items) {
    if (trackKindForClip(o.type) !== kind) return null;
    if (at.has(o.trackId)) continue;
    const index = tracks.findIndex((t) => t.id === o.trackId);
    if (index < 0) return null;
    at.set(o.trackId, index);
  }
  const trackIds = [...at.keys()].sort((a, b) => at.get(a)! - at.get(b)!);
  return { trackIds, indexes: trackIds.map((id) => at.get(id)!), kind };
}

/**
 * the index the new tracks get when the moved clips are held over a border (one new track per track the clips come
 * from, in the same order), or null when the move does not open any: too little vertical travel, clips of both kinds,
 * a track that would break the video-first order, or a move that only swaps empty tracks for new ones.
 * `clips` are the clips as the drag found them. `pressIndex` is the border the press itself was on (a clip
 * grabbed by its top or bottom edge sits inside that band): that one never opens, a hand that drifts a little
 * while sliding the clip sideways would make a track nobody asked for.
 */
export function gapForMove(
  tracks: Pick<Track, 'id' | 'kind'>[],
  clips: Pick<Clip, 'id' | 'trackId'>[],
  items: GapItem[],
  index: number | null,
  movedY: number,
  pressIndex: number | null = null,
): number | null {
  if (index === null || index === pressIndex || Math.abs(movedY) < GAP_MOVE_PX) return null;
  const from = moveTracks(tracks, items);
  if (!from || !gapAllows(tracks, index, from.kind)) return null;
  // pointless: the clips are all there is on their tracks, those tracks sit together and the border touches them
  const lo = from.indexes[0]!;
  const hi = from.indexes[from.indexes.length - 1]!;
  if (hi - lo + 1 === from.indexes.length && index >= lo && index <= hi + 1) {
    const emptied = from.trackIds.every((id) => clips.filter((c) => c.trackId === id).length === items.filter((o) => o.trackId === id).length);
    if (emptied) return null;
  }
  return index;
}
