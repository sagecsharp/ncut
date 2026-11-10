/** pure parts of the persistent derived cache: keys and which entries to delete */

/** bump a version when the way a value is computed changes, so old entries are simply never read again */
const THUMB_VERSION = 1;
const WAVE_VERSION = 1;

export function thumbCacheKey(assetId: string, width: number, quality: number): string {
  return `thumb:${assetId}:w${width}:q${Math.round(quality * 100)}:v${THUMB_VERSION}`;
}

export function waveCacheKey(assetId: string, peaksPerSecond: number): string {
  return `wave:${assetId}:p${peaksPerSecond}:v${WAVE_VERSION}`;
}

export interface CacheEntryInfo {
  key: string;
  bytes: number;
  usedAt: number;
}

export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** a hit only rewrites usedAt when it is older than this, so reading does not mean writing */
export const TOUCH_AFTER_MS = 12 * 60 * 60 * 1000;

/** keys to delete: everything unused for `maxAgeMs`, then the oldest until the rest fits in `maxBytes` */
export function planCleanup(
  entries: CacheEntryInfo[],
  now: number,
  maxAgeMs = MAX_AGE_MS,
  maxBytes = MAX_TOTAL_BYTES,
): string[] {
  const drop: string[] = [];
  const keep: CacheEntryInfo[] = [];
  for (const e of entries) {
    if (!Number.isFinite(e.usedAt) || now - e.usedAt > maxAgeMs) drop.push(e.key);
    else keep.push(e);
  }
  let total = 0;
  for (const e of keep) total += Math.max(0, e.bytes);
  if (total > maxBytes) {
    keep.sort((a, b) => a.usedAt - b.usedAt);
    for (const e of keep) {
      if (total <= maxBytes) break;
      drop.push(e.key);
      total -= Math.max(0, e.bytes);
    }
  }
  return drop;
}

export function needsTouch(usedAt: number, now: number): boolean {
  return !Number.isFinite(usedAt) || now - usedAt > TOUCH_AFTER_MS;
}
