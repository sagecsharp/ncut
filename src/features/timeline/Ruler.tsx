import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { formatDuration, formatTimecode } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { PlayheadHandle } from './Playhead';
import { RULER_H } from './layout';
import { CHAR_W, FLAG_H, FLAG_PAD, flagLabel, flagWidth, visibleMarkerRange } from './markers';
import { cssVar, subscribeView, view } from './view';

interface Props {
  onPointerDown(e: ReactPointerEvent<HTMLElement>): void;
}

interface Step {
  /** seconds between major ticks */
  step: number;
  /** minor subdivisions per major tick */
  div: number;
}

const SECOND_STEPS: Step[] = [
  { step: 0.5, div: 5 },
  { step: 1, div: 5 },
  { step: 2, div: 4 },
  { step: 5, div: 5 },
  { step: 10, div: 5 },
  { step: 15, div: 3 },
  { step: 30, div: 6 },
  { step: 60, div: 6 },
  { step: 120, div: 4 },
  { step: 300, div: 5 },
  { step: 600, div: 5 },
  { step: 900, div: 3 },
  { step: 1800, div: 6 },
  { step: 3600, div: 6 },
];

const MIN_LABEL_PX = 84;

let stepCacheFps = 0;
let stepCache: Step[] = [];

function stepsFor(fps: number): Step[] {
  if (fps === stepCacheFps) return stepCache;
  const f = 1 / fps;
  const all: Step[] = [
    { step: f, div: 1 },
    { step: f * 2, div: 2 },
    { step: f * 5, div: 5 },
    { step: f * 10, div: 5 },
    ...SECOND_STEPS,
  ].sort((a, b) => a.step - b.step);
  stepCacheFps = fps;
  stepCache = all;
  return all;
}

function pickStep(zoom: number, fps: number): Step {
  const steps = stepsFor(fps);
  for (const s of steps) if (s.step * zoom >= MIN_LABEL_PX) return s;
  return steps[steps.length - 1]!;
}

/**
 * time ruler. a viewport-wide canvas pinned with position: sticky, redrawn (once per frame at most)
 * only when scroll, zoom, fps or size change. pointer down / drag seeks (handled by the gestures).
 */
export function Ruler({ onPointerDown }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;

    const draw = () => {
      raf = 0;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const W = Math.max(1, Math.round(view.width));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pw = Math.round(W * dpr);
      const ph = Math.round(RULER_H * dpr);
      if (canvas.width !== pw) canvas.width = pw;
      if (canvas.height !== ph) canvas.height = ph;
      canvas.style.width = `${W}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, RULER_H);

      const state = useEditor.getState();
      const zoom = state.zoom;
      const fps = Math.max(1, Math.round(state.project?.fps ?? 30));
      const { step, div } = pickStep(zoom, fps);
      const minor = step / div;
      const scroll = view.scrollLeft;
      const first = Math.floor(scroll / zoom / minor);
      const last = Math.ceil((scroll + W) / zoom / minor);
      const tickColor = cssVar('--text-faint');
      const labelColor = cssVar('--text-dim');
      const borderColor = cssVar('--border');
      ctx.font = `10px ${cssVar('--font-mono') || 'monospace'}`;
      ctx.textBaseline = 'top';
      const showMinor = minor * zoom >= 4;
      const frameLabels = step < 1;

      ctx.fillStyle = tickColor;
      for (let i = Math.max(0, first); i <= last; i++) {
        const major = i % div === 0;
        if (!major && !showMinor) continue;
        const x = Math.round((i * minor * zoom - scroll) * dpr) / dpr;
        const h = major ? 11 : 5;
        ctx.fillRect(x, RULER_H - h - 1, 1, h);
      }
      ctx.fillStyle = labelColor;
      for (let i = Math.max(0, (Math.ceil(first / div) - 1) * div); i <= last; i += div) {
        const t = i * minor;
        const x = Math.round((t * zoom - scroll) * dpr) / dpr;
        ctx.fillText(frameLabels ? formatTimecode(t, fps) : formatDuration(t), x + 4, 4);
      }
      ctx.fillStyle = borderColor;
      ctx.fillRect(0, RULER_H - 1, W, 1);

      // markers: only those that can touch the viewport are drawn
      const markers = state.project?.markers;
      if (markers && markers.length > 0) {
        const { from, to } = visibleMarkerRange(markers, zoom, scroll, W);
        if (to > from) {
          const accent = cssVar('--accent');
          const onAccent = cssVar('--on-accent');
          ctx.font = `10px ${cssVar('--font-mono') || 'monospace'}`;
          ctx.textBaseline = 'middle';
          for (let i = from; i < to; i++) {
            const m = markers[i]!;
            const x = Math.round((m.time * zoom - scroll) * dpr) / dpr;
            ctx.fillStyle = accent;
            ctx.fillRect(x, 0, 1, RULER_H - 1);
            const w = flagWidth(m.name);
            ctx.fillRect(x, 0, w, FLAG_H);
            const label = flagLabel(m.name);
            if (label) {
              ctx.fillStyle = onAccent;
              ctx.fillText(label, x + FLAG_PAD, FLAG_H / 2 + 0.5, label.length * CHAR_W);
            }
          }
          ctx.textBaseline = 'top';
        }
      }
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    const unsubView = subscribeView(schedule);
    const unsubEditor = useEditor.subscribe((s, p) => {
      if (s.zoom !== p.zoom || s.project?.fps !== p.project?.fps || s.project?.markers !== p.project?.markers) schedule();
    });
    schedule();
    return () => {
      unsubView();
      unsubEditor();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="timeline-ruler" onPointerDown={onPointerDown} title="click or drag to seek">
      <canvas ref={canvasRef} className="timeline-ruler-canvas" />
      <PlayheadHandle />
    </div>
  );
}
