/**
 * things derived from media files, computed lazily and cached in memory per asset id:
 * poster thumbnails, filmstrips for timeline clips, audio waveforms.
 *
 * all heavy work goes through one small priority queue (see derivedQueue.ts), so only one job runs at a time, and each job
 * yields to the main thread regularly so drags and playback stay smooth.
 */
import { ALL_FORMATS, AudioSampleSink, BlobSource, CanvasSink, EncodedPacketSink, Input, VideoSampleSink } from 'mediabunny';
import type { InputVideoTrack } from 'mediabunny';
import type { MediaAsset } from '../types';
import { useEditor } from '../store/editorStore';
import { getAssetBlob, getAssetUrl } from './registry';
import { seekFrame } from './seekFrame';
import { pickPosterTime, pickSlotTime } from './stripPlan';
import { createShrinker, shrunkSize } from './shrink';
import { dataUrlToBlob } from './dataUrl';
import { createScheduler } from './derivedQueue';
import { thumbCacheKey, waveCacheKey } from './derivedCachePlan';
import { getCachedBlob, getCachedPeaks, putCachedBlob, putCachedPeaks } from './derivedStore';
import type { JobKind } from './derivedQueue';

export interface WaveformData {
  /** how many peaks describe one second of audio */
  peaksPerSecond: number;
  /** absolute peak amplitude per bucket, 0..1 */
  peaks: Float32Array;
}

const THUMB_WIDTH = 320;
const THUMB_QUALITY = 0.8;
const PEAKS_PER_SECOND = 50;
const MAX_FILMSTRIP_FRAMES = 160;
const SEEK_TIMEOUT_MS = 6000;
const SLICE_MS = 10;
const WAVEFORM_FALLBACK_MAX_BYTES = 200 * 1024 * 1024;

/* ---------- job queue ---------- */

// one job at a time (decoders are heavy). thumbnails go before filmstrips before waveforms, newest request first.
// same-asset de-duplication is done by the caches below (they are cleared together with the cancel tokens).
const scheduler = createScheduler({ concurrency: 1, yieldFn: () => nextTask() });

function enqueue<T>(kind: JobKind, job: () => Promise<T>): Promise<T> {
  return scheduler.submit(kind, job);
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

/** pictures up to this many pixels are encoded on the spot (a poster is 320 wide) */
const ENCODE_NOW_MAX_PIXELS = 640 * 640;

function canvasToBlob(canvas: AnyCanvas, type: string, quality: number): Promise<Blob | null> {
  // toBlob / convertToBlob wait for an idle moment of the page, up to a second (dataUrl.ts). a small picture is
  // encoded right here instead.
  if (typeof document !== 'undefined' && canvas.width * canvas.height <= ENCODE_NOW_MAX_PIXELS) {
    try {
      let el: HTMLCanvasElement;
      if (canvas instanceof HTMLCanvasElement) el = canvas;
      else {
        el = makeCanvas(canvas.width, canvas.height);
        el.getContext('2d')?.drawImage(canvas, 0, 0);
      }
      const blob = dataUrlToBlob(el.toDataURL(type, quality));
      if (blob && blob.type === type) return Promise.resolve(blob);
    } catch {
      /* the slow way below */
    }
  }
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

/** seek and wait for the picture of the new position (not just the 'seeked' event, see seekFrame) */
function seekTo(v: HTMLVideoElement, t: number): Promise<boolean> {
  return seekFrame(v, t, SEEK_TIMEOUT_MS);
}

/* ---------- thumbnails ---------- */

/** svg and other formats createImageBitmap rejects: decode through an <img> */
async function thumbFromImageElement(blob: Blob): Promise<Blob | null> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 320;
    const h = img.naturalHeight || 180;
    const scale = THUMB_WIDTH / w;
    const c = makeCanvas(w * scale, h * scale);
    c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
    return await canvasToBlob(c, 'image/jpeg', THUMB_QUALITY);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

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
      return canvasToBlob(c, 'image/jpeg', THUMB_QUALITY);
    } catch {
      return thumbFromImageElement(blob);
    }
  }
  const c = makeCanvas(bmp.width, bmp.height);
  c.getContext('2d')?.drawImage(bmp, 0, 0);
  bmp.close();
  return canvasToBlob(c, 'image/jpeg', THUMB_QUALITY);
}

/**
 * the frames of a video at these times (in order) as small canvases. `fast`: decoded frames are shrunk by the
 * gpu (shrink.ts), about 3 ms each instead of 50 for 4k. it throws where that cannot work, then the caller asks
 * again without it and gets mediabunny's own canvas drawing. a canvas is only good until the next one comes.
 */
