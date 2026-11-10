/**
 * runtime registry of imported media: assetId -> blob + object url.
 * the project json only stores metadata. anything that needs the actual file (preview, thumbnails,
 * waveform, export) asks here.
 */
import type { Project } from '../types';
import { getMediaBlob } from '../storage/db';

interface Entry {
  blob: Blob;
  url: string;
}

const entries = new Map<string, Entry>();

export function registerAsset(assetId: string, blob: Blob): string {
  const existing = entries.get(assetId);
  if (existing) return existing.url;
  const url = URL.createObjectURL(blob);
  entries.set(assetId, { blob, url });
  return url;
}

/** object url for <video>/<audio>/<img>. undefined when the file is missing. */
export function getAssetUrl(assetId: string): string | undefined {
  return entries.get(assetId)?.url;
}

export function getAssetBlob(assetId: string): Blob | undefined {
  return entries.get(assetId)?.blob;
}

export function hasAsset(assetId: string): boolean {
  return entries.has(assetId);
}

export function releaseAsset(assetId: string): void {
  const e = entries.get(assetId);
  if (!e) return;
  URL.revokeObjectURL(e.url);
  entries.delete(assetId);
}

export function releaseAllAssets(): void {
  for (const e of entries.values()) URL.revokeObjectURL(e.url);
  entries.clear();
}

/** load every blob of a project from indexeddb. returns ids of assets whose file is missing. */
export async function loadProjectMedia(project: Project): Promise<string[]> {
  const missing: string[] = [];
  await Promise.all(
    project.assets.map(async (asset) => {
      if (entries.has(asset.id)) return;
      try {
        const blob = await getMediaBlob(asset.id);
        if (blob) registerAsset(asset.id, blob);
        else missing.push(asset.id);
      } catch {
        missing.push(asset.id);
      }
    }),
  );
  return missing;
}
