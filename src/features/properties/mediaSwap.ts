import type { MediaAsset, MediaKind } from '../../types';

export interface SwapOption {
  id: string;
  label: string;
}

/** the other assets of the same kind a media clip can be swapped to (never the current one). a sound clip (audio of a video) also lists videos with sound */
export function swapOptions(assets: readonly MediaAsset[], currentId: string, kind: MediaKind): SwapOption[] {
  const soundClip = kind === 'audio' && assets.find((a) => a.id === currentId)?.kind === 'video';
  return assets
    .filter((a) => (a.kind === kind || (soundClip && a.kind === 'video' && a.hasAudio)) && a.id !== currentId)
    .map((a) => ({ id: a.id, label: a.name.trim() || a.kind }));
}
