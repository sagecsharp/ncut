/**
 * the finished stills of the effects / transitions cards (small bitmaps) are kept while the tab is switched away,
 * so coming back does not render every card again. they are let go when the project closes or when the tab has
 * been closed for a while. pure bookkeeping, no dom: the bitmaps only need a close() method.
 */

export interface Closable {
  close(): void;
}

/** how long the stills stay after the tab was closed */
export const STILL_RETAIN_MS = 60_000;

export interface StillCache<T extends Closable> {
  get(id: string): T | undefined;
  has(id: string): boolean;
  /** number of stills held */
  readonly size: number;
  /**
   * a card is about to save a still it just rendered. returns a ticket for finish(), or null when that still is
   * already held or already being saved
   */
  begin(id: string): number | null;
  /** the bitmap is ready: it is kept, unless the cache was released since begin() (or it is a duplicate): then it is closed */
  finish(id: string, ticket: number, bitmap: T): void;
  /** saving did not work out */
  fail(id: string): void;
  /** the tab is shown: nothing is released any more */
  open(): void;
  /** the tab is gone: release after the retain time, or at once (the project was closed) */
  close(releaseNow: boolean): void;
  /** close every bitmap now. late results of saves that began before are closed too */
  release(): void;
}

export interface StillCacheOptions {
  retainMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createStillCache<T extends Closable>(options: StillCacheOptions = {}): StillCache<T> {
  const retainMs = options.retainMs ?? STILL_RETAIN_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const held = new Map<string, T>();
  const saving = new Set<string>();
  let generation = 0;
  let timer: unknown = null;

  const stopTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const release = () => {
    stopTimer();
    generation++;
    for (const b of held.values()) b.close();
    held.clear();
    saving.clear();
  };

  return {
    get: (id) => held.get(id),
    has: (id) => held.has(id),
    get size() {
      return held.size;
    },
    begin(id) {
      if (held.has(id) || saving.has(id)) return null;
      saving.add(id);
      return generation;
    },
    finish(id, ticket, bitmap) {
      if (ticket !== generation) {
        // released since: the saving mark was cleared there (a newer save may own it now)
        bitmap.close();
        return;
      }
      saving.delete(id);
      if (held.has(id)) bitmap.close();
      else held.set(id, bitmap);
    },
    fail(id) {
      saving.delete(id);
    },
    open: stopTimer,
    close(releaseNow) {
      stopTimer();
      if (releaseNow) release();
      else timer = setTimer(release, retainMs);
    },
    release,
  };
}
