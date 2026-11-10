/**
 * splits an export into parts and renders several of them at once, each with its own encoder: in web workers
 * (exportWorker.ts) or, for tests, on this thread. the exporter joins the parts in order.
 *
 * why: one hardware / software encoder session takes about the same number of frames per second whatever feeds
 * it, a second and third session nearly add up, and the drawing of the frames moves off the main thread.
 */
import type { Project } from '../../types';
import type { DrawSource } from '../../engine/draw';
import type { FontKit } from '../../lib/fontKit';
import { KEYFRAME_SECONDS, renderSegment } from './segment';
import type { SegmentJob, SegmentResult } from './segment';

/** a part is at most this long, so the workers stay evenly loaded on long timelines and little is held in memory */
export const MAX_SEGMENT_SECONDS = 20;
/**
 * exports with fewer frames are done on one thread: starting the workers, their encoders and the run-in frames of
 * the parts cost about a quarter of a second, which is what the parts save on roughly this many frames
 */
export const MIN_PARALLEL_FRAMES = 480;
/** frames a part draws and encodes before its own first frame, for the encoder to settle (segment.ts warmup) */
export const WARMUP_FRAMES = 24;
/** a worker that has not started after this long is treated as broken */
const WORKER_START_MS = 20_000;
/** how often the workers are looked at, and how long one may stay silent in the middle of a part */
const WATCH_MS = 5_000;
const STALL_MS = 120_000;

export interface Span {
  from: number;
  to: number;
}

/** the key frame group of a frame: the rule both ways of exporting drive the encoder by (segment.ts keyStep) */
export function keyGroupOf(frame: number, fps: number): number {
  return Math.floor(frame / fps / KEYFRAME_SECONDS);
}

/**
 * the first frame of key frame group k, which is where one encoder writes that group's key frame. not k * 2 * fps
 * rounded: at 29.97 or 23.976 fps the groups are not all the same length.
 */
export function keyFrameIndex(k: number, fps: number): number {
  if (!(k > 0) || !(fps > 0)) return 0;
  let i = Math.max(0, Math.round(k * KEYFRAME_SECONDS * fps));
  while (keyGroupOf(i, fps) < k) i++;
  while (i > 0 && keyGroupOf(i - 1, fps) >= k) i--;
  return i;
}

/**
 * the parts of an export for a number of workers: about equal lengths of whole key frame groups, cut exactly
 * where one encoder would start a group (every part starts with a key frame anyway, so the file keeps the key
 * frames of a one-thread export), at most MAX_SEGMENT_SECONDS each. a short tail joins the part before it.
 */
export function planSegments(totalFrames: number, fps: number, workers: number): Span[] {
  const total = Math.max(0, Math.floor(totalFrames));
  if (total === 0) return [];
  if (!(fps > 0)) return [{ from: 0, to: total }];
  const groups = keyGroupOf(total - 1, fps) + 1;
  const cap = Math.max(1, Math.floor(MAX_SEGMENT_SECONDS / KEYFRAME_SECONDS));
  const per = Math.max(1, Math.min(cap, Math.ceil(groups / Math.max(1, Math.floor(workers)))));
  const out: Span[] = [];
  let from = 0;
  for (let k = per; from < total; k += per) {
    const to = Math.min(total, keyFrameIndex(k, fps));
    // below half a frame per second several groups start on one frame
    if (to <= from) continue;
    out.push({ from, to });
    from = to;
  }
  if (out.length > 1) {
    const last = out[out.length - 1]!;
    if (last.to - last.from < (KEYFRAME_SECONDS * fps) / 2) {
      out.pop();
      out[out.length - 1]!.to = total;
    }
  }
  return out;
}

/** how many parts past the one being joined may be rendered: enough that no worker waits, little enough to bound the memory */
export function runAhead(workers: number): number {
  return Math.max(2, 2 * Math.max(1, Math.floor(workers)));
}

