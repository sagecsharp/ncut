/**
 * the preview engine. plain class, no react. owns the canvas, the pool of media elements and the
 * web audio graph, and keeps all of them in sync with the master clock (usePlayback) and the project.
 *
 * rules it follows (see docs/ARCHITECTURE.md):
 * - no react state per frame. everything is driven by store subscriptions.
 * - while playing the media elements play on their own, we only correct them when they drift.
 * - while paused we draw only when something changed (one rAF), never a permanent loop.
 */
import type { AudioClip, Clip, ImageClip, Project, VideoClip } from '../../types';
import { releaseRenderResources, renderFrame, renderSceneView } from '../../engine/draw';
import { isExporting } from '../../engine/exportState';
import type { DrawSource } from '../../engine/draw';
import { valueAt } from '../../lib/anim';
import { onFontsChanged } from '../../lib/fonts';
import { APPEARANCE_EVENT } from '../../lib/appearance';
import { fadeFactor, sourceTimeAt } from '../../lib/timelineOps';
import { transitionHolds } from '../../lib/transitions';
import { clamp } from '../../lib/time';
import { getAssetBlob, getAssetUrl } from '../../media/registry';
import { useEditor } from '../../store/editorStore';
import { mediaPlaybackRate, rateAudible, usePlayback } from '../../store/playback';
import { blocksPaint, isScrubbing, onSeekedAction, staleScrubTarget } from './previewSync';
import { ScrubFeed } from './scrubFeed';
import { useUi } from '../../store/ui';
import { neededImageAssets } from './imageWindow';
import { ParkingLot } from './mediaPark';
import { frameInfo } from './frameStatic';
import { SKIP_UNCHANGED_FRAMES, canSkipRepaint } from './repaintSkip';
import type { FrameRecord } from './repaintSkip';
import { backingSize, usePreviewQuality } from './quality';
import { currentOrbit, toCamera3D, useSceneCamera } from './sceneCamera';

type LineColor = [number, number, number, number];
const FALLBACK_LINE: LineColor = [1, 1, 1, 0.6];

/** seconds before a clip starts that its element is created and pre-positioned */
const LOOKAHEAD = 1.5;
/** seconds after a clip ends that its element is kept (avoids churn at the boundary) */
const LINGER = 0.25;
/** playing: only correct currentTime when the element drifts further than this */
const DRIFT = 0.15;
/** longest time the last picture is held while an element seeks or loads, so a stuck seek cannot freeze the canvas */
const HOLD_MAX_MS = 500;
/** how long a freshly created element may still be loading before it stops holding the picture */
const LOAD_HOLD_MS = 1000;
/** a drag that the scrub feed serves: the element seeks to the playhead once it rested this long */
const SETTLE_MS = 60;
/** image bitmaps kept alive beyond the ones needed around the playhead */
const IMAGE_LRU = 8;
/** the eviction pass runs again when the playhead moved this far (seconds), or the project / image count changed */
const EVICT_STEP = 0.5;

