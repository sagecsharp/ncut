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
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  WebMOutputFormat,
  canEncodeAudio,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from 'mediabunny';
import type { AudioCodec, Quality, VideoCodec, WrappedCanvas } from 'mediabunny';
import type { ImageClip, Project, VideoClip } from '../../types';
import { renderFrame, visibleClipsAt } from '../../engine/draw';
import type { DrawSource, SourceResolver } from '../../engine/draw';
import { projectDuration } from '../../lib/timelineOps';
import { getAssetBlob } from '../../media/registry';
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

const VIDEO_CODECS: Record<ExportContainer, VideoCodec[]> = {
  mp4: ['avc', 'hevc', 'av1', 'vp9'],
  webm: ['vp9', 'vp8', 'av1'],
};
const AUDIO_CODECS: Record<ExportContainer, AudioCodec[]> = {
  mp4: ['aac', 'opus'],
  webm: ['opus'],
};

const QUALITY_MAP: Record<ExportQuality, Quality> = {
  low: QUALITY_LOW,
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
};

const EPS = 1e-6;

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

export function outputSize(project: Pick<Project, 'width' | 'height'>, scale: number): { width: number; height: number } {
  return { width: even(project.width * scale), height: even(project.height * scale) };
}

export function frameCount(project: Pick<Project, 'clips'>, fps: number): number {
  return Math.max(1, Math.ceil(projectDuration(project) * fps - 1e-6));
}

export function fileExtension(container: ExportContainer): string {
  return container;
}

function abortError(): DOMException {
  return new DOMException('export cancelled', 'AbortError');
}

/** which containers have an encodable video codec on this browser */
export async function probeFormats(project: Pick<Project, 'width' | 'height' | 'fps'>): Promise<Record<ExportContainer, boolean>> {
  const result: Record<ExportContainer, boolean> = { mp4: false, webm: false };
  if (typeof VideoEncoder === 'undefined') return result;
  const size = outputSize(project, 1);
  for (const container of ['mp4', 'webm'] as const) {
    try {
      const codec = await getFirstEncodableVideoCodec(VIDEO_CODECS[container], {
        width: size.width,
        height: size.height,
        quality: QUALITY_MEDIUM,
        frameRate: project.fps,
      });
      result[container] = codec !== null;
    } catch {
      result[container] = false;
    }
  }
  return result;
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
function clipTimestamps(clip: VideoClip, fps: number, totalFrames: number, assetDuration: number): Float64Array {
  const end = clip.start + clip.duration;
  const from = Math.max(0, Math.floor(clip.start * fps) - 1);
  const to = Math.min(totalFrames - 1, Math.ceil(end * fps) + 1);
  const maxT = assetDuration > 0 ? Math.max(0, assetDuration - 0.001) : Infinity;
  const out: number[] = [];
  for (let i = from; i <= to; i++) {
    const t = i / fps;
    if (t >= clip.start - EPS && t < end - EPS) {
      out.push(Math.min(maxT, Math.max(0, clip.trimStart + (t - clip.start) * clip.speed)));
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
  const quality = QUALITY_MAP[options.quality];
  const container = options.container;

  const videoCodec = await getFirstEncodableVideoCodec(VIDEO_CODECS[container], {
    width,
    height,
    quality,
    frameRate: fps,
  });
  if (!videoCodec) {
    throw new Error(`this browser cannot encode ${container} video at ${width}x${height}, try the other format or a smaller size`);
  }

  const report = (phase: ExportProgress['phase'], progress: number, frame: number) =>
    onProgress?.({ phase, progress: Math.min(1, Math.max(0, progress)), frame, totalFrames });

  // ---- audio mix (phase 1) ----
  let mix: AudioBuffer | null = null;
  let audioCodec: AudioCodec | null = null;
  if (options.includeAudio) {
    report('audio', 0, 0);
    await yieldToUi();
    const res = await renderAudioMix(project, duration, signal);
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
  const bitmaps = new Map<string, ImageBitmap>();
  let output: Output | null = null;
  let finished = false;

  const resolver: SourceResolver = (clip: VideoClip | ImageClip) => {
    if (clip.type === 'video') return feeds.get(clip.id)?.current ?? null;
    const bmp = bitmaps.get(clip.assetId);
    return bmp ? { image: bmp, width: bmp.width, height: bmp.height } : null;
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
    for (const bmp of bitmaps.values()) bmp.close();
    bitmaps.clear();
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
        if (bitmaps.has(clip.assetId)) continue;
        try {
          bitmaps.set(clip.assetId, await createImageBitmap(blob));
        } catch {
          onWarning?.(`could not read image "${asset.name}", the clip is skipped`);
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
        const sink = new CanvasSink(track, { poolSize: 3 });
        const stamps = clipTimestamps(clip, fps, totalFrames, asset.duration);
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

    const videoSource = new CanvasSource(canvas, { codec: videoCodec, quality, keyFrameInterval: 2 });
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
        const next = await feed.gen.next();
        if (next.done) {
          feed.done = true;
        } else if (next.value) {
          const c = next.value.canvas;
          feed.current = { image: c, width: c.width, height: c.height };
        }
      }

      renderFrame(ctx, project, t, resolver);
      await videoSource.add(t, frameDur);
      await feedAudio(t + 1.5);

      report('video', 0.05 + 0.9 * ((i + 1) / totalFrames), i + 1);
      if (performance.now() - lastYield > 14) await yieldToUi();
    }
    await feedAudio(duration + 1);

    if (signal?.aborted) throw abortError();
    report('finalizing', 0.96, totalFrames);
    await yieldToUi();
    await output.finalize();
    finished = true;
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
