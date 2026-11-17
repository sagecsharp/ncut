/**
 * offline project renderer. no react. webcodecs + mediabunny.
 * frames are drawn with the same renderFrame the preview uses, video clips are decoded sequentially
 * (one sink iterator per clip, sources.ts), audio is mixed offline (audioMix.ts).
 *
 * a video export is rendered in parts: a few web workers each draw and encode a stretch of the timeline
 * (segment.ts, parallel.ts, exportWorker.ts) and this thread joins their packets in order and adds the sound.
 * a gif is made in parts too: after its palette is found on this thread, a few web workers each draw a stretch
 * of the timeline and compress its frames (segment.ts renderGifSegment), and the frames are written here in
 * playing order. where a project cannot be drawn in a worker the gif is drawn on this thread and only the slow
 * part of each frame (palette lookup, dithering, lzw) runs in workers (gifPool.ts). the bytes are the same.
 *
 * the plain way (every frame on this thread, one encoder) is still here: gifs, exports too short to gain,
 * pictures only an <img> can read, and anything that goes wrong in the parts fall back to it.
 */
import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferSource,
  BufferTarget,
  CanvasSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  OggOutputFormat,
  Output,
  QUALITY_MEDIUM,
  Quality,
  WavOutputFormat,
  WebMOutputFormat,
  canEncodeVideo,
  getFirstEncodableAudioCodec,
} from 'mediabunny';
import type { AudioCodec, VideoCodec } from 'mediabunny';
import type { Project } from '../../types';
import { releaseRenderResources, renderFrame } from '../../engine/draw';
import { beginExport, endExport } from '../../engine/exportState';
import type { DrawSource } from '../../engine/draw';
import { ensureProjectFonts } from '../../lib/fonts';
import { collectFontKit } from '../../lib/fontKit';
import { projectDuration } from '../../lib/timelineOps';
import { buildPalette, createGifEncoder, gifDelayCs, indexFrame } from '../../lib/gif';
import { gifExportFps, gifSizeWarning, paletteSampleFrames, sampleSize } from './gifPlan';
import { GifPoolError, createGifPool, gifPartWorkers, gifWorkerCount, planGifParts } from './gifPool';
import { type TimeRange, clampRange, rangeFrameCount } from './range';
import { createFrameSources } from './sources';
import { isStillContainer, jpegQuality, renderStill, stillMime, stillSize } from './still';
import { TEXT, autoAudioBitrate, deliverySize, resolveDelivery } from './delivery';
import type { ExportDelivery, ResolvedDelivery } from './delivery';
import { alphaNotes } from './alphaNotes';
import { createFrameDrawer, placeFrame } from './frameFit';
import type { FrameDrawer } from './frameFit';
import type { StillContainer } from './still';
import { KEYFRAME_SECONDS, unpackGifFrames } from './segment';
import { pickWorkers, planSegments, sameDecoderConfig, startSegments } from './parallel';
import { checkPartsMedia } from './mediaCheck';
import { avcCodecStringOf, avcLengthSize, avcLevel, pickEncoderSetup, raiseAvcLevel, raiseAvcLevelInPacket } from './encoderSetup';
import type { EncoderSetup } from './encoderSetup';
import { DISK_MIN_BYTES, expectedExportBytes, openExportSink } from './sink';
import type { ExportSink } from './sink';
import type { PartsMedia } from './mediaCheck';
import type { SegmentPool } from './parallel';
import { getAssetBlob, getAssetUrl } from '../../media/registry';
import { MIX_CHANNELS, createAudioMixer } from './audioMix';
import type { AudioMixer } from './audioMix';
import { createAudioPump } from './audioPump';
import type { AudioPump } from './audioPump';
import { decideOutput } from './outputPlan';
import type { OutputPlanned } from './outputPlan';
import { wantsLoudness } from './loudnessTypes';
import type { ExportLoudness, LoudnessReport } from './loudnessTypes';

export type VideoContainer = 'mp4' | 'webm';
/** wav / ogg are audio only files (no picture) */
export type AudioContainer = 'wav' | 'ogg';
/** gif is a picture only file (no audio), made by lib/gif.ts instead of webcodecs */
export type ImageContainer = 'gif';
/** png / jpg are one picture (still.ts): the first frame of the range */
export type ExportContainer = VideoContainer | AudioContainer | ImageContainer | StillContainer;

export function isAudioContainer(c: ExportContainer): c is AudioContainer {
  return c === 'wav' || c === 'ogg';
}
export function isGifContainer(c: ExportContainer): c is ImageContainer {
  return c === 'gif';
}
export type ExportQuality = 'low' | 'medium' | 'high';

export interface ExportOptions {
  container: ExportContainer;
  /** 1, 0.75 or 0.5 of the project size */
  scale: number;
  fps: number;
  quality: ExportQuality;
  includeAudio: boolean;
  /** the part of the timeline to render (absolute seconds). missing = the whole project. the file starts at 0. */
  range?: TimeRange;
  /**
   * how many parts of a video export are rendered and encoded at once. missing = decided from the size, the length
   * and the machine (parallel.ts pickWorkers). 1 = every frame on this thread with one encoder.
   */
  workers?: number;
  /** tests: render the parts on this thread instead of in web workers */
  partsOnMain?: boolean;
  /** benchmarks: run-in frames of a part (missing = parallel.ts WARMUP_FRAMES) */
  warmup?: number;
  /** benchmarks: which kind of encoder the parts ask for (missing = the browser decides) */
  acceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  /**
   * false = never arrange the encoders for the gpu (encoderSetup.ts), true = also with workers: 1. missing = arranged
   * whenever it gets the gpu encoder where the plain setup would not, unless workers is 1.
   */
  gpuEncoder?: boolean;
  /** tests: video exports expected to be at least this many bytes are written to disk while they are made (missing = sink.ts DISK_MIN_BYTES) */
  diskBytes?: number;
  /** loudness target and peak limit (loudnessTypes.ts). missing or both null = the sound as it is */
  loudness?: ExportLoudness;
  /** the advanced choices (delivery.ts). missing = DEFAULT_DELIVERY = what an export always did */
  delivery?: ExportDelivery;
}

export interface ExportProgress {
  phase: 'loudness' | 'audio' | 'palette' | 'video' | 'finalizing';
  /** 0..1 over the whole export */
  progress: number;
  frame: number;
  totalFrames: number;
}

