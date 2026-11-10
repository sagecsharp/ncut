/**
 * things derived from media files, computed lazily and cached in memory per asset id:
 * poster thumbnails, filmstrips for timeline clips, audio waveforms.
 *
 * all heavy work goes through one serial queue, so only one job runs at a time, and each job
 * yields to the main thread regularly so drags and playback stay smooth.
 */
import { ALL_FORMATS, AudioSampleSink, BlobSource, CanvasSink, Input } from 'mediabunny';
import type { MediaAsset } from '../types';
import { useEditor } from '../store/editorStore';
import { getAssetBlob, getAssetUrl } from './registry';

export interface WaveformData {
  /** how many peaks describe one second of audio */
  peaksPerSecond: number;
  /** absolute peak amplitude per bucket, 0..1 */
  peaks: Float32Array;
}

const THUMB_WIDTH = 320;
const PEAKS_PER_SECOND = 50;
const MAX_FILMSTRIP_FRAMES = 160;
const SEEK_TIMEOUT_MS = 6000;
const SLICE_MS = 10;

/* ---------- serial queue ---------- */

let tail: Promise<void> = Promise.resolve();

/** run `job` after every previously queued job finished. failures never poison the queue. */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(() => nextTask()).then(job);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** let the browser handle input / paint before the next piece of heavy work */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (sched?.yield) void sched.yield().then(resolve);
    else setTimeout(resolve, 0);
  });
}

function now(): number {
  return performance.now();
}

function getAsset(assetId: string): MediaAsset | undefined {
  return useEditor.getState().project?.assets.find((a) => a.id === assetId);
}

/* ---------- caches ---------- */

interface Token {
  cancelled: boolean;
}
const tokens = new Map<string, Token>();

function tokenFor(assetId: string): Token {
  let t = tokens.get(assetId);
  if (!t) {
    t = { cancelled: false };
    tokens.set(assetId, t);
  }
  return t;
}

const thumbs = new Map<string, Promise<string | null>>();
const thumbUrls = new Map<string, string>();

interface Filmstrip {
  times: number[];
  frames: ImageBitmap[];
}
interface FilmstripEntry {
  count: number;
  height: number;
  promise: Promise<Filmstrip | null>;
  done: Filmstrip | null;
}
const filmstrips = new Map<string, FilmstripEntry>();

const waveforms = new Map<string, Promise<WaveformData | null>>();

/* ---------- helpers ---------- */

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function canvasToBlob(canvas: AnyCanvas, type: string, quality: number): Promise<Blob | null> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality }).catch(() => null);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** a hidden video element loaded with the asset. resolves once metadata is available. */
async function openVideoElement(assetId: string): Promise<HTMLVideoElement | null> {
  const url = getAssetUrl(assetId);
  if (!url) return null;
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  const ready = new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 15000);
    v.addEventListener(
      'loadeddata',
      () => {
        clearTimeout(t);
        resolve(true);
      },
      { once: true },
    );
    v.addEventListener(
      'error',
      () => {
        clearTimeout(t);
        resolve(false);
      },
      { once: true },
    );
  });
  v.src = url;
  if (!(await ready) || !v.videoWidth) {
    closeVideoElement(v);
    return null;
  }
  return v;
}

function closeVideoElement(v: HTMLVideoElement): void {
  v.removeAttribute('src');
  v.load();
}

function seekTo(v: HTMLVideoElement, t: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, SEEK_TIMEOUT_MS, false);
    function done(ok: boolean) {
      clearTimeout(timer);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('error', onError);
      resolve(ok);
    }
    const onSeeked = () => done(true);
    const onError = () => done(false);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('error', onError);
    v.currentTime = t;
  });
}

/* ---------- thumbnails ---------- */

