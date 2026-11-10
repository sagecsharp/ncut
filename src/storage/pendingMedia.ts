/**
 * copies of imported files into indexeddb that are still running in the background.
 * an imported asset shows up as soon as it is probed; the copy finishes later. anything that saves the project
 * or switches to another one waits for these first (whenMediaStored), so a saved project never points at a
 * file that is not stored yet.
 */
import { setBusy } from '../lib/busy';

const BUSY_KEY = 'media-store';
const pending = new Map<string, Promise<void>>();

function syncBusy(): void {
  setBusy(BUSY_KEY, pending.size > 0 ? 'saving imported media' : null);
}

/** register a running copy. `done` must never reject (settle failures inside it). */
export function trackMediaWrite(assetId: string, done: Promise<void>): void {
  const p = done.finally(() => {
    if (pending.get(assetId) === p) {
      pending.delete(assetId);
      syncBusy();
    }
  });
  pending.set(assetId, p);
  syncBusy();
}

/** resolves when every copy that is running right now has settled (a copy started later is not waited for). never rejects. */
export async function whenMediaStored(): Promise<void> {
  if (pending.size === 0) return;
  await Promise.allSettled([...pending.values()]);
}

/** resolves when the copy of this one asset (if any) has settled. never rejects. */
export async function whenAssetStored(assetId: string): Promise<void> {
  const p = pending.get(assetId);
  if (p) await Promise.allSettled([p]);
}

export function pendingMediaCount(): number {
  return pending.size;
}