/**
 * where the time of an export went, in milliseconds. on one thread the stages do not overlap; with workers the
 * decode / render / encode numbers are summed over the workers (thread time, more than the wall clock).
 */
export interface ExportStats {
  frames: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  /** true = a see-through export. missing = not */
  alpha?: boolean;
  /** the key frame interval asked for, in seconds. missing = the usual one */
  keySeconds?: number;
  /** parts rendered at once (1 = the plain way on this thread) */
  workers: number;
  /** the frame rate the encoders were told to get the gpu encoder (encoderSetup.ts). missing = the real one. */
  encoderFps?: number;
  /** true = the file was written to disk while it was made (sink.ts) */
  onDisk?: boolean;
  /** fonts, opening the sources, starting the output */
  setupMs: number;
  /** waiting for the next decoded frame of the video clips */
  decodeMs: number;
  /** renderFrame (the drawing commands; the gpu may finish them later, inside the encode stage) */
  renderMs: number;
  /** handing the frame to the encoder, including waiting for it to keep up */
  encodeMs: number;
  /** mixing and encoding sound */
  audioMs: number;
  /** joining the parts into the file (0 on one thread) */
  muxMs: number;
  /** with workers: how long each took to start, and the times of every part */
  workerStartMs?: number[];
  parts?: Array<{ from: number; to: number; wallMs: number; firstFrameMs: number; openMs: number; encodeMs: number }>;
  /** flushing the encoders and writing the file */
  finalizeMs: number;
  totalMs: number;
}

export interface ExportHooks {
  onProgress?: (p: ExportProgress) => void;
  onWarning?: (message: string) => void;
  signal?: AbortSignal;
  /** once, when a video export ends well */
  onStats?: (stats: ExportStats) => void;
  /**
   * after a frame is drawn and before it is encoded (benchmarks and tests read pixels here). without captureFrames
   * it is called for every frame, which keeps the export on this thread.
   */
  onFrame?: (index: number, picture: OffscreenCanvas | ImageBitmap) => void;
  /** the only frames onFrame wants (a worker then sends a copy of just those) */
  captureFrames?: readonly number[];
  /**
   * rendering in parts failed and the export started over in a simpler way. progress starts again, and frames
   * onFrame saw before this are not the ones in the file (they come again).
   */
  onFallback?: (reason: string) => void;
  /** once, when an export with sound and a loudness choice ends well: what came out */
  onLoudness?: (report: LoudnessReport) => void;
}

/** tried in this order, the first one the browser can encode at the chosen size + fps + bitrate wins */
export const VIDEO_CODECS: Record<VideoContainer, VideoCodec[]> = {
  mp4: ['avc', 'hevc', 'av1', 'vp9'],
  webm: ['vp9', 'av1', 'vp8'],
};
const AUDIO_CODECS: Record<ExportContainer, AudioCodec[]> = {
  mp4: ['aac', 'opus'],
  webm: ['opus'],
  wav: ['pcm-s16'],
  ogg: ['opus', 'vorbis'],
  gif: [],
  png: [],
  jpg: [],
};

export const CODEC_LABEL: Record<string, string> = {
  avc: 'h.264',
  hevc: 'h.265',
  av1: 'av1',
  vp9: 'vp9',
  vp8: 'vp8',
};

/** bits per pixel per frame at 30 fps */
const BITS_PER_PIXEL: Record<ExportQuality, number> = { low: 0.04, medium: 0.08, high: 0.16 };
/** how much smaller a codec gets for the same look (vs h.264) */
const CODEC_EFFICIENCY: Record<string, number> = { avc: 1, hevc: 0.75, vp9: 0.8, av1: 0.65, vp8: 1.2 };
const MIN_BITRATE = 500_000;
const MAX_BITRATE = 240_000_000;
/** progress callbacks are at most this often */
const PROGRESS_MS = 100;

/**
 * target video bitrate in bits per second. the quality table is per pixel at 30 fps and grows
 * sub-linearly with the frame rate (x (fps / 30) ^ 0.7), so 240 fps is not starved and not 8x the size.
 */
export function videoBitrate(width: number, height: number, fps: number, quality: ExportQuality, codec: string): number {
  const base = width * height * 30 * BITS_PER_PIXEL[quality] * (CODEC_EFFICIENCY[codec] ?? 1);
  const scaled = base * Math.pow(Math.max(1, fps) / 30, 0.7);
  return Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, scaled)));
}

export interface ExportPlan {
  codec: VideoCodec;
  bitrate: number;
}

export interface PlanRequest {
  container: VideoContainer;
  width: number;
  height: number;
  fps: number;
  quality: ExportQuality;
  /** only this codec is asked (a delivery choice). missing = the container's list in order */
  codec?: VideoCodec;
  /** whole bits per second instead of the one the quality gives. missing = the quality's */
  bitrate?: number;
}

/** what canEncodeVideo is: tests and the probe hand in their own */
export type CanEncodeVideo = (codec: VideoCodec, options: NonNullable<Parameters<typeof canEncodeVideo>[1]>) => Promise<boolean>;

/** first codec of the container the browser says it can encode for this exact size, fps and bitrate. null = none. */
export async function planExport(req: PlanRequest, signal?: AbortSignal, can: CanEncodeVideo = canEncodeVideo): Promise<ExportPlan | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  const codecs = req.codec === undefined ? VIDEO_CODECS[req.container] : VIDEO_CODECS[req.container].includes(req.codec) ? [req.codec] : [];
  for (const codec of codecs) {
    if (signal?.aborted) throw abortError();
    const bitrate = req.bitrate ?? videoBitrate(req.width, req.height, req.fps, req.quality, codec);
    try {
      const ok = await can(codec, {
        width: req.width,
        height: req.height,
        frameRate: req.fps,
        quality: new Quality({ bitrate }),
      });
      if (ok) return { codec, bitrate };
    } catch {
      // a codec that throws while probing is treated as unsupported, the next one is tried
    }
  }
  return null;
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

export function outputSize(project: Pick<Project, 'width' | 'height'>, scale: number): { width: number; height: number } {
  return { width: even(project.width * scale), height: even(project.height * scale) };
}

export function frameCount(project: Pick<Project, 'clips'>, fps: number, range?: TimeRange): number {
  const r = clampRange(range, projectDuration(project));
  // float error in duration * fps stays far below 1e-6 even for hours at 240 fps
  return r ? rangeFrameCount(r, fps) : 1;
}

export function fileExtension(container: ExportContainer): string {
  return container;
}

function abortError(): DOMException {
  return new DOMException('export cancelled', 'AbortError');
}

