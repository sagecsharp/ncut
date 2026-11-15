/**
 * work that would be lost if the page went away right now (a running export).
 * the browser tab asks before it closes, and the desktop shell reads it through window.__ncutBusy.
 */

const reasons = new Map<string, string>();

/** mark / clear a piece of running work. `label` is what the user is told, e.g. 'an export is still running'. */
export function setBusy(key: string, label: string | null): void {
  if (label === null) reasons.delete(key);
  else reasons.set(key, label);
}

/** the first thing that is still running, or null */
export function busyReason(): string | null {
  for (const label of reasons.values()) return label;
  return null;
}

/** the label of the first of these keys that is busy, or null. for work that only some kinds of running work should hold up (an export, not a media copy) */
export function busyFor(keys: readonly string[]): string | null {
  for (const key of keys) {
    const label = reasons.get(key);
    if (label !== undefined) return label;
  }
  return null;
}

/** for tests */
export function clearBusy(): void {
  reasons.clear();
}
