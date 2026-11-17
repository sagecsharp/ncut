import { memo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { MAX_CURVE_POINTS, isToneKind } from '../../lib/gradeData';
import type { CurveKind } from '../../lib/gradeData';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import type { ClipGrade, GradePoint } from '../../types';
import { tip } from '../shell/tip';
import { beginEdit, cancelEdit, endEdit, liveOpts } from './edit';
import {
  CURVE_TABS,
  addPoint,
  curvePath,
  curvesPatch,
  fromPx,
  hitPoint,
  hueStripCss,
  insertAfter,
  movePoint,
  nudgePoint,
  pointFields,
  pointsOf,
  removePoint,
  stepPoint,
} from './gradeLogic';

/** the picture is drawn on a 100 x 75 sheet that stretches to the box */
const W = 100;
const H = 75;

const FULL = '16 points at most here';
const HUE_STRIP = hueStripCss();
const STRIPS: Record<CurveKind, string> = {
  y: 'linear-gradient(to right, #000, #fff)',
  r: 'linear-gradient(to right, #000, var(--grade-r))',
  g: 'linear-gradient(to right, #000, var(--grade-g))',
  b: 'linear-gradient(to right, #000, var(--grade-b))',
  hueSat: HUE_STRIP,
  hueHue: HUE_STRIP,
  lumaSat: 'linear-gradient(to right, #000, #fff)',
};

const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

interface Drag {
  i: number;
  /** pointer and point when this relative drag started */
  px0: number;
  py0: number;
  x0: number;
  y0: number;
  shift: boolean;
  ctrl: boolean;
  w: number;
  h: number;
  list: GradePoint[];
}

interface GradeCurvesProps {
  id: string;
  grade: ClipGrade | null | undefined;
  kind: CurveKind;
  /** the picked point, -1 for none */
  sel: number;
  onSel(i: number): void;
  disabled: boolean;
}

/** the drawing area of one list of the grade curves: add, pick, drag and take off points */
export const GradeCurves = memo(function GradeCurves({ id, grade, kind, sel, onSel, disabled }: GradeCurvesProps) {
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [over, setOver] = useState(false);
  const [dragging, setDragging] = useState(false);

  const pts = pointsOf(grade, kind);
  const label = CURVE_TABS.find((t) => t.kind === kind)?.label ?? kind;
  const tone = isToneKind(kind);
  const picked = sel >= 0 && sel < pts.length ? pts[sel]! : null;
  const fields = pointFields(kind);

  /** the grade as the store has it now */
  const gradeNow = (): ClipGrade | null | undefined => (useEditor.getState().project?.clips.find((c) => c.id === id) as { grade?: ClipGrade | null } | undefined)?.grade;
  const write = (list: readonly GradePoint[]): void => {
    const next = list.length > 0 ? curvesPatch(gradeNow(), kind, [...list]) : curvesPatch(gradeNow(), kind, null);
    useEditor.getState().updateClip(id, { grade: next }, liveOpts());
  };
  const full = (): void => useUi.getState().toast(FULL);
  const focused = (): boolean => !!area.current && document.activeElement === area.current;
  const end = (): void => {
    if (drag.current) {
      drag.current = null;
      setDragging(false);
    }
    endEdit();
    if (focused()) beginEdit();
  };
  const boxOf = (e: PointerEvent<HTMLDivElement>): { px: number; py: number; w: number; h: number } => {
    const r = e.currentTarget.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top, w: Math.max(1, r.width), h: Math.max(1, r.height) };
  };
  /** the picked index after a point is gone */
  const afterRemove = (i: number, list: readonly GradePoint[]): number => (list.length === 0 ? -1 : Math.min(i, list.length - 1));

  const onDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (disabled) return;
    if (e.button === 2) {
      if (drag.current) {
        cancelEdit();
        drag.current = null;
        setDragging(false);
        beginEdit();
      }
      return;
    }
    if (e.button !== 0) return;
    const { px, py, w, h } = boxOf(e);
    let list = pointsOf(gradeNow(), kind);
    let i = hitPoint(list, px, py, w, h);
    beginEdit();
    if (i < 0) {
      const add = addPoint(kind, list, fromPx(px, py, w, h)[0]);
      if (!add) {
        if (list.length >= MAX_CURVE_POINTS) full();
        return;
      }
      list = add.pts;
      i = add.sel;
      // the add and the drag after it are one undo step
      write(list);
    }
    onSel(i);
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { i, px0: px, py0: py, x0: list[i]![0], y0: list[i]![1], shift: e.shiftKey, ctrl: e.ctrlKey, w, h, list };
    setDragging(true);
  };

  const onMove = (e: PointerEvent<HTMLDivElement>): void => {
    const { px, py, w, h } = boxOf(e);
    const d = drag.current;
    if (d && e.button === 2) {
      // the right button during a left drag comes as a move
      e.preventDefault();
      cancelEdit();
      drag.current = null;
      setDragging(false);
      beginEdit();
      return;
    }
    if (!d) {
      if (!disabled) setOver(hitPoint(pointsOf(gradeNow(), kind), px, py, w, h) >= 0);
      return;
    }
    if (e.shiftKey !== d.shift || e.ctrlKey !== d.ctrl) {
      // a changed modifier starts a new relative drag from where the point is now
      d.shift = e.shiftKey;
      d.ctrl = e.ctrlKey;
      d.px0 = px;
      d.py0 = py;
      d.x0 = d.list[d.i]![0];
      d.y0 = d.list[d.i]![1];
    }
    const k = d.shift ? 0.1 : 1;
    const dx = d.ctrl ? 0 : ((px - d.px0) / d.w) * k;
    const dy = (-(py - d.py0) / d.h) * k;
    d.list = movePoint(kind, d.list, d.i, d.x0 + dx, d.y0 + dy);
    write(d.list);
  };

  const onDouble = (e: MouseEvent<HTMLDivElement>): void => {
    if (disabled) return;
    const r = e.currentTarget.getBoundingClientRect();
    const list = pointsOf(gradeNow(), kind);
    const i = hitPoint(list, e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    if (i < 0) return;
    const next = removePoint(kind, list, i);
    beginEdit();
    write(next);
    onSel(tone && (i === 0 || i === list.length - 1) ? i : afterRemove(i, next));
    end();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled || e.ctrlKey || e.metaKey || e.altKey) return;
    const list = pointsOf(gradeNow(), kind);
    const has = sel >= 0 && sel < list.length;
    const k = e.key;
    if (k === '[' || k === ']') {
      e.preventDefault();
      onSel(stepPoint(list, sel, k === '[' ? -1 : 1));
    } else if (k === 'Home' || k === 'End') {
      e.preventDefault();
      onSel(list.length === 0 ? -1 : k === 'Home' ? 0 : list.length - 1);
    } else if (ARROWS.includes(k)) {
      e.preventDefault();
      if (has) write(nudgePoint(kind, list, sel, k, e.shiftKey));
    } else if (k === 'Enter') {
      e.preventDefault();
      if (!has) return;
      const add = insertAfter(kind, list, sel);
      if (!add) {
        if (list.length >= MAX_CURVE_POINTS) full();
        return;
      }
      write(add.pts);
      onSel(add.sel);
    } else if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      if (!has) return;
      const next = removePoint(kind, list, sel);
      write(next);
      onSel(tone && (sel === 0 || sel === list.length - 1) ? sel : afterRemove(sel, next));
    } else if (k === 'Escape') {
      e.preventDefault();
      cancelEdit();
      drag.current = null;
      setDragging(false);
      beginEdit();
    }
  };

  const mid = H / 2;
  return (
    <div className="grade-curves">
      <div
        ref={area}
        className={`grade-area${disabled ? ' is-disabled' : ''}${dragging ? ' is-drag' : over ? ' is-over' : ''}`}
        role="group"
        tabIndex={disabled ? -1 : 0}
        aria-label={`${label} curves`}
        aria-disabled={disabled || undefined}
        {...tip('curves', {
          does: 'click adds a point and drags it, double click takes it off. shift: finer. ctrl: up and down only',
          keys: ['grade-curve-add', 'grade-curve-remove', 'grade-curve-fine', 'grade-curve-keys'],
        })}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={end}
        onLostPointerCapture={end}
        onPointerLeave={() => setOver(false)}
        onContextMenu={(e) => e.preventDefault()}
        onDoubleClick={onDouble}
        onKeyDown={onKey}
        onFocus={() => {
          if (!disabled && !drag.current) beginEdit();
        }}
        onBlur={() => {
          drag.current = null;
          setDragging(false);
          endEdit();
        }}
      >
        <svg className="grade-sheet" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {[0.25, 0.5, 0.75].map((f) => (
            <g key={f}>
              <line className="grade-gridline" x1={f * W} y1="0" x2={f * W} y2={H} />
              <line className="grade-gridline" x1="0" y1={f * H} x2={W} y2={f * H} />
            </g>
          ))}
          {tone ? <line className="grade-base" x1="0" y1={H} x2={W} y2="0" /> : <line className="grade-base" x1="0" y1={mid} x2={W} y2={mid} />}
          <path className={`grade-line grade-line-${kind}`} d={curvePath(kind, pts, W, H)} />
        </svg>
        {picked ? <div className="grade-guide" style={{ left: `${picked[0] * 100}%` }} /> : null}
        {pts.map((p, i) => (
          <div key={i} className={`grade-point${i === sel ? ' is-picked' : ''}`} style={{ left: `${p[0] * 100}%`, top: `${(1 - p[1]) * 100}%` }} />
        ))}
        {picked ? (
          <div className="grade-live">{`${fields[0].label} ${fields[0].toShown(picked[0])} ${fields[1].label} ${fields[1].toShown(picked[1])}`}</div>
        ) : null}
      </div>
      <div className="grade-strip" style={{ backgroundImage: STRIPS[kind] }} />
    </div>
  );
});
