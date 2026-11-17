/**
 * the player of the source view: it makes one media element follow the source store (useSource) and the other way
 * round. playing forward the element leads the clock (setSourceMaster), backwards and paused the clock leads the
 * element (one coalesced seek at a time). a drag on the scrub bar is fed by a ScrubFeed like the timeline drag.
 * no react render per frame: everything here runs from store subscriptions and media events.
 */
import type { DrawSource } from '../../engine/draw';
import { frameIndexAt } from '../../lib/marks';
import { getAssetBlob } from '../../media/registry';
import { useEditor } from '../../store/editorStore';
import { mediaPlaybackRate, rateAudible, usePlayback } from '../../store/playback';
import { projectFps, setSourceMaster, useSource } from '../../store/source';
import type { SourceState } from '../../store/source';
import { useUi } from '../../store/ui';
import { REASON_TEXT } from '../shell/reasons';
import { ScrubFeed } from './scrubFeed';

type RvfcElement = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta?: { mediaTime?: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/** the longest side of the kept still, px */
const STILL_LONG_SIDE = 640;


function setPreservesPitch(el: HTMLMediaElement, value: boolean): void {
  const e = el as HTMLMediaElement & { webkitPreservesPitch?: boolean; mozPreservesPitch?: boolean };
  e.preservesPitch = value;
  if ('webkitPreservesPitch' in e) e.webkitPreservesPitch = value;
  if ('mozPreservesPitch' in e) e.mozPreservesPitch = value;
}

/** the one kept still: the last picture of the last video the view showed, so a view that opens again has one at once */
let kept: { assetId: string; time: number; canvas: HTMLCanvasElement } | null = null;

/** keep what the video shows now (readyState >= 2) as a small canvas. one still, the last one wins */
export function takeStill(v: HTMLVideoElement, assetId: string, time: number): void {
  if (v.readyState < 2 || v.videoWidth <= 0 || v.videoHeight <= 0) return;
  const k = Math.min(1, STILL_LONG_SIDE / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.max(1, Math.round(v.videoWidth * k));
  const h = Math.max(1, Math.round(v.videoHeight * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  try {
    ctx.drawImage(v, 0, 0, w, h);
  } catch {
    return;
  }
  kept = { assetId, time, canvas };
}

/** the kept still when it is of this media and within half a frame of this time */
export function stillFor(assetId: string, time: number): HTMLCanvasElement | null {
  if (!kept || kept.assetId !== assetId) return null;
  return Math.abs(kept.time - time) < 0.5 / projectFps() ? kept.canvas : null;
}

export class SourcePlayer {
  private readonly el: HTMLVideoElement | HTMLAudioElement;
  private readonly assetId: string;
  private readonly onPicture: () => void;
  private readonly isVideo: boolean;
  private feed: ScrubFeed | null = null;
  private scrubbing = false;
  /** the store time last seen for this media, for the still */
  private time = 0;
  /** start time of the frame the element shows (requestVideoFrameCallback), NaN until it said so */
  private shown = Number.NaN;
  private rvfc = 0;
  private wasForward = false;
  private wasPlaying = false;
  private disposed = false;
  private failed = false;
  private readonly offs: Array<() => void> = [];

  constructor(el: HTMLVideoElement | HTMLAudioElement, assetId: string, onPicture: () => void) {
    this.el = el;
    this.assetId = assetId;
    this.onPicture = onPicture;
    this.isVideo = 'videoWidth' in el;
    setPreservesPitch(el, false);
    this.time = useSource.getState().time;

    const onSeeked = () => {
      this.sync(useSource.getState());
      if (!useSource.getState().playing) this.onPicture();
    };
    const onMeta = () => this.sync(useSource.getState());
    const onError = () => {
      if (this.failed || this.disposed) return;
      this.failed = true;
      useUi.getState().toast(REASON_TEXT.sourceMissing, 'error');
      useSource.getState().pause();
    };
    el.addEventListener('seeked', onSeeked);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('error', onError);
    this.offs.push(() => {
      el.removeEventListener('seeked', onSeeked);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('error', onError);
    });

    const v = el as RvfcElement;
    if (this.isVideo && typeof v.requestVideoFrameCallback === 'function') {
      const onFrame = (_now: number, meta?: { mediaTime?: number }) => {
        if (this.disposed) return;
        this.shown = typeof meta?.mediaTime === 'number' ? meta.mediaTime : Number.NaN;
        if (!useSource.getState().playing) this.onPicture();
        this.rvfc = v.requestVideoFrameCallback!(onFrame);
      };
      this.rvfc = v.requestVideoFrameCallback(onFrame);
    }

    this.offs.push(useSource.subscribe((s) => this.sync(s)));
    this.offs.push(
      usePlayback.subscribe((s, p) => {
        if (s.muted !== p.muted || s.volume !== p.volume) this.applySound(useSource.getState());
      }),
    );
    this.applySound(useSource.getState());
    this.sync(useSource.getState());
  }

  /** the bar drag moves to t: the feed decodes towards it and the clock follows, the element seeks only when the feed cannot lead */
  scrubTo(t: number): void {
    if (this.disposed) return;
    this.scrubbing = true;
    if (!this.feed && this.isVideo) {
      const blob = getAssetBlob(this.assetId);
      if (blob) this.feed = new ScrubFeed(blob, () => this.onPicture());
    }
    this.feed?.want(t);
    useSource.getState().seek(t);
  }

  /** the drag is over: the element settles on the store time */
  scrubEnd(): void {
    if (this.disposed) return;
    this.scrubbing = false;
    this.sync(useSource.getState());
  }

  /** the feed's picture while it is nearer to the wanted time than the frame the element shows. null: show the element */
  feedPicture(): DrawSource | null {
    const feed = this.feed;
    if (!feed || this.disposed || !this.isVideo || !Number.isFinite(this.shown)) return null;
    const s = useSource.getState();
    if (s.playing) return null;
    const v = this.el as HTMLVideoElement;
    return feed.nearer(s.time, this.shown, v.videoWidth, v.videoHeight);
  }

  dispose(): void {
    if (this.disposed) return;
    const el = this.el;
    if (this.isVideo) takeStill(el as HTMLVideoElement, this.assetId, this.time);
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs.length = 0;
    const v = el as RvfcElement;
    if (this.rvfc && typeof v.cancelVideoFrameCallback === 'function') v.cancelVideoFrameCallback(this.rvfc);
    this.rvfc = 0;
    el.pause();
    setSourceMaster(null);
    this.feed?.dispose();
    this.feed = null;
    el.removeAttribute('src');
    el.load();
  }

  /** muted by the preview's mute or by a rate that is not heard (backwards, above 4x) */
  private applySound(s: SourceState): void {
    const pb = usePlayback.getState();
    const el = this.el;
    const muted = pb.muted || !rateAudible(s.rate);
    if (el.muted !== muted) el.muted = muted;
    const vol = Math.min(1, Math.max(0, pb.volume));
    if (el.volume !== vol) el.volume = vol;
  }

  private master = (): number | null => {
    const el = this.el;
    return el.ended ? Infinity : el.paused || el.seeking || el.readyState < 3 ? null : el.currentTime;
  };

  /** make the element do what the store says */
  private sync(s: SourceState): void {
    if (this.disposed || s.assetId !== this.assetId) return;
    this.time = s.time;
    // playing starts: a feed picture that was shown must go, the view asks for the element again
    if (s.playing && !this.wasPlaying) this.onPicture();
    this.wasPlaying = s.playing;
    const el = this.el;
    const fps = projectFps();
    this.applySound(s);
    const pr = mediaPlaybackRate(1, s.rate);
    if (s.playing && pr > 0) {
      // forward: the element leads, the store takes its time
      if (!this.wasForward) {
        this.wasForward = true;
        this.scrubbing = false;
        this.feed?.rest();
      }
      if (!el.seeking && Math.abs(el.currentTime - s.time) > 1.5 / fps) this.seekEl(s.time);
      if (el.playbackRate !== pr) el.playbackRate = pr;
      if (el.paused && !el.ended) void el.play().catch(() => undefined);
      setSourceMaster(this.master);
      return;
    }
    // paused or backwards: the store leads, one coalesced seek, newer targets wait for 'seeked'
    this.wasForward = false;
    if (!el.paused) el.pause();
    setSourceMaster(null);
    if (this.scrubbing && this.feed?.leads(s.time)) return;
    if (el.seeking) return;
    if (Math.abs(el.currentTime - s.time) > 0.5 / fps && frameIndexAt(el.currentTime, fps) !== frameIndexAt(s.time, fps)) this.seekEl(s.time);
  }

  private seekEl(t: number): void {
    try {
      this.el.currentTime = t;
    } catch {
      // not seekable yet: loadedmetadata runs sync again
    }
  }
}
