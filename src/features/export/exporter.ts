/**
 * offline project renderer. no react. webcodecs + mediabunny.
 * frames are drawn with the same renderFrame the preview uses, video clips are decoded sequentially
 * (one sink iterator per clip), audio is mixed offline (audioMix.ts).
 */
import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
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
import type { AudioCodec, VideoCodec, WrappedCanvas } from 'mediabunny';
import type { ImageClip, Project, VideoClip } from '../../types';
import { releaseRenderResources, renderFrame } from '../../engine/draw';
import { beginExport, endExport } from '../../engine/exportState';
import type { DrawSource, SourceResolver } from '../../engine/draw';
import { ensureProjectFonts } from '../../lib/fonts';
import { projectDuration } from '../../lib/timelineOps';
import { buildPalette, createGifEncoder, gifDelayCs, indexFrame } from '../../lib/gif';
import { gifExportFps, gifSizeWarning, paletteSampleFrames, sampleSize } from './gifPlan';
import { neededForFrame } from './reach';
import { type TimeRange, clampRange, frameTime, rangeFrameCount } from './range';
import { getAssetBlob, getAssetUrl } from '../../media/registry';
import { MIX_CHANNELS, MIX_SAMPLE_RATE, createAudioMixer, sliceAudioBuffer } from './audioMix';
import type { AudioMixer } from './audioMix';

export type VideoContainer = 'mp4' | 'webm';
/** wav / ogg are audio only files (no picture) */
export type AudioContainer = 'wav' | 'ogg';
/** gif is a picture only file (no audio), made by lib/gif.ts instead of webcodecs */
export type ImageContainer = 'gif';
export type ExportContainer = VideoContainer | AudioContainer | ImageContainer;

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
}

export interface ExportProgress {
  phase: 'audio' | 'palette' | 'video' | 'finalizing';
  /** 0..1 over the whole export */
  progress: number;
  frame: number;
  totalFrames: number;
}

/** where the time of an export went, in milliseconds. the stages do not overlap. */
export interface ExportStats {
  frames: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
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
  /** after a frame is drawn and before it is encoded (benchmarks and tests read pixels here) */
  onFrame?: (index: number, canvas: OffscreenCanvas) => void;
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
/** seconds between key frames (not frames: 240 fps would otherwise get one every 0.1 s) */
const KEYFRAME_SECONDS = 2;
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
}