type RvfcElement = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta?: { mediaTime?: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

function setPreservesPitch(el: HTMLMediaElement, value: boolean): void {
  const e = el as HTMLMediaElement & { webkitPreservesPitch?: boolean; mozPreservesPitch?: boolean };
  e.preservesPitch = value;
  if ('webkitPreservesPitch' in e) e.webkitPreservesPitch = value;
  if ('mozPreservesPitch' in e) e.mozPreservesPitch = value;
}

interface MediaEntry {
  clipId: string;
  assetId: string;
  url: string;
  kind: 'video' | 'audio';
  el: HTMLVideoElement | HTMLAudioElement;
  gen: number;
  /** latest seek target that has not been applied yet (coalesced while a seek is in flight) */
  want: number | null;
  failed: boolean;
  source: DrawSource | null;
  rvfc: number;
  gain: GainNode | null;
  node: MediaElementAudioSourceNode | null;
  lastGain: number;
  createdAt: number;
  /** performance.now() when the last seek was issued (0 = none) */
  seekStart: number;
  /** measured seek latency in seconds, used to aim drift corrections ahead of the clock */
  seekCost: number;
  /** no drift correction before this performance.now() (lets the element settle after a seek) */
  holdUntil: number;
  /** the clock runs backwards / too fast for audio: this element stays silent */
  rateMute: boolean;
  /** a running clock drives this video by seeks (backwards / unplayable rate): see previewSync */
  scrub: boolean;
  /** paused: the source time the playhead wants right now (NaN while playing or off the clip) */
  target: number;
  /** start time of the frame the element shows (requestVideoFrameCallback), NaN until it said so */
  shown: number;
  /** decoded frames for a drag that is faster than the element's seeks (scrubFeed.ts), made on the first such drag */
  feed: ScrubFeed | null;
  /** timer of the element's seek that waits for the drag to rest (0: none) */
  settle: number;
  /** seek tolerance of the last paused pass (seconds) */
  tol: number;
  cleanup: () => void;
}

/** a video element parked for the next clip of the same file: it keeps its src, decoder and audio graph nodes */
interface ParkedMedia {
  el: HTMLVideoElement;
  node: MediaElementAudioSourceNode | null;
  gain: GainNode | null;
}

interface ImageEntry {
  source: DrawSource | null;
  loading: boolean;
  url: string | undefined;
  lastUsed: number;
}

export class PreviewEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly pool = new Map<string, MediaEntry>();
  private readonly images = new Map<string, ImageEntry>();
  /** video elements of clips that left the window, by url (see destroyEntry / createEntry) */
  private readonly parked = new ParkingLot<ParkedMedia>();
  /** sync() already swept the pool for stale entries this pass (so a new clip can take their elements) */
  private swept = false;
  /** video frames presented by any pooled element so far (counted in the requestVideoFrameCallback handler) */
  private framesPresented = 0;
  /** what the last painted frame was made of, kept only while playing (see canSkipTick); null = paint on the next tick */
  private lastFrame: FrameRecord | null = null;
  /** something changed that the canvas might show but did not ask for a draw itself: the next tick paints */
  private mustDraw = false;
  private readonly unsubs: Array<() => void> = [];
  private audioCtx: AudioContext | null = null;
  private audioFailed = false;
  private cssW = 0;
  private cssH = 0;
  private rafId = 0;
  private dirty = false;
  private hasDrawn = false;
  private gen = 0;
  private disposed = false;
  private holdSince = 0;
  private holdTimer = 0;
  private readonly neededScratch = new Set<string>();
  private evictProject: Project | null = null;
  private evictTime = -Infinity;
  private evictSize = 0;
  private drawQueued = false;
  private imageTick = 0;
  private dprOff: (() => void) | null = null;
  private lineColor: LineColor | null = null;
  /** a still is being saved: only the elements' own frames are drawn, not the scrub feeds' */
  private elementsOnly = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d canvas is not available');
    this.ctx = ctx;

    this.unsubs.push(
      usePlayback.subscribe((s, prev) => {
        if (s.playing !== prev.playing) {
          if (s.playing) this.ensureAudio();
          this.sync();
          this.invalidate();
          return;
        }
        // shuttle key / speed menu while playing: every active element follows at once
        if (s.rate !== prev.rate && s.playing) {
          this.mustDraw = true;
          this.sync();
        }
        if (s.volume !== prev.volume || s.muted !== prev.muted) this.applyGains();
        if (s.time !== prev.time) {
          this.sync();
          // draw right inside the clock's own frame while playing so the picture never lags a frame.
          // the clock ticks every animation frame, so this is also what animates an effect over a still
          // image or text (hasEffectsAt is true, nothing else on screen changes); every tick must paint
          if (s.playing) {
            if (!this.canSkipTick(s.time)) this.draw();
          } else this.invalidate();
        }
      }),
    );
    this.unsubs.push(
      useEditor.subscribe((s, prev) => {
        // any change of the store (not only the project) is painted by the next tick, as before
        this.mustDraw = true;
        if (s.project === prev.project) return;
        if (s.project && prev.project && (s.project.width !== prev.project.width || s.project.height !== prev.project.height)) {
          this.applyBackingSize();
          // bitmaps are decoded bounded by the project size: decode again at the new bound
          this.clearImages();
        }
        if (s.project?.assets !== prev.project?.assets) this.pruneImages(s.project);
        this.sync();
        // a closed project, another project or changed assets: parked elements of urls nobody uses any more go
        if (s.project?.assets !== prev.project?.assets) this.purgeParked(s.project);
        // edits while paused draw in the same frame as the gesture that made them (the selection box moves
        // synchronously); a raf would show the picture one frame late
        if (usePlayback.getState().playing) this.invalidate();
        else this.drawSoon();
      }),
    );
    // preview quality: another backing size, same css size
    this.unsubs.push(
      usePreviewQuality.subscribe((q, prev) => {
        if (q.quality === prev.quality) return;
        this.applyBackingSize();
        this.invalidate();
      }),
    );
    // scene view: mode switch and the free camera redraw the canvas
    this.unsubs.push(
      useUi.subscribe((s, prev) => {
        this.mustDraw = true;
        if (s.previewMode === prev.previewMode) return;
        this.invalidate();
      }),
    );
    this.unsubs.push(
      useSceneCamera.subscribe(() => {
        if (useUi.getState().previewMode !== 'scene') return;
        if (usePlayback.getState().playing) this.invalidate();
        else this.drawSoon();
      }),
    );
    // helper lines of the scene view use the theme's text color: read once per theme change
    if (typeof window !== 'undefined') {
      const onTheme = () => {
        this.lineColor = null;
        this.invalidate();
      };
      window.addEventListener(APPEARANCE_EVENT, onTheme);
      this.unsubs.push(() => window.removeEventListener(APPEARANCE_EVENT, onTheme));
    }
    // a font that finished loading changes how text measures and draws
    this.unsubs.push(onFontsChanged(() => this.invalidate()));
    this.watchDpr();
    this.unsubs.push(() => this.dprOff?.());
    // text clips drawn before their web font finished loading must be redrawn once it arrives
    if (typeof document !== 'undefined' && document.fonts) {
      const onFonts = () => this.invalidate();
      document.fonts.addEventListener('loadingdone', onFonts);
      this.unsubs.push(() => document.fonts.removeEventListener('loadingdone', onFonts));
    }
    this.sync();
  }

  /** css size of the canvas (largest project-aspect rect that fits the stage). */
  resize(cssW: number, cssH: number): void {
    if (this.disposed) return;
    if (cssW === this.cssW && cssH === this.cssH) return;
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.applyBackingSize();
    this.invalidate();
  }

  /** re-apply the backing size when the window moves to a display with another pixel ratio */
  private watchDpr(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const arm = () => {
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      const onChange = () => {
        mq.removeEventListener('change', onChange);
        if (this.disposed) return;
        this.applyBackingSize();
        this.invalidate();
        arm();
      };
      mq.addEventListener('change', onChange);
      this.dprOff = () => mq.removeEventListener('change', onChange);
    };
    arm();
  }

  /** backing store = css size x dpr, never more than the project resolution */
  private applyBackingSize(): void {
    const project = useEditor.getState().project;
    if (!project || this.cssW <= 0 || this.cssH <= 0) return;
    // the quality only shrinks the backing store: the css size (and with it the overlay math) stays
    const { w, h } = backingSize(this.cssW, this.cssH, project.width, project.height, window.devicePixelRatio || 1, usePreviewQuality.getState().quality);
    // assigning width/height clears the canvas, so only touch them when they really change
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.hasDrawn = false;
    this.dirty = true;
  }

  /** schedule one redraw on the next animation frame (coalesced) */
  invalidate(): void {
    if (this.disposed || this.rafId) return;
    this.dirty = true;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      if (this.dirty) this.draw();
    });
  }

  /** coalesced draw in a microtask: runs right after the current callback, still inside the same frame */
  private drawSoon(): void {
    if (this.disposed) return;
    this.dirty = true;
    if (this.drawQueued) return;
    this.drawQueued = true;
    queueMicrotask(() => {
      this.drawQueued = false;
      if (this.dirty && !this.disposed) this.draw();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.clearHoldTimer();
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    for (const entry of Array.from(this.pool.values())) this.destroyEntry(entry);
    this.pool.clear();
    this.discardAll(this.parked.clear());
    for (const img of this.images.values()) this.closeImage(img);
    this.images.clear();
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
    // give back the preview channel's gl contexts and scratch canvases (a remount rebuilds them on first use)
    releaseRenderResources('preview');
  }

  /* ---------- drawing ---------- */

  /**
   * the frame at the playhead as a png at the full project resolution: the same renderFrame and the same
   * picture sources as the preview, at quality 1 (full motion blur). null when it cannot be made.
   */
  async frameBlob(): Promise<Blob | null> {
    const project = useEditor.getState().project;
    if (this.disposed || !project || typeof OffscreenCanvas === 'undefined') return null;
    // a drag that the scrub feed served: the elements go to the playhead now instead of when the drag has rested
    for (const entry of this.pool.values()) {
      if (!entry.settle) continue;
      this.dropSettle(entry);
      if (!entry.failed && Number.isFinite(entry.target)) this.seek(entry, entry.target, entry.tol);
    }
    // a video that is still landing on this frame would be captured one frame behind: wait for it, but not for long
    const waitStart = performance.now();
    while (this.anySeeking(project, usePlayback.getState().time, false, true) && performance.now() - waitStart < HOLD_MAX_MS) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
      if (this.disposed) return null;
    }
    const canvas = new OffscreenCanvas(project.width, project.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return null;
    try {
      this.elementsOnly = true;
      try {
        renderFrame(ctx, project, usePlayback.getState().time, this.resolve, { quality: 1 });
      } finally {
        this.elementsOnly = false;
      }
      return await canvas.convertToBlob({ type: 'image/png' });
    } finally {
      // an OffscreenCanvas draws on the export channel: give back its full size canvases and gl contexts,
      // unless an export is using them right now
      if (!isExporting()) releaseRenderResources('export');
    }
  }

  /** returns true when a frame was painted */
  private draw(): boolean {
    if (this.disposed) return false;
    this.dirty = false;
    this.mustDraw = false;
    this.lastFrame = null;
    const project = useEditor.getState().project;
    const { time, playing } = usePlayback.getState();
    const { ctx, canvas } = this;
    if (!project || canvas.width <= 0) return false;

    // keep the last picture until in-flight seeks / loads land (no flash of background), but never for long
    if (this.hasDrawn && this.anySeeking(project, time, playing)) {
      const now = performance.now();
      if (this.holdSince === 0) this.holdSince = now;
      if (now - this.holdSince < HOLD_MAX_MS) {
        // nothing else may invalidate when a seek never completes: draw once more when the hold runs out
        this.armHoldTimer(HOLD_MAX_MS - (now - this.holdSince) + 1);
        return false;
      }
    }
    this.holdSince = 0;
    this.clearHoldTimer();

    const k = canvas.width / project.width;
    ctx.setTransform(k, 0, 0, canvas.height / project.height, 0, 0);
    if (useUi.getState().previewMode === 'scene') {
      const cam = toCamera3D(currentOrbit(project), project);
      renderSceneView(ctx, project, time, this.resolve, cam, this.sceneLineColor());
    } else {
      // while playing, motion blur uses fewer samples so the preview stays smooth
      renderFrame(ctx, project, time, this.resolve, { quality: playing ? 0.5 : 1 });
    }
    this.hasDrawn = true;
    if (!playing) this.flushWants();
    else if (SKIP_UNCHANGED_FRAMES && useUi.getState().previewMode !== 'scene') this.lastFrame = this.frameRecord(project, time);
    return true;
  }

  /** what a frame at this time is made of, with the engine's own counters (see repaintSkip) */
  private frameRecord(project: Project, time: number): FrameRecord & { videos: VideoClip[] } {
    const info = frameInfo(project, time);
    return {
      project,
      key: info.key,
      allStatic: info.allStatic,
      time,
      frames: this.framesPresented,
      width: this.canvas.width,
      height: this.canvas.height,
      videos: info.videos,
    };
  }

  /**
   * a running clock ticked: can this tick leave the canvas as it is? only when nothing can look different from the
   * last painted frame: no draw was asked for, no video presented a new frame, the same clips are on screen, and all of
   * them are static (frameStatic.ts). anything else paints, exactly as before.
   */
  private canSkipTick(time: number): boolean {
    const last = this.lastFrame;
    if (!SKIP_UNCHANGED_FRAMES || !last || !last.allStatic || this.disposed) return false;
    // cheap exits first: a pending draw request, a store change, a new video frame
    if (this.dirty || this.mustDraw || this.holdTimer || this.framesPresented !== last.frames) return false;
    const project = useEditor.getState().project;
    if (!project || project !== last.project || this.canvas.width <= 0) return false;
    const sceneView = useUi.getState().previewMode === 'scene';
    if (sceneView) return false;
    const now = this.frameRecord(project, time);
    let videosReady = true;
    for (const v of now.videos) {
      const entry = this.pool.get(v.id);
      if (!entry || entry.failed || entry.kind !== 'video') {
        videosReady = false;
        break;
      }
      const el = entry.el as RvfcElement;
      // without requestVideoFrameCallback there is no way to know a new frame arrived: always paint
      if (el.seeking || el.readyState < 2 || typeof el.requestVideoFrameCallback !== 'function') {
        videosReady = false;
        break;
      }
    }
    return canSkipRepaint(last, now, { enabled: SKIP_UNCHANGED_FRAMES, playing: true, sceneView, pending: false, videosReady });
  }

  private armHoldTimer(ms: number): void {
    if (this.holdTimer || this.disposed) return;
    this.holdTimer = window.setTimeout(() => {
      this.holdTimer = 0;
      if (!this.disposed) this.draw();
    }, ms);
  }

  private clearHoldTimer(): void {
    if (!this.holdTimer) return;
    window.clearTimeout(this.holdTimer);
    this.holdTimer = 0;
  }

  /** the theme's text color as straight rgba 0..1 (cached until the theme changes) */
  private sceneLineColor(): LineColor {
    if (this.lineColor) return this.lineColor;
    let out = FALLBACK_LINE;
    try {
      const host = this.canvas.parentElement ?? document.body;
      const probe = document.createElement('span');
      probe.style.color = 'var(--text)';
      probe.style.display = 'none';
      host.appendChild(probe);
      const css = getComputedStyle(probe).color;
      host.removeChild(probe);
      // let a 1x1 canvas turn any css color syntax (oklch ...) into rgb
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 1;
      const cx = c.getContext('2d', { willReadFrequently: true });
      if (cx && css) {
        cx.fillStyle = css;
        cx.fillRect(0, 0, 1, 1);
        const d = cx.getImageData(0, 0, 1, 1).data;
        out = [d[0]! / 255, d[1]! / 255, d[2]! / 255, 0.6];
      }
    } catch {
      out = FALLBACK_LINE;
    }
    this.lineColor = out;
    return out;
  }

  /** paused: issue the seeks that were deferred while a frame was waiting to be painted */
  private flushWants(): void {
    for (const entry of this.pool.values()) {
      const w = entry.want;
      if (w === null || entry.el.seeking) continue;
      entry.want = null;
      if (Math.abs(entry.el.currentTime - w) > 0.01) this.assignTime(entry, w);
    }
  }

  /** `strict`: the element itself must have landed, a frame of the scrub feed does not count (a saved still) */
  private anySeeking(project: Project, time: number, playing = false, strict = false): boolean {
    const now = performance.now();
    for (const clip of project.clips) {
      if (clip.type !== 'video') continue;
      if (time < clip.start || time >= clip.start + clip.duration) continue;
      const entry = this.pool.get(clip.id);
      if (!entry || entry.failed) continue;
      const el = entry.el;
      // a drag: the feed has a nearer frame than the element, paint that one instead of waiting for the seek
      if (!strict && !playing && this.scrubSource(entry)) continue;
      // a new element is not "seeking" yet but has nothing to show until its first frame loads
      if (
        blocksPaint({
          seeking: el.seeking,
          readyState: el.readyState,
          loading: now - entry.createdAt < LOAD_HOLD_MS,
          scrubbing: entry.scrub,
          playing,
        })
      )
        return true;
    }
    return false;
  }

  /** the picture of a media clip right now (the pooled element / decoded image). also used by the camera inset. */
  readonly resolve = (clip: VideoClip | ImageClip, _sourceTime: number): DrawSource | null => {
    if (clip.type === 'video') {
      const entry = this.pool.get(clip.id);
      if (!entry || entry.kind !== 'video') return null;
      const v = entry.el as HTMLVideoElement;
      // the feed's frame first: a seeking element can have nothing to draw for a moment (readyState drops)
      const scrubbed = this.scrubSource(entry);
      if (scrubbed) return scrubbed;
      if (v.readyState < 2 || v.videoWidth === 0) return null;
      if (!entry.source) entry.source = { image: v, width: v.videoWidth, height: v.videoHeight };
      else {
        entry.source.width = v.videoWidth;
        entry.source.height = v.videoHeight;
      }
      return entry.source;
    }
    return this.imageSource(clip.assetId);
  };

  /**
   * paused, the playhead is being dragged: the frame of the entry's scrub feed, when that is nearer to the wanted
   * time than the frame the element shows. null: the element's picture is the one to draw
   */
  private scrubSource(entry: MediaEntry): DrawSource | null {
    const feed = entry.feed;
    if (!feed || this.elementsOnly || entry.kind !== 'video' || !Number.isFinite(entry.target) || !Number.isFinite(entry.shown)) return null;
    if (usePlayback.getState().playing) return null;
    const v = entry.el as HTMLVideoElement;
    return feed.nearer(entry.target, entry.shown, v.videoWidth, v.videoHeight);
  }

  /** the element seeks to the playhead when no newer wanted time came for SETTLE_MS */
  private settleLater(entry: MediaEntry): void {
    if (entry.settle) window.clearTimeout(entry.settle);
    entry.settle = window.setTimeout(() => {
      entry.settle = 0;
      if (this.disposed || this.pool.get(entry.clipId) !== entry || entry.failed) return;
      if (usePlayback.getState().playing || !Number.isFinite(entry.target)) return;
      this.seek(entry, entry.target, entry.tol);
    }, SETTLE_MS);
  }

  private dropSettle(entry: MediaEntry): void {
    if (!entry.settle) return;
    window.clearTimeout(entry.settle);
    entry.settle = 0;
  }

  /** the drag is ahead of the element's seeks: let the entry's feed decode towards the wanted time */
  private feedWant(entry: MediaEntry, target: number): void {
    if (!entry.feed) {
      const blob = getAssetBlob(entry.assetId);
      if (!blob) return;
      entry.feed = new ScrubFeed(blob, () => {
        if (this.disposed || this.pool.get(entry.clipId) !== entry) return;
        if (!usePlayback.getState().playing) this.invalidate();
      });
    }
    entry.feed.want(target);
  }

  /* ---------- images ---------- */

  private imageSource(assetId: string): DrawSource | null {
    let entry = this.images.get(assetId);
    const url = getAssetUrl(assetId);
    if (entry && entry.url !== url) {
      this.closeImage(entry);
      this.images.delete(assetId);
      entry = undefined;
    }
    if (!entry) {
      entry = { source: null, loading: false, url, lastUsed: 0 };
      this.images.set(assetId, entry);
    }
    entry.lastUsed = ++this.imageTick;
    if (entry.source) return entry.source;
    if (!entry.loading && url) {
      entry.loading = true;
      void this.loadImage(assetId, entry, url);
    }
    return null;
  }

  private async loadImage(assetId: string, entry: ImageEntry, url: string): Promise<void> {
    let source: DrawSource | null = null;
    const blob = getAssetBlob(assetId);
    if (blob) {
      try {
        const project = useEditor.getState().project;
        const asset = project?.assets.find((a) => a.id === assetId);
        const nw = asset?.width ?? 0;
        const nh = asset?.height ?? 0;
        // decode no larger than the preview can show (up to 2x the project for scaled-up clips)
        const k = project && nw > 0 && nh > 0 ? (2 * Math.max(project.width, project.height)) / Math.max(nw, nh) : 1;
        if (k < 1) {
          const bmp = await createImageBitmap(blob, {
            resizeWidth: Math.max(1, Math.round(nw * k)),
            resizeHeight: Math.max(1, Math.round(nh * k)),
            resizeQuality: 'high',
          });
          // report the natural size so clip boxes are unchanged
          source = { image: bmp, width: nw, height: nh };
        } else {
          const bmp = await createImageBitmap(blob);
          source = { image: bmp, width: bmp.width, height: bmp.height };
        }
      } catch {
        source = null;
      }
    }
    if (!source) {
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        source = { image: img, width: img.naturalWidth || 1, height: img.naturalHeight || 1 };
      } catch {
        source = null;
      }
    }
    entry.loading = false;
    if (this.disposed || this.images.get(assetId) !== entry) {
      if (source && source.image instanceof ImageBitmap) source.image.close();
      return;
    }
    if (source) {
      entry.source = source;
      this.invalidate();
    } else {
      // give up for this url so a broken file is not retried every frame
      entry.loading = true;
    }
  }

  private closeImage(entry: ImageEntry): void {
    if (entry.source && entry.source.image instanceof ImageBitmap) entry.source.image.close();
    entry.source = null;
  }

  private clearImages(): void {
    for (const img of this.images.values()) this.closeImage(img);
    this.images.clear();
  }

  /** keep only the bitmaps near the playhead plus a small lru; the rest is decoded again on demand */
  private evictImages(project: Project, time: number): void {
    if (this.images.size <= IMAGE_LRU) return;
    // sync() runs on every clock tick: only look again when the answer can have changed
    if (project === this.evictProject && this.images.size === this.evictSize && Math.abs(time - this.evictTime) < EVICT_STEP) return;
    this.evictProject = project;
    this.evictTime = time;
    const needed = neededImageAssets(project, time, transitionHolds(project), LOOKAHEAD, LINGER, this.neededScratch);
    const candidates = Array.from(this.images).filter(([id]) => !needed.has(id));
    candidates.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let over = this.images.size - IMAGE_LRU;
    for (const [id, entry] of candidates) {
      if (over <= 0) break;
      this.closeImage(entry);
      this.images.delete(id);
      over--;
    }
    this.evictSize = this.images.size;
  }

  private pruneImages(project: Project | null): void {
    if (this.images.size === 0) return;
    for (const [id, entry] of Array.from(this.images)) {
      if (!project || !project.assets.some((a) => a.id === id)) {
        this.closeImage(entry);
        this.images.delete(id);
      }
    }
  }

  /* ---------- audio graph ---------- */

  /** lazily create the shared AudioContext (called from a play gesture) and route existing elements */
  private ensureAudio(): void {
    if (this.audioFailed) return;
    if (!this.audioCtx) {
      try {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) {
          this.audioFailed = true;
          return;
        }
        this.audioCtx = new Ctor();
      } catch {
        this.audioFailed = true;
        return;
      }
      for (const entry of this.pool.values()) this.routeEntry(entry);
    }
    if (this.audioCtx.state === 'suspended') void this.audioCtx.resume().catch(() => undefined);
  }

  private routeEntry(entry: MediaEntry): void {
    const ac = this.audioCtx;
    if (!ac || entry.node) return;
    try {
      const node = ac.createMediaElementSource(entry.el);
      const gain = ac.createGain();
      node.connect(gain);
      gain.connect(ac.destination);
      entry.node = node;
      entry.gain = gain;
      entry.el.volume = 1;
      entry.lastGain = -1;
    } catch {
      entry.node = null;
      entry.gain = null;
    }
  }

  private applyGains(): void {
    const project = useEditor.getState().project;
    if (!project) return;
    const time = usePlayback.getState().time;
    for (const clip of project.clips) {
      if (clip.type !== 'video' && clip.type !== 'audio') continue;
      const entry = this.pool.get(clip.id);
      if (entry) this.setGain(entry, clip, project, time);
    }
  }

  private setGain(entry: MediaEntry, clip: VideoClip | AudioClip, project: Project, time: number): void {
    const { volume, muted } = usePlayback.getState();
    const track = project.tracks.find((t) => t.id === clip.trackId);
    const silent = entry.rateMute || clip.muted || !track || track.muted || muted;
    // volume may be keyframed
    const g = silent ? 0 : (valueAt(clip, 'volume', time) ?? clip.volume) * fadeFactor(clip, time) * volume;
    if (Math.abs(g - entry.lastGain) < 1e-4) return;
    entry.lastGain = g;
    if (entry.gain) entry.gain.gain.value = g;
    else entry.el.volume = clamp(g, 0, 1);
  }

  /* ---------- media pool + clock sync ---------- */

  /** bring the pool and the element states in line with the project and the clock */
  private sync(): void {
    if (this.disposed) return;
    const project = useEditor.getState().project;
    const { time, playing, rate } = usePlayback.getState();
    this.gen++;
    this.swept = false;
    if (project) {
      const holds = transitionHolds(project);
      for (const clip of project.clips) {
        if (clip.type !== 'video' && clip.type !== 'audio') continue;
        if (!this.inWindow(clip, holds, time)) continue;
        const entry = this.ensureEntry(clip, project, holds, time);
        if (!entry) continue;
        entry.gen = this.gen;
        this.syncEntry(entry, clip, project, time, playing, time >= clip.start && time < clip.start + clip.duration, rate);
        this.setGain(entry, clip, project, time);
      }
      this.evictImages(project, time);
    }
    for (const entry of Array.from(this.pool.values())) {
      if (entry.gen !== this.gen) this.destroyEntry(entry);
    }
  }

  /** is the clip's element wanted at this time (its range, the lookahead / linger, the frozen edges of a transition) */
  private inWindow(clip: VideoClip | AudioClip, holds: ReturnType<typeof transitionHolds>, time: number): boolean {
    const end = clip.start + clip.duration;
    // a clip in a transition shows its frozen first / last frame outside its own range
    const hold = holds.get(clip.id);
    const before = hold ? Math.max(LOOKAHEAD, hold.before + 0.25) : LOOKAHEAD;
    const after = hold ? Math.max(LINGER, hold.after + 0.1) : LINGER;
    return !(time < clip.start - before || time >= end + after);
  }

  /**
   * destroy (park) the pool entries that this pass no longer wants, ahead of creating a new one: a clip entering the
   * window can then take the element of a clip of the same file that is leaving it in the same pass (a jump across cuts)
   */
  private sweepStale(project: Project, holds: ReturnType<typeof transitionHolds>, time: number): void {
    this.swept = true;
    for (const clip of project.clips) {
      if (clip.type !== 'video' && clip.type !== 'audio') continue;
      const e = this.pool.get(clip.id);
      if (!e || e.assetId !== clip.assetId || e.url !== getAssetUrl(clip.assetId)) continue;
      if (this.inWindow(clip, holds, time)) e.gen = this.gen;
    }
    for (const entry of Array.from(this.pool.values())) {
      if (entry.gen !== this.gen) this.destroyEntry(entry);
    }
  }

  private syncEntry(
    entry: MediaEntry,
    clip: VideoClip | AudioClip,
    project: Project,
    time: number,
    playing: boolean,
    active: boolean,
    rate: number,
  ): void {
    const el = entry.el;
    entry.rateMute = false;
    const wasScrub = entry.scrub;
    entry.scrub = false;
    entry.target = Number.NaN;
    // leaving a scrub (shuttle changed or stopped, clip no longer under the playhead): drop the stale deferred
    // target, the normal path aims again
    if (wasScrub && (!active || !playing || rate === 1)) entry.want = null;
    // seek tolerance: half a timeline frame, in source seconds (depends on the clip speed)
    const halfFrame = Math.max(0.001, (0.5 / (project.fps || 30)) * clip.speed);
    if (entry.failed) return;
    const dur = Number.isFinite(el.duration) ? el.duration : Infinity;
    const toSource = (t: number) => clamp(t, 0, Math.max(0, dur - 0.001));

    if (!active) {
      this.dropSettle(entry);
      // lookahead (or just ended): keep it parked on its first frame, silent
      if (!el.paused) el.pause();
      const park = toSource(clip.trimStart);
      if (time < clip.start) this.seek(entry, park, halfFrame);
      // ended: a video rests on its last frame (a transition out of it shows that frame)
      else if (clip.type === 'video') this.seek(entry, toSource(sourceTimeAt(clip, clip.start + clip.duration) - halfFrame), halfFrame * 2);
      return;
    }

    const target = toSource(sourceTimeAt(clip, time));
    if (!playing) {
      if (!el.paused) el.pause();
      entry.target = target;
      entry.tol = halfFrame;
      // the element is still on its way to an older time (or waits for the drag to rest): a drag it cannot keep up
      // with. only when the element says which frame it shows: without that the feed's frames are never drawn
      if (entry.kind === 'video' && Number.isFinite(entry.shown) && (el.seeking || entry.settle !== 0)) {
        this.feedWant(entry, target);
        if (entry.feed?.leads(target)) {
          // the feed brings the pictures. the element would start every seek at a key frame and take the decoder
          // from the feed: it goes to the playhead once, when the drag rests
          entry.want = null;
          this.settleLater(entry);
          return;
        }
      }
      this.dropSettle(entry);
      this.seek(entry, target, halfFrame);
      return;
    }
    // the clock runs: the decoder of the feed is given back
    this.dropSettle(entry);
    entry.feed?.rest();

    // rate 1 is the plain path. other rates: the element plays at clip speed * rate, or (backwards, or a rate
    // browsers refuse) it stays paused and is seeked to the clock like a scrub. audio is silent in that case,
    // and above 4x forward (it would only be a squeal)
    let pr = clip.speed;
    if (rate !== 1) {
      pr = mediaPlaybackRate(clip.speed, rate);
      entry.rateMute = pr === 0 || !rateAudible(rate);
      if (pr === 0) {
        entry.scrub = isScrubbing(playing, rate, pr, entry.kind === 'video');
        if (!el.paused) el.pause();
        this.seek(entry, target, halfFrame);
        return;
      }
    }
    // left a scrub into another rate the element can play: the deferred target is stale
    if (staleScrubTarget(wasScrub, entry.scrub)) entry.want = null;
    if (el.playbackRate !== pr) el.playbackRate = pr;
    if (el.paused) {
      // play() on an ended element restarts it from 0: only play when it is not parked at the end
      const off = Math.abs(el.currentTime - target) > 0.05;
      if (off) this.seek(entry, toSource(sourceTimeAt(clip, time + entry.seekCost * rate)), 0.05);
      if (off || !el.ended) void el.play().catch(() => undefined);
    } else if (
      !el.seeking &&
      performance.now() >= entry.holdUntil &&
      // drift in timeline seconds (the target follows the clock), so the threshold depends on neither clip speed nor rate
      Math.abs(el.currentTime - target) / clip.speed > DRIFT
    ) {
      // aim ahead by the measured seek latency so the element lands on the clock instead of behind it
      this.seek(entry, toSource(sourceTimeAt(clip, time + entry.seekCost * rate)), 0.01);
    }
  }

  /** coalesced seek: never queue a new seek while one is in flight, remember the latest target */
  private seek(entry: MediaEntry, target: number, tol: number): void {
    const el = entry.el;
    if (el.seeking) {
      entry.want = target;
      return;
    }
    if (Math.abs(el.currentTime - target) <= tol) {
      entry.want = null;
      return;
    }
    entry.want = null;
    this.assignTime(entry, target);
  }

  private assignTime(entry: MediaEntry, target: number): void {
    try {
      entry.el.currentTime = target;
      entry.seekStart = performance.now();
    } catch {
      // metadata not available yet: the loadedmetadata handler re-syncs
    }
  }

  private ensureEntry(clip: VideoClip | AudioClip, project: Project, holds: ReturnType<typeof transitionHolds>, time: number): MediaEntry | null {
    const url = getAssetUrl(clip.assetId);
    let entry = this.pool.get(clip.id);
    if (entry && (entry.assetId !== clip.assetId || entry.url !== url)) {
      this.destroyEntry(entry);
      entry = undefined;
    }
    if (entry) return entry;
    if (!url) return null;
    if (!this.swept) this.sweepStale(project, holds, time);
    return this.createEntry(clip, url);
  }

  private createEntry(clip: Clip & { assetId: string }, url: string): MediaEntry {
    const isVideo = clip.type === 'video';
    // a parked element of the same file (metadata and decoder already there) is set up like a new one
    const parked = isVideo ? this.parked.take(url) : undefined;
    let el: HTMLVideoElement | HTMLAudioElement;
    if (parked) {
      el = parked.el;
      el.muted = false;
      el.volume = 1;
      el.playbackRate = 1;
    } else {
      el = isVideo ? document.createElement('video') : document.createElement('audio');
      el.preload = 'auto';
      el.muted = false;
      // pitch follows speed, same as the export which resamples (no time stretch)
      setPreservesPitch(el, false);
      if (el instanceof HTMLVideoElement) el.playsInline = true;
      el.src = url;
    }

    const entry: MediaEntry = {
      clipId: clip.id,
      assetId: clip.assetId,
      url,
      kind: isVideo ? 'video' : 'audio',
      el,
      gen: this.gen,
      want: null,
      failed: false,
      source: null,
      rvfc: 0,
      gain: parked ? parked.gain : null,
      node: parked ? parked.node : null,
      lastGain: -1,
      createdAt: performance.now(),
      seekStart: 0,
      seekCost: 0.1,
      holdUntil: 0,
      rateMute: false,
      scrub: false,
      target: Number.NaN,
      shown: Number.NaN,
      feed: null,
      settle: 0,
      tol: 0.001,
      cleanup: () => undefined,
    };

    const onSeeked = () => {
      const now = performance.now();
      if (entry.seekStart > 0) {
        entry.seekCost = clamp((now - entry.seekStart) / 1000, 0, 1);
        entry.seekStart = 0;
      }
      entry.holdUntil = now + 400;
      const w = entry.want;
      const playing = usePlayback.getState().playing;
      const act = onSeekedAction({ playing, scrubbing: entry.scrub, want: w, current: el.currentTime });
      // paused scrub: paint the frame that just landed before chasing the newer target, otherwise a moving
      // playhead replaces every landed frame and nothing is ever shown. draw() issues the deferred seek itself
      // once it painted (or later, if another video is still seeking).
      // running clock scrub (backwards shuttle): same, paint first, then chase the target here
      if (playing) entry.want = null;
      if (act.draw) this.draw();
      if (act.seek && w !== null) this.assignTime(entry, w);
      if (act.invalidate) this.invalidate();
    };
    const onReady = () => {
      this.invalidate();
    };
    const onMeta = () => {
      // metadata arrived: positions set earlier may have been clamped, re-sync once
      this.sync();
      this.invalidate();
    };
    const onError = () => {
      entry.failed = true;
      this.invalidate();
    };
    el.addEventListener('seeked', onSeeked);
    el.addEventListener('loadeddata', onReady);
    el.addEventListener('canplay', onReady);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('error', onError);

    // redraw exactly when a new video frame is presented (paused redraws; while playing the clock draws)
    const v = el as RvfcElement;
    if (isVideo && typeof v.requestVideoFrameCallback === 'function') {
      const onFrame = (_now: number, meta?: { mediaTime?: number }) => {
        if (this.disposed || this.pool.get(entry.clipId) !== entry) return;
        // which frame the element shows now (a paused seek can say 'seeked' before its picture is there)
        entry.shown = typeof meta?.mediaTime === 'number' ? meta.mediaTime : Number.NaN;
        this.framesPresented++;
        if (!usePlayback.getState().playing) this.invalidate();
        entry.rvfc = v.requestVideoFrameCallback!(onFrame);
      };
      entry.rvfc = v.requestVideoFrameCallback(onFrame);
    }

    entry.cleanup = () => {
      el.removeEventListener('seeked', onSeeked);
      el.removeEventListener('loadeddata', onReady);
      el.removeEventListener('canplay', onReady);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('error', onError);
      if (entry.rvfc && typeof v.cancelVideoFrameCallback === 'function') v.cancelVideoFrameCallback(entry.rvfc);
      entry.rvfc = 0;
    };

    this.pool.set(clip.id, entry);
    if (this.audioCtx) this.routeEntry(entry);
    // a parked element will not fire loadeddata / canplay again: ask for the redraw those events would have asked for
    if (parked) this.invalidate();
    return entry;
  }

  /** can this entry's element be parked: a healthy video of a url that is still the asset's current one */
  private canPark(entry: MediaEntry): boolean {
    if (this.disposed || entry.kind !== 'video' || entry.failed) return false;
    if ((entry.el as HTMLVideoElement).error) return false;
    return getAssetUrl(entry.assetId) === entry.url;
  }

  private destroyEntry(entry: MediaEntry): void {
    entry.cleanup();
    this.dropSettle(entry);
    entry.feed?.dispose();
    entry.feed = null;
    if (this.pool.get(entry.clipId) === entry) this.pool.delete(entry.clipId);
    entry.source = null;
    if (this.canPark(entry)) {
      const el = entry.el as HTMLVideoElement;
      // silent and still, but with its src, decoder and audio graph nodes (a media element can be captured by a
      // MediaElementAudioSourceNode only once, so the nodes stay with the element)
      el.pause();
      el.muted = true;
      if (entry.gain) entry.gain.gain.value = 0;
      const out = this.parked.park(entry.url, { el, node: entry.node, gain: entry.gain });
      entry.node = null;
      entry.gain = null;
      this.discardAll(out);
      return;
    }
    // the url is gone or changed: parked elements of it cannot be reused either
    if (getAssetUrl(entry.assetId) !== entry.url) this.discardAll(this.parked.evictUrl(entry.url));
    this.unloadMedia({ el: entry.el, node: entry.node, gain: entry.gain });
    entry.node = null;
    entry.gain = null;
  }

  /** really give back an element: no src, no decoder, no audio graph nodes */
  private unloadMedia(m: { el: HTMLMediaElement; node: MediaElementAudioSourceNode | null; gain: GainNode | null }): void {
    m.el.pause();
    m.el.removeAttribute('src');
    m.el.load();
    if (m.node) {
      try {
        m.node.disconnect();
      } catch {
        // already disconnected
      }
    }
    if (m.gain) {
      try {
        m.gain.disconnect();
      } catch {
        // already disconnected
      }
    }
  }

  private discardAll(list: ParkedMedia[]): void {
    for (const m of list) this.unloadMedia(m);
  }

  /** drop the parked elements whose url no asset of the project (if any) has any more */
  private purgeParked(project: Project | null): void {
    if (this.parked.size === 0) return;
    const live = new Set<string | undefined>();
    if (project) for (const a of project.assets) live.add(getAssetUrl(a.id));
    this.discardAll(this.parked.evictWhere((u) => !live.has(u)));
  }
}
