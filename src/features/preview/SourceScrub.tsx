import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { cleanRange, lastFrameStart, sameRange } from '../../lib/inOut';
import type { InOutRange } from '../../types';
import { marksOf } from '../../lib/marks';
import { formatTimecode } from '../../lib/time';
import { getWaveform } from '../../media/derived';
import type { WaveformData } from '../../media/derived';
import { useEditor } from '../../store/editorStore';
import { useSource } from '../../store/source';
import type { MediaAsset } from '../../types';
import { drawPeaks, gripTime, markHit, markRect, peakColumns, timeAtX, xAtTime } from './sourceDraw';
import type { SourcePlayer } from './sourcePlayer';

interface Props {
  asset: MediaAsset | null;
  /** the player of the shown media: the bar hands its drags to it (null for pictures, sound files not yet loaded and no media) */
  playerRef: RefObject<SourcePlayer | null>;
}

type Drag =
  | { kind: 'grip'; side: 'in' | 'out'; id: number; base: InOutRange | null; off: number }
  | { kind: 'scrub'; id: number; moved: boolean };

/** the bar under the source view: the sound of the media, the marked part, the playhead. moved by store subscription, no react render per frame */
export function SourceScrub({ asset, playerRef }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLSpanElement>(null);
  const [wave, setWave] = useState<WaveformData | null>(null);
  const fps = useEditor((s) => s.project?.fps ?? 30);
  const timed = !!asset && asset.kind !== 'image' && asset.duration > 0;
  const duration = timed ? asset.duration : 0;
  const wantWave = timed && !!asset.hasAudio;

  const drag = useRef<Drag | null>(null);
  /** the marks while a grip is dragged (undefined: not dragging) */
  const live = useRef<InOutRange | null | undefined>(undefined);
  const nextX = useRef<number | null>(null);
  const raf = useRef(0);
  const stopEscape = useRef<(() => void) | null>(null);
  const latest = useRef({ asset, wave, fps, duration, timed });
  latest.current = { asset, wave, fps, duration, timed };
  const draw = useRef<() => void>(() => undefined);
  const place = useRef<(t: number) => void>(() => undefined);

  useEffect(() => {
    // the peaks of the media before are not these
    setWave(null);
    if (!wantWave || !asset) return;
    let alive = true;
    void getWaveform(asset.id).then((w) => {
      if (alive) setWave(w);
    });
    return () => {
      alive = false;
    };
  }, [wantWave, asset?.id]);

  // the canvas follows the bar's size, the playhead follows the store
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const head = headRef.current;
    if (!wrap || !canvas || !head) return;
    let w = 0;
    let h = 0;
    let lastText = '';
    // the columns and colors only change with the wave, the width or the duration, not with a grip drag
    let cols: Float32Array | null = null;
    let colsKey: { wave: WaveformData | null; w: number; duration: number } | null = null;
    let accent = '#4f8cff';
    let faint = '#888888';
    place.current = (t: number) => {
      const p = latest.current;
      head.style.transform = `translate3d(${xAtTime(t, w, p.duration)}px,0,0)`;
      const text = formatTimecode(t, p.fps);
      if (text !== lastText) {
        lastText = text;
        wrap.setAttribute('aria-valuenow', String(Math.round(t * 1000) / 1000));
        wrap.setAttribute('aria-valuetext', text);
      }
    };
    draw.current = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx || w <= 0 || h <= 0) return;
      const p = latest.current;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pw = Math.round(w * dpr);
      const ph = Math.round(h * dpr);
      if (canvas.width !== pw) canvas.width = pw;
      if (canvas.height !== ph) canvas.height = ph;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!p.timed || !p.asset) return;
      const stale = !colsKey || colsKey.wave !== p.wave || colsKey.w !== w || colsKey.duration !== p.duration;
      if (stale || live.current === undefined) {
        const cs = getComputedStyle(wrap);
        accent = cs.getPropertyValue('--accent').trim() || '#4f8cff';
        faint = cs.getPropertyValue('--text-faint').trim() || '#888888';
      }
      if (stale) {
        colsKey = { wave: p.wave, w, duration: p.duration };
        cols = p.wave && p.wave.peaks.length > 0 ? peakColumns(p.wave.peaks, p.wave.peaksPerSecond, p.duration, w) : null;
      }
      if (cols) {
        ctx.fillStyle = faint;
        ctx.globalAlpha = 0.8;
        drawPeaks(ctx, cols, 0, h);
        ctx.globalAlpha = 1;
      }
      const m = live.current !== undefined ? live.current : marksOf(p.asset);
      const rect = markRect(m, p.duration, w);
      ctx.fillStyle = accent;
      if (rect) {
        ctx.globalAlpha = 0.18;
        ctx.fillRect(rect.x, 0, rect.w, h);
        ctx.globalAlpha = 1;
      }
      // set marks: a 2 px line with a 6 px grip at the top, pointing into the marked part
      const c = cleanRange(m);
      if (c?.in !== undefined) {
        const x = Math.min(w - 2, xAtTime(c.in, w, p.duration));
        ctx.fillRect(x, 0, 2, h);
        ctx.fillRect(x + 2, 0, 6, 8);
      }
      if (c?.out !== undefined) {
        const x = Math.max(0, xAtTime(c.out, w, p.duration) - 2);
        ctx.fillRect(x, 0, 2, h);
        ctx.fillRect(x - 6, 0, 6, 8);
      }
    };
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      w = Math.floor(e.contentRect.width);
      h = Math.floor(e.contentRect.height);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      draw.current();
      place.current(useSource.getState().time);
    });
    ro.observe(wrap);
    place.current(useSource.getState().time);
    const off = useSource.subscribe((s, p) => {
      if (s.time !== p.time || s.assetId !== p.assetId) place.current(s.time);
    });
    return () => {
      ro.disconnect();
      off();
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      stopEscape.current?.();
    };
  }, []);

  // data changed: draw again, and the playhead may sit at another place
  useEffect(() => {
    draw.current();
    place.current(useSource.getState().time);
  }, [asset, wave, duration]);

  const localX = (e: { clientX: number }): number => (wrapRef.current ? e.clientX - wrapRef.current.getBoundingClientRect().left : 0);
  const barWidth = (): number => wrapRef.current?.clientWidth ?? 0;

  const hover = (x: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const p = latest.current;
    wrap.classList.toggle('is-grip', p.timed && markHit(x, marksOf(p.asset), p.duration, barWidth()) !== null);
  };

  const showRead = (x: number, t: number) => {
    const r = readRef.current;
    if (!r) return;
    r.hidden = false;
    r.textContent = formatTimecode(t, latest.current.fps);
    r.style.transform = `translate3d(${Math.max(0, Math.min(barWidth() - 56, x - 28))}px,0,0)`;
  };

  const endDrag = (commit: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    nextX.current = null;
    stopEscape.current?.();
    stopEscape.current = null;
    const wrap = wrapRef.current;
    wrap?.classList.remove('is-gripping');
    if (readRef.current) readRef.current.hidden = true;
    if (d.kind === 'grip') {
      const a = latest.current.asset;
      const m = live.current;
      live.current = undefined;
      if (commit && a && m !== undefined) useEditor.getState().setMediaMarks(a.id, cleanRange(m));
      draw.current();
    } else {
      playerRef.current?.scrubEnd();
    }
  };

  /** the newest pointer x of the drag, applied once per frame */
  const apply = () => {
    raf.current = 0;
    const d = drag.current;
    const x = nextX.current;
    nextX.current = null;
    if (!d || x === null) return;
    const p = latest.current;
    const w = barWidth();
    if (d.kind === 'scrub') {
      const t = timeAtX(x, w, p.duration, p.fps);
      if (playerRef.current) playerRef.current.scrubTo(t);
      else useSource.getState().seek(t);
      return;
    }
    // a grip: one frame is kept between the two marks
    const frame = 1 / p.fps;
    const t = gripTime(x - d.off, w, p.duration, p.fps);
    let v: number;
    if (d.side === 'in') v = Math.max(0, Math.min(t, (d.base?.out ?? p.duration) - frame));
    else v = Math.min(p.duration, Math.max(t, (d.base?.in ?? 0) + frame));
    live.current = { ...(d.base ?? {}), [d.side]: v };
    draw.current();
    showRead(xAtTime(v, w, p.duration), v);
  };
  const schedule = (x: number) => {
    nextX.current = x;
    if (!raf.current) raf.current = requestAnimationFrame(apply);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = latest.current;
    if (e.button !== 0 || !p.timed || !p.asset || drag.current) return;
    const x = localX(e);
    const base = marksOf(p.asset);
    const hit = markHit(x, base, p.duration, barWidth());
    e.currentTarget.setPointerCapture(e.pointerId);
    if (hit) {
      // the pointer keeps its distance to the line it took hold of
      drag.current = { kind: 'grip', side: hit, id: e.pointerId, base, off: x - xAtTime(base?.[hit] ?? 0, barWidth(), p.duration) };
      live.current = base;
      e.currentTarget.classList.add('is-gripping');
      // escape puts the grip back
      const onKey = (ke: KeyboardEvent) => {
        if (ke.key !== 'Escape') return;
        ke.preventDefault();
        ke.stopPropagation();
        endDrag(false);
      };
      window.addEventListener('keydown', onKey, true);
      stopEscape.current = () => window.removeEventListener('keydown', onKey, true);
      return;
    }
    drag.current = { kind: 'scrub', id: e.pointerId, moved: false };
    useSource.getState().pause();
    useSource.getState().seek(timeAtX(x, barWidth(), p.duration, p.fps));
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return hover(localX(e));
    if (d.id !== e.pointerId) return;
    if (d.kind === 'scrub') d.moved = true;
    schedule(localX(e));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    // the last position counts
    // (a click on the bar already seeked, only a drag needs it)
    if (e.type === 'pointerup' && (d.kind === 'grip' || d.moved)) {
      nextX.current = localX(e);
      cancelAnimationFrame(raf.current);
      apply();
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    endDrag(e.type === 'pointerup');
  };
  const onPointerLeave = () => {
    if (!drag.current) wrapRef.current?.classList.remove('is-grip');
  };

  // a double click on a grip takes that mark away
  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const p = latest.current;
    if (!p.timed || !p.asset) return;
    const m = marksOf(p.asset);
    const hit = markHit(localX(e), m, p.duration, barWidth());
    if (!hit || !m) return;
    const next: InOutRange = { ...m };
    delete next[hit];
    const clean = cleanRange(next);
    if (!sameRange(m, clean)) useEditor.getState().setMediaMarks(p.asset.id, clean);
  };

  // the bar is a slider: it owns its keys (useShortcuts leaves them to it), each one is stopped here
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const p = latest.current;
    const src = useSource.getState();
    const act = (run: () => void) => {
      e.preventDefault();
      if (p.timed) run();
    };
    if (e.key === 'ArrowLeft') act(() => src.stepFrames(e.shiftKey ? -10 : -1));
    else if (e.key === 'ArrowRight') act(() => src.stepFrames(e.shiftKey ? 10 : 1));
    else if (e.key === 'Home') act(() => src.seek(0));
    else if (e.key === 'End') act(() => src.seek(lastFrameStart(0, p.duration, p.fps)));
  };

  return (
    <div
      ref={wrapRef}
      className="source-scrub"
      role="slider"
      aria-label="source playhead"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-disabled={timed ? undefined : true}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvasRef} className="source-scrub-canvas" />
      <div ref={headRef} className="source-scrub-head" />
      <span ref={readRef} className="source-scrub-read mono" hidden />
    </div>
  );
}