/** first codec of the container the browser says it can encode for this exact size, fps and bitrate. null = none. */
export async function planExport(req: PlanRequest, signal?: AbortSignal): Promise<ExportPlan | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const codec of VIDEO_CODECS[req.container]) {
    if (signal?.aborted) throw abortError();
    const bitrate = videoBitrate(req.width, req.height, req.fps, req.quality, codec);
    try {
      const ok = await canEncodeVideo(codec, {
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

const EPS = 1e-6;

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

/** give the event loop (rendering, input, fps counter) a turn */
function yieldToUi(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (channel) {
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(0);
    } else {
      setTimeout(resolve, 0);
    }
  }).then(() => {
    lastYield = performance.now();
  });
}

interface VideoFeed {
  gen: AsyncGenerator<WrappedCanvas | null, void, unknown>;
  current: DrawSource | null;
  done: boolean;
  /** the first frame was pulled early (a transition shows it before the clip starts). set by the pull itself, whatever it yielded. */
  primed?: boolean;
}

/**
 * feeds the chunks of an audio mixer to an audio source in 1 s slices, in order. `to(seconds)` mixes (one chunk at a
 * time) and adds everything up to that time of the mix.
 */
function createAudioPump(mixer: AudioMixer, source: AudioBufferSource) {
  let pos = 0;
  let idx = 0;
  let cur: AudioBuffer | null = null;
  return {
    /** frames fed so far */
    position: () => pos,
    async to(untilSeconds: number): Promise<void> {
      const target = Math.min(mixer.totalFrames, Math.ceil(untilSeconds * MIX_SAMPLE_RATE));
      while (pos < target) {
        const chunk = mixer.chunks[idx];
        if (!chunk) return;
        if (!cur) cur = await mixer.renderChunk(idx);
        const chunkEnd = chunk.startFrame + chunk.frames;
        const end = Math.min(target, chunkEnd, pos + MIX_SAMPLE_RATE);
        await source.add(sliceAudioBuffer(cur, pos - chunk.startFrame, end - chunk.startFrame));
        pos = end;
        if (pos >= chunkEnd) {
          cur = null;
          idx++;
        }
      }
    },
  };
}

/**
 * the one source timestamp of a clip that is only needed as a frozen edge: the clip ended before the range starts
 * (a transition still shows its last frame) or starts after it (a transition shows its first frame early).
 */
export function clipEdgeTimestamp(clip: VideoClip, fps: number, assetDuration: number, firstTimestamp = 0, rangeStart = 0): number {
  const end = clip.start + clip.duration;
  const maxT = assetDuration > 0 ? Math.max(0, assetDuration - 0.001) : Infinity;
  const minT = Math.min(maxT, Math.max(0, firstTimestamp));
  let local = 0;
  if (rangeStart >= end - EPS) {
    // the last frame of the clip on the frame grid of the project
    const lastFrame = Math.max(0, Math.ceil(end * fps - EPS) - 1);
    local = Math.min(clip.duration, Math.max(0, lastFrame / fps - clip.start));
  }
  return Math.min(maxT, Math.max(minT, 0, clip.trimStart + local * clip.speed));
}

/** source timestamps (seconds in the asset) for every output frame where the clip is visible (`only` = just those frames) */
export function clipTimestamps(
  clip: VideoClip,
  fps: number,
  totalFrames: number,
  assetDuration: number,
  firstTimestamp = 0,
  rangeStart = 0,
  only?: ReadonlySet<number>,
): Float64Array {
  const end = clip.start + clip.duration;
  // output frame i shows timeline time rangeStart + i / fps
  const from = Math.max(0, Math.floor((clip.start - rangeStart) * fps) - 1);
  const to = Math.min(totalFrames - 1, Math.ceil((end - rangeStart) * fps) + 1);
  const maxT = assetDuration > 0 ? Math.max(0, assetDuration - 0.001) : Infinity;
  // frames before the track's first packet do not exist, show the first picture instead
  const minT = Math.min(maxT, Math.max(0, firstTimestamp));
  const out: number[] = [];
  for (let i = from; i <= to; i++) {
    if (only && !only.has(i)) continue;
    const t = frameTime(rangeStart, i, fps);
    if (t >= clip.start - EPS && t < end - EPS) {
      out.push(Math.min(maxT, Math.max(minT, 0, clip.trimStart + (t - clip.start) * clip.speed)));
    }
  }
  return Float64Array.from(out);
}

export async function exportProject(project: Project, options: ExportOptions, hooks: ExportHooks = {}): Promise<Blob> {
  // while this runs the renderer does not use wall clock retry pauses (see engine/exportState.ts)
  beginExport();
  try {
    return await runExport(project, options, hooks);
  } finally {
    endExport();
  }
}

async function runExport(project: Project, options: ExportOptions, hooks: ExportHooks): Promise<Blob> {
  const { onProgress, onWarning, signal } = hooks;
  const startedAt = performance.now();
  const stats: ExportStats = { frames: 0, width: 0, height: 0, fps: 0, codec: '', setupMs: 0, decodeMs: 0, renderMs: 0, encodeMs: 0, audioMs: 0, finalizeMs: 0, totalMs: 0 };
  const projectLength = projectDuration(project);
  if (projectLength <= 0) throw new Error('the project is empty');
  const range = clampRange(options.range, projectLength);
  if (!range) throw new Error('the range is empty, pick a start before the end');
  if (signal?.aborted) throw abortError();
  if (isAudioContainer(options.container)) return exportAudioOnly(project, options.container, range, hooks);
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
  const { width, height } = outputSize(project, options.scale);
  const totalFrames = rangeFrameCount(range, fps);
  const container = options.container;

  let videoCodec: VideoCodec = 'avc';
  let videoQuality = QUALITY_MEDIUM;
  if (container !== 'gif') {
    const plan = await planExport({ container, width, height, fps, quality: options.quality }, signal);
    if (!plan) {
      throw new Error(
        `this browser cannot encode ${container} at ${width}x${height} and ${fps} fps, try a lower frame rate, a smaller resolution or the other format`,
      );
    }
    videoCodec = plan.codec;
    videoQuality = new Quality({ bitrate: plan.bitrate });
  } else {
    if (wantedFps > fps) onWarning?.(`gif plays at most ${fps} fps, exported at ${fps} fps`);
    const big = gifSizeWarning(width, height, totalFrames);
    if (big) onWarning?.(big);
  }

  let lastReport = 0;
  const report = (phase: ExportProgress['phase'], progress: number, frame: number, force = true) => {
    const now = performance.now();
    if (!force && now - lastReport < PROGRESS_MS) return;
    lastReport = now;
    onProgress?.({ phase, progress: Math.min(1, Math.max(0, progress)), frame, totalFrames });
  };

  // text must be drawn in its real font from the first frame (never rejects)
  for (const family of await ensureProjectFonts(project)) {
    onWarning?.(`font "${family}" could not be loaded, its text is drawn in a fallback font`);
  }
  if (signal?.aborted) throw abortError();

  // ---- resources to dispose ----
  const inputs = new Map<string, Input>();
  const feeds = new Map<string, VideoFeed>();
  const images = new Map<string, DrawSource>();
  let output: Output | null = null;
  let finished = false;
  let mixer: AudioMixer | null = null;
  let audioCodec: AudioCodec | null = null;

  const resolver: SourceResolver = (clip: VideoClip | ImageClip) => {
    if (clip.type === 'video') return feeds.get(clip.id)?.current ?? null;
    return images.get(clip.assetId) ?? null;
  };

  const dispose = async () => {
    for (const feed of feeds.values()) {
      feed.done = true;
      try {
        await feed.gen.return(undefined);
      } catch {
        // ignore
      }
      feed.current = null;
    }
    feeds.clear();
    for (const input of inputs.values()) {
      try {
        input.dispose();
      } catch {
        // ignore
      }
    }
    inputs.clear();
    for (const src of images.values()) {
      if (typeof ImageBitmap !== 'undefined' && src.image instanceof ImageBitmap) src.image.close();
    }
    images.clear();
  };

  try {
    // ---- audio (mixed in chunks while the video renders) ----
    if (options.includeAudio && !isGif) {
      report('audio', 0, 0);
      await yieldToUi();
      const m = createAudioMixer(project, duration, signal, onWarning, rangeStart);
      if (m.hasAudio) {
        mixer = m;
        audioCodec = await getFirstEncodableAudioCodec(AUDIO_CODECS[container], {
          numberOfChannels: MIX_CHANNELS,
          sampleRate: MIX_SAMPLE_RATE,
          quality: QUALITY_MEDIUM,
        });
        if (!audioCodec) {
          onWarning?.('this browser cannot encode audio for this format, exported without sound');
          mixer = null;
          m.dispose();
        }
      } else m.dispose();
      report('audio', 0.05, 0);
    }
    if (signal?.aborted) throw abortError();

    // ---- inputs for visible video / image clips (a gif export opens them twice: palette pass, encode pass) ----
    // `onlyFrames` = open the feeds for just those output frames (the gif palette pass)
    const openSources = async (onlyFrames?: ReadonlySet<number>) => {
    // clips a transition or a temporal effect (motion blur, echo) shows inside the range without the clip playing
    // there: it ended before the range (still needed at the first frame) or starts after it (needed at the last frame)
    // without transitions and effects a clip is only needed while it plays, so the two ends are enough. with
    // them every frame this pass renders is asked (a temporal effect that fades in reaches back further and
    // further, a transition head can fall between the ends).
    const reaches = project.clips.some((c) => c.type === 'effect' || ('transition' in c && !!c.transition));
    const probe: Iterable<number> = onlyFrames ?? (reaches ? Array.from({ length: totalFrames }, (_, i) => i) : [0, Math.max(0, totalFrames - 1)]);
    const neededAtStart = new Set<string>();
    for (const i of probe) for (const c of neededForFrame(project, frameTime(rangeStart, i, fps))) neededAtStart.add(c.id);
    const hiddenTrack = new Set(project.tracks.filter((t) => t.kind !== 'video' || t.hidden).map((t) => t.id));
    for (const clip of project.clips) {
      if (hiddenTrack.has(clip.trackId)) continue;
      if (clip.type !== 'video' && clip.type !== 'image') continue;
      if (signal?.aborted) throw abortError();
      const asset = project.assets.find((a) => a.id === clip.assetId);
      const blob = getAssetBlob(clip.assetId);
      if (!asset || !blob) {
        onWarning?.(`file for "${clip.name}" is missing, the clip is skipped`);
        continue;
      }
      if (clip.type === 'image') {
        if (images.has(clip.assetId)) continue;
        try {
          const bmp = await createImageBitmap(blob);
          images.set(clip.assetId, { image: bmp, width: bmp.width, height: bmp.height });
        } catch {
          // svg and friends: createImageBitmap rejects them, an <img> can draw them (same as the preview)
          try {
            const url = getAssetUrl(clip.assetId);
            if (!url) throw new Error('no url');
            const img = new Image();
            img.src = url;
            await img.decode();
            images.set(clip.assetId, { image: img, width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
          } catch {
            onWarning?.(`could not read image "${asset.name}", the clip is skipped`);
          }
        }
        continue;
      }
      try {
        let input = inputs.get(clip.assetId);
        if (!input) {
          input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
          inputs.set(clip.assetId, input);
        }
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error('no video track');
        if (!(await track.canDecode())) throw new Error('cannot decode');
        const first = await track.getFirstTimestamp();
        // one pooled canvas is enough: each frame is drawn right after it is pulled
        const sink = new CanvasSink(track, { poolSize: 1 });
        let stamps = clipTimestamps(clip, fps, totalFrames, asset.duration, first, rangeStart, onlyFrames);
        const edgeOnly = stamps.length === 0;
        if (edgeOnly) {
          if (!neededAtStart.has(clip.id)) continue;
          stamps = Float64Array.of(clipEdgeTimestamp(clip, fps, asset.duration, first, rangeStart));
        }
        const feed: VideoFeed = { gen: sink.canvasesAtTimestamps(stamps), current: null, done: false };
        if (edgeOnly) {
          // decode that one frame now, it never plays: the transition just holds it
          try {
            const next = await feed.gen.next();
            if (!next.done && next.value) {
              const c = next.value.canvas;
              feed.current = { image: c, width: c.width, height: c.height };
            }
          } catch {
            onWarning?.(`could not decode video "${asset.name}", the clip is skipped`);
          }
          feed.done = true;
          try {
            await feed.gen.return(undefined);
          } catch {
            // ignore
          }
        }
        feeds.set(clip.id, feed);
      } catch {
        onWarning?.(`could not decode video "${asset.name}", the clip is skipped`);
      }
    }

    };

    // advance the decoders of the video clips visible at time t. a clip that a transition shows
    // before it starts gets its first frame early; one shown after it ended holds its last frame.
    const advanceFeeds = async (t: number, visible: readonly Project['clips'][number][]) => {
      for (const clip of visible) {
        if (clip.type !== 'video') continue;
        const feed = feeds.get(clip.id);
        if (!feed || feed.done) continue;
        if (t < clip.start - EPS) {
          // at most one frame is pulled before the clip starts, even when the source gave no picture for it
          if (feed.primed) continue;
          feed.primed = true;
        } else if (t >= clip.start + clip.duration - EPS) {
          continue;
        } else if (feed.primed) {
          // its first frame is already here
          feed.primed = false;
          continue;
        }
        try {
          const next = await feed.gen.next();
          if (next.done) {
            feed.done = true;
          } else if (next.value) {
            const c = next.value.canvas;
            feed.current = { image: c, width: c.width, height: c.height };
          }
        } catch (err) {
          if (signal?.aborted) throw err;
          // the decoder gave up: hold the last frame and keep exporting the rest
          feed.done = true;
          onWarning?.(`video "${clip.name}" stopped decoding, its last frame is held`);
        }
      }
    };

    // free the decoder + canvas of video clips that just played their last frame
    const freeFeeds = async (i: number, visible: readonly Project['clips'][number][]) => {
      const nextT = frameTime(rangeStart, i + 1, fps);
      const neededNext = neededForFrame(project, nextT);
      for (const clip of visible) {
        if (clip.type !== 'video' || clip.start + clip.duration - EPS > nextT) continue;
        // a transition out of the clip still shows its last frame
        if (neededNext.includes(clip)) continue;
        const feed = feeds.get(clip.id);
        if (!feed) continue;
        feed.done = true;
        try {
          await feed.gen.return(undefined);
        } catch {
          // ignore
        }
        const img = feed.current?.image;
        if (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) {
          img.width = 0;
          img.height = 0;
        }
        feed.current = null;
        feeds.delete(clip.id);
      }
    };

    // one step of the frame loop: advance the decoders for frame i, draw, then free finished ones.
    // advance + free run for every frame (decoders are sequential), draw only does the wanted work.
    const stepFrame = async (i: number, draw: (t: number) => Promise<void> | void) => {
      // timeline time of this frame. the file's own timestamp is i / fps (starts at 0).
      const t = frameTime(rangeStart, i, fps);
      const visible = neededForFrame(project, t);
      const t0 = performance.now();
      await advanceFeeds(t, visible);
      stats.decodeMs += performance.now() - t0;
      await draw(t);
      await freeFeeds(i, visible);
    };

    // ---- gif: pass 1 samples a few small frames for one global palette, pass 2 encodes every frame ----
    const exportGifFrames = async (): Promise<Blob> => {
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

      await openSources(sampleFrames);
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
      await dispose();
      releaseRenderResources('export');
      if (signal?.aborted) throw abortError();

      await openSources();
      const gifCanvas = new OffscreenCanvas(width, height);
      const gctx = gifCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!gctx) throw new Error('2d canvas is not available');
      gctx.setTransform(width / project.width, 0, 0, height / project.height, 0, 0);
      const encoder = createGifEncoder({ width, height, palette, loop: 0 });
      let indices: Uint8Array | undefined;
      lastYield = performance.now();
      for (let i = 0; i < totalFrames; i++) {
        if (signal?.aborted) throw abortError();
        await stepFrame(i, (t) => {
          renderFrame(gctx, project, t, resolver);
          const data = gctx.getImageData(0, 0, width, height).data;
          indices = indexFrame(data, width, palette, true, indices);
          encoder.addFrame(indices, gifDelayCs(i, fps));
        });
        report('video', 0.2 + 0.78 * ((i + 1) / totalFrames), i + 1, false);
        if (performance.now() - lastYield > 14) await yieldToUi();
      }
      if (signal?.aborted) throw abortError();
      report('finalizing', 0.99, totalFrames);
      await yieldToUi();
      const blob = new Blob(encoder.finishParts() as BlobPart[], { type: 'image/gif' });
      report('finalizing', 1, totalFrames);
      return blob;
    };

    // ---- output ----
    if (container === 'gif') {
      return await exportGifFrames();
    }
    await openSources();
    const format =
      container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat();
    const target = new BufferTarget();
    output = new Output({ format, target });

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d canvas is not available');
    ctx.setTransform(width / project.width, 0, 0, height / project.height, 0, 0);

    const videoSource = new CanvasSource(canvas, { codec: videoCodec, quality: videoQuality, keyFrameInterval: KEYFRAME_SECONDS });
    output.addVideoTrack(videoSource, { frameRate: fps });
    let pump: ReturnType<typeof createAudioPump> | null = null;
    if (mixer && audioCodec) {
      const audioSource = new AudioBufferSource({ codec: audioCodec, quality: QUALITY_MEDIUM });
      output.addAudioTrack(audioSource);
      pump = createAudioPump(mixer, audioSource);
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
        renderFrame(ctx, project, t, resolver);
        hooks.onFrame?.(i, canvas);
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
    stats.frames = totalFrames;
    stats.width = width;
    stats.height = height;
    stats.fps = fps;
    stats.codec = videoCodec;
    stats.totalMs = performance.now() - startedAt;
    hooks.onStats?.(stats);
    if (signal?.aborted) throw abortError();
    const buffer = target.buffer;
    if (!buffer) throw new Error('the encoder produced no data');
    report('finalizing', 1, totalFrames);
    return new Blob([buffer], { type: format.mimeType });
  } catch (err) {
    if (output && !finished) {
      try {
        await output.cancel();
      } catch {
        // ignore
      }
    }
    if (signal?.aborted && !(err instanceof DOMException && err.name === 'AbortError')) throw abortError();
    throw err;
  } finally {
    await dispose();
    mixer?.dispose();
    releaseRenderResources('export');
  }
}

/** wav / ogg: only the audio mix of the range, no picture */
async function exportAudioOnly(project: Project, container: AudioContainer, range: TimeRange, hooks: ExportHooks): Promise<Blob> {
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
  const mixer = createAudioMixer(project, length, signal, onWarning, range.start);
  if (!mixer.hasAudio) {
    mixer.dispose();
    throw new Error('there is no sound in this range, nothing to export');
  }
  if (signal?.aborted) {
    mixer.dispose();
    throw abortError();
  }

  const codec = await getFirstEncodableAudioCodec(AUDIO_CODECS[container], {
    numberOfChannels: MIX_CHANNELS,
    sampleRate: MIX_SAMPLE_RATE,
    quality: QUALITY_MEDIUM,
  });
  if (!codec) {
    mixer.dispose();
    throw new Error(`this browser cannot encode ${container} audio, try wav`);
  }

  const format = container === 'wav' ? new WavOutputFormat() : new OggOutputFormat();
  const target = new BufferTarget();
  const output = new Output({ format, target });
  let finished = false;
  try {
    const source = new AudioBufferSource({ codec, quality: QUALITY_MEDIUM });
    output.addAudioTrack(source);
    await output.start();
    // 1 s slices (mixed 30 s at a time), so cancel and progress stay responsive
    const pump = createAudioPump(mixer, source);
    for (let sec = 1; pump.position() < mixer.totalFrames; sec++) {
      if (signal?.aborted) throw abortError();
      await pump.to(sec);
      report('audio', 0.98 * (pump.position() / mixer.totalFrames), false);
      if (performance.now() - lastYield > 14) await yieldToUi();
    }
    report('finalizing', 0.98);
    await yieldToUi();
    await output.finalize();
    finished = true;
    if (signal?.aborted) throw abortError();
    const buffer = target.buffer;
    if (!buffer) throw new Error('the encoder produced no data');
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
