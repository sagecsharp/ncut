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
import { renderFrame } from '../../engine/draw';
import type { DrawSource } from '../../engine/draw';
import { fadeFactor, sourceTimeAt } from '../../lib/timelineOps';
import { clamp } from '../../lib/time';
import { getAssetBlob, getAssetUrl } from '../../media/registry';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';

/** seconds before a clip starts that its element is created and pre-positioned */
const LOOKAHEAD = 1.5;
/** seconds after a clip ends that its element is kept (avoids churn at the boundary) */
const LINGER = 0.25;
/** playing: only correct currentTime when the element drifts further than this */
const DRIFT = 0.15;

type RvfcElement = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

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
  cleanup: () => void;
}

interface ImageEntry {
  source: DrawSource | null;
  loading: boolean;
  url: string | undefined;
}

export class PreviewEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly pool = new Map<string, MediaEntry>();
  private readonly images = new Map<string, ImageEntry>();
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
        if (s.volume !== prev.volume || s.muted !== prev.muted) this.applyGains();
        if (s.time !== prev.time) {
          this.sync();
          // draw right inside the clock's own frame while playing so the picture never lags a frame
          if (s.playing) this.draw();
          else this.invalidate();
        }
      }),
    );
    this.unsubs.push(
      useEditor.subscribe((s, prev) => {
        if (s.project === prev.project) return;
        if (s.project && prev.project && (s.project.width !== prev.project.width || s.project.height !== prev.project.height)) {
          this.applyBackingSize();
        }
        if (s.project?.assets !== prev.project?.assets) this.pruneImages(s.project);
        this.sync();
        this.invalidate();
      }),
    );
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

  /** backing store = css size x dpr, never more than the project resolution */
  private applyBackingSize(): void {
    const project = useEditor.getState().project;
    if (!project || this.cssW <= 0 || this.cssH <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const k = Math.min(dpr, project.width / this.cssW, project.height / this.cssH);
    const w = Math.max(1, Math.round(this.cssW * k));
    const h = Math.max(1, Math.round(this.cssH * k));
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    for (const entry of Array.from(this.pool.values())) this.destroyEntry(entry);
    this.pool.clear();
    for (const img of this.images.values()) this.closeImage(img);
    this.images.clear();
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
  }

  /* ---------- drawing ---------- */

  private draw(): void {
    if (this.disposed) return;
    this.dirty = false;
    const project = useEditor.getState().project;
    const { time, playing } = usePlayback.getState();
    const { ctx, canvas } = this;
    if (!project || canvas.width <= 0) return;

    // while scrubbing, keep the last picture until in-flight seeks land (no flash of background)
    if (!playing && this.hasDrawn && this.anySeeking(project, time)) return;

    const k = canvas.width / project.width;
    ctx.setTransform(k, 0, 0, canvas.height / project.height, 0, 0);
    renderFrame(ctx, project, time, this.resolve);
    this.hasDrawn = true;
  }

  private anySeeking(project: Project, time: number): boolean {
    for (const clip of project.clips) {
      if (clip.type !== 'video') continue;
      if (time < clip.start || time >= clip.start + clip.duration) continue;
      const entry = this.pool.get(clip.id);
      if (entry && !entry.failed && entry.el.seeking) return true;
    }
    return false;
  }

  private readonly resolve = (clip: VideoClip | ImageClip, _sourceTime: number): DrawSource | null => {
    if (clip.type === 'video') {
      const entry = this.pool.get(clip.id);
      if (!entry || entry.kind !== 'video') return null;
      const v = entry.el as HTMLVideoElement;
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
      entry = { source: null, loading: false, url };
      this.images.set(assetId, entry);
    }
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
        const bmp = await createImageBitmap(blob);
        source = { image: bmp, width: bmp.width, height: bmp.height };
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
    const silent = clip.muted || !track || track.muted || muted;
    const g = silent ? 0 : clip.volume * fadeFactor(clip, time) * volume;
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
    const { time, playing } = usePlayback.getState();
    this.gen++;
    if (project) {
      const halfFrame = Math.max(0.01, 0.5 / (project.fps || 30));
      for (const clip of project.clips) {
        if (clip.type !== 'video' && clip.type !== 'audio') continue;
        const end = clip.start + clip.duration;
        if (time < clip.start - LOOKAHEAD || time >= end + LINGER) continue;
        const entry = this.ensureEntry(clip);
        if (!entry) continue;
        entry.gen = this.gen;
        this.syncEntry(entry, clip, project, time, playing, halfFrame, time >= clip.start && time < end);
        this.setGain(entry, clip, project, time);
      }
    }
    for (const entry of Array.from(this.pool.values())) {
      if (entry.gen !== this.gen) this.destroyEntry(entry);
    }
  }

  private syncEntry(
    entry: MediaEntry,
    clip: VideoClip | AudioClip,
    _project: Project,
    time: number,
    playing: boolean,
    halfFrame: number,
    active: boolean,
  ): void {
    const el = entry.el;
    if (entry.failed) return;
    const dur = Number.isFinite(el.duration) ? el.duration : Infinity;
    const toSource = (t: number) => clamp(t, 0, Math.max(0, dur - 0.001));

    if (!active) {
      // lookahead (or just ended): keep it parked on its first frame, silent
      if (!el.paused) el.pause();
      const park = toSource(clip.trimStart);
      if (time < clip.start) this.seek(entry, park, halfFrame);
      return;
    }

    const target = toSource(sourceTimeAt(clip, time));
    if (!playing) {
      if (!el.paused) el.pause();
      this.seek(entry, target, halfFrame);
      return;
    }

    if (el.playbackRate !== clip.speed) el.playbackRate = clip.speed;
    if (el.paused) {
      if (Math.abs(el.currentTime - target) > 0.05) this.seek(entry, target, 0.05);
      void el.play().catch(() => undefined);
    } else if (!el.seeking && Math.abs(el.currentTime - target) > DRIFT) {
      this.seek(entry, target, DRIFT);
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
    try {
      el.currentTime = target;
    } catch {
      // metadata not available yet: the loadedmetadata handler re-syncs
    }
  }

  private ensureEntry(clip: VideoClip | AudioClip): MediaEntry | null {
    const url = getAssetUrl(clip.assetId);
    let entry = this.pool.get(clip.id);
    if (entry && (entry.assetId !== clip.assetId || entry.url !== url)) {
      this.destroyEntry(entry);
      entry = undefined;
    }
    if (entry) return entry;
    if (!url) return null;
    return this.createEntry(clip, url);
  }

  private createEntry(clip: Clip & { assetId: string }, url: string): MediaEntry {
    const isVideo = clip.type === 'video';
    const el: HTMLVideoElement | HTMLAudioElement = isVideo ? document.createElement('video') : document.createElement('audio');
    el.preload = 'auto';
    el.muted = false;
    el.preservesPitch = true;
    if (el instanceof HTMLVideoElement) el.playsInline = true;
    el.src = url;

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
      gain: null,
      node: null,
      lastGain: -1,
      cleanup: () => undefined,
    };

    const onSeeked = () => {
      const w = entry.want;
      if (w !== null) {
        entry.want = null;
        if (Math.abs(el.currentTime - w) > 0.01) {
          try {
            el.currentTime = w;
            return;
          } catch {
            // fall through and just redraw
          }
        }
      }
      this.invalidate();
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
      const onFrame = () => {
        if (this.disposed || this.pool.get(entry.clipId) !== entry) return;
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
    return entry;
  }

  private destroyEntry(entry: MediaEntry): void {
    entry.cleanup();
    const el = entry.el;
    el.pause();
    el.removeAttribute('src');
    el.load();
    if (entry.node) {
      try {
        entry.node.disconnect();
      } catch {
        // already disconnected
      }
    }
    if (entry.gain) {
      try {
        entry.gain.disconnect();
      } catch {
        // already disconnected
      }
    }
    entry.node = null;
    entry.gain = null;
    entry.source = null;
    if (this.pool.get(entry.clipId) === entry) this.pool.delete(entry.clipId);
  }
}
