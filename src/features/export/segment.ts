/**
 * renders and encodes one part of an export: frames [from, to) of the frame grid, as a small video file of its
 * own (same container, codec and bitrate as the final file). several of these run at once, each with its own
 * encoder (in web workers, see exportWorker.ts), and the exporter joins their packets in order.
 * no dom, no audio: it runs on the main thread and inside a worker.
 */
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality, WebMOutputFormat } from 'mediabunny';
import type { VideoCodec } from 'mediabunny';
import type { Project } from '../../types';
import { renderFrame } from '../../engine/draw';
import type { DrawSource } from '../../engine/draw';
import { createFrameSources } from './sources';

/** seconds between key frames (not frames: 240 fps would otherwise get one every 0.1 s) */
export const KEYFRAME_SECONDS = 2;

export interface SegmentJob {
  id: number;
  container: 'mp4' | 'webm';
  codec: VideoCodec;
  bitrate: number;
  width: number;
  height: number;
  fps: number;
  /** timeline time of frame 0 of the whole export */
  rangeStart: number;
  /** frames of the whole export */
  totalFrames: number;
  /** this part: frames [from, to) */
  from: number;
  to: number;
  /**
   * frames before `from` that are drawn and encoded too and then thrown away. a fresh encoder spends its first
   * frames finding its footing (measured: about 5 db less for a dozen frames), so a part that starts in the middle
   * of the film lets the encoder run in on the frames before it and starts its own frames with a forced key frame.
   */
  warmup?: number;
  /** frames (of the whole export) whose pixels the caller wants to see before they are encoded */
  capture?: number[];
  /** benchmarks: which kind of encoder to ask for (missing = the browser decides, as on one thread) */
  acceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
}

export interface SegmentStats {
  /** from the start of the part to its last byte */
  wallMs: number;
  /** drawing and encoding the first frame (the encoder starts here) */
  firstFrameMs: number;
  openMs: number;
  decodeMs: number;
  renderMs: number;
  encodeMs: number;
  finalizeMs: number;
}

export interface SegmentResult {
  id: number;
  from: number;
  to: number;
  /** the frame the file starts with: `from` minus the run-in frames */
  first: number;
  /** a complete video file holding the frames [first, to), starting at time 0 */
  buffer: ArrayBuffer;
  stats: SegmentStats;
}

export interface SegmentEnv {
  blobOf: (assetId: string) => Blob | undefined;
  loadImageElement?: (assetId: string) => Promise<DrawSource | null>;
  strictImages?: boolean;
  onWarning?: (message: string) => void;
  /** frames of this part that are done (called often: throttle on the receiving side) */
  onProgress?: (framesDone: number) => void;
  onCapture?: (frame: number, canvas: OffscreenCanvas) => void | Promise<void>;
  signal?: AbortSignal;
  /** called after every frame; lets the caller give other work a turn */
  breathe?: () => Promise<void> | void;
}

function abortError(): DOMException {
  return new DOMException('export cancelled', 'AbortError');
}

export async function renderSegment(project: Project, job: SegmentJob, env: SegmentEnv): Promise<SegmentResult> {
  const { fps, from, to, width, height } = job;
  const first = Math.max(0, from - Math.max(0, Math.floor(job.warmup ?? 0)));
  // the key frame rhythm of the whole export (one every KEYFRAME_SECONDS of its own time), whatever part this is
  const keyStep = (i: number) => Math.floor(i / fps / KEYFRAME_SECONDS);
  const stats: SegmentStats = { wallMs: 0, firstFrameMs: 0, openMs: 0, decodeMs: 0, renderMs: 0, encodeMs: 0, finalizeMs: 0 };
  const startedAt = performance.now();
  const sources = createFrameSources({
    project,
    fps,
    rangeStart: job.rangeStart,
    totalFrames: job.totalFrames,
    from: first,
    to,
    blobOf: env.blobOf,
    loadImageElement: env.loadImageElement,
    strictImages: env.strictImages,
    onWarning: env.onWarning,
    signal: env.signal,
    stats,
  });
  const capture = job.capture && job.capture.length > 0 ? new Set(job.capture) : null;
  let output: Output | null = null;
  let finished = false;
  const canvas = new OffscreenCanvas(width, height);
  try {
    const t0 = performance.now();
    await sources.open();
    if (env.signal?.aborted) throw abortError();
    // the file is only a container for the packets on their way to the real output: no fast start needed
    const format = job.container === 'mp4' ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat();
    const target = new BufferTarget();
    output = new Output({ format, target });
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d canvas is not available');
    ctx.setTransform(width / project.width, 0, 0, height / project.height, 0, 0);
    const source = new CanvasSource(canvas, {
      codec: job.codec,
      quality: new Quality({ bitrate: job.bitrate }),
      keyFrameInterval: KEYFRAME_SECONDS,
      ...(job.acceleration ? { hardwareAcceleration: job.acceleration } : {}),
    });
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();
    stats.openMs = performance.now() - t0;

    // every time below comes from the integer frame index, nothing is accumulated
    const frameDur = 1 / fps;
    for (let i = first; i < to; i++) {
      if (env.signal?.aborted) throw abortError();
      await sources.step(i, async (t) => {
        const a = performance.now();
        renderFrame(ctx, project, t, sources.resolver);
        if (i >= from && capture?.has(i)) await env.onCapture?.(i, canvas);
        const b = performance.now();
        // run-in frames never start a group (the encoder's very first frame is a key frame by itself)
        const keyFrame = i === from || (i > from && keyStep(i) !== keyStep(i - 1));
        await source.add((i - first) / fps, frameDur, { keyFrame });
        stats.renderMs += b - a;
        stats.encodeMs += performance.now() - b;
        if (i === first) stats.firstFrameMs = performance.now() - a;
      });
      if (i >= from) env.onProgress?.(i + 1 - from);
      const pause = env.breathe?.();
      if (pause) await pause;
    }
    if (env.signal?.aborted) throw abortError();
    const f0 = performance.now();
    await output.finalize();
    finished = true;
    stats.finalizeMs = performance.now() - f0;
    stats.wallMs = performance.now() - startedAt;
    const buffer = target.buffer;
    if (!buffer) throw new Error('the encoder produced no data');
    return { id: job.id, from, to, first, buffer, stats };
  } catch (err) {
    if (output && !finished) {
      try {
        await output.cancel();
      } catch {
        // ignore
      }
    }
    throw err;
  } finally {
    await sources.dispose();
    canvas.width = 0;
    canvas.height = 0;
  }
}
