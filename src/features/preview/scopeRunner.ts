/**
 * the scope runner: listens to the frame tap, reads the picture back on a throttle, bins it and hands it to the
 * strip to paint. live: a small nearest sample while it plays. exact: while paused, every pixel of the frame the
 * export draws (the source view: the media at its own size). it follows the preview mode and nothing else.
 */
import { releaseRenderResources } from '../../engine/draw';
import { isExporting } from '../../engine/exportState';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { REASON_TEXT } from '../shell/reasons';
import { binScopes, EXACT_SAMPLE, LIVE_SAMPLE, lumaLevels, sameKey, sampleSize, scopeDelay, subsample, type BinWants, type ScopeBins } from './scopes';
import { FrameReader, tapSizeOk } from './scopeRead';
import { addFrameTap, scopeDebug, tapCounts, wantFrame, type TapImage, type TapKind } from './scopeTap';
import { useScopes } from './scopesState';

export const EXACT_SETTLE_MS = 300,
  EXACT_RETRY_MS = 1000,
  EXACT_IDLE_MS = 15000;

export interface ScopeHooks {
  /** PreviewEngine.exactFrame(true, true) */
  exactFrame(): Promise<OffscreenCanvas | null>;
  /** bins and hist null: no picture, paint empty cells. pixels: what hist counted. reading null: no picture */
  paint(bins: ScopeBins | null, hist: Uint32Array | null, pixels: number, reading: { how: 'live' | 'exact'; w: number; h: number } | null): void;
  /** '' hides the note */
  note(text: string): void;
  /** false while the tab is hidden or the stage is fullscreen */
  visible(): boolean;
}

interface Tap {
  image: TapImage | null;
  w: number;
  h: number;
  kind: TapKind;
  still: boolean;
}

/** the sample the cells show now, kept to repaint after a kinds or zoom change */
interface Kept {
  data: Uint8ClampedArray;
  w: number;
  h: number;
  /** the histogram of every pixel when the plots use a subsample (exact), else null: the bins' own */
  hist: Uint32Array | null;
  pixels: number;
  reading: { how: 'live' | 'exact'; w: number; h: number };
}

const NO_SOURCE: Tap = { image: null, w: 0, h: 0, kind: 'source', still: true };

export class ScopeRunner {
  private running = false;
  private tap: Tap | null = null;
  private kept: Kept | null = null;
  private bins: ScopeBins | undefined;
  private exactHist: Uint32Array | undefined;
  /** the key of the exact reading that shows now, null when live shows */
  private exactKey: readonly unknown[] | null = null;
  private reader = new FrameReader();
  private waiting = false;
  private timer = 0;
  private raf = 0;
  private settle = 0;
  private idle = 0;
  private rebinRaf = 0;
  private last = -Infinity;
  private cost = 0;
  private gen = 0;
  private down = false;
  private usedChannel = false;
  private offs: (() => void)[] = [];

