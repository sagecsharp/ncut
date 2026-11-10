/**
 * the pictures an export reads while it renders frames [from, to) of its frame grid: one sequential decoder per
 * video clip, one bitmap per image. no dom is needed, so it runs on the main thread and inside a worker.
 *
 * a part of the grid (from > 0) must show exactly what the whole export would show at those frames. the only state
 * that reaches across frames is the picture a video clip holds (a transition or a temporal effect can show a clip
 * before it starts and after it ended), so `open` works out which source frame the whole export would be holding.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';
import type { WrappedCanvas } from 'mediabunny';
import type { ImageClip, Project, VideoClip } from '../../types';
import type { DrawSource, SourceResolver } from '../../engine/draw';
import { neededForFrame } from './reach';
import { frameTime } from './range';

const EPS = 1e-6;

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

/**
 * source timestamps (seconds in the asset) for every output frame where the clip is visible (`only` = just those
 * frames; fromFrame / toFrame = just the frames of [fromFrame, toFrame))
 */
export function clipTimestamps(
  clip: VideoClip,
  fps: number,
  totalFrames: number,
  assetDuration: number,
  firstTimestamp = 0,
  rangeStart = 0,
  only?: ReadonlySet<number>,
  fromFrame = 0,
  toFrame = totalFrames,
): Float64Array {
  const end = clip.start + clip.duration;
  // output frame i shows timeline time rangeStart + i / fps
  const from = Math.max(0, fromFrame, Math.floor((clip.start - rangeStart) * fps) - 1);
  const to = Math.min(totalFrames - 1, toFrame - 1, Math.ceil((end - rangeStart) * fps) + 1);
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

/** the frame grid of an export */
export interface FrameGrid {
  fps: number;
  /** timeline time of frame 0 */
  rangeStart: number;
  totalFrames: number;
}

/**
 * whether an export that renders every frame from 0 would still be holding the last picture of a clip at frame
 * `from`. `lastShown` is the last frame the clip plays in, or -1 for a clip that ended before the range (its edge
 * picture is opened up front). the exporter lets a picture go after the first frame that needs it while the next
 * one does not, and never opens it again.
 */
export function heldAtFrame(project: Project, clip: VideoClip, grid: FrameGrid, lastShown: number, from: number): boolean {
  let needed = lastShown >= 0 ? true : neededForFrame(project, frameTime(grid.rangeStart, 0, grid.fps)).includes(clip);
  for (let j = Math.max(0, lastShown); j < from; j++) {
    const next = neededForFrame(project, frameTime(grid.rangeStart, j + 1, grid.fps)).includes(clip);
    if (needed && !next) return false;
    needed = next;
  }
  return true;
}

interface VideoFeed {
  gen: AsyncGenerator<WrappedCanvas | null, void, unknown>;
  current: DrawSource | null;
  done: boolean;
  /** the first frame was pulled early (a transition shows it before the clip starts). set by the pull itself, whatever it yielded. */
  primed?: boolean;
}

export interface FrameSourcesInit extends FrameGrid {
  project: Project;
  /** this instance renders frames [from, to). missing = the whole grid. */
  from?: number;
  to?: number;
  blobOf: (assetId: string) => Blob | undefined;
  /** pictures createImageBitmap cannot read (svg): the main thread draws them through an <img>. missing in a worker. */
  loadImageElement?: (assetId: string) => Promise<DrawSource | null>;
  /** true = a picture that cannot be read is an error instead of a skipped clip (a worker hands the export back to the main thread) */
  strictImages?: boolean;
  /**
   * true = a video that cannot be decoded is an error instead of a skipped clip or a held frame. a worker sets it:
   * with several decoders open at once it may fail where the main thread alone would not, and the export is then
   * done there instead of coming out with a clip missing.
   */
  strictVideo?: boolean;
  /** asset ids strictVideo does not apply to (the main thread cannot decode them either) */
  lenient?: readonly string[];
  onWarning?: (message: string) => void;
  signal?: AbortSignal;
  /** decodeMs grows by the time spent waiting for decoded frames */
  stats?: { decodeMs: number };
}

export interface FrameSources {
  resolver: SourceResolver;
  /** open the decoders and pictures. `onlyFrames` = just those output frames (the gif palette pass). */
  open(onlyFrames?: ReadonlySet<number>): Promise<void>;
  /** advance the decoders for frame i, draw, then free the finished ones. must be called in increasing order. */
  step(i: number, draw: (t: number) => Promise<void> | void): Promise<void>;
  /** close everything (also between the two passes of a gif) */
  dispose(): Promise<void>;
}

function abortError(): DOMException {
  return new DOMException('export cancelled', 'AbortError');
}

/** a video failed where strictVideo is set */
export class StrictVideoError extends Error {}

export function createFrameSources(init: FrameSourcesInit): FrameSources {
  const { project, fps, rangeStart, totalFrames, blobOf, onWarning, signal } = init;
  const from = Math.max(0, init.from ?? 0);
  const to = Math.min(totalFrames, init.to ?? totalFrames);
  const partial = from > 0 || to < totalFrames;
  const grid: FrameGrid = { fps, rangeStart, totalFrames };

  const inputs = new Map<string, Input>();
  const feeds = new Map<string, VideoFeed>();
  const images = new Map<string, DrawSource>();

  const strictFor = (assetId: string) => !!init.strictVideo && !init.lenient?.includes(assetId);

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

  /**
   * the source time of the one picture a clip shows in [from, to) without playing there. null = the whole export
   * would not be holding it anymore.
   */
  const edgeStamp = (clip: VideoClip, assetDuration: number, first: number): number | null => {
    if (!partial) return clipEdgeTimestamp(clip, fps, assetDuration, first, rangeStart);
    const whole = clipTimestamps(clip, fps, totalFrames, assetDuration, first, rangeStart);
    const endedBefore = clip.start + clip.duration - EPS <= frameTime(rangeStart, from, fps);
    if (whole.length === 0) {
      // it never plays inside the export: the edge picture of the whole export, while that is still held
      if (endedBefore && !heldAtFrame(project, clip, grid, -1, from)) return null;
      return clipEdgeTimestamp(clip, fps, assetDuration, first, rangeStart);
    }
    if (!endedBefore) return whole[0]!;
    // the last frame it plays in: the last one before `from` whose time is inside the clip
    let last = Math.min(from - 1, Math.ceil((clip.start + clip.duration - rangeStart) * fps) + 1);
    while (last >= 0 && frameTime(rangeStart, last, fps) >= clip.start + clip.duration - EPS) last--;
    if (last < 0 || !heldAtFrame(project, clip, grid, last, from)) return null;
    return whole[whole.length - 1]!;
  };

  const open = async (onlyFrames?: ReadonlySet<number>) => {
    // clips a transition or a temporal effect (motion blur, echo) shows inside the range without the clip playing
    // there: it ended before the range (still needed at the first frame) or starts after it (needed at the last frame)
    // without transitions and effects a clip is only needed while it plays, so the two ends are enough. with
    // them every frame this pass renders is asked (a temporal effect that fades in reaches back further and
    // further, a transition head can fall between the ends).
    const reaches = project.clips.some((c) => c.type === 'effect' || ('transition' in c && !!c.transition));
    const probe: Iterable<number> =
      onlyFrames ?? (reaches ? Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i) : [from, Math.max(from, to - 1)]);
    const neededAtStart = new Set<string>();
    for (const i of probe) for (const c of neededForFrame(project, frameTime(rangeStart, i, fps))) neededAtStart.add(c.id);
    const hiddenTrack = new Set(project.tracks.filter((t) => t.kind !== 'video' || t.hidden).map((t) => t.id));
    for (const clip of project.clips) {
      if (hiddenTrack.has(clip.trackId)) continue;
      if (clip.type !== 'video' && clip.type !== 'image') continue;
      if (signal?.aborted) throw abortError();
      const asset = project.assets.find((a) => a.id === clip.assetId);
      const blob = blobOf(clip.assetId);
      if (!asset || !blob) {
        onWarning?.(`file for "${clip.name}" is missing, the clip is skipped`);
        continue;
      }
      if (clip.type === 'image') {
        if (images.has(clip.assetId)) continue;
        // a part of the grid only opens the pictures it shows
        if (partial && !neededAtStart.has(clip.id) && !imageInSpan(clip)) continue;
        try {
          const bmp = await createImageBitmap(blob);
          images.set(clip.assetId, { image: bmp, width: bmp.width, height: bmp.height });
        } catch {
          // svg and friends: createImageBitmap rejects them, an <img> can draw them (same as the preview)
          let src: DrawSource | null = null;
          try {
            src = (await init.loadImageElement?.(clip.assetId)) ?? null;
          } catch {
            src = null;
          }
          if (src) images.set(clip.assetId, src);
          else if (init.strictImages) throw new Error(`image "${asset.name}" cannot be read here`);
          else onWarning?.(`could not read image "${asset.name}", the clip is skipped`);
        }
        continue;
      }
      try {
        let stamps = clipTimestamps(clip, fps, totalFrames, asset.duration, 0, rangeStart, onlyFrames, from, to);
        // nothing of it in this part: no decoder is opened at all
        if (partial && stamps.length === 0 && !neededAtStart.has(clip.id)) continue;
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
        stamps = clipTimestamps(clip, fps, totalFrames, asset.duration, first, rangeStart, onlyFrames, from, to);
        const edgeOnly = stamps.length === 0;
        if (edgeOnly) {
          if (!neededAtStart.has(clip.id)) continue;
          const stamp = edgeStamp(clip, asset.duration, first);
          if (stamp === null) continue;
          stamps = Float64Array.of(stamp);
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
            if (signal?.aborted) throw abortError();
            if (strictFor(clip.assetId)) throw new StrictVideoError(`video "${asset.name}" cannot be decoded here`);
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
      } catch (err) {
        if (signal?.aborted || err instanceof StrictVideoError) throw err;
        if (strictFor(clip.assetId)) throw new StrictVideoError(`video "${asset.name}" cannot be decoded here`);
        onWarning?.(`could not decode video "${asset.name}", the clip is skipped`);
      }
    }
  };

  /** an image clip that is on screen somewhere in [from, to) */
  const imageInSpan = (clip: ImageClip): boolean => {
    const lo = frameTime(rangeStart, from, fps);
    const hi = frameTime(rangeStart, Math.max(from, to - 1), fps);
    return clip.start <= hi + EPS && clip.start + clip.duration > lo - EPS;
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
        if (strictFor(clip.assetId)) throw new StrictVideoError(`video "${clip.name}" stopped decoding here`);
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
  const step = async (i: number, draw: (t: number) => Promise<void> | void) => {
    // timeline time of this frame. the file's own timestamp is i / fps (starts at 0).
    const t = frameTime(rangeStart, i, fps);
    const visible = neededForFrame(project, t);
    const t0 = performance.now();
    await advanceFeeds(t, visible);
    if (init.stats) init.stats.decodeMs += performance.now() - t0;
    await draw(t);
    await freeFeeds(i, visible);
  };

  return { resolver, open, step, dispose };
}
