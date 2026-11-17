/**
 * measures the mix the way the export hears it, offline, and keeps what it found. one cache and one list of runs in
 * flight for the mixer, the dialog, the export and mcp: the same sound is measured once.
 */
import type { Project } from '../../types';
import { inOutSpan } from '../../lib/inOut';
import { projectDuration } from '../../lib/timelineOps';
import { LoudnessMeter, NO_NUMBERS, NO_TRACE } from '../../lib/loudness';
import { useEditor } from '../../store/editorStore';
import { clampRange } from './range';
import type { TimeRange } from './range';
import { createAudioMixer } from './audioMix';
import type { MixLoudness } from './loudnessTypes';
import { loudnessDebug } from './loudnessDebug';
import { measureRate } from './loudnessPrefs';
import { soundSignature } from './soundSignature';

export interface MeasureOpts { signal?: AbortSignal; onProgress?: (f: number) => void }
export type MeasureRun = (project: Project, range: TimeRange, rate: number, signal: AbortSignal, progress: (f: number) => void) => Promise<MixLoudness>;

export interface Measurer {
  measure(project: Project, range: TimeRange, rate: number, opts?: MeasureOpts): Promise<MixLoudness>;
  /** the cached answer, no work */
  measured(project: Project, range: TimeRange, rate: number): MixLoudness | null;
  /** 0..1 while a run for this sound goes, else null */
  measuring(project: Project, range: TimeRange, rate: number): number | null;
  /** start, progress and end of any run. returns the way to stop listening */
  onChange(fn: () => void): () => void;
}

const KEPT = 8;
const TELL_MS = 100;

const cancelled = (): DOMException => new DOMException('measure cancelled', 'AbortError');

interface Waiter {
  resolve(m: MixLoudness): void;
  reject(e: unknown): void;
  onProgress?: (f: number) => void;
  leave?: () => void;
}

interface Flight {
  ctl: AbortController;
  waiters: Set<Waiter>;
  progress: number;
  lastTell: number;
}

/** sign tells two sounds apart (soundSignature) */
export function createMeasurer(run: MeasureRun, sign: (project: Project, range: TimeRange, rate: number) => string = soundSignature): Measurer {
  const cache = new Map<string, MixLoudness>();
  const flights = new Map<string, Flight>();
  const listeners = new Set<() => void>();
  const tell = (): void => {
    for (const fn of [...listeners]) fn();
  };

  const finish = (key: string, flight: Flight, how: { ok: MixLoudness } | { bad: unknown }): void => {
    if (flights.get(key) !== flight) return; // every waiter left: nobody is told
    flights.delete(key);
    const waiters = [...flight.waiters];
    flight.waiters.clear();
    if ('ok' in how) {
      if (how.ok.warnings.length === 0) {
        cache.delete(key);
        cache.set(key, how.ok);
        while (cache.size > KEPT) cache.delete(cache.keys().next().value!);
      }
      for (const w of waiters) {
        w.leave?.();
        w.resolve(how.ok);
      }
    } else {
      for (const w of waiters) {
        w.leave?.();
        w.reject(how.bad);
      }
    }
    tell();
  };

  const start = (key: string, project: Project, range: TimeRange, rate: number): Flight => {
    const flight: Flight = { ctl: new AbortController(), waiters: new Set(), progress: 0, lastTell: Date.now() };
    flights.set(key, flight);
    loudnessDebug.measures++;
    const progress = (f: number): void => {
      if (flights.get(key) !== flight) return;
      flight.progress = f;
      for (const w of [...flight.waiters]) w.onProgress?.(f);
      const now = Date.now();
      if (now - flight.lastTell >= TELL_MS) {
        flight.lastTell = now;
        tell();
      }
    };
    let p: Promise<MixLoudness>;
    try {
      p = run(project, range, rate, flight.ctl.signal, progress);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (ok) => finish(key, flight, { ok }),
      (bad) => finish(key, flight, { bad }),
    );
    tell();
    return flight;
  };

  return {
    measure(project, range, rate, opts) {
      const signal = opts?.signal;
      if (signal?.aborted) return Promise.reject(cancelled());
      const key = sign(project, range, rate);
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        loudnessDebug.cacheHits++;
        return Promise.resolve(hit);
      }
      const flight = flights.get(key) ?? start(key, project, range, rate);
      return new Promise<MixLoudness>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject, onProgress: opts?.onProgress };
        flight.waiters.add(waiter);
        if (signal) {
          const onAbort = (): void => {
            if (!flight.waiters.delete(waiter)) return;
            waiter.leave?.();
            reject(cancelled());
            if (flight.waiters.size === 0 && flights.get(key) === flight) {
              flights.delete(key);
              flight.ctl.abort();
              tell();
            }
          };
          signal.addEventListener('abort', onAbort, { once: true });
          waiter.leave = () => signal.removeEventListener('abort', onAbort);
        }
      });
    },
    measured: (project, range, rate) => cache.get(sign(project, range, rate)) ?? null,
    measuring: (project, range, rate) => flights.get(sign(project, range, rate))?.progress ?? null,
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** what the mixer and the search row measure: the in / out range, else the whole project */
export function mixerRange(project: Project): TimeRange | null {
  const d = projectDuration(project);
  return inOutSpan(project.range, d) ?? clampRange(undefined, d);
}