  constructor(private hooks: ScopeHooks) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    if (useUi.getState().previewMode === 'source') this.tap = NO_SOURCE;
    this.offs.push(addFrameTap(this.onTap));
    this.offs.push(
      useUi.subscribe((s, p) => {
        if (s.previewMode !== p.previewMode) this.onMode(s.previewMode);
      }),
    );
    this.offs.push(
      useScopes.subscribe((s, p) => {
        if (s.exact !== p.exact) this.onExact(s.exact);
        if (s.kinds !== p.kinds || s.vectorZoom !== p.vectorZoom) this.rebin();
      }),
    );
    const onVisible = () => {
      if (this.hooks.visible()) wantFrame();
    };
    const onPointer = (e: PointerEvent) => {
      this.down = e.type === 'pointerdown' ? true : e.buttons > 0;
    };
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('fullscreenchange', onVisible);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('pointerup', onPointer, true);
    window.addEventListener('pointercancel', onPointer, true);
    this.offs.push(() => {
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('fullscreenchange', onVisible);
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('pointerup', onPointer, true);
      window.removeEventListener('pointercancel', onPointer, true);
    });
    // a source view with no picture yet: the note shows until a real tap lands
    if (this.tap) this.schedule();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const off of this.offs) off();
    this.offs = [];
    window.clearTimeout(this.timer);
    window.clearTimeout(this.settle);
    window.clearTimeout(this.idle);
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.rebinRaf);
    this.timer = this.settle = this.idle = this.raf = this.rebinRaf = 0;
    this.waiting = false;
    this.gen++;
    this.reader.dispose();
    this.releaseChannel();
    this.tap = null;
    this.kept = null;
    this.exactKey = null;
    this.down = false;
  }

  /** repaints the kept sample on the next animation frame, so new cells (a kind, a zoom, a resize) get their plots */
  rebin(): void {
    if (!this.running) return;
    cancelAnimationFrame(this.rebinRaf);
    this.rebinRaf = requestAnimationFrame(() => {
      this.rebinRaf = 0;
      if (!this.running) return;
      const k = this.kept;
      if (!k) {
        this.hooks.paint(null, null, 0, null);
        return;
      }
      this.bins = binScopes(k.data, k.w, k.h, useScopes.getState().vectorZoom, this.wants(), this.bins);
      this.hooks.paint(this.bins, k.hist ?? this.bins.hist, k.pixels, k.reading);
    });
  }

  private wants(): BinWants {
    const kinds = useScopes.getState().kinds;
    return { wave: kinds.includes('waveform'), parade: kinds.includes('parade'), vector: kinds.includes('vectorscope') };
  }

  private mode(): string {
    return useUi.getState().previewMode;
  }

  private keyNow(): readonly unknown[] {
    const mode = this.mode();
    if (mode === 'source') {
      const img = this.tap?.image ?? null;
      return [img, typeof HTMLVideoElement !== 'undefined' && img instanceof HTMLVideoElement ? img.currentTime : 0, 'source'];
    }
    return [useEditor.getState().project, usePlayback.getState().time, mode];
  }

  private onTap = (image: TapImage | null, w: number, h: number, kind: TapKind, still: boolean): void => {
    if (!this.running || !tapCounts(kind, this.mode())) return;
    this.tap = { image, w, h, kind, still };
    const exactOn = useScopes.getState().exact;
    if (still && exactOn && this.exactKey && sameKey(this.exactKey, this.keyNow())) {
      // the exact reading still holds: no flicker to live, only exact again
      this.armSettle();
      return;
    }
    if (!still) this.exactKey = null;
    this.schedule();
    if (exactOn) {
      if (still) this.armSettle();
      else {
        window.clearTimeout(this.settle);
        this.settle = 0;
      }
    }
  };

  private onMode(mode: string): void {
    this.gen++;
    this.exactKey = null;
    window.clearTimeout(this.settle);
    this.settle = 0;
    // a source view shows its note until a real tap lands
    this.tap = mode === 'source' ? NO_SOURCE : null;
    if (this.tap) this.schedule();
    wantFrame();
  }

  private onExact(on: boolean): void {
    if (on) {
      if (this.tap?.still) this.armSettle();
      return;
    }
    this.gen++;
    window.clearTimeout(this.settle);
    this.settle = 0;
    window.clearTimeout(this.idle);
    this.idle = 0;
    this.exactKey = null;
    this.releaseChannel();
    this.hooks.note('');
    wantFrame();
  }

  private armSettle(delay = EXACT_SETTLE_MS): void {
    window.clearTimeout(this.settle);
    this.settle = window.setTimeout(() => void this.runExact(), delay);
  }

  /** the coalesced read: while one is pending only the stored tap changes (the newest wins) */
  private schedule(): void {
    if (this.waiting || !this.running || !this.tap) return;
    this.waiting = true;
    const playing = !this.tap.still;
    const wait = scopeDelay(performance.now(), this.last, playing, this.cost);
    const go = () => {
      this.timer = 0;
      this.raf = 0;
      this.waiting = false;
      this.run();
    };
    if (!playing) {
      // paused: the next animation frame, or a timer when the cost asks for more
      if (wait <= 0) this.raf = requestAnimationFrame(go);
      else this.timer = window.setTimeout(go, wait);
      return;
    }
    // playing: the read lands just after an animation frame, its gpu wait in idle time
    this.timer = window.setTimeout(() => {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.timer = window.setTimeout(go, 0);
      });
    }, wait);
  }

  private run(): void {
    if (!this.running || !this.hooks.visible()) return;
    const tap = this.tap;
    if (!tap) return;
    // an output canvas read after a switch to the scene view would measure the free camera
    if (!tapCounts(tap.kind, this.mode())) return;
    if (!tap.image) {
      this.kept = null;
      this.exactKey = null;
      this.hooks.paint(null, null, 0, null);
      this.hooks.note(REASON_TEXT.scopesNoPicture);
      return;
    }
    if (this.exactKey && sameKey(this.exactKey, this.keyNow())) return;
    if (!tapSizeOk(tap.image, tap.w, tap.h)) return;
    const t0 = performance.now();
    const s = sampleSize(tap.w, tap.h, LIVE_SAMPLE);
    const img = this.reader.read(tap.image, 0, 0, tap.w, tap.h, s.w, s.h);
    if (!img) {
      this.hooks.note(REASON_TEXT.scopesNoPicture);
      return;
    }
    const t1 = performance.now();
    this.bins = binScopes(img.data, s.w, s.h, useScopes.getState().vectorZoom, this.wants(), this.bins);
    const t2 = performance.now();
    this.exactKey = null;
    const reading = { how: 'live' as const, w: s.w, h: s.h };
    this.kept = { data: img.data, w: s.w, h: s.h, hist: null, pixels: this.bins.pixels, reading };
    this.hooks.paint(this.bins, this.bins.hist, this.bins.pixels, reading);
    this.hooks.note('');
    const t3 = performance.now();
    this.last = t3;
    const ms = t3 - t0;
    this.cost = this.cost * 0.8 + ms * 0.2;
    scopeDebug.reads++;
    scopeDebug.readMs += t1 - t0;
    scopeDebug.binMs += t2 - t1;
    scopeDebug.plotMs += t3 - t2;
  }

  /** the settle timer fired: read every pixel of the picture the export would draw */
  private async runExact(): Promise<void> {
    this.settle = 0;
    if (!this.running || !useScopes.getState().exact || !this.hooks.visible()) return;
    if (this.down) {
      // a button is down (a resting drag): a 4k render in the middle of it would stall the gesture
      this.armSettle();
      return;
    }
    if (isExporting()) {
      this.hooks.note(REASON_TEXT.exactExport);
      this.armSettle(EXACT_RETRY_MS);
      return;
    }
    const tap = this.tap;
    if (!tap || !tap.image || !tapCounts(tap.kind, this.mode())) return;
    const gen = ++this.gen;
    const key = this.keyNow();
    const t0 = performance.now();
    let img: ImageData | null = null;
    if (tap.kind === 'source') {
      const reader = new FrameReader();
      try {
        if (tapSizeOk(tap.image, tap.w, tap.h)) img = reader.read(tap.image, 0, 0, tap.w, tap.h, tap.w, tap.h);
      } finally {
        reader.dispose();
      }
    } else {
      const canvas = await this.hooks.exactFrame();
      if (!canvas) {
        // an export started during the seek wait: say so and try again after it
        if (isExporting()) {
          this.hooks.note(REASON_TEXT.exactExport);
          this.armSettle(EXACT_RETRY_MS);
        }
        return;
      }
      this.usedChannel = true;
      try {
        if (gen !== this.gen || !this.running || !sameKey(key, this.keyNow())) return;
        const g = canvas.getContext('2d');
        img = g ? g.getImageData(0, 0, canvas.width, canvas.height) : null;
      } catch {
        img = null;
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        if (gen !== this.gen || !this.running) this.releaseChannel();
        else this.armIdle();
      }
    }
    if (!img || gen !== this.gen || !this.running) return;
    const t1 = performance.now();
    const pixels = img.width * img.height;
    this.exactHist = lumaLevels(img.data, pixels, this.exactHist);
    const sub = subsample(img.data, img.width, img.height, EXACT_SAMPLE);
    this.bins = binScopes(sub.data, sub.w, sub.h, useScopes.getState().vectorZoom, this.wants(), this.bins);
    const t2 = performance.now();
    const reading = { how: 'exact' as const, w: img.width, h: img.height };
    this.exactKey = key;
    // the plots use the subsample, the stats and the histogram count every pixel
    this.kept = { data: sub.data, w: sub.w, h: sub.h, hist: this.exactHist, pixels, reading };
    this.hooks.paint(this.bins, this.exactHist, pixels, reading);
    this.hooks.note('');
    const t3 = performance.now();
    scopeDebug.exactReads++;
    scopeDebug.readMs += t1 - t0;
    scopeDebug.binMs += t2 - t1;
    scopeDebug.plotMs += t3 - t2;
  }

  /** the export channel stays between exact readings and goes back a while after the last one */
  private armIdle(): void {
    window.clearTimeout(this.idle);
    this.idle = window.setTimeout(() => {
      this.idle = 0;
      this.releaseChannel();
    }, EXACT_IDLE_MS);
  }

  private releaseChannel(): void {
    window.clearTimeout(this.idle);
    this.idle = 0;
    if (!this.usedChannel) return;
    this.usedChannel = false;
    if (!isExporting()) releaseRenderResources('export');
  }
}
