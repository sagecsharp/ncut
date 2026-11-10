/**
 * swap media: pure rules for which clip a dropped asset replaces and which assets a clip can be
 * swapped to. the store does the swap (replaceClipAsset), the checks here only decide what to offer.
 */
import type { Clip, MediaAsset, Track } from '../../types';

/** at most this many assets in the clip menu */
export const SWAP_MENU_LIMIT = 8;

/** only clips that point at an asset can swap, and only to an asset of their own kind */
export function swappableKind(clip: Pick<Clip, 'type'>): MediaAsset['kind'] | null {
  return clip.type === 'video' || clip.type === 'image' || clip.type === 'audio' ? clip.type : null;
}

/** other assets of the clip's kind, most recently added first. empty for clips without media. */
export function swapCandidates(
  assets: readonly MediaAsset[],
  clip: Pick<Clip, 'type'> & { assetId?: string },
  limit = SWAP_MENU_LIMIT,
): MediaAsset[] {
  const kind = swappableKind(clip);
  if (!kind) return [];
  return assets
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.kind === kind && a.id !== clip.assetId)
    .sort((x, y) => y.a.createdAt - x.a.createdAt || y.i - x.i)
    .slice(0, limit)
    .map(({ a }) => a);
}

/**
 * the clip an asset dropped at (trackId, time) with alt held would replace: the clip of the same
 * kind under that time on that unlocked track, or null (then the drop inserts as usual).
 */
export function swapTarget(
  project: { tracks: readonly Track[]; clips: readonly Clip[] },
  trackId: string | undefined,
  time: number,
  asset: Pick<MediaAsset, 'id' | 'kind'> | undefined,
): Clip | null {
  if (!asset || !trackId) return null;
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track || track.locked) return null;
  for (const c of project.clips) {
    if (c.trackId !== trackId || swappableKind(c) !== asset.kind) continue;
    if ((c as { assetId?: string }).assetId === asset.id) continue;
    if (time >= c.start && time < c.start + c.duration) return c;
  }
  return null;
}