async function* smallFrames(
  track: InputVideoTrack,
  stamps: number[],
  want: { width?: number; height?: number },
  fast: boolean,
): AsyncGenerator<AnyCanvas | null, void, undefined> {
  if (!fast) {
    const sink = new CanvasSink(track, { ...want, poolSize: 2 });
    for await (const wrapped of sink.canvasesAtTimestamps(stamps)) yield wrapped ? wrapped.canvas : null;
    return;
  }
  const rotation = await track.getRotation();
  const size = shrunkSize(await track.getSquarePixelWidth(), await track.getSquarePixelHeight(), rotation, want);
  const shrinker = createShrinker(size.width, size.height, rotation, await track.getFlip());
  if (!shrinker) throw new Error('no gpu shrinker');
  try {
    const sink = new VideoSampleSink(track);
    for await (const sample of sink.samplesAtTimestamps(stamps)) {
      if (!sample) {
        yield null;
        continue;
      }
      let canvas: AnyCanvas | null = null;
      let frame: VideoFrame | null = null;
      try {
        frame = sample.toVideoFrame();
        canvas = shrinker.draw(frame);
      } finally {
        frame?.close();
        sample.close();
      }
      if (!canvas) throw new Error('the gpu shrinker failed');
      yield canvas;
    }
  } finally {
    shrinker.dispose();
  }
}

async function thumbFromVideoMediabunny(blob: Blob, duration: number, fast: boolean): Promise<Blob | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return null;
    const d = duration > 0 ? duration : await input.computeDuration();
    const first = await track.getFirstTimestamp();
    const wanted = Math.max(first, d * 0.1);
    // the key frame before that moment is one decode instead of half a key frame distance of them (stripPlan.ts)
    let at = wanted;
    try {
      const key = await new EncodedPacketSink(track).getKeyPacket(wanted, { metadataOnly: true });
      at = pickPosterTime(wanted, first, key ? key.timestamp : null);
    } catch {
      at = wanted;
    }
    for await (const canvas of smallFrames(track, [at], { width: THUMB_WIDTH }, fast)) {
      if (!canvas) return null;
      const out = await canvasToBlob(canvas, 'image/jpeg', THUMB_QUALITY);
      return out;
    }
    return null;
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
    return await canvasToBlob(c, 'image/jpeg', THUMB_QUALITY);
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
  const cacheKey = thumbCacheKey(assetId, THUMB_WIDTH, THUMB_QUALITY);
  const compute = () => enqueue('thumb', async () => {
    if (token.cancelled) return null;
    const blob = getAssetBlob(assetId);
    if (!blob) return null;
    let out: Blob | null = null;
    try {
      if (asset.kind === 'image') out = await thumbFromImage(blob);
      else {
        for (const fast of [true, false]) {
          try {
            out = await thumbFromVideoMediabunny(blob, asset.duration, fast);
          } catch {
            out = null;
          }
          if (out || token.cancelled) break;
        }
        if (!out) out = await thumbFromVideoElement(assetId, asset.duration);
      }
    } catch {
      out = null;
    }
    if (!out) return null;
    if (!token.cancelled) putCachedBlob(cacheKey, out);
    const url = URL.createObjectURL(out);
    if (token.cancelled) {
      URL.revokeObjectURL(url);
      return null;
    }
    thumbUrls.set(assetId, url);
    return url;
  });
  // assets never change after import, so a thumbnail stored by an earlier session is the same picture
  const p = (async (): Promise<string | null> => {
    const hit = await getCachedBlob(cacheKey, asset.createdAt);
    if (!hit) return compute();
    if (token.cancelled) return null;
    const url = URL.createObjectURL(hit);
    thumbUrls.set(assetId, url);
    return url;
  })();
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

/**
 * the time to decode for every slot of a strip: the key frame inside the slot where there is one (one decode
 * instead of a run from the key frame before), else the middle as asked. see stripPlan.ts. the answers only
 * read the file's index. never throws: a file that cannot say where its key frames are keeps the middles.
 */
async function slotTimes(track: InputVideoTrack, stamps: number[], half: number, token: Token): Promise<number[]> {
  const out = stamps.slice();
  if (!(half > 0)) return out;
  try {
    const packets = new EncodedPacketSink(track);
    let sliceStart = now();
    for (let i = 0; i < stamps.length; i++) {
      if (token.cancelled) return out;
      const center = stamps[i]!;
      const before = await packets.getKeyPacket(center, { metadataOnly: true });
      const after = before ? await packets.getNextKeyPacket(before, { metadataOnly: true }) : null;
      const t = pickSlotTime(center, half, before ? before.timestamp : null, after ? after.timestamp : null);
      // times stay in order, whatever the file says
      out[i] = i > 0 && t < out[i - 1]! ? center : t;
      if (now() - sliceStart > SLICE_MS) {
        await nextTask();
        sliceStart = now();
      }
    }
    return out;
  } catch {
    return stamps.slice();
  }
}