/**
 * how many parts to render at once. 1 = not worth it (or not possible): one thread, the old way.
 * measured on a 28 thread desktop with one gpu: up to full hd three encoders nearly add up and a fourth adds
 * nothing; above that two are the best (more of them fight over the same memory bandwidth).
 */
export function pickWorkers(width: number, height: number, totalFrames: number, fps: number, cores: number): number {
  if (!(fps > 0) || totalFrames < MIN_PARALLEL_FRAMES) return 1;
  if (cores < 4) return 1;
  const big = width * height > 1920 * 1088 * 1.2;
  let n = big ? 2 : 3;
  if (cores < 8) n = Math.min(n, 2);
  // fewer parts than workers: plan again for that many (the parts change with the number of workers)
  for (;;) {
    const parts = planSegments(totalFrames, fps, n).length;
    if (parts >= n || n <= 1) return Math.max(1, n);
    n = Math.max(1, parts);
  }
}

function bytesOf(d: AllowSharedBufferSource | undefined): Uint8Array | null {
  if (!d) return null;
  return ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
}

/** whether two encoders produced streams one track can hold: same codec string, size and setup bytes (sps / pps ...) */
export function sameDecoderConfig(a: VideoDecoderConfig, b: VideoDecoderConfig): boolean {
  if (a.codec !== b.codec || a.codedWidth !== b.codedWidth || a.codedHeight !== b.codedHeight) return false;
  const x = bytesOf(a.description);
  const y = bytesOf(b.description);
  if (!x || !y) return x === y;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// ---- messages between the exporter and a worker ----

export type ToWorker =
  | { type: 'init'; project: Project; blobs: Array<[string, Blob]>; fontKit: FontKit | null }
  | { type: 'segment'; job: SegmentJob }
  | { type: 'cancel' };

export type FromWorker =
  | { type: 'ready'; missingFonts: string[] }
  | { type: 'progress'; id: number; frames: number }
  /** the part is working but has no frame to report (run-in frames, sources opening): only tells the watchdog */
  | { type: 'alive'; id: number }
  | { type: 'warning'; message: string }
  | { type: 'capture'; frame: number; bitmap: ImageBitmap }
  | { type: 'done'; result: SegmentResult }
  | { type: 'error'; id: number; message: string };

export interface SegmentPoolInit {
  project: Project;
  /** everything of a job but its place */
  base: Omit<SegmentJob, 'id' | 'from' | 'to' | 'capture' | 'warmup'>;
  /** benchmarks: run-in frames per part (missing = WARMUP_FRAMES) */
  warmup?: number;
  segments: Span[];
  workers: number;
  /** true = run the parts on this thread (no workers) */
  onMain: boolean;
  blobOf: (assetId: string) => Blob | undefined;
  /** fonts for the workers (lib/fontKit.ts), null on this thread */
  fontKit: FontKit | null;
  /** families this thread could not load either (a worker missing one of these is no difference) */
  missingFonts?: readonly string[];
  /** this thread only */
  loadImageElement?: (assetId: string) => Promise<DrawSource | null>;
  /** this thread only: give the ui a turn */
  breathe?: () => Promise<void> | void;
  capture?: number[];
  onCapture?: (frame: number, picture: OffscreenCanvas | ImageBitmap) => void;
  onWarning?: (message: string) => void;
  /** frames done over all parts */
  onFrames?: (done: number) => void;
  signal?: AbortSignal;
}

export interface SegmentPool {
  /**
   * the part at an index of `segments`. rejects when any part failed (the whole pool is stopped then).
   * ask in order: asking for a part says the ones before it are joined.
   */
  result(index: number): Promise<SegmentResult>;
  /** the caller has joined this part: its bytes are let go and the workers may start a part further ahead */
  release(index: number): void;
  /** how long each worker took to start (ms), for the stats */
  startTimes(): number[];
  /** stop everything and free the workers */
  dispose(): void;
}

interface Deferred {
  promise: Promise<SegmentResult>;
  resolve: (r: SegmentResult) => void;
  reject: (e: unknown) => void;
  settled: boolean;
}

export function startSegments(init: SegmentPoolInit): SegmentPool {
  const { segments } = init;
  const deferred: Array<Deferred | null> = segments.map(() => {
    let resolve!: (r: SegmentResult) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<SegmentResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // a part nobody waits for yet must not count as an unhandled rejection
    promise.catch(() => {});
    return { promise, resolve, reject, settled: false };
  });
  const stop = new AbortController();
  const onOuterAbort = () => fail(new DOMException('export cancelled', 'AbortError'));
  init.signal?.addEventListener('abort', onOuterAbort);
  const workers: Worker[] = [];
  let failed = false;
  let next = 0;
  // parts [0, consumed) are joined. only parts below consumed + ahead are handed out, so a long export never
  // holds more than a few finished parts in memory
  let consumed = 0;
  const count = Math.max(1, Math.min(init.workers, segments.length));
  const ahead = runAhead(count);
  const waiting: Array<() => void> = [];
  const mayStart = () => next < consumed + ahead;
  const advance = (to: number) => {
    if (to <= consumed) return;
    consumed = to;
    for (const wake of waiting.splice(0)) wake();
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let watch: ReturnType<typeof setInterval> | null = null;
  let readyCount = 0;
  const poolStart = performance.now();
  const startMs: number[] = [];
  const done = new Array<number>(segments.length).fill(0);
  let doneSum = 0;

  const progress = (index: number, frames: number) => {
    doneSum += frames - done[index]!;
    done[index] = frames;
    init.onFrames?.(doneSum);
  };

  const settle = (index: number, r: SegmentResult) => {
    const d = deferred[index];
    if (!d || d.settled) return;
    d.settled = true;
    // the part is handed over first: a progress listener that throws must not leave it hanging
    d.resolve(r);
    progress(index, segments[index]!.to - segments[index]!.from);
  };

  function fail(err: unknown): void {
    if (failed) return;
    failed = true;
    stop.abort();
    for (const t of timers) clearTimeout(t);
    timers.clear();
    if (watch !== null) clearInterval(watch);
    watch = null;
    for (const w of workers) w.terminate();
    workers.length = 0;
    for (const d of deferred) {
      if (!d || d.settled) continue;
      d.settled = true;
      d.reject(err);
    }
    for (const wake of waiting.splice(0)) wake();
  }

  const jobAt = (index: number): SegmentJob => {
    const span = segments[index]!;
    const capture = init.capture?.filter((f) => f >= span.from && f < span.to);
    const warmup = Math.min(span.from, init.warmup ?? WARMUP_FRAMES);
    return { ...init.base, id: index, from: span.from, to: span.to, warmup, ...(capture && capture.length > 0 ? { capture } : {}) };
  };

  const runOnMain = async () => {
    for (;;) {
      while (!failed && next < segments.length && !mayStart()) await new Promise<void>((wake) => waiting.push(wake));
      if (failed) return;
      const index = next++;
      if (index >= segments.length) return;
      try {
        const r = await renderSegment(init.project, jobAt(index), {
          blobOf: init.blobOf,
          loadImageElement: init.loadImageElement,
          onWarning: init.onWarning,
          onProgress: (frames) => progress(index, frames),
          onCapture: (frame, canvas) => init.onCapture?.(frame, canvas),
          signal: stop.signal,
          breathe: init.breathe,
        });
        settle(index, r);
      } catch (err) {
        fail(err);
        return;
      }
    }
  };

  /** per worker: the part it is on (-1 = none) and whether it was heard from since the last look */
  interface Watched {
    current: number;
    heard: boolean;
    quiet: number;
  }
  const watched = new Map<Worker, Watched>();

  const runWorker = (worker: Worker) => {
    const state: Watched = { current: -1, heard: true, quiet: 0 };
    watched.set(worker, state);
    const send = (m: ToWorker) => worker.postMessage(m);
    const takeNext = () => {
      state.current = -1;
      if (failed || next >= segments.length) return;
      if (!mayStart()) {
        waiting.push(takeNext);
        return;
      }
      const index = next++;
      state.current = index;
      state.quiet = 0;
      send({ type: 'segment', job: jobAt(index) });
    };
    const startTimer = setTimeout(() => {
      timers.delete(startTimer);
      if (failed) return;
      // the others are at work already: go on without this one instead of throwing their work away
      if (readyCount > 0) {
        console.warn('[export] an export worker did not start, going on without it');
        worker.terminate();
        watched.delete(worker);
        const at = workers.indexOf(worker);
        if (at >= 0) workers.splice(at, 1);
        return;
      }
      fail(new Error('an export worker did not start'));
    }, WORKER_START_MS);
    timers.add(startTimer);
    const started = () => {
      clearTimeout(startTimer);
      timers.delete(startTimer);
    };
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      state.heard = true;
      if (m.type === 'ready') {
        started();
        readyCount++;
        // text in another font than this thread draws would be a different picture: not acceptable
        const lost = m.missingFonts.filter((f) => !init.missingFonts?.includes(f));
        startMs.push(Math.round(performance.now() - poolStart));
        if (lost.length > 0) fail(new Error(`a worker could not load the font "${lost[0]}"`));
        else takeNext();
      } else if (m.type === 'progress') {
        if (!failed) progress(m.id, m.frames);
      } else if (m.type === 'alive') {
        // nothing more to do: any message already marked the worker as heard from, the progress stays as it is
      } else if (m.type === 'warning') {
        init.onWarning?.(m.message);
      } else if (m.type === 'capture') {
        try {
          init.onCapture?.(m.frame, m.bitmap);
        } finally {
          m.bitmap.close();
        }
      } else if (m.type === 'done') {
        settle(m.result.id, m.result);
        takeNext();
      } else if (m.type === 'error') {
        started();
        fail(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      started();
      fail(new Error(`an export worker stopped${e.message ? `: ${e.message}` : ''}`));
    };
    worker.onmessageerror = () => fail(new Error('an export worker sent something unreadable'));
    // only the files the project shows are handed over (a Blob is a handle, not a copy)
    const blobs: Array<[string, Blob]> = [];
    const seen = new Set<string>();
    for (const clip of init.project.clips) {
      if ((clip.type !== 'video' && clip.type !== 'image') || seen.has(clip.assetId)) continue;
      seen.add(clip.assetId);
      const blob = init.blobOf(clip.assetId);
      if (blob) blobs.push([clip.assetId, blob]);
    }
    send({ type: 'init', project: init.project, blobs, fontKit: init.fontKit });
  };

  if (init.onMain) {
    for (let k = 0; k < count; k++) void runOnMain();
  } else {
    try {
      for (let k = 0; k < count; k++) {
        const worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module', name: 'ncut export' });
        workers.push(worker);
        runWorker(worker);
      }
      // a worker that hangs in the middle of a part would hang the export: counted in looks, not in wall time, so
      // a sleeping machine does not look like a stall
      watch = setInterval(() => {
        for (const state of watched.values()) {
          if (state.current < 0 || state.heard) {
            state.heard = false;
            state.quiet = 0;
            continue;
          }
          state.quiet++;
          if (state.quiet * WATCH_MS >= STALL_MS) {
            fail(new Error('an export worker stopped answering'));
            return;
          }
        }
      }, WATCH_MS);
    } catch (err) {
      fail(err);
    }
  }

  return {
    result: (index) => {
      advance(index);
      return deferred[index]?.promise ?? Promise.reject(new Error('no such part'));
    },
    release: (index) => {
      if (index >= 0 && index < deferred.length) deferred[index] = null;
      advance(index + 1);
    },
    startTimes: () => startMs.slice(),
    dispose: () => {
      init.signal?.removeEventListener('abort', onOuterAbort);
      fail(new DOMException('export cancelled', 'AbortError'));
    },
  };
}
