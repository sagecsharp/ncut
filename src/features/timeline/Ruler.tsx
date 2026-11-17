import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { rulerLabel, subscribeRulerLabel } from './rulerLabel';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { cleanRange, lastFrameIn, lastFrameStart, withIn, withOut } from '../../lib/inOut';
import { formatTimecode } from '../../lib/time';
import { projectDuration } from '../../lib/timelineOps';
import { PlayheadHandle } from './Playhead';
import { HEADER_W, RULER_H, SNAP_PX } from './layout';
import { CHAR_W, FLAG_H, FLAG_PAD, flagLabel, flagWidth, hitMarker, rangeSnapPoints, visibleMarkerRange } from './markers';
import { rangeDrag } from './rangeDrag';
import { dragTime, edgeSpeed, hitRangeHandle, liveRange, shadeSpan } from './rangeRuler';
import { cssVar, interaction, notifyView, subscribeView, view } from './view';

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
 * the in / out brackets are dragged here: a press on one starts its own drag, any other press goes to the gestures.
 */
export function Ruler({ onPointerDown }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const cancelDrag = useRef<(() => void) | null>(null);

  // a bracket drag that is still on when the ruler goes away is dropped
  useEffect(() => () => cancelDrag.current?.(), []);

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
      const projFps = state.project?.fps ?? 30;
      const range = liveRange(state.project?.range, rangeDrag.get());
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

      // the in / out shade sits under the ticks and the labels
      const shade = range && state.project ? shadeSpan(range, projectDuration(state.project)) : null;
      if (shade) {
        const x0 = Math.max(0, shade.start * zoom - scroll);
        const x1 = Math.min(W, shade.end * zoom - scroll);
        if (x1 > x0) {
          ctx.globalAlpha = 0.6;
          ctx.fillStyle = cssVar('--accent-muted');
          ctx.fillRect(x0, 0, x1 - x0, RULER_H - 1);
          ctx.globalAlpha = 1;
        }
      }

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
        ctx.fillText(rulerLabel(t, fps, frameLabels), x + 4, 4);
      }
      ctx.fillStyle = borderColor;
      ctx.fillRect(0, RULER_H - 1, W, 1);

      // the in / out brackets, below the flag zone
      let inX = NaN;
      let outX = NaN;
      if (range) {
        ctx.fillStyle = cssVar('--accent');
        if (range.in !== undefined) {
          const x = Math.round((range.in * zoom - scroll) * dpr) / dpr;
          if (x > -6 && x < W + 6) {
            inX = x;
            ctx.fillRect(x, FLAG_H, 2, RULER_H - 1 - FLAG_H);
            ctx.fillRect(x + 2, FLAG_H, 6, 2);
            ctx.fillRect(x + 2, RULER_H - 3, 6, 2);
          }
        }
        if (range.out !== undefined) {
          const x = Math.round((range.out * zoom - scroll) * dpr) / dpr;
          if (x > -6 && x < W + 6) {
            outX = x;
            ctx.fillRect(x - 2, FLAG_H, 2, RULER_H - 1 - FLAG_H);
            ctx.fillRect(x - 8, FLAG_H, 6, 2);
            ctx.fillRect(x - 8, RULER_H - 3, 6, 2);
          }
        }
      }

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

      // the drag readout goes last so no marker pole cuts through it
      if (range) {
        // the readout of the bracket being dragged, beside it
        const drag = rangeDrag.get();
        const bx = drag ? (drag.which === 'in' ? inX : outX) : NaN;
        if (drag && !Number.isNaN(bx)) {
          const isIn = drag.which === 'in';
          const length = range.in !== undefined && range.out !== undefined ? `, ${formatTimecode(range.out - range.in, projFps)} long` : '';
          const mark = isIn ? formatTimecode(range.in ?? 0, projFps) : formatTimecode(lastFrameStart(range.in ?? 0, range.out ?? 0, projFps), projFps);
          const text = `${isIn ? 'in' : 'out'} ${mark}${length}`;
          const w = Math.ceil(ctx.measureText(text).width) + 8;
          let x = isIn ? bx + 8 + 6 : bx - 8 - 6 - w;
          if (x + w > W) x = bx - 8 - 6 - w;
          if (x < 0) x = bx + 8 + 6;
          x = Math.max(0, Math.min(x, W - w));
          ctx.fillStyle = cssVar('--surface-5');
          ctx.fillRect(x, FLAG_H, w, RULER_H - 1 - FLAG_H);
          ctx.fillStyle = cssVar('--text');
          ctx.textBaseline = 'middle';
          ctx.fillText(text, x + 4, FLAG_H + (RULER_H - 1 - FLAG_H) / 2 + 0.5);
          ctx.textBaseline = 'top';
        }
      }
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    const unsubView = subscribeView(schedule);
    const unsubLabel = subscribeRulerLabel(schedule);
    const unsubDrag = rangeDrag.subscribe(schedule);
    const unsubEditor = useEditor.subscribe((s, p) => {
      if (s.zoom !== p.zoom || s.project?.fps !== p.project?.fps || s.project?.markers !== p.project?.markers || s.project?.range !== p.project?.range) {
        schedule();
        return;
      }
      // a half range shades to the end of the project, so the clips decide where the shade stops
      if (s.project?.clips !== p.project?.clips) {
        const r = cleanRange(s.project?.range);
        if (r && (r.in === undefined) !== (r.out === undefined)) schedule();
      }
    });
    schedule();
    return () => {
      unsubView();
      unsubLabel();
      unsubDrag();
      unsubEditor();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  /** drag the in or out bracket: snaps like a marker, scrolls at the edges, escape cancels, one setRange on release */
  const startBracketDrag = (e: ReactPointerEvent<HTMLDivElement>, which: 'in' | 'out') => {
    const root = rootRef.current;
    const st = useEditor.getState();
    const project = st.project;
    const start = cleanRange(project?.range);
    if (!root || !project || !start || start[which] === undefined) return;
    e.preventDefault();
    cancelDrag.current?.();
    const pointerId = e.pointerId;
    const fps = project.fps;
    const zoom = st.zoom;
    const startX = e.clientX;
    const startMark = start[which]!;
    // the grab point inside the 5 px reach stays under the pointer
    const offset = startMark - (e.clientX - root.getBoundingClientRect().left) / zoom;
    const points = rangeSnapPoints(project, which, usePlayback.getState().time);
    const scroller = root.closest('.timeline-scroller') as HTMLElement | null;
    let cx = e.clientX;
    let moved = false;
    let raf = 0;
    try {
      root.setPointerCapture(pointerId);
    } catch {
      // the pointer may already be gone
    }
    interaction.gestureActive = true;
    if (scroller) scroller.dataset.gesture = 'trim';

    const timeAt = () =>
      dragTime(which, (cx - root.getBoundingClientRect().left) / zoom + offset, start, fps, points, SNAP_PX, zoom, useEditor.getState().snapping);

    const frame = () => {
      raf = 0;
      const r = timeAt();
      const cur = rangeDrag.get();
      if (!cur || cur.which !== which || cur.time !== r.time || cur.snapped !== r.snapped) rangeDrag.set({ which, time: r.time, snapped: r.snapped });
      if (!scroller) return;
      const xv = cx - scroller.getBoundingClientRect().left - HEADER_W;
      const speed = edgeSpeed(xv, scroller.clientWidth - HEADER_W);
      if (speed === 0) return;
      const before = scroller.scrollLeft;
      scroller.scrollLeft = before + speed;
      if (scroller.scrollLeft !== before) {
        view.scrollLeft = scroller.scrollLeft;
        notifyView();
        raf = requestAnimationFrame(frame);
      }
    };
    const onMove = (ev: PointerEvent) => {
      cx = ev.clientX;
      if (!moved && Math.abs(cx - startX) >= 3) moved = true;
      if (moved && !raf) raf = requestAnimationFrame(frame);
    };
    const finish = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      window.removeEventListener('keydown', onKey, true);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      try {
        if (root.hasPointerCapture(pointerId)) root.releasePointerCapture(pointerId);
      } catch {
        // ignore
      }
      rangeDrag.set(null);
      interaction.gestureActive = false;
      if (scroller) delete scroller.dataset.gesture;
      cancelDrag.current = null;
    };
    const onUp = (ev: PointerEvent) => {
      cx = ev.clientX;
      if (!moved && Math.abs(cx - startX) >= 3) moved = true;
      const t = timeAt().time;
      const ed = useEditor.getState();
      const now = cleanRange(ed.project?.range);
      finish();
      if (moved) {
        ed.setRange((which === 'in' ? withIn : withOut)(now, t).range);
      } else if (now) {
        const at = which === 'in' ? now.in : lastFrameIn(now, fps);
        if (at !== undefined && at !== null) usePlayback.getState().seek(at);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      finish();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
    window.addEventListener('keydown', onKey, true);
    cancelDrag.current = finish;
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const st = useEditor.getState();
    const project = st.project;
    if (e.button === 0 && root && project) {
      const rect = root.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // a marker flag wins in the top zone, then a bracket (also over a marker pole), then the scrub
      const flag = y <= FLAG_H && project.markers ? hitMarker(project.markers, st.zoom, x, y) : null;
      if (!flag) {
        const which = hitRangeHandle(cleanRange(project.range), st.zoom, x);
        if (which) {
          startBracketDrag(e, which);
          return;
        }
      }
    }
    onPointerDown(e);
  };

  const onMoveOver = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 0) return;
    const st = useEditor.getState();
    const el = e.currentTarget;
    const range = cleanRange(st.project?.range);
    if (!range) {
      if (el.style.cursor) el.style.cursor = '';
      return;
    }
    const which = hitRangeHandle(range, st.zoom, e.clientX - el.getBoundingClientRect().left);
    el.style.cursor = which ? 'ew-resize' : '';
  };

  return (
    <div
      ref={rootRef}
      className="timeline-ruler"
      onPointerDown={onDown}
      onPointerMove={onMoveOver}
      title="click or drag to move the playhead. drag an in or out bracket to move it"
    >
      <canvas ref={canvasRef} className="timeline-ruler-canvas" />
      <PlayheadHandle />
    </div>
  );
}
