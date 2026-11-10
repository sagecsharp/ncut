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
 * the index a new track gets when the moved clips are held over a border, or null when the
 * move does not open one: too little vertical travel, clips from several tracks, a track
 * that would break the video-first order, or a move that only swaps one empty track for another.
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
  const one = singleTrack(tracks, items);
  if (!one || !gapAllows(tracks, index, one.kind)) return null;
  if (index === one.index || index === one.index + 1) {
    const own = items[0]!.trackId;
    const all = clips.filter((c) => c.trackId === own).length;
    if (all === items.length) return null;
  }
  return index;
}