let lastYield = 0;
const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;

/** callers waiting for the next turn (several loops can wait at once: parts rendered on this thread) */
const waiting: Array<() => void> = [];
if (channel) {
  channel.port1.onmessage = () => {
    for (const resolve of waiting.splice(0)) resolve();
  };
}

/** give the event loop (rendering, input, fps counter) a turn */
function yieldToUi(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (channel) {
      waiting.push(resolve);
      if (waiting.length === 1) channel.port2.postMessage(0);
    } else {
      setTimeout(resolve, 0);
    }
  }).then(() => {
    lastYield = performance.now();
  });
}

/**
 * the sound codec and quality of a file: the delivery's choice, else the first codec of the format this browser can
 * encode at the mix rate. a codec or bitrate that was asked for and finds nothing falls back to the usual one (the
 * format's list at the medium quality, the same rate) and says so. null = no encoder at all.
 */
async function pickAudio(
  container: ExportContainer,
  d: ResolvedDelivery,
  rate: number,
  onWarning?: (message: string) => void,
): Promise<{ codec: AudioCodec; quality: Quality } | null> {
  const list = AUDIO_CODECS[container];
  const set = d.audioCodec !== 'auto' || d.audioBitrate !== null;
  const asked: AudioCodec[] = d.audioCodec === 'auto' ? list : [d.audioCodec];
  const quality = d.audioBitrate ? new Quality({ bitrate: d.audioBitrate }) : QUALITY_MEDIUM;
  const first = await getFirstEncodableAudioCodec(asked, { numberOfChannels: MIX_CHANNELS, sampleRate: rate, quality });
  if (first) return { codec: first, quality };
  if (!set) return null;
  const usual = await getFirstEncodableAudioCodec(list, { numberOfChannels: MIX_CHANNELS, sampleRate: rate, quality: QUALITY_MEDIUM });
  if (!usual) return null;
  const name = asked[0] ?? usual;
  const kbps = (d.audioBitrate ?? autoAudioBitrate(name === 'aac' || name === 'opus' || name === 'vorbis' ? name : 'aac')) / 1000;
  onWarning?.(TEXT.audioFallback(name, kbps, rate / 1000, usual));
  return { codec: usual, quality: QUALITY_MEDIUM };
}

/** true when the finished file really holds alpha data (the header flag alone is written for every see-through export, a browser can drop the alpha without saying so) */
export async function checkAlphaFile(blob: Blob): Promise<boolean> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canBeTransparent())) return false;
    const first = await new EncodedPacketSink(track).getFirstPacket();
    return !!first?.sideData.alpha;
  } finally {
    input.dispose();
  }
}

export { clipEdgeTimestamp, clipTimestamps } from './sources';

export async function exportProject(project: Project, options: ExportOptions, hooks: ExportHooks = {}): Promise<Blob> {
  // while this runs the renderer does not use wall clock retry pauses (see engine/exportState.ts)
  beginExport();
  try {
    return await runExport(project, options, hooks);
  } finally {
    endExport();
  }
}

/** svg and friends: createImageBitmap rejects them, an <img> can draw them (same as the preview) */
async function loadImageElement(assetId: string): Promise<DrawSource | null> {
  const url = getAssetUrl(assetId);
  if (!url) return null;
  const img = new Image();
  img.src = url;
  await img.decode();
  return { image: img, width: img.naturalWidth || 1, height: img.naturalHeight || 1 };
}

