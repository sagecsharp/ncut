/**
 * match frame: the timeline clip under the playhead and the exact moment of its media (and back). pure.
 */
import type { InOutRange, MediaAsset, MediaClip, Project } from '../types';
import { isMediaClip } from '../types';
import { cleanRange } from './inOut';
import { clamp } from './time';
import { clipEnd } from './timelineOps';

export type { MediaClip };

export interface MatchTarget {
  clip: MediaClip;
  asset: MediaAsset;
  time: number;
  marks: InOutRange | null;
}
type P = Pick<Project, 'clips' | 'tracks' | 'assets'>;

const EPS = 1e-6;

function trackRank(p: P): Map<string, number> {
  const rank = new Map<string, number>();
  p.tracks.forEach((t, i) => rank.set(t.id, i));
  return rank;
}

/** the media clips (with their media) under t: at a join the next clip wins, at the project end nothing. locked tracks count */
function underAt(p: P, t: number): MediaClip[] {
  const out: MediaClip[] = [];
  for (const c of p.clips) {
    if (!isMediaClip(c)) continue;
    if (!p.assets.some((a) => a.id === c.assetId)) continue;
    if (c.start <= t + EPS && t < clipEnd(c) - EPS) out.push(c);
  }
  return out;
}

/** the first of the list in track order (index 0 = top), then project order */
function firstOnTop(list: MediaClip[], rank: Map<string, number>): MediaClip | null {
  let best: MediaClip | null = null;
  let bestRank = Infinity;
  for (const c of list) {
    const r = rank.get(c.trackId) ?? Infinity;
    if (best === null || r < bestRank) {
      best = c;
      bestRank = r;
    }
  }
  return best;
}

/** the clip to match at t: a selected one, else the top picture, else heard sound, else any media clip. null over nothing */
export function pickMatchClip(p: P, t: number, selection: readonly string[]): MediaClip | null {
  const under = underAt(p, t);
  if (under.length === 0) return null;
  const rank = trackRank(p);
  const track = (c: MediaClip) => p.tracks.find((x) => x.id === c.trackId);
  const selected = firstOnTop(under.filter((c) => selection.includes(c.id)), rank);
  if (selected) return selected;
  const picture = firstOnTop(under.filter((c) => (c.type === 'video' || c.type === 'image') && !track(c)?.hidden), rank);
  if (picture) return picture;
  const heard = firstOnTop(under.filter((c) => c.type === 'audio' && !track(c)?.muted), rank);
  if (heard) return heard;
  return firstOnTop(under, rank);
}

/** the moment of the media shown by clip at timeline time t, and the part of the media the clip uses */
export function planMatchFrame(clip: MediaClip, asset: MediaAsset, t: number): MatchTarget {
  if (clip.type === 'image') return { clip, asset, time: 0, marks: null };
  const time = clamp(clip.trimStart + (t - clip.start) * clip.speed, 0, asset.duration);
  const marks = cleanRange({ in: clip.trimStart, out: Math.min(asset.duration, clip.trimStart + clip.duration * clip.speed) });
  return { clip, asset, time, marks };
}

export function matchFrameAt(p: P, t: number, selection: readonly string[]): MatchTarget | null {
  const clip = pickMatchClip(p, t, selection);
  if (!clip) return null;
  const asset = p.assets.find((a) => a.id === clip.assetId);
  return asset ? planMatchFrame(clip, asset, t) : null;
}

/** the timeline moment that shows sourceTime of a media: a selected clip first, else the nearest to the playhead */
export function planReverseMatch(p: P, assetId: string, sourceTime: number, playhead: number, selection: readonly string[]): { clipId: string; time: number } | null {
  const rank = trackRank(p);
  const uses: MediaClip[] = [];
  for (const c of p.clips) {
    if (!isMediaClip(c) || c.assetId !== assetId) continue;
    if (c.type === 'image' || (sourceTime >= c.trimStart - EPS && sourceTime < c.trimStart + c.duration * c.speed - EPS)) uses.push(c);
  }
  if (uses.length === 0) return null;
  const chosen = uses.filter((c) => selection.includes(c.id));
  const pool = chosen.length > 0 ? chosen : uses;
  const away = (c: MediaClip): number => (playhead < c.start ? c.start - playhead : playhead >= clipEnd(c) ? playhead - clipEnd(c) : 0);
  let best: MediaClip | null = null;
  for (const c of pool) {
    if (best === null) {
      best = c;
      continue;
    }
    const da = away(c);
    const db = away(best);
    if (da !== db) {
      if (da < db) best = c;
      continue;
    }
    const ra = rank.get(c.trackId) ?? Infinity;
    const rb = rank.get(best.trackId) ?? Infinity;
    if (ra !== rb) {
      if (ra < rb) best = c;
      continue;
    }
    if (c.start < best.start) best = c;
  }
  if (!best) return null;
  if (best.type === 'image') {
    const inside = playhead >= best.start && playhead < clipEnd(best);
    return { clipId: best.id, time: inside ? playhead : best.start };
  }
  return { clipId: best.id, time: clamp(best.start + (sourceTime - best.trimStart) / best.speed, best.start, clipEnd(best) - EPS) };
}
