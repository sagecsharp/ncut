import { memo, useEffect, useRef, useState } from 'react';
import type { AudioClip, MediaAsset, VideoClip } from '../../types';
import { getFilmstrip, getWaveform } from '../../media/derived';
import type { WaveformData } from '../../media/derived';
import { CLIP_LABEL_H } from './layout';
import { cssVar, subscribeView, view } from './view';

interface Film {
  times: number[];
  frames: ImageBitmap[];
}

interface Props {
  clip: VideoClip | AudioClip;
  asset: MediaAsset;
  zoom: number;
  /** inner height of the clip box in css px */
  innerH: number;
}

/** extra css px drawn beyond the viewport on each side so small scrolls do not redraw */
const MARGIN = 480;
/** redraw ranges snap to multiples of this */
const BUCKET = 256;
/** never let the backing store exceed this many device pixels in width */
const MAX_BACKING = 8192;

function nearestIndex(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1]! - t) <= Math.abs(times[lo]! - t)) return lo - 1;
  return lo;
}

/**
 * filmstrip + waveform of one clip, drawn on a canvas that only covers the visible part of the clip
 * (viewport plus a margin). redraws when zoom / clip / data change or when scrolling leaves the
 * drawn range. the canvas is released when the clip is far off screen.
 */
export const ClipCanvas = memo(function ClipCanvas({ clip, asset, zoom, innerH }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [film, setFilm] = useState<Film | null>(null);
  const [wave, setWave] = useState<WaveformData | null>(null);
  const api = useRef<{ invalidate(): void; check(): void } | null>(null);
  const latest = useRef({ clip, asset, zoom, innerH, film, wave });
  latest.current = { clip, asset, zoom, innerH, film, wave };

  const wantFilm = clip.type === 'video' && asset.kind === 'video';
  const wantWave = asset.hasAudio;

  // how many frames to ask for: enough tiles for the clip at this zoom, quantised to avoid refetch churn
  const tileW = Math.max(8, innerH * (16 / 9));
  const sourceSpan = Math.max(0.05, clip.duration * clip.speed);
  const rawCount = Math.ceil(((clip.duration * zoom) / tileW) * (Math.max(asset.duration, 0.1) / sourceSpan));
  const count = Math.min(96, Math.max(8, Math.ceil(rawCount / 8) * 8));

  useEffect(() => {
    if (!wantFilm) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      getFilmstrip(asset.id, count, innerH)
        .then((res) => {
          if (!cancelled && res && res.frames.length > 0) setFilm(res);
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [wantFilm, asset.id, count, innerH]);

  useEffect(() => {
    if (!wantWave) return;
    let cancelled = false;
    getWaveform(asset.id)
      .then((res) => {
        if (!cancelled && res) setWave(res);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [wantWave, asset.id]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    let force = true;
    let drawn: { a: number; b: number } | null = null;

    const release = () => {
      if (!drawn) return;
      drawn = null;
      canvas.width = 0;
      canvas.height = 0;
    };

    const draw = () => {
      raf = 0;
      const p = latest.current;
      const clipW = p.clip.duration * p.zoom;
      const clipX = p.clip.start * p.zoom;
      const vs = view.scrollLeft - clipX;
      const ve = vs + view.width;
      if (ve < -MARGIN || vs > clipW + MARGIN || clipW <= 0) {
        release();
        return;
      }
      const needA = Math.max(0, vs);
      const needB = Math.min(clipW, ve);
      if (!force && drawn && needA >= drawn.a - 0.5 && needB <= drawn.b + 0.5) return;
      force = false;
      const a = Math.max(0, Math.floor((vs - MARGIN) / BUCKET) * BUCKET);
      const b = Math.min(clipW, Math.ceil((ve + MARGIN) / BUCKET) * BUCKET);
      if (b <= a) {
        release();
        return;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const cssW = b - a;
      const cssH = p.innerH;
      const dpr = Math.min(window.devicePixelRatio || 1, 2, MAX_BACKING / cssW);
      const pw = Math.max(1, Math.round(cssW * dpr));
      const ph = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== pw) canvas.width = pw;
      if (canvas.height !== ph) canvas.height = ph;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.style.transform = `translate3d(${a}px,0,0)`;
      ctx.setTransform(dpr, 0, 0, dpr, -a * dpr, 0);
      ctx.clearRect(a, 0, cssW, cssH);
      drawFilm(ctx, p, a, b, cssH);
      drawWave(ctx, p, a, b, cssH);
      drawn = { a, b };
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    api.current = {
      invalidate() {
        force = true;
        schedule();
      },
      check: schedule,
    };
    const unsub = subscribeView(schedule);
    schedule();
    return () => {
      unsub();
      api.current = null;
      if (raf) cancelAnimationFrame(raf);
      canvas.width = 0;
      canvas.height = 0;
    };
  }, []);

  useEffect(() => {
    api.current?.invalidate();
  }, [film, wave, zoom, innerH, clip.duration, clip.trimStart, clip.speed, asset.id]);

  // moving a clip changes only where it sits relative to the viewport, not its pixels
  useEffect(() => {
    api.current?.check();
  }, [clip.start]);

  return <canvas ref={canvasRef} className="timeline-clip-canvas" />;
});

type DrawProps = { clip: VideoClip | AudioClip; asset: MediaAsset; zoom: number; film: Film | null; wave: WaveformData | null };

function drawFilm(ctx: CanvasRenderingContext2D, p: DrawProps, a: number, b: number, h: number): void {
  const film = p.film;
  if (!film || film.frames.length === 0 || p.clip.type !== 'video') return;
  const f0 = film.frames[0]!;
  const tileW = Math.max(8, h * (f0.width / Math.max(1, f0.height)));
  const first = Math.floor(a / tileW);
  const last = Math.ceil(b / tileW);
  for (let i = first; i < last; i++) {
    const x = i * tileW;
    const t = p.clip.trimStart + ((x + tileW / 2) / p.zoom) * p.clip.speed;
    const frame = film.frames[nearestIndex(film.times, t)];
    if (!frame) continue;
    const x0 = Math.round(x);
    ctx.drawImage(frame, x0, 0, Math.round(x + tileW) - x0 + 1, h);
  }
}

function drawWave(ctx: CanvasRenderingContext2D, p: DrawProps, a: number, b: number, h: number): void {
  const wave = p.wave;
  if (!wave || wave.peaks.length === 0 || !p.asset.hasAudio) return;
  const isVideo = p.clip.type === 'video';
  const y0 = isVideo ? Math.round(h * 0.6) : CLIP_LABEL_H;
  const stripH = h - y0;
  if (stripH < 4) return;
  const mid = y0 + stripH / 2;
  const half = stripH / 2 - 1;
  if (isVideo) {
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = cssVar('--surface-0');
    ctx.fillRect(a, y0, b - a, stripH);
  }
  ctx.globalAlpha = isVideo ? 0.7 : 0.8;
  ctx.fillStyle = cssVar('--clip-label');
  const { peaks, peaksPerSecond: pps } = wave;
  const secPerPx = p.clip.speed / p.zoom;
  const x0 = Math.floor(a);
  const x1 = Math.ceil(b);
  for (let x = x0; x < x1; x++) {
    const t0 = p.clip.trimStart + x * secPerPx;
    const i0 = Math.floor(t0 * pps);
    const i1 = Math.max(i0 + 1, Math.ceil((t0 + secPerPx) * pps));
    if (i0 >= peaks.length) break;
    let peak = 0;
    const end = Math.min(i1, peaks.length);
    for (let i = Math.max(0, i0); i < end; i++) {
      const v = peaks[i]!;
      if (v > peak) peak = v;
    }
    const amp = Math.min(1, peak) * half;
    const hh = Math.max(0.5, amp);
    ctx.fillRect(x, mid - hh, 1, hh * 2);
  }
  ctx.globalAlpha = 1;
}