/** a picture only an <img> can read keeps the export on this thread (a worker has no <img>) */
function needsMainThread(project: Project): boolean {
  for (const clip of project.clips) {
    if (clip.type !== 'image') continue;
    const asset = project.assets.find((a) => a.id === clip.assetId);
    if (asset && (/svg/i.test(asset.mime) || /\.svg$/i.test(asset.name))) return true;
  }
  return false;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

async function runExport(project: Project, options: ExportOptions, hooks: ExportHooks): Promise<Blob> {
  const { onProgress, signal } = hooks;
  // both ways of rendering can run for one export (a failed parallel run is redone on this thread): say things once
  const warned = new Set<string>();
  const onWarning = (message: string) => {
    if (warned.has(message)) return;
    warned.add(message);
    hooks.onWarning?.(message);
  };
  const startedAt = performance.now();
  const stats: ExportStats = {
    frames: 0,
    width: 0,
    height: 0,
    fps: 0,
    codec: '',
    workers: 1,
    setupMs: 0,
    decodeMs: 0,
    renderMs: 0,
    encodeMs: 0,
    audioMs: 0,
    muxMs: 0,
    finalizeMs: 0,
    totalMs: 0,
  };
  const projectLength = projectDuration(project);
  if (projectLength <= 0) throw new Error('the project is empty');
  const range = clampRange(options.range, projectLength);
  if (!range) throw new Error('the range is empty, pick a start before the end');
  if (signal?.aborted) throw abortError();
  // what the advanced choices mean for this format: what a format cannot hold is said once, here
  const d = resolveDelivery(options.container, options.delivery);
  for (const note of d.notes) onWarning(note);
  if (isAudioContainer(options.container)) return exportAudioOnly(project, options.container, range, hooks, d, options.loudness);
  if (isStillContainer(options.container)) {
    // one picture: the frame a video of this range starts with. no encoder, no sound, no frame rate
    const size = deliverySize(stillSize(project, options.scale), options.container, d);
    const stillPlace = d.size ? placeFrame(project.width, project.height, size.width, size.height, d.size.fit) : null;
    if (d.transparent) for (const n of alphaNotes(project, { start: range.start, end: range.start + 1 / project.fps })) onWarning(n.text);
    onProgress?.({ phase: 'video', progress: 0, frame: 0, totalFrames: 1 });
    const blob = await renderStill(
      project,
      {
        time: range.start,
        width: size.width,
        height: size.height,
        mime: stillMime(options.container),
        quality: jpegQuality(options.quality),
        ...(d.transparent ? { transparent: true } : {}),
        ...(stillPlace && !stillPlace.direct ? { place: stillPlace } : {}),
      },
      { onWarning, signal },
    );
    onProgress?.({ phase: 'finalizing', progress: 1, frame: 1, totalFrames: 1 });
    return blob;
  }
  const isGif = options.container === 'gif';
  if (!isGif && typeof VideoEncoder === 'undefined') {
    throw new Error('this browser has no webcodecs support, try a recent chrome or edge');
  }
  // the file is the range only: its time 0 is the range start. `duration` is its length.
  const rangeStart = range.start;
  const duration = range.end - range.start;

  const wantedFps = options.fps > 0 ? options.fps : project.fps;
  // a gif cannot go faster than 50 fps (delays are whole 1/100 s, below 2 browsers play it slow)
  const fps = isGif ? gifExportFps(wantedFps) : wantedFps;
  const { width, height } = deliverySize(outputSize(project, options.scale), options.container, d);
  const totalFrames = rangeFrameCount(range, fps);
  const container = options.container;
  // a custom size of another shape: drawn at the project's shape and placed (frameFit.ts). the project's shape is drawn as always
  const framePlace = d.size ? placeFrame(project.width, project.height, width, height, d.size.fit) : null;
  const place = framePlace && !framePlace.direct ? framePlace : null;
  const keySeconds = d.keySeconds ?? KEYFRAME_SECONDS;
  if (d.transparent) for (const n of alphaNotes(project, range)) onWarning(n.text);

  let videoCodec: VideoCodec = 'avc';
  let videoBitrate = 0;
  let videoQuality = QUALITY_MEDIUM;
  if (container !== 'gif') {
    const plan = await planExport(
      { container, width, height, fps, quality: options.quality, ...(d.codec !== 'auto' ? { codec: d.codec } : {}), ...(d.bitrate !== null ? { bitrate: d.bitrate } : {}) },
      signal,
    );
    if (!plan) {
      throw new Error(
        d.codec !== 'auto' || d.bitrate !== null
          ? TEXT.noPlan(CODEC_LABEL[d.codec] ?? container, width, height, fps, d.bitrate)
          : `this browser cannot encode ${container} at ${width}x${height} and ${fps} fps, try a lower frame rate, a smaller resolution or the other format`,
      );
    }
    videoCodec = plan.codec;
    videoBitrate = plan.bitrate;
    videoQuality = new Quality({ bitrate: plan.bitrate });
  } else {
    if (wantedFps > fps) onWarning(`gif plays at most ${fps} fps, exported at ${fps} fps`);
    const big = gifSizeWarning(width, height, totalFrames);
    if (big) onWarning(big);
  }

  let lastReport = 0;
  const report = (phase: ExportProgress['phase'], progress: number, frame: number, force = true) => {
    const now = performance.now();
    if (!force && now - lastReport < PROGRESS_MS) return;
    lastReport = now;
    onProgress?.({ phase, progress: Math.min(1, Math.max(0, progress)), frame, totalFrames });
  };

  // text must be drawn in its real font from the first frame (never rejects)
  const missingFonts = await ensureProjectFonts(project);
  for (const family of missingFonts) {
    onWarning(`font "${family}" could not be loaded, its text is drawn in a fallback font`);
  }
  if (signal?.aborted) throw abortError();

  /** the sound of the range, or null (no sound wanted, none there, or no encoder for it). mixed in chunks while the video renders. */
  let plan: Promise<OutputPlanned | null> | null = null;
  const openAudio = async (): Promise<{ mixer: AudioMixer; codec: AudioCodec; quality: Quality; planned: OutputPlanned | null } | null> => {
    if (!options.includeAudio || isGif) return null;
    report('audio', 0, 0);
    await yieldToUi();
    const m = createAudioMixer(project, duration, signal, onWarning, rangeStart, d.sampleRate);
    let picked: { codec: AudioCodec; quality: Quality } | null = null;
    if (m.hasAudio) {
      picked = await pickAudio(container, d, m.sampleRate, onWarning);
      if (!picked) onWarning('this browser cannot encode audio for this format, exported without sound');
    }
    let planned: OutputPlanned | null = null;
    if (picked && wantsLoudness(options.loudness)) {
      // measured once for the export: the parts and the plain way after them share it
      try {
        planned = await (plan ??= decideOutput(project, { start: rangeStart, end: rangeStart + duration }, m.sampleRate, options.loudness, { signal, onProgress: (f) => report('loudness', 0.05 * f, 0, false) }));
      } catch (err) {
        m.dispose();
        throw err;
      }
    }
    report('audio', 0.05, 0);
    if (!picked) {
      m.dispose();
      return null;
    }
    return { mixer: m, codec: picked.codec, quality: picked.quality, planned };
  };

  const finish = (workers: number) => {
    stats.frames = totalFrames;
    stats.width = width;
    stats.height = height;
    stats.fps = fps;
    stats.codec = videoCodec;
    if (d.transparent) stats.alpha = true;
    if (d.keySeconds !== null) stats.keySeconds = d.keySeconds;
    stats.workers = workers;
    stats.totalMs = performance.now() - startedAt;
    hooks.onStats?.(stats);
  };

  /** a see-through webm is read back: a browser can drop the alpha without saying so */
  const alphaCheck = async (blob: Blob): Promise<void> => {
    if (!d.transparent || container !== 'webm') return;
    const kept = await checkAlphaFile(blob).catch(() => false);
    if (!kept) onWarning(TEXT.alphaLost);
  };

  /** what the loudness choice did to the file: its warnings, then the report (once, when the file is made) */
  const tellLoudness = (plan: OutputPlanned | null, pump: AudioPump | null) => {
    if (!plan) return;
    const made = plan.reportFor(pump?.stageReport() ?? null);
    for (const w of made.warnings) onWarning(w);
    hooks.onLoudness?.(made.report);
  };

  const captureSet = hooks.captureFrames ? new Set(hooks.captureFrames) : null;

  /**
   * the file being written: in memory, or on disk when it will be big (sink.ts). an mp4 on disk keeps its index at
   * the front like the ones built in memory: the room for it is set aside up front, which needs the packet counts.
   */
  const openOutput = async (withAudio: boolean) => {
    const expected = expectedExportBytes(videoBitrate * (d.transparent ? 2 : 1), withAudio ? Math.max(192_000, d.audioBitrate ?? 0) : 0, duration);
    const sink = await openExportSink(expected, container, options.diskBytes ?? DISK_MIN_BYTES);
    const reserve = sink.onDisk && container === 'mp4';
    const format = container === 'mp4' ? new Mp4OutputFormat({ fastStart: reserve ? 'reserve' : 'in-memory' }) : new WebMOutputFormat();
    return {
      sink,
      format,
      output: new Output({ format, target: sink.target }),
      // exact for the picture, generous for the sound (one packet is 20 ms or more in every codec used here)
      videoMeta: { frameRate: fps, ...(reserve ? { maximumPacketCount: totalFrames + 2 } : {}), ...(d.transparent ? { canBeTransparent: true } : {}) },
      audioMeta: reserve ? { maximumPacketCount: Math.ceil(duration * 100 * 1.34) + 200 } : {},
    };
  };

  // looked at once, and only when an export is about to be split for workers
  let mediaCheck: Promise<PartsMedia> | null = null;
  const partsMedia = () => (mediaCheck ??= checkPartsMedia(project, getAssetBlob));

  // ---- the fast way: parts of the timeline rendered and encoded at once, joined here in order ----
  const runParts = async (workers: number, onMain: boolean, lenient: readonly string[], setup: EncoderSetup | null): Promise<Blob> => {
    const segments = planSegments(totalFrames, fps, workers, keySeconds);
    // the bar moves with the frames the workers finish and, for the last tenth, with the frames in the file
    let rendered = 0;
    let joined = 0;
    const tell = () => report('video', 0.05 + 0.9 * ((rendered * 0.9 + joined * 0.1) / totalFrames), rendered, false);
    const audio = await openAudio();
    let pool: SegmentPool | null = null;
    let output: Output | null = null;
    let sink: ExportSink | null = null;
    let finished = false;
    try {
      if (signal?.aborted) throw abortError();
      const opened = await openOutput(!!audio);
      sink = opened.sink;
      const format = opened.format;
      output = opened.output;
      const videoSource = new EncodedVideoPacketSource(videoCodec);
      output.addVideoTrack(videoSource, opened.videoMeta);
      let pump: AudioPump | null = null;
      if (audio) {
        const audioSource = new AudioBufferSource({ codec: audio.codec, quality: audio.quality });
        output.addAudioTrack(audioSource, opened.audioMeta);
        pump = createAudioPump(audio.mixer, audioSource, audio.planned?.makeStage() ?? null);
      }
      await output.start();
      const feedAudio = async (untilSeconds: number) => {
        if (!pump) return;
        const t0 = performance.now();
        await pump.to(untilSeconds);
        stats.audioMs += performance.now() - t0;
      };
      // the fonts the text needs, for the workers (this thread already has them)
      const fontKit = onMain ? null : await collectFontKit(project);
      if (signal?.aborted) throw abortError();
      lastYield = performance.now();
      pool = startSegments({
        project,
        base: {
          container: container as VideoContainer,
          codec: videoCodec,
          bitrate: videoBitrate,
          width,
          height,
          fps,
          rangeStart,
          totalFrames,
          ...(d.keySeconds !== null ? { keySeconds } : {}),
          ...(d.transparent ? { alpha: true } : {}),
          ...(place ? { place } : {}),
          ...(options.acceleration ? { acceleration: options.acceleration } : {}),
          ...(lenient.length > 0 ? { lenient: [...lenient] } : {}),
          ...(setup ? { encoder: setup } : {}),
        },
        segments,
        workers,
        warmup: options.warmup,
        onMain,
        blobOf: getAssetBlob,
        fontKit,
        missingFonts,
        loadImageElement,
        breathe: () => (performance.now() - lastYield > 14 ? yieldToUi() : undefined),
        capture: hooks.onFrame && captureSet ? [...captureSet] : undefined,
        onCapture: (frame, picture) => hooks.onFrame?.(frame, picture),
        onWarning,
        onFrames: (done) => {
          rendered = done;
          tell();
        },
        signal,
      });
      stats.setupMs = performance.now() - startedAt;

      const frameDur = 1 / fps;
      let config: VideoDecoderConfig | null = null;
      // what the file's track is opened with: the first part's setup, with the true h264 level where the encoders
      // were told a lower frame rate and wrote that rate's level (encoderSetup.ts)
      let trackConfig: VideoDecoderConfig | null = null;
      let levelFix: { level: number; lengthSize: number } | null = null;
      for (let s = 0; s < segments.length; s++) {
        const part = await pool.result(s);
        if (signal?.aborted) throw abortError();
        const m0 = performance.now();
        const audioBefore = stats.audioMs;
        const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(part.buffer) });
        try {
          const track = await input.getPrimaryVideoTrack();
          const cfg = track ? await track.getDecoderConfig() : null;
          if (!track || !cfg) throw new Error('a rendered part cannot be read back');
          // one track has one decoder setup: every encoder must have produced the same one
          if (!config) {
            config = cfg;
            trackConfig = cfg;
            const desc = cfg.description;
            if (setup && videoCodec === 'avc' && desc) {
              const bytes = ArrayBuffer.isView(desc) ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength) : new Uint8Array(desc);
              const level = avcLevel(width, height, fps, videoBitrate);
              const raised = raiseAvcLevel(bytes, level);
              if (raised) {
                trackConfig = { ...cfg, description: raised, codec: avcCodecStringOf(raised) };
                levelFix = { level, lengthSize: avcLengthSize(bytes) };
              }
            }
          } else if (!sameDecoderConfig(config, cfg)) throw new Error('the parts were encoded with different settings');
          const sink = new EncodedPacketSink(track);
          let count = 0;
          for await (const packet of sink.packets()) {
            // the frame index, not a sum of durations: the file gets exactly the times one encoder would have written
            const i = part.first + Math.round(packet.timestamp * part.rate);
            // the run-in frames of the part (see segment.ts warmup) stay behind
            if (i < part.from) continue;
            if (i >= part.to) throw new Error('a rendered part holds a frame outside its range');
            if (count === 0 && (i !== part.from || packet.type !== 'key')) throw new Error('a rendered part does not start with a key frame');
            const data = levelFix && packet.type === 'key' ? raiseAvcLevelInPacket(packet.data, levelFix.lengthSize, levelFix.level) : packet.data;
            await videoSource.add(
              packet.clone({ timestamp: i / fps, duration: frameDur, ...(data !== packet.data ? { data } : {}) }),
              joined === 0 ? { decoderConfig: trackConfig ?? config } : undefined,
            );
            joined++;
            count++;
            await feedAudio(i / fps + 1.5);
            // a part is thousands of packets: cancel and the ui get their turn inside it too
            if (signal?.aborted) throw abortError();
            tell();
            if (performance.now() - lastYield > 14) await yieldToUi();
          }
          if (count !== part.to - part.from) throw new Error('a rendered part lost frames');
        } finally {
          input.dispose();
        }
        // its bytes are in the file now: let them go, and let the workers start a part further ahead
        pool.release(s);
        stats.muxMs += performance.now() - m0 - (stats.audioMs - audioBefore);
        stats.decodeMs += part.stats.decodeMs;
        stats.renderMs += part.stats.renderMs;
        stats.encodeMs += part.stats.encodeMs;
        (stats.parts ??= []).push({
          from: part.from,
          to: part.to,
          wallMs: Math.round(part.stats.wallMs),
          firstFrameMs: Math.round(part.stats.firstFrameMs),
          openMs: Math.round(part.stats.openMs),
          encodeMs: Math.round(part.stats.encodeMs),
        });
        if (performance.now() - lastYield > 14) await yieldToUi();
      }
      await feedAudio(duration + 1);

      if (signal?.aborted) throw abortError();
      report('finalizing', 0.96, totalFrames);
      await yieldToUi();
      const finalizeAt = performance.now();
      await output.finalize();
      finished = true;
      stats.finalizeMs = performance.now() - finalizeAt;
      stats.workerStartMs = pool.startTimes();
      if (setup) stats.encoderFps = setup.fps;
      if (signal?.aborted) throw abortError();
      const blob = await sink.finish(format.mimeType);
      sink = null;
      if (opened.sink.onDisk) stats.onDisk = true;
      await alphaCheck(blob);
      tellLoudness(audio?.planned ?? null, pump);
      finish(Math.min(workers, segments.length));
      report('finalizing', 1, totalFrames);
      return blob;
    } catch (err) {
      if (output && !finished) {
        try {
          await output.cancel();
        } catch {
          // ignore
        }
      }
      await sink?.discard();
      throw err;
    } finally {
      pool?.dispose();
      audio?.mixer.dispose();
      if (onMain) releaseRenderResources('export');
    }
  };

  if (container !== 'gif') {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    const workers = options.workers ?? pickWorkers(width, height, totalFrames, fps, cores, keySeconds);
    let onMain = !!options.partsOnMain;
    // every frame is wanted by the caller: only this thread can hand over the canvas itself
    const watched = !!hooks.onFrame && !captureSet;
    const canParts = typeof OffscreenCanvas !== 'undefined' && !watched;
    // the gpu encoder for sizes and frame rates the plain setup would encode in software: only parts can have it
    // (their times are rewritten at the join), so such an export is done in parts even when it is one part
    const wantSetup = options.gpuEncoder === true || (options.gpuEncoder !== false && options.workers !== 1 && !options.acceleration);
    const setup = canParts && wantSetup && !d.transparent ? await pickEncoderSetup(videoCodec, width, height, fps, videoBitrate) : null;
    if (signal?.aborted) throw abortError();
    let inWorkers = !onMain && typeof Worker !== 'undefined' && !needsMainThread(project);
    let lenient: readonly string[] = [];
    let able = canParts && (setup !== null || (workers > 1 && planSegments(totalFrames, fps, workers, keySeconds).length > 1)) && (onMain || inWorkers || setup !== null);
    if (able && inWorkers) {
      // a picture only an <img> can show keeps the export here; a video nothing can decode is skipped everywhere
      const media = await partsMedia();
      if (signal?.aborted) throw abortError();
      if (!media.images) inWorkers = false;
      lenient = media.lenient;
    }
    if (able && !onMain && !inWorkers) {
      // no workers for this project: with the gpu setup the parts are made on this thread, without it the plain way is as good
      if (setup) onMain = true;
      else able = false;
    }
    if (able) {
      try {
        return await runParts(workers, onMain, lenient, setup);
      } catch (err) {
        if (signal?.aborted || isAbort(err)) throw abortError();
        // anything else: the export is done again the plain way, so the user still gets the file
        const reason = err instanceof Error ? err.message : String(err);
        console.warn('[export] rendering in parts failed, exporting on one thread:', reason);
        hooks.onFallback?.(reason);
        for (const k of ['setupMs', 'decodeMs', 'renderMs', 'encodeMs', 'audioMs', 'muxMs'] as const) stats[k] = 0;
        delete stats.parts;
      }
    }
  }

  // ---- the plain way: one frame after the other on this thread ----
  const sources = createFrameSources({
    project,
    fps,
    rangeStart,
    totalFrames,
    blobOf: getAssetBlob,
    loadImageElement,
    onWarning,
    signal,
    stats,
    ...(d.transparent ? { alpha: true } : {}),
  });
  const resolver = sources.resolver;
  const stepFrame = sources.step;
  let output: Output | null = null;
  let sink: ExportSink | null = null;
  let finished = false;
  let mixer: AudioMixer | null = null;
  let audioCodec: AudioCodec | null = null;
  let audioQuality = QUALITY_MEDIUM;
  let planned: OutputPlanned | null = null;
  let drawer: FrameDrawer | null = null;

  try {
    const audio = await openAudio();
    mixer = audio?.mixer ?? null;
    audioCodec = audio?.codec ?? null;
    audioQuality = audio?.quality ?? QUALITY_MEDIUM;
    planned = audio?.planned ?? null;
    if (signal?.aborted) throw abortError();

    // ---- gif: pass 1 samples a few small frames for one global palette, pass 2 encodes every frame ----
    const exportGifFrames = async (mode: 'parts' | 'pool' | 'plain'): Promise<Blob> => {
      const allowPool = mode !== 'plain';
      // increasing order: the pass-1 feeds hold only these frames, so nothing in between is decoded
      const sampleList = [...new Set(paletteSampleFrames(totalFrames))].sort((a, b) => a - b);
      const sampleFrames = new Set(sampleList);
      const small = sampleSize(width, height);
      const sc = new OffscreenCanvas(small.width, small.height);
      const sctx = sc.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!sctx) throw new Error('2d canvas is not available');
      sctx.setTransform(small.width / project.width, 0, 0, small.height / project.height, 0, 0);
      const samples = new Uint8Array(sampleFrames.size * small.width * small.height * 4);
      let filled = 0;

      await sources.open(sampleFrames);
      lastYield = performance.now();
      for (let k = 0; k < sampleList.length; k++) {
        if (signal?.aborted) throw abortError();
        await stepFrame(sampleList[k]!, (t) => {
          renderFrame(sctx, project, t, resolver);
          samples.set(sctx.getImageData(0, 0, small.width, small.height).data, filled);
          filled += small.width * small.height * 4;
        });
        report('palette', 0.02 + 0.18 * ((k + 1) / sampleList.length), 0, false);
        if (performance.now() - lastYield > 14) await yieldToUi();
      }
      const palette = buildPalette(samples.subarray(0, filled), 256);
      sc.width = 0;
      sc.height = 0;
      await sources.dispose();
      releaseRenderResources('export');
      if (signal?.aborted) throw abortError();

      const encoder = createGifEncoder({ width, height, palette, loop: 0 });
      const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;

      // ---- in parts: workers draw and compress stretches of the timeline, this thread writes them in order ----
      const partWorkers = options.workers ?? gifPartWorkers(cores, width * height, totalFrames);
      // video pictures reach a cpu canvas through the gpu, one at a time: more threads drawing them gain nothing
      // (measured), so a project with video is drawn here and only its frames' number work goes to workers
      const hasVideo = project.clips.some((c) => c.type === 'video');
      const partsAble =
        typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined' && !hooks.onFrame && !hasVideo && !needsMainThread(project);
      const partsOk = options.partsOnMain || (partsAble && mode === 'parts' && partWorkers > 1 && (await partsMedia()).images);
      if (signal?.aborted) throw abortError();
      if (mode === 'parts' && partWorkers > 1 && partsOk) {
        const segments = planGifParts(totalFrames, partWorkers);
        const fontKit = options.partsOnMain ? null : await collectFontKit(project);
        if (signal?.aborted) throw abortError();
        lastYield = performance.now();
        const parts = startSegments({
          project,
          base: { container: 'gif', gifPalette: palette, codec: 'avc', bitrate: 0, width, height, fps, rangeStart, totalFrames },
          segments,
          workers: partWorkers,
          warmup: 0,
          onMain: !!options.partsOnMain,
          blobOf: getAssetBlob,
          fontKit,
          missingFonts,
          loadImageElement,
          breathe: () => (performance.now() - lastYield > 14 ? yieldToUi() : undefined),
          onWarning,
          onFrames: (done) => report('video', 0.2 + 0.78 * (done / totalFrames), done, false),
          signal,
        });
        try {
          let i = 0;
          for (let s = 0; s < segments.length; s++) {
            const part = await parts.result(s);
            if (signal?.aborted) throw abortError();
            const frames = unpackGifFrames(part.buffer);
            if (part.from !== i || frames.length !== part.to - part.from) throw new Error('a rendered part lost frames');
            for (const lzw of frames) encoder.addEncodedFrame(lzw, gifDelayCs(i++, fps));
            parts.release(s);
            stats.decodeMs += part.stats.decodeMs;
            stats.renderMs += part.stats.renderMs;
            stats.encodeMs += part.stats.encodeMs;
            if (performance.now() - lastYield > 14) await yieldToUi();
          }
          if (i !== totalFrames) throw new Error('a rendered part lost frames');
          stats.workerStartMs = parts.startTimes();
        } finally {
          parts.dispose();
          if (options.partsOnMain) releaseRenderResources('export');
        }
        if (signal?.aborted) throw abortError();
        report('finalizing', 0.99, totalFrames);
        await yieldToUi();
        const blob = new Blob(encoder.finishParts() as BlobPart[], { type: 'image/gif' });
        finish(Math.min(partWorkers, segments.length));
        report('finalizing', 1, totalFrames);
        return blob;
      }

      await sources.open();
      const gifCanvas = new OffscreenCanvas(width, height);
      const gctx = gifCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!gctx) throw new Error('2d canvas is not available');
      gctx.setTransform(width / project.width, 0, 0, height / project.height, 0, 0);
      // the slow part of a frame (palette lookup, dithering, lzw) goes to web workers when that pays off
      const gifWorkers = allowPool ? (options.workers ?? gifWorkerCount(cores, width * height, totalFrames)) : 1;
      const pool = gifWorkers > 1 ? createGifPool(gifWorkers, width, palette) : null;
      const made: Promise<Uint8Array>[] = [];
      const ignore = () => undefined;
      let indices: Uint8Array | undefined;
      lastYield = performance.now();
      try {
        for (let i = 0; i < totalFrames; i++) {
          if (signal?.aborted) throw abortError();
          // at most a few frames of pixels wait for a worker
          if (pool) await pool.room();
          await stepFrame(i, (t) => {
            const t0 = performance.now();
            renderFrame(gctx, project, t, resolver);
            const data = gctx.getImageData(0, 0, width, height).data;
            const t1 = performance.now();
            stats.renderMs += t1 - t0;
            if (pool) {
              const lzw = pool.encode(data.buffer as ArrayBuffer);
              // a failure is seen where the frame is added, not as an unhandled rejection
              lzw.catch(ignore);
              made.push(lzw);
            } else {
              indices = indexFrame(data, width, palette, true, indices);
              encoder.addFrame(indices, gifDelayCs(i, fps));
            }
            stats.encodeMs += performance.now() - t1;
          });
          report('video', 0.2 + 0.78 * ((i + 1) / totalFrames), i + 1, false);
          if (performance.now() - lastYield > 14) await yieldToUi();
        }
        // into the file in playing order, whatever order the workers finished in
        const t2 = performance.now();
        for (let i = 0; i < made.length; i++) {
          if (signal?.aborted) throw abortError();
          encoder.addEncodedFrame(await made[i]!, gifDelayCs(i, fps));
        }
        stats.encodeMs += performance.now() - t2;
      } finally {
        pool?.dispose();
        gifCanvas.width = 0;
        gifCanvas.height = 0;
      }
      if (signal?.aborted) throw abortError();
      report('finalizing', 0.99, totalFrames);
      await yieldToUi();
      const blob = new Blob(encoder.finishParts() as BlobPart[], { type: 'image/gif' });
      finish(pool ? gifWorkers : 1);
      report('finalizing', 1, totalFrames);
      return blob;
    };

    // ---- output ----
    if (container === 'gif') {
      // each way that fails (not a cancel) hands over to the next simpler one, so the user still gets the file
      let lastError: unknown = null;
      for (const mode of ['parts', 'pool', 'plain'] as const) {
        try {
          return await exportGifFrames(mode);
        } catch (err) {
          if (signal?.aborted || isAbort(err)) throw abortError();
          if (mode === 'plain' || (mode === 'pool' && !(err instanceof GifPoolError))) throw err;
          lastError = err;
          const reason = err instanceof Error ? err.message : String(err);
          console.warn('[export] gif workers failed, trying a simpler way:', reason);
          hooks.onFallback?.(reason);
          await sources.dispose();
          releaseRenderResources('export');
          for (const k of ['decodeMs', 'renderMs', 'encodeMs'] as const) stats[k] = 0;
        }
      }
      throw lastError;
    }
    await sources.open();
    const opened = await openOutput(!!(mixer && audioCodec));
    sink = opened.sink;
    const format = opened.format;
    output = opened.output;

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: d.transparent });
    if (!ctx) throw new Error('2d canvas is not available');
    drawer = createFrameDrawer(canvas, ctx, project, place, d.transparent);
    const frames = drawer;

    const videoSource = new CanvasSource(canvas, {
      codec: videoCodec,
      quality: videoQuality,
      keyFrameInterval: keySeconds,
      ...(d.transparent ? { alpha: 'keep' as const } : {}),
    });
    output.addVideoTrack(videoSource, opened.videoMeta);
    let pump: AudioPump | null = null;
    if (mixer && audioCodec) {
      const audioSource = new AudioBufferSource({ codec: audioCodec, quality: audioQuality });
      output.addAudioTrack(audioSource, opened.audioMeta);
      pump = createAudioPump(mixer, audioSource, planned?.makeStage() ?? null);
    }
    await output.start();
    stats.setupMs = performance.now() - startedAt;

    // audio is fed in 1 s slices (mixed 30 s at a time), a little ahead of the video, so the muxer interleaves
    const feedAudio = async (untilSeconds: number) => {
      if (!pump) return;
      const t0 = performance.now();
      await pump.to(untilSeconds);
      stats.audioMs += performance.now() - t0;
    };

    lastYield = performance.now();
    // every time below comes from the integer frame index (i / fps), nothing is accumulated
    const frameDur = 1 / fps;
    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) throw abortError();
      await stepFrame(i, async (t) => {
        const t0 = performance.now();
        renderFrame(frames.target, project, t, resolver, d.transparent ? { transparent: true } : undefined);
        frames.finish();
        if (!captureSet || captureSet.has(i)) hooks.onFrame?.(i, canvas);
        const t1 = performance.now();
        await videoSource.add(i / fps, frameDur);
        stats.renderMs += t1 - t0;
        stats.encodeMs += performance.now() - t1;
      });
      await feedAudio(i / fps + 1.5);

      report('video', 0.05 + 0.9 * ((i + 1) / totalFrames), i + 1, false);
      if (performance.now() - lastYield > 14) await yieldToUi();
    }
    await feedAudio(duration + 1);

    if (signal?.aborted) throw abortError();
    report('finalizing', 0.96, totalFrames);
    await yieldToUi();
    const finalizeAt = performance.now();
    await output.finalize();
    finished = true;
    stats.finalizeMs = performance.now() - finalizeAt;
    if (signal?.aborted) throw abortError();
    const blob = await sink.finish(format.mimeType);
    sink = null;
    if (opened.sink.onDisk) stats.onDisk = true;
    await alphaCheck(blob);
    tellLoudness(planned, pump);
    finish(1);
    report('finalizing', 1, totalFrames);
    return blob;
  } catch (err) {
    if (output && !finished) {
      try {
        await output.cancel();
      } catch {
        // ignore
      }
    }
    await sink?.discard();
    if (signal?.aborted && !(err instanceof DOMException && err.name === 'AbortError')) throw abortError();
    throw err;
  } finally {
    drawer?.dispose();
    await sources.dispose();
    mixer?.dispose();
    releaseRenderResources('export');
  }
}

