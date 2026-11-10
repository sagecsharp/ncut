import type { MediaAsset, MediaKind } from '../../types';

export interface SwapOption {
  id: string;
  label: string;
}

/** the other assets of the same kind a media clip can be swapped to (never the current one) */
export function swapOptions(assets: readonly MediaAsset[], currentId: string, kind: MediaKind): SwapOption[] {
  return assets.filter((a) => a.kind === kind && a.id !== currentId).map((a) => ({ id: a.id, label: a.name.trim() || a.kind }));
}
