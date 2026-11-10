/**
 * STUB - owned by the media agent. keep the exported signatures.
 *
 * importing files into the open project: probe -> store blob -> register -> add asset to the store.
 */
import type { MediaAsset, MediaKind } from '../types';

export const ACCEPTED_TYPES = 'video/*,audio/*,image/*';

/** media kind from a mime type / file name, or null when the file is not supported */
export function detectKind(file: { type: string; name: string }): MediaKind | null {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  return null;
}

/**
 * import files into the open project. unsupported / unreadable files are skipped (with a toast).
 * resolves with the assets that were added.
 */
export async function importFiles(_files: File[] | FileList): Promise<MediaAsset[]> {
  throw new Error('importFiles: not implemented');
}

/** remove an asset from the project, the registry and indexeddb */
export async function deleteAsset(_assetId: string): Promise<void> {
  throw new Error('deleteAsset: not implemented');
}