/** wav / ogg: only the audio mix of the range, no picture */
async function exportAudioOnly(project: Project, container: AudioContainer, range: TimeRange, hooks: ExportHooks, d: ResolvedDelivery, loudness?: ExportLoudness): Promise<Blob> {
  const { onProgress, onWarning, signal } = hooks;
  const length = range.end - range.start;
  let lastReport = 0;
  const report = (phase: ExportProgress['phase'], progress: number, force = true) => {
    const now = performance.now();
    if (!force && now - lastReport < PROGRESS_MS) return;
    lastReport = now;
    onProgress?.({ phase, progress: Math.min(1, Math.max(0, progress)), frame: 0, totalFrames: 0 });
  };

  report('audio', 0);
  await yieldToUi();
  const mixer = createAudioMixer(project, length, signal, onWarning, range.start, d.sampleRate);
  if (!mixer.hasAudio) {
    mixer.dispose();
    throw new Error('there is no sound in this range, nothing to export');
  }
  if (signal?.aborted) {
    mixer.dispose();
    throw abortError();
  }

  const picked = await pickAudio(container, d, mixer.sampleRate, onWarning);
  if (!picked) {
    mixer.dispose();
    throw new Error(`this browser cannot encode ${container} audio, try wav`);
  }

  let planned: OutputPlanned | null = null;
  try {
    planned = await decideOutput(project, range, mixer.sampleRate, loudness, { signal, onProgress: (f) => report('loudness', 0.5 * f, false) });
  } catch (err) {
    mixer.dispose();
    throw err;
  }

  const format = container === 'wav' ? new WavOutputFormat() : new OggOutputFormat();
  const target = new BufferTarget();
  const output = new Output({ format, target });
  let finished = false;
  try {
    const source = new AudioBufferSource({ codec: picked.codec, quality: picked.quality });
    output.addAudioTrack(source);
    await output.start();
    // 1 s slices (mixed 30 s at a time), so cancel and progress stay responsive
    const pump = createAudioPump(mixer, source, planned?.makeStage() ?? null);
    for (let sec = 1; pump.position() < mixer.totalFrames; sec++) {
      if (signal?.aborted) throw abortError();
      await pump.to(sec);
      const share = pump.position() / mixer.totalFrames;
      report('audio', planned ? 0.5 + 0.48 * share : 0.98 * share, false);
      if (performance.now() - lastYield > 14) await yieldToUi();
    }
    report('finalizing', 0.98);
    await yieldToUi();
    await output.finalize();
    finished = true;
    if (signal?.aborted) throw abortError();
    const buffer = target.buffer;
    if (!buffer) throw new Error('the encoder produced no data');
    if (planned) {
      const made = planned.reportFor(pump.stageReport());
      for (const w of made.warnings) onWarning?.(w);
      hooks.onLoudness?.(made.report);
    }
    report('finalizing', 1);
    return new Blob([buffer], { type: format.mimeType });
  } catch (err) {
    if (!finished) {
      try {
        await output.cancel();
      } catch {
        // ignore
      }
    }
    if (signal?.aborted && !(err instanceof DOMException && err.name === 'AbortError')) throw abortError();
    throw err;
  } finally {
    mixer.dispose();
  }
}