async function thumbFromImage(blob: Blob): Promise<Blob | null> {
  let bmp: ImageBitmap | null = null;
  try {
    bmp = await createImageBitmap(blob, { resizeWidth: THUMB_WIDTH, resizeQuality: 'medium' });
  } catch {
    try {
      const full = await createImageBitmap(blob);
      const scale = Math.min(1, THUMB_WIDTH / full.width);
      const c = makeCanvas(full.width * scale, full.height * scale);
      c.getContext('2d')?.drawImage(full, 0, 0, c.width, c.height);
      full.close();
      return canvasToBlob(c, 'image/jpeg', 0.8);
    } catch {
      return null;
    }
  }
  const c = makeCanvas(bmp.width, bmp.height);
  c.getContext('2d')?.drawImage(bmp, 0, 0);
  bmp.close();
  return canvasToBlob(c, 'image/jpeg', 0.8);
}

async function thumbFromVideoMediabunny(blob: Blob, duration: number): Promise<Blob | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return null;
    const sink = new CanvasSink(track, { width: THUMB_WIDTH });
    const d = duration > 0 ? duration : await input.computeDuration();
    const first = await track.getFirstTimestamp();
    const wrapped = await sink.getCanvas(Math.max(first, d * 0.1));
    if (!wrapped) return null;
    return canvasToBlob(wrapped.canvas, 'image/jpeg', 0.8);
  } finally {
    input.dispose();
  }
}

async function thumbFromVideoElement(assetId: string, duration: number): Promise<Blob | null> {
  const v = await openVideoElement(assetId);
  if (!v) return null;
  try {
    const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : duration;
    if (!(await seekTo(v, Math.max(0, d * 0.1)))) return null;
    const scale = Math.min(1, THUMB_WIDTH / v.videoWidth);
    const c = makeCanvas(v.videoWidth * scale, v.videoHeight * scale);
    c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
    return await canvasToBlob(c, 'image/jpeg', 0.8);
  } finally {
    closeVideoElement(v);
  }
}

/**
 * small poster image (object url) for an asset: a frame for video, the picture for images.
 * null for audio or when it cannot be produced. cached.
 */
export function getThumbnail(assetId: string): Promise<string | null> {
  const cached = thumbs.get(assetId);
  if (cached) return cached;
  const asset = getAsset(assetId);
  if (!asset || asset.kind === 'audio') return Promise.resolve(null);
  const token = tokenFor(assetId);
  const p = enqueue(async () => {
    if (token.cancelled) return null;
    const blob = getAssetBlob(assetId);
    if (!blob) return null;
    let out: Blob | null = null;
    try {
      if (asset.kind === 'image') out = await thumbFromImage(blob);
      else {
        try {
          out = await thumbFromVideoMediabunny(blob, asset.duration);
        } catch {
          out = null;
        }
        if (!out) out = await thumbFromVideoElement(assetId, asset.duration);
      }
    } catch {
      out = null;
    }
    if (!out) return null;
    const url = URL.createObjectURL(out);
    if (token.cancelled) {
      URL.revokeObjectURL(url);
      return null;
    }
    thumbUrls.set(assetId, url);
    return url;
  });
  thumbs.set(assetId, p);
  // a failed attempt may be retried later
  void p.then((u) => {
    if (u === null && thumbs.get(assetId) === p) thumbs.delete(assetId);
  });
  return p;
}

/* ---------- filmstrip ---------- */

function frameTimes(duration: number, count: number): number[] {
  const times: number[] = [];
  for (let i = 0; i < count; i++) times.push(Math.min(duration, ((i + 0.5) / count) * duration));
  return times;
}

async function filmstripMediabunny(
  blob: Blob,
  times: number[],
  pixelHeight: number,
  token: Token,
): Promise<ImageBitmap[] | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  const frames: ImageBitmap[] = [];
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return null;
    const sink = new CanvasSink(track, { height: pixelHeight, poolSize: 2 });
    const first = await track.getFirstTimestamp();
    const stamps = times.map((t) => Math.max(first, t));
    let last: ImageBitmap | null = null;
    let sliceStart = now();
    let i = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(stamps)) {
      if (token.cancelled) {
        for (const f of frames) f.close();
        return null;
      }
      let bmp: ImageBitmap;
      if (wrapped) {
        bmp = await createImageBitmap(wrapped.canvas);
        last = bmp;
      } else if (last) {
        bmp = await createImageBitmap(last);
      } else {
        i++;
        continue;
      }
      frames.push(bmp);
      i++;
      if (now() - sliceStart > SLICE_MS) {
        await nextTask();
        sliceStart = now();
      }
    }
    if (frames.length !== times.length) {
      // leading frames before the first decodable one: pad with the first available
      const lead = times.length - frames.length;
      if (frames.length === 0) return null;
      const pad: ImageBitmap[] = [];
      for (let k = 0; k < lead; k++) pad.push(await createImageBitmap(frames[0]!));
      return [...pad, ...frames];
    }
    return frames;
  } catch {
    for (const f of frames) f.close();
    return null;
  } finally {
    input.dispose();
  }
}

