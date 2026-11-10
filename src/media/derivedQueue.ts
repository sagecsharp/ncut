/**
 * small priority scheduler for the derived-data jobs (thumbnails, filmstrips, waveforms).
 *
 * rules:
 *  - at most `concurrency` jobs run at once (decoders are heavy, the app keeps 1)
 *  - when several wait: thumbnails before filmstrips before waveforms, newest request first inside a kind
 *  - a job with a key that is still waiting or running returns the same promise (no double work)
 *  - a failed job rejects its own promise only, the queue goes on
 *  - before each job the scheduler yields to the main thread (yieldFn) so input / paint can run
 */

export type JobKind = 'thumb' | 'film' | 'wave';

const RANK: Record<JobKind, number> = { thumb: 0, film: 1, wave: 2 };

interface Pending {
  kind: JobKind;
  seq: number;
  key: string | null;
  job: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export interface Scheduler {
  /** queue a job. same `key` while pending / running = same promise. */
  submit<T>(kind: JobKind, job: () => Promise<T>, key?: string): Promise<T>;
  /** jobs waiting + running (for tests / debugging) */
  size(): number;
}

export function createScheduler(opts: { concurrency?: number; yieldFn?: () => Promise<void> } = {}): Scheduler {
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  const yieldFn = opts.yieldFn ?? (() => Promise.resolve());
  const waiting: Pending[] = [];
  const byKey = new Map<string, Promise<unknown>>();
  let running = 0;
  let seq = 0;

  function pickIndex(): number {
    let best = -1;
    for (let i = 0; i < waiting.length; i++) {
      const p = waiting[i]!;
      if (best < 0) {
        best = i;
        continue;
      }
      const b = waiting[best]!;
      const r = RANK[p.kind] - RANK[b.kind];
      if (r < 0 || (r === 0 && p.seq > b.seq)) best = i;
    }
    return best;
  }

  // slots that were started (still in their yield) but have not picked a job yet
  let starting = 0;

  function pump(): void {
    while (running < concurrency && waiting.length > starting) {
      running++;
      starting++;
      void start();
    }
  }

  async function start(): Promise<void> {
    try {
      await yieldFn();
    } catch {
      /* a broken yield must not stall the queue */
    }
    starting--;
    const i = pickIndex();
    if (i < 0) {
      running--;
      return;
    }
    const p = waiting.splice(i, 1)[0]!;
    try {
      p.resolve(await p.job());
    } catch (e) {
      p.reject(e);
    } finally {
      running--;
      pump();
    }
  }

  function submit<T>(kind: JobKind, job: () => Promise<T>, key?: string): Promise<T> {
    if (key !== undefined) {
      const existing = byKey.get(key);
      if (existing) return existing as Promise<T>;
    }
    const promise = new Promise<T>((resolve, reject) => {
      waiting.push({ kind, seq: seq++, key: key ?? null, job, resolve: resolve as (v: unknown) => void, reject });
    });
    if (key !== undefined) {
      byKey.set(key, promise);
      const clear = () => {
        if (byKey.get(key) === promise) byKey.delete(key);
      };
      promise.then(clear, clear);
    }
    pump();
    return promise;
  }

  return { submit, size: () => waiting.length + running - starting };
}
