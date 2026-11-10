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
  Output,
  QUALITY_MEDIUM,
  Quality,
  WebMOutputFormat,
  canEncodeVideo,
  getFirstEncodableAudioCodec,
} from 'mediabunny';
import type { AudioCodec, VideoCodec, WrappedCanvas } from 'mediabunny';
import type { ImageClip, Project, VideoClip } from '../../types';
import { renderFrame, visibleClipsAt } from '../../engine/draw';
import type { DrawSource, SourceResolver } from '../../engine/draw';
import { projectDuration } from '../../lib/timelineOps';
import { getAssetBlob, getAssetUrl } from '../../media/registry';
import { MIX_CHANNELS, MIX_SAMPLE_RATE, renderAudioMix, sliceAudioBuffer } from './audioMix';

export type ExportContainer = 'mp4' | 'webm';
export type ExportQuality = 'low' | 'medium' | 'high';

export interface ExportOptions {
  container: ExportContainer;
  /** 1, 0.75 or 0.5 of the project size */
  scale: number;
  fps: number;
  quality: ExportQuality;
  includeAudio: boolean;
}

export interface ExportProgress {
  phase: 'audio' | 'video' | 'finalizing';
  /** 0..1 over the whole export */
  progress: number;
  frame: number;
  totalFrames: number;
}

export interface ExportHooks {
  onProgress?: (p: ExportProgress) => void;
  onWarning?: (message: string) => void;
  signal?: AbortSignal;
}

