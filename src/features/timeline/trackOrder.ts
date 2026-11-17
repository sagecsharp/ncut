/** where a dragged track lands among its kind. pure: no store, no dom */
import type { Track, TrackKind } from '../../types';
import type { Layout } from './layout';

export interface ReorderTarget {
  /** the index moveTrack gets */
  to: number;
  anchorId: string;
  side: 'above' | 'below';
}

/** the place of the track at `from` for a pointer at lanes-area y. null: no other track of its kind, or its own place */
export function reorderTarget(tracks: readonly Pick<Track, 'id' | 'kind'>[], layout: Pick<Layout, 'tops' | 'heights'>, from: number, y: number): ReorderTarget | null {
  const me = tracks[from];
  if (!me) return null;
  const others: number[] = [];
  let lo = -1;
  for (let i = 0; i < tracks.length; i++) {
    if (tracks[i]!.kind !== me.kind) continue;
    if (lo < 0) lo = i;
    if (i !== from) others.push(i);
  }
  if (others.length === 0) return null;
  let k = 0;
  for (const i of others) if (layout.tops[i]! + layout.heights[i]! / 2 < y) k++;
  const to = lo + k;
  if (to === from) return null;
  if (k < others.length) return { to, anchorId: tracks[others[k]!]!.id, side: 'above' };
  return { to, anchorId: tracks[others[others.length - 1]!]!.id, side: 'below' };
}

/** the words on the drop line: a video track is a layer (on top of / under), an audio track a row (above / below) */
export function dropLabel(kind: TrackKind, side: 'above' | 'below', name: string): string {
  if (kind === 'video') return `${side === 'above' ? 'on top of' : 'under'} ${name}`;
  return `${side} ${name}`;
}
