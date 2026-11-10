/**
 * runtime registry of imported media: assetId -> blob + object url.
 * the project json only stores metadata. anything that needs the actual file (preview, thumbnails,
 * waveform, export) asks here.
 */
import type { Project } from '../types';
import { getMediaBlobs } from '../storage/db';

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

/**
 * load every blob of a project from indexeddb. returns ids of assets whose file is missing.
 * `known` = files that were already read (by asset id): only the rest is asked for, in one transaction.
 */
export async function loadProjectMedia(project: Project, known?: ReadonlyMap<string, Blob>): Promise<string[]> {
  const missing: string[] = [];
  const toRead: string[] = [];
  for (const asset of project.assets) {
    if (entries.has(asset.id)) continue;
    const blob = known?.get(asset.id);
    if (blob) registerAsset(asset.id, blob);
    else toRead.push(asset.id);
  }
  if (toRead.length === 0) return missing;
  let read: Map<string, Blob | undefined | Error> | null = null;
  try {
    read = await getMediaBlobs(toRead);
  } catch {
    read = null; // the database could not be read: every one of these files counts as missing
  }
  for (const id of toRead) {
    const blob = read?.get(id);
    if (blob instanceof Blob) registerAsset(id, blob);
    else missing.push(id);
  }
  return missing;
}