async function filmstripElement(
  assetId: string,
  times: number[],
  pixelHeight: number,
  token: Token,
): Promise<ImageBitmap[] | null> {
  const v = await openVideoElement(assetId);
  if (!v) return null;
  const frames: ImageBitmap[] = [];
  try {
    const h = pixelHeight;
    const w = Math.max(1, Math.round((v.videoWidth / v.videoHeight) * h));
    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    for (const t of times) {
      if (token.cancelled) {
        for (const f of frames) f.close();
        return null;
      }
      await seekTo(v, t);
      ctx.drawImage(v, 0, 0, w, h);
      frames.push(await createImageBitmap(c));
      await nextTask();
    }
    return frames;
  } catch {
    for (const f of frames) f.close();
    return null;
  } finally {
    closeVideoElement(v);
  }
}

/**
 * frames across a video asset for drawing inside timeline clips.
 * `count` evenly spaced frames, each `height` css px tall. frames[i] is taken at times[i] seconds.
 * null for non-video assets or on failure. cached per asset (largest count wins).
 */
export function getFilmstrip(
  assetId: string,
  count: number,
  height: number,
): Promise<{ times: number[]; frames: ImageBitmap[] } | null> {
  const asset = getAsset(assetId);
  if (!asset || asset.kind !== 'video' || asset.duration <= 0) return Promise.resolve(null);
  const want = Math.max(1, Math.min(MAX_FILMSTRIP_FRAMES, Math.round(count)));
  const hCss = Math.max(8, Math.round(height));
  const entry = filmstrips.get(assetId);
  if (entry && entry.count >= want && entry.height >= hCss) return entry.promise;
  const token = tokenFor(assetId);
  const dpr = Math.min(2, Math.max(1, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1));
  const pixelHeight = Math.round(Math.max(hCss, entry?.height ?? 0) * dpr);
  // ask for a bit more than needed so small zoom changes do not recompute
  const total = Math.min(MAX_FILMSTRIP_FRAMES, Math.max(want, entry?.count ?? 0));
  const times = frameTimes(asset.duration, total);
  const fresh: FilmstripEntry = { count: total, height: Math.max(hCss, entry?.height ?? 0), promise: null as never, done: null };
  fresh.promise = enqueue(async (): Promise<Filmstrip | null> => {
    if (token.cancelled) return null;
    const blob = getAssetBlob(assetId);
    if (!blob) return null;
    let frames = await filmstripMediabunny(blob, times, pixelHeight, token);
    if (!frames && !token.cancelled) frames = await filmstripElement(assetId, times, pixelHeight, token);
    if (!frames) return null;
    if (token.cancelled) {
      for (const f of frames) f.close();
      return null;
    }
    const result = { times, frames };
    fresh.done = result;
    return result;
  });
  filmstrips.set(assetId, fresh);
  void fresh.promise.then((r) => {
    // failed: forget it so a later call can retry. keep the previous good result if there was one.
    if (!r && filmstrips.get(assetId) === fresh) {
      if (entry?.done) filmstrips.set(assetId, entry);
      else filmstrips.delete(assetId);
    }
  });
  // while the bigger strip computes, callers that are happy with the old one get it right away
  return fresh.promise.then((r) => r ?? entry?.done ?? null);
}

/* ---------- waveform ---------- */

