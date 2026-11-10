import { memo, useEffect, useRef } from 'react';
import type { Clip } from '../../types';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { KEY_STRIP_H, keyX, mergeKeys } from './keyGeometry';
import { clipKeyTimes, keyAt } from './keyTimesCache';
import { cssVar, getAppearanceGen, subscribeView, view } from './view';

interface Props {
  clip: Clip;
  zoom: number;
  /** outer height of the clip box (css px) */
  clipH: number;
}

const MARGIN = 64;

/**
 * keyframe diamonds of one clip on a small canvas that only covers the visible part of the clip.
 * the diamond at the playhead is drawn bigger and filled; the playhead is followed through a
 * store subscription and only triggers a redraw when the highlighted diamond changes.
 */
export const KeyMarks = memo(function KeyMarks({ clip, zoom, clipH }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ clip, zoom, clipH });
  latest.current = { clip, zoom, clipH };
  const api = useRef<{ invalidate(): void } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    let activeKey = NaN;
    /** the clip-local range the canvas covers right now, null when it is empty */
    let drawn: { a: number; b: number } | null = null;
    let drawnGen = getAppearanceGen();

    /** clip-local time of the key at the playhead, or NaN */
    const activeAt = (): number => {
      const p = latest.current;
      const fps = useEditor.getState().project?.fps ?? 30;
      const local = usePlayback.getState().time - p.clip.start;
      return keyAt(p.clip.keyframes, p.clip.duration, local, 0.5 / fps);
    };

    const draw = () => {
      raf = 0;
      const p = latest.current;
      const w = p.clip.duration * p.zoom;
      const vs = view.scrollLeft - p.clip.start * p.zoom;
      const a = Math.max(0, Math.floor(vs - MARGIN));
      const b = Math.min(w, Math.ceil(vs + view.width + MARGIN));
      const ctx = b > a ? canvas.getContext('2d') : null;
      drawnGen = getAppearanceGen();
      if (!ctx) {
        drawn = null;
        canvas.width = 0;
        canvas.height = 0;
        return;
      }
      drawn = { a, b };
      const cssW = b - a;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pw = Math.max(1, Math.round(cssW * dpr));
      const ph = Math.max(1, Math.round(KEY_STRIP_H * dpr));
      if (canvas.width !== pw) canvas.width = pw;
      if (canvas.height !== ph) canvas.height = ph;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${KEY_STRIP_H}px`;
      canvas.style.transform = `translate3d(${a}px,${Math.max(0, p.clipH - 2 - KEY_STRIP_H)}px,0)`;
      ctx.setTransform(dpr, 0, 0, dpr, -a * dpr, 0);
      ctx.clearRect(a, 0, cssW, KEY_STRIP_H);
      activeKey = activeAt();
      const fill = cssVar('--clip-label');
      const hollow = cssVar('--clip-audio');
      const groups = mergeKeys(clipKeyTimes(p.clip.keyframes, p.clip.duration), p.zoom, w);
      const cy = KEY_STRIP_H / 2;
      ctx.lineWidth = 1;
      ctx.strokeStyle = fill;
      for (const group of groups) {
        const x = keyX(group[0]!, p.zoom, w);
        if (x < a - 6 || x > b + 6) continue;
        const on = group.some((t) => t === activeKey);
        const r = on ? 4.5 : 3.5;
        ctx.beginPath();
        ctx.moveTo(x, cy - r);
        ctx.lineTo(x + r, cy);
        ctx.lineTo(x, cy + r);
        ctx.lineTo(x - r, cy);
        ctx.closePath();
        ctx.fillStyle = on ? fill : hollow;
        ctx.fill();
        ctx.stroke();
      }
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    api.current = { invalidate: schedule };
    // a scroll that leaves the visible part of the clip as it was drawn changes no pixel: skip it
    const unView = subscribeView(() => {
      if (raf) return;
      const p = latest.current;
      const w = p.clip.duration * p.zoom;
      const vs = view.scrollLeft - p.clip.start * p.zoom;
      const seen = Math.min(w, vs + view.width) > Math.max(0, vs);
      if (!seen && !drawn) return;
      if (drawn && drawnGen === getAppearanceGen() && Math.max(0, vs) >= drawn.a && Math.min(w, vs + view.width) <= drawn.b) return;
      schedule();
    });
    const unPlay = usePlayback.subscribe(() => {
      const now = activeAt();
      if (now !== activeKey && !(Number.isNaN(now) && Number.isNaN(activeKey))) schedule();
    });
    draw();
    return () => {
      unView();
      unPlay();
      api.current = null;
      if (raf) cancelAnimationFrame(raf);
      canvas.width = 0;
      canvas.height = 0;
    };
  }, []);

  useEffect(() => {
    api.current?.invalidate();
  }, [clip.keyframes, clip.start, clip.duration, zoom, clipH]);

  return <canvas ref={canvasRef} className="timeline-keymarks" />;
});