async function filmstripMediabunny(
  blob: Blob,
  times: number[],
  half: number,
  pixelHeight: number,
  token: Token,
  fast: boolean,
): Promise<Filmstrip | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  const frames: ImageBitmap[] = [];
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return null;
    const first = await track.getFirstTimestamp();
    const stamps = await slotTimes(
      track,
      times.map((t) => Math.max(first, t)),
      half,
      token,
    );
    let last: ImageBitmap | null = null;
    let sliceStart = now();
    let i = 0;
    for await (const canvas of smallFrames(track, stamps, { height: pixelHeight }, fast)) {
      if (token.cancelled) {
        for (const f of frames) f.close();
        return null;
      }
      let bmp: ImageBitmap;
      if (canvas) {
        bmp = await createImageBitmap(canvas);
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
      return { times: stamps, frames: [...pad, ...frames] };
    }
    return { times: stamps, frames };
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
      // a seek that fails leaves the picture of the frame before: no strip is better than a wrong one
      if (!(await seekTo(v, t))) {
        for (const f of frames) f.close();
        return null;
      }
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
const SUPERSEDED = Symbol('superseded');
const STRIP_LADDER = [24, 48, 96, MAX_FILMSTRIP_FRAMES];

export function getFilmstrip(
  assetId: string,
  count: number,
  height: number,
): Promise<{ times: number[]; frames: ImageBitmap[] } | null> {
  const asset = getAsset(assetId);
  if (!asset || asset.kind !== 'video' || asset.duration <= 0) return Promise.resolve(null);
  const wanted = Math.max(1, Math.min(MAX_FILMSTRIP_FRAMES, Math.round(count)));
  // coarse ladder: stepping the zoom does not queue one decode pass per step
  const want = STRIP_LADDER.find((n) => n >= wanted) ?? MAX_FILMSTRIP_FRAMES;
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
  fresh.promise = enqueue('film', async (): Promise<Filmstrip | null | typeof SUPERSEDED> => {
    if (token.cancelled) return null;
    // a bigger strip was requested while this one waited: skip the pass
    if (filmstrips.get(assetId) !== fresh) return SUPERSEDED;
    const blob = getAssetBlob(assetId);
    if (!blob) return null;
    let result = await filmstripMediabunny(blob, times, asset.duration / total / 2, pixelHeight, token, true);
    if (!result && !token.cancelled) result = await filmstripMediabunny(blob, times, asset.duration / total / 2, pixelHeight, token, false);
    if (!result && !token.cancelled) {
      const frames = await filmstripElement(assetId, times, pixelHeight, token);
      if (frames) result = { times, frames };
    }
    if (!result) return null;
    if (token.cancelled) {
      for (const f of result.frames) f.close();
      return null;
    }
    fresh.done = result;
    return result;
  }).then((r) => (r === SUPERSEDED ? (filmstrips.get(assetId)?.promise ?? null) : r));
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
  let retry = false;
  const cacheKey = waveCacheKey(assetId, PEAKS_PER_SECOND);
  const compute = () => enqueue('wave', async () => {
    if (token.cancelled) {
      retry = true;
      return null;
    }
    const blob = getAssetBlob(assetId);
    if (!blob) {
      retry = true;
      return null;
    }
    const viaBunny = await waveformMediabunny(blob, token);
    if (viaBunny) {
      if (!token.cancelled) putCachedPeaks(cacheKey, viaBunny.peaks);
      return viaBunny;
    }
    if (token.cancelled) {
      retry = true;
      return null;
    }
    if (blob.size > WAVEFORM_FALLBACK_MAX_BYTES) return null;
    const decoded = await waveformDecode(blob, token);
    if (decoded && !token.cancelled) putCachedPeaks(cacheKey, decoded.peaks);
    return decoded;
  });
  // assets never change after import, so peaks stored by an earlier session are the same numbers
  const p = (async (): Promise<WaveformData | null> => {
    const hit = await getCachedPeaks(cacheKey, asset.createdAt);
    if (!hit) return compute();
    if (token.cancelled) {
      retry = true;
      return null;
    }
    return { peaksPerSecond: PEAKS_PER_SECOND, peaks: hit };
  })();
  waveforms.set(assetId, p);
  // a real failure stays cached (tried once per session), only cancelled / missing-file results may be retried
  void p.then((w) => {
    if (w === null && retry && waveforms.get(assetId) === p) waveforms.delete(assetId);
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

/** drop every cached thing (call when the open project closes or changes) */
export function releaseAllDerived(): void {
  const ids = new Set<string>([...tokens.keys(), ...thumbs.keys(), ...thumbUrls.keys(), ...filmstrips.keys(), ...waveforms.keys()]);
  // timeline canvases may still draw one frame before they unmount, so bitmaps are closed a moment later
  const late: ImageBitmap[] = [];
  for (const id of ids) {
    const done = filmstrips.get(id)?.done;
    if (done) late.push(...done.frames);
    filmstrips.delete(id);
    releaseDerived(id);
  }
  if (late.length > 0) {
    setTimeout(() => {
      for (const f of late) f.close();
    }, 2000);
  }
}