async function waveformMediabunny(blob: Blob, token: Token): Promise<WaveformData | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return null;
    const duration = await track.computeDuration();
    if (!(duration > 0)) return null;
    const peaks = new Float32Array(Math.ceil(duration * PEAKS_PER_SECOND) + 1);
    const sink = new AudioSampleSink(track);
    let plane = new Float32Array(0);
    let sliceStart = now();
    for await (const sample of sink.samples()) {
      if (token.cancelled) {
        sample.close();
        return null;
      }
      const frames = sample.numberOfFrames;
      const rate = sample.sampleRate;
      if (plane.length < frames) plane = new Float32Array(frames);
      const perBucket = rate / PEAKS_PER_SECOND;
      for (let ch = 0; ch < sample.numberOfChannels; ch++) {
        sample.copyTo(plane, { planeIndex: ch, format: 'f32-planar', frameCount: frames });
        for (let i = 0; i < frames; i++) {
          const v = plane[i]!;
          const a = v < 0 ? -v : v;
          const b = Math.floor((sample.timestamp * rate + i) / perBucket);
          if (b >= 0 && b < peaks.length && a > peaks[b]!) peaks[b] = a;
        }
      }
      sample.close();
      if (now() - sliceStart > SLICE_MS) {
        await nextTask();
        sliceStart = now();
      }
    }
    for (let i = 0; i < peaks.length; i++) if (peaks[i]! > 1) peaks[i] = 1;
    return { peaksPerSecond: PEAKS_PER_SECOND, peaks };
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}

async function waveformDecode(blob: Blob, token: Token): Promise<WaveformData | null> {
  try {
    const buf = await blob.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const audio = await ctx.decodeAudioData(buf);
    const rate = audio.sampleRate;
    const peaks = new Float32Array(Math.ceil(audio.duration * PEAKS_PER_SECOND) + 1);
    const perBucket = rate / PEAKS_PER_SECOND;
    let sliceStart = now();
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const data = audio.getChannelData(ch);
      for (let start = 0; start < data.length; start += 65536) {
        if (token.cancelled) return null;
        const end = Math.min(data.length, start + 65536);
        for (let i = start; i < end; i++) {
          const v = data[i]!;
          const a = v < 0 ? -v : v;
          const b = Math.floor(i / perBucket);
          if (a > peaks[b]!) peaks[b] = a;
        }
        if (now() - sliceStart > SLICE_MS) {
          await nextTask();
          sliceStart = now();
        }
      }
    }
    for (let i = 0; i < peaks.length; i++) if (peaks[i]! > 1) peaks[i] = 1;
    return { peaksPerSecond: PEAKS_PER_SECOND, peaks };
  } catch {
    return null;
  }
}

/** audio peaks for an audio asset or a video asset with audio. null when there is no audio. cached. */
export function getWaveform(assetId: string): Promise<WaveformData | null> {
  const cached = waveforms.get(assetId);
  if (cached) return cached;
  const asset = getAsset(assetId);
  if (!asset || !asset.hasAudio || asset.kind === 'image') return Promise.resolve(null);
  const token = tokenFor(assetId);
  const p = enqueue(async () => {
    if (token.cancelled) return null;
    const blob = getAssetBlob(assetId);
    if (!blob) return null;
    const viaBunny = await waveformMediabunny(blob, token);
    if (viaBunny || token.cancelled) return viaBunny;
    return waveformDecode(blob, token);
  });
  waveforms.set(assetId, p);
  void p.then((w) => {
    if (w === null && waveforms.get(assetId) === p) waveforms.delete(assetId);
  });
  return p;
}

/** drop cached data for an asset (call when the asset is deleted) */
export function releaseDerived(assetId: string): void {
  const token = tokens.get(assetId);
  if (token) token.cancelled = true;
  tokens.delete(assetId);
  const url = thumbUrls.get(assetId);
  if (url) URL.revokeObjectURL(url);
  thumbUrls.delete(assetId);
  thumbs.delete(assetId);
  const fs = filmstrips.get(assetId);
  if (fs) {
    filmstrips.delete(assetId);
    const done = fs.done;
    if (done) for (const f of done.frames) f.close();
    // a strip still computing closes its own frames when it sees the cancelled token
  }
  waveforms.delete(assetId);
}
