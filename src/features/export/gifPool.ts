/**
 * gif frames do not depend on each other and their slow part is pure number work (lib/gif.ts encodeGifFrame),
 * so a few web workers do it side by side while the exporter keeps drawing. the bytes are exactly the ones
 * the exporter would make itself; only the order of the work changes, the frames are put into the file in
 * playing order by the caller.
 */
import type { Palette } from '../../lib/gif';

export type ToGifWorker = { type: 'init'; palette: Uint8Array; width: number } | { type: 'frame'; id: number; rgba: ArrayBuffer };
export type FromGifWorker = { type: 'done'; id: number; lzw: ArrayBuffer } | { type: 'error'; id: number; message: string };

/** the pool itself failed (not a cancel): the exporter makes the gif again on its own thread */
export class GifPoolError extends Error {}

/** below this much work (pixels of all frames) starting workers costs more than it saves */
export const GIF_POOL_MIN_PIXELS = 3_000_000;
export const GIF_POOL_MAX_WORKERS = 8;

/**
 * how many workers a gif export gets. 1 = none (everything on the calling thread).
 * the calling thread keeps drawing and reading the pixels back, so one core stays with it and one with the system.
 */
export function gifWorkerCount(cores: number, pixelsPerFrame: number, totalFrames: number): number {
  if (!(cores >= 4) || !(totalFrames >= 4)) return 1;
  if (pixelsPerFrame * totalFrames < GIF_POOL_MIN_PIXELS) return 1;
  return Math.max(1, Math.min(GIF_POOL_MAX_WORKERS, Math.floor(cores) - 2, totalFrames));
}

/** frames that may be waiting or in work at once: every worker busy and one more ready behind it */
export function gifPoolDepth(workers: number): number {
  return Math.max(1, workers) * 2;
}

export interface GifPool {
  /** resolves when another frame may be handed over (keeps the pixels waiting in memory bounded). rejects once the pool failed. */
  room(): Promise<void>;
  /** the lzw data of one frame. the pixel buffer is given away (transferred). */
  encode(rgba: ArrayBuffer): Promise<Uint8Array>;
  /** stop everything. pending frames reject. */
  dispose(): void;
}

interface Slot {
  worker: Worker;
  busy: number;
}

/** null when workers cannot be used here */
export function createGifPool(count: number, width: number, palette: Palette): GifPool | null {
  if (typeof Worker === 'undefined' || count < 2) return null;
  const slots: Slot[] = [];
  const pending = new Map<number, { slot: Slot; resolve: (v: Uint8Array) => void; reject: (e: unknown) => void }>();
  const waiting: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  const depth = gifPoolDepth(count);
  let failure: unknown = null;
  let seq = 0;

  const fail = (reason: unknown) => {
    if (failure) return;
    failure = reason;
    for (const s of slots) s.worker.terminate();
    for (const p of pending.values()) p.reject(reason);
    pending.clear();
    for (const w of waiting.splice(0)) w.reject(reason);
  };

  const settle = (id: number): { resolve: (v: Uint8Array) => void; reject: (e: unknown) => void } | null => {
    const p = pending.get(id);
    if (!p) return null;
    pending.delete(id);
    p.slot.busy--;
    waiting.shift()?.resolve();
    return p;
  };

  try {
    for (let k = 0; k < count; k++) {
      const worker = new Worker(new URL('./gifWorker.ts', import.meta.url), { type: 'module', name: 'ncut gif' });
      const slot: Slot = { worker, busy: 0 };
      worker.onmessage = (e: MessageEvent<FromGifWorker>) => {
        const m = e.data;
        if (m.type === 'done') settle(m.id)?.resolve(new Uint8Array(m.lzw));
        else fail(new GifPoolError(`gif worker: ${m.message}`));
      };
      worker.onerror = (e) => fail(new GifPoolError(`gif worker failed: ${e.message || 'could not start'}`));
      worker.onmessageerror = () => fail(new GifPoolError('gif worker: a message could not be read'));
      const init: ToGifWorker = { type: 'init', palette, width };
      worker.postMessage(init);
      slots.push(slot);
    }
  } catch (err) {
    fail(err);
    return null;
  }

  return {
    room() {
      if (failure) return Promise.reject(failure);
      if (pending.size < depth) return Promise.resolve();
      return new Promise<void>((resolve, reject) => waiting.push({ resolve, reject }));
    },
    encode(rgba) {
      if (failure) return Promise.reject(failure);
      let slot = slots[0]!;
      for (const s of slots) if (s.busy < slot.busy) slot = s;
      const id = ++seq;
      return new Promise<Uint8Array>((resolve, reject) => {
        pending.set(id, { slot, resolve, reject });
        slot.busy++;
        try {
          const m: ToGifWorker = { type: 'frame', id, rgba };
          slot.worker.postMessage(m, [rgba]);
        } catch (err) {
          fail(new GifPoolError(err instanceof Error ? err.message : String(err)));
        }
      });
    },
    dispose() {
      fail(new DOMException('export cancelled', 'AbortError'));
    },
  };
}