let lastTurn = 0;
let channel: MessageChannel | null = null;
const waiting: Array<() => void> = [];

/** give the event loop a turn through a message (a hidden window throttles setTimeout) */
function turn(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0);
      return;
    }
    if (!channel) {
      channel = new MessageChannel();
      channel.port1.onmessage = () => {
        for (const f of waiting.splice(0)) f();
      };
    }
    waiting.push(resolve);
    if (waiting.length === 1) channel.port2.postMessage(0);
  }).then(() => {
    lastTurn = performance.now();
  });
}

/** the real run: the export's mixer, one meter, 1 s pieces */
async function runMeasure(project: Project, range: TimeRange, rate: number, signal: AbortSignal, progress: (f: number) => void): Promise<MixLoudness> {
  const warnings: string[] = [];
  const span = { start: range.start, end: range.end };
  const seconds = range.end - range.start;
  const mixer = createAudioMixer(project, seconds, signal, (m) => warnings.push(m), range.start, rate);
  try {
    if (!mixer.hasAudio) {
      return { numbers: { ...NO_NUMBERS, seconds }, trace: NO_TRACE, sampleRate: rate, span, warnings, silent: true };
    }
    const meter = new LoudnessMeter(rate);
    const total = mixer.totalFrames;
    let done = 0;
    lastTurn = performance.now();
    for (let i = 0; i < mixer.chunks.length; i++) {
      if (signal.aborted) throw cancelled();
      const chunk = mixer.chunks[i]!;
      const buf = await mixer.renderChunk(i);
      const l = buf.getChannelData(0);
      const r = buf.getChannelData(1);
      const frames = Math.min(chunk.frames, buf.length);
      for (let at = 0; at < frames; at += rate) {
        if (signal.aborted) throw cancelled();
        const n = Math.min(rate, frames - at);
        meter.push(l, r, at, n);
        done += n;
        progress(Math.min(1, done / total));
        if (performance.now() - lastTurn > 14) await turn();
      }
    }
    meter.finish();
    return { numbers: meter.numbers(), trace: meter.trace(), sampleRate: rate, span, warnings, silent: false };
  } finally {
    mixer.dispose();
  }
}

const measurer = createMeasurer(runMeasure);

export function measureMix(project: Project, range: TimeRange, rate: number, opts?: MeasureOpts): Promise<MixLoudness> {
  return measurer.measure(project, range, rate, opts);
}
/** the cached answer, no work */
export function measuredFor(project: Project, range: TimeRange, rate: number): MixLoudness | null {
  return measurer.measured(project, range, rate);
}
/** 0..1 while it runs */
export function measuringFor(project: Project, range: TimeRange, rate: number): number | null {
  return measurer.measuring(project, range, rate);
}
/** start, progress (10 a second at most), end */
export function onMeasureChange(fn: () => void): () => void {
  return measurer.onChange(fn);
}

let pending: { key: string; ctl: AbortController } | null = null;

/** mixer and dialog: start a measure that outlives them. the same sound again while it runs does nothing */
export function measureNow(project: Project, range: TimeRange, rate: number): void {
  const key = soundSignature(project, range, rate);
  if (pending && pending.key === key) return;
  pending?.ctl.abort();
  const mine = { key, ctl: new AbortController() };
  pending = mine;
  measureMix(project, range, rate, { signal: mine.ctl.signal })
    .catch(() => {})
    .then(() => {
      if (pending === mine) pending = null;
    });
}
export function cancelMeasureNow(): void {
  pending?.ctl.abort();
  pending = null;
}
/** the search row: the open project, mixerRange, measureRate() */
export function measureMixNow(): void {
  const project = useEditor.getState().project;
  if (!project) return;
  const range = mixerRange(project);
  if (range) measureNow(project, range, measureRate());
}
/** dev */
export function measureOpen(start?: number, end?: number, rate?: number): Promise<MixLoudness> {
  const project = useEditor.getState().project;
  if (!project) return Promise.reject(new Error('no project is open'));
  const range = start !== undefined && end !== undefined ? clampRange({ start, end }, projectDuration(project)) : mixerRange(project);
  if (!range) return Promise.reject(new Error('nothing to measure'));
  return measureMix(project, range, rate ?? measureRate());
}
