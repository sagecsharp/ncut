/** which assets the media tab lists and in what order. pure: no react, no store. */
import type { Clip, MediaAsset, MediaKind } from '../../types';

export type MediaFilter = 'all' | MediaKind;
export type MediaSort = 'added' | 'newest' | 'name' | 'longest';

export const MEDIA_SORTS: readonly { id: MediaSort; label: string; tip: string }[] = [
  { id: 'added', label: 'added', tip: 'in the order they were imported' },
  { id: 'newest', label: 'newest', tip: 'most recently imported first' },
  { id: 'name', label: 'name', tip: 'a to z' },
  { id: 'longest', label: 'longest', tip: 'longest duration first' },
];

/** ids of the assets that at least one clip points at */
export function usedAssetIds(clips: readonly Clip[]): Set<string> {
  const used = new Set<string>();
  for (const c of clips) if ('assetId' in c && c.assetId) used.add(c.assetId);
  return used;
}

export interface MediaListOptions {
  kind: MediaFilter;
  query: string;
  /** only assets no clip uses. needs `used`. */
  unusedOnly: boolean;
  used: ReadonlySet<string>;
}

export function filterAssets(assets: readonly MediaAsset[], o: MediaListOptions): MediaAsset[] {
  const q = o.query.trim().toLowerCase();
  return assets.filter(
    (a) => (o.kind === 'all' || a.kind === o.kind) && (!q || a.name.toLowerCase().includes(q)) && (!o.unusedOnly || !o.used.has(a.id)),
  );
}

/** a sorted copy. every mode is stable: equal items keep their import order. */
export function sortAssets(assets: readonly MediaAsset[], mode: MediaSort): MediaAsset[] {
  const list = assets.map((a, i) => ({ a, i }));
  const byIndex = (x: { i: number }, y: { i: number }) => x.i - y.i;
  if (mode === 'newest') list.sort((x, y) => y.a.createdAt - x.a.createdAt || y.i - x.i);
  else if (mode === 'name') {
    list.sort((x, y) => x.a.name.localeCompare(y.a.name, undefined, { numeric: true, sensitivity: 'base' }) || byIndex(x, y));
  } else if (mode === 'longest') list.sort((x, y) => y.a.duration - x.a.duration || byIndex(x, y));
  return list.map((x) => x.a);
}

/** the kind of media a clip holds, or null for clips that cannot swap their media (text, shape, effect...) */
export function swapKind(clip: Clip | undefined): MediaKind | null {
  return clip && (clip.type === 'video' || clip.type === 'image' || clip.type === 'audio') ? clip.type : null;
}

/** can this asset be swapped into that clip: same kind, and not the media it already has */
export function canSwapInto(clip: Clip | undefined, asset: Pick<MediaAsset, 'id' | 'kind'>): boolean {
  const kind = swapKind(clip);
  return kind !== null && kind === asset.kind && (clip as { assetId?: string }).assetId !== asset.id;
}
