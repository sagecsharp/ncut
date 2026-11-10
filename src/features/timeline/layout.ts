import type { Track, TrackKind } from '../../types';

export const HEADER_W = 150;
export const RULER_H = 26;
/** thin "new track" drop zones above the first and below the last track */
export const ZONE_H = 14;
export const LANE_H_VIDEO = 56;
export const LANE_H_AUDIO = 48;
/** vertical gap between a lane edge and the clip inside it */
export const CLIP_INSET = 3;
export const CLIP_LABEL_H = 14;
/** snap distance in screen pixels */
export const SNAP_PX = 8;
/** minimum blank space after the last clip, in px */
export const TAIL_MIN_PX = 160;

export function laneHeight(kind: TrackKind): number {
  return kind === 'video' ? LANE_H_VIDEO : LANE_H_AUDIO;
}

export interface Layout {
  /** y of each track row inside the lanes area (below the ruler) */
  tops: number[];
  heights: number[];
  bottomZoneTop: number;
  total: number;
}

const cache = new WeakMap<Track[], Layout>();

export function computeLayout(tracks: Track[]): Layout {
  const hit = cache.get(tracks);
  if (hit) return hit;
  const tops: number[] = [];
  const heights: number[] = [];
  let y = ZONE_H;
  for (const t of tracks) {
    const h = laneHeight(t.kind);
    tops.push(y);
    heights.push(h);
    y += h;
  }
  const layout: Layout = { tops, heights, bottomZoneTop: y, total: y + ZONE_H };
  cache.set(tracks, layout);
  return layout;
}

export type LaneHit = { type: 'lane'; index: number } | { type: 'zone'; where: 'top' | 'bottom' };

/** what is at lanes-area y. above everything = top zone, below everything = bottom zone. */
export function hitLane(layout: Layout, y: number): LaneHit {
  if (y < ZONE_H) return { type: 'zone', where: 'top' };
  if (y >= layout.bottomZoneTop) return { type: 'zone', where: 'bottom' };
  for (let i = 0; i < layout.tops.length; i++) {
    if (y < layout.tops[i]! + layout.heights[i]!) return { type: 'lane', index: i };
  }
  return { type: 'zone', where: 'bottom' };
}