/** tried in this order, the first one the browser can encode at the chosen size + fps + bitrate wins */
export const VIDEO_CODECS: Record<ExportContainer, VideoCodec[]> = {
  mp4: ['avc', 'hevc', 'av1', 'vp9'],
  webm: ['vp9', 'av1', 'vp8'],
};
const AUDIO_CODECS: Record<ExportContainer, AudioCodec[]> = {
  mp4: ['aac', 'opus'],
  webm: ['opus'],
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
  container: ExportContainer;
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

export function frameCount(project: Pick<Project, 'clips'>, fps: number): number {
  const n = projectDuration(project) * fps;
  // float error in duration * fps stays far below 1e-6 even for hours at 240 fps
  return Math.max(1, Math.ceil(n - 1e-6));
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
}

/** source timestamps (seconds in the asset) for every output frame where the clip is visible */
function clipTimestamps(clip: VideoClip, fps: number, totalFrames: number, assetDuration: number, firstTimestamp = 0): Float64Array {
  const end = clip.start + clip.duration;
  const from = Math.max(0, Math.floor(clip.start * fps) - 1);
  const to = Math.min(totalFrames - 1, Math.ceil(end * fps) + 1);
  const maxT = assetDuration > 0 ? Math.max(0, assetDuration - 0.001) : Infinity;
  // frames before the track's first packet do not exist, show the first picture instead
  const minT = Math.min(maxT, Math.max(0, firstTimestamp));
  const out: number[] = [];
  for (let i = from; i <= to; i++) {
    const t = i / fps;
    if (t >= clip.start - EPS && t < end - EPS) {
      out.push(Math.min(maxT, Math.max(minT, 0, clip.trimStart + (t - clip.start) * clip.speed)));
    }
  }
  return Float64Array.from(out);
}

export async function exportProject(project: Project, options: ExportOptions, hooks: ExportHooks = {}): Promise<Blob> {
  const { onProgress, onWarning, signal } = hooks;
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('this browser has no webcodecs support, try a recent chrome or edge');
  }
  const duration = projectDuration(project);
  if (duration <= 0) throw new Error('the project is empty');
  if (signal?.aborted) throw abortError();

  const fps = options.fps > 0 ? options.fps : project.fps;
  const { width, height } = outputSize(project, options.scale);
  const totalFrames = frameCount(project, fps);
  const container = options.container;

  const plan = await planExport({ container, width, height, fps, quality: options.quality }, signal);
  if (!plan) {
    throw new Error(
      `this browser cannot encode ${container} at ${width}x${height} and ${fps} fps, try a lower frame rate, a smaller resolution or the other format`,
    );
  }
  const videoCodec = plan.codec;
  const videoQuality = new Quality({ bitrate: plan.bitrate });

  let lastReport = 0;
  const report = (phase: ExportProgress['phase'], progress: number, frame: number, force = true) => {
    const now = performance.now();
    if (!force && now - lastReport < PROGRESS_MS) return;
    lastReport = now;
    onProgress?.({ phase, progress: Math.min(1, Math.max(0, progress)), frame, totalFrames });
  };

  // ---- audio mix (phase 1) ----
  let mix: AudioBuffer | null = null;
  let audioCodec: AudioCodec | null = null;
  if (options.includeAudio) {
    report('audio', 0, 0);
    await yieldToUi();
    const res = await renderAudioMix(project, duration, signal, (f) => report('audio', f * 0.05, 0));
    for (const w of res.warnings) onWarning?.(w);
    mix = res.buffer;
    if (mix) {
      audioCodec = await getFirstEncodableAudioCodec(AUDIO_CODECS[container], {
        numberOfChannels: MIX_CHANNELS,
        sampleRate: MIX_SAMPLE_RATE,
        quality: QUALITY_MEDIUM,
      });
      if (!audioCodec) {
        onWarning?.('this browser cannot encode audio for this format, exported without sound');
        mix = null;
      }
    }
    report('audio', 0.05, 0);
  }
  if (signal?.aborted) throw abortError();

  // ---- resources to dispose ----
  const inputs = new Map<string, Input>();
  const feeds = new Map<string, VideoFeed>();
  const images = new Map<string, DrawSource>();
  let output: Output | null = null;
  let finished = false;

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
    // ---- inputs for visible video / image clips ----
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
        const stamps = clipTimestamps(clip, fps, totalFrames, asset.duration, first);
        if (stamps.length === 0) continue;
        feeds.set(clip.id, { gen: sink.canvasesAtTimestamps(stamps), current: null, done: false });
      } catch {
        onWarning?.(`could not decode video "${asset.name}", the clip is skipped`);
      }
    }

    // ---- output ----
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
    let audioSource: AudioBufferSource | null = null;
    if (mix && audioCodec) {
      audioSource = new AudioBufferSource({ codec: audioCodec, quality: QUALITY_MEDIUM });
      output.addAudioTrack(audioSource);
    }
    await output.start();

    // audio is fed in 1 s slices, a little ahead of the video, so the muxer interleaves
    const sliceFrames = MIX_SAMPLE_RATE;
    let audioPos = 0;
    const feedAudio = async (untilSeconds: number) => {
      if (!audioSource || !mix) return;
      const target = Math.min(mix.length, Math.ceil(untilSeconds * MIX_SAMPLE_RATE));
      while (audioPos < target) {
        const end = Math.min(mix.length, audioPos + sliceFrames);
        await audioSource.add(sliceAudioBuffer(mix, audioPos, end));
        audioPos = end;
      }
    };

    lastYield = performance.now();
    // every time below comes from the integer frame index (i / fps), nothing is accumulated
    const frameDur = 1 / fps;
    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) throw abortError();
      const t = i / fps;

      // advance decoders of the video clips visible in this frame
      const visible = visibleClipsAt(project, t);
      for (const clip of visible) {
        if (clip.type !== 'video') continue;
        const feed = feeds.get(clip.id);
        if (!feed || feed.done) continue;
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

      renderFrame(ctx, project, t, resolver);
      await videoSource.add(t, frameDur);

      // free the decoder + canvas of video clips that just played their last frame
      const nextT = (i + 1) / fps;
      for (const clip of visible) {
        if (clip.type !== 'video' || clip.start + clip.duration - EPS > nextT) continue;
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
      await feedAudio(t + 1.5);

      report('video', 0.05 + 0.9 * ((i + 1) / totalFrames), i + 1, false);
      if (performance.now() - lastYield > 14) await yieldToUi();
    }
    await feedAudio(duration + 1);

    if (signal?.aborted) throw abortError();
    report('finalizing', 0.96, totalFrames);
    await yieldToUi();
    await output.finalize();
    finished = true;
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
  }
}
