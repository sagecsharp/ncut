import { useEffect, useRef, useState } from 'react';
import { formatNumber } from './numberFormat';
import {
  DOUBLE_CLICK_MS,
  DOUBLE_CLICK_PX,
  JOG_PX,
  beginDrag,
  clampHard,
  decimalsOf,
  faceOf,
  gestureHint,
  isPastThreshold,
  keptDrag,
  moveDrag,
  nudge,
  parseTyped,
  unitText,
  type DragState,
  type SliderSpec,
  type Span,
} from './sliderMath';

export type SliderSource = 'drag' | 'type' | 'key' | 'reset' | 'cancel';

export interface SliderFieldProps {
  /** shown value. null = mixed (several clips that differ) */
  value: number | null;
  /** write a shown value. may return the value really kept (shown units); a drag re-anchors on it */
  onChange(v: number, source: SliderSource): number | void;
  /** right before the first write of a gesture (a drag, or one focus). store sites: beginEdit. local sites: a no-op */
  onStart(): void;
  /** the gesture ended (released, blurred, cancelled). store sites: endEdit */
  onEnd?(): void;
  /** escape or the right button: take back the gesture. store sites: cancelEdit. missing: onChange(start value, 'cancel') */
  onCancel?(): void;
  /** pointer down, before the threshold (keyed fields pause playback here) */
  onPress?(): void;
  /** hard limits, default none */
  min?: number;
  max?: number;
  /** the face, default none */
  soft?: Span | null;
  step?: number;
  precision?: number;
  snap?: number;
  perPx?: number;
  origin?: number | null;
  /** double click value, default none */
  rest?: number | null;
  /** start value of a drag or an arrow on a mixed field (0, or 100 for a scale that multiplies) */
  mixedFrom?: number;
  /** shown in place of the number while dragging (a mixed field: "+12 px") */
  dragText?: string | null;
  /** inner label of a pair: "in", "len", "w", "h" */
  label?: string;
  suffix?: string;
  disabled?: boolean;
  className?: string;
  /** the field's own title. the gesture line is added under it */
  title?: string;
  ariaLabel?: string;
}

type Mode = 'idle' | 'pressed' | 'dragging' | 'typing';

function specOf(p: SliderFieldProps): SliderSpec {
  const step = p.step ?? 1;
  const precision = p.precision ?? decimalsOf(step);
  return {
    min: p.min ?? -Infinity,
    max: p.max ?? Infinity,
    soft: p.soft ?? null,
    step,
    precision,
    snap: p.snap ?? (p.suffix === 'deg' || p.suffix === '°' ? 15 : step * 10),
    perPx: p.perPx ?? step / JOG_PX,
    origin: p.origin ?? null,
  };
}

/**
 * the one number control of the properties: the box is the slider. drag it sideways, click to type, double click
 * for the rest value. it subscribes to nothing: the fill is css variables set in render.
 */
export function SliderField(props: SliderFieldProps) {
  const [draft, setDraftState] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const P = useRef(props);
  P.current = props;
  const draftRef = useRef<string | null>(null);
  const setDraft = (v: string | null) => {
    draftRef.current = v;
    setDraftState(v);
  };

  const mode = useRef<Mode>('idle');
  const press = useRef({ x: 0, y: 0, id: 0, type: 'mouse' });
  const drag = useRef<DragState | null>(null);
  const width = useRef(0);
  const started = useRef(false);
  const startValue = useRef(0);
  const lastWritten = useRef<number | null>(null);
  const enteredAt = useRef(0);
  const enteredSpot = useRef({ x: 0, y: 0 });
  const skipBlur = useRef(false);
  const noMenuUntil = useRef(0);
  const listeners = useRef<{ keydown: (e: KeyboardEvent) => void; keyup: (e: KeyboardEvent) => void; blur: () => void } | null>(null);

  const spec = specOf(props);
  const value = props.value;
  const mixed = value === null;
  const text = mixed ? '' : formatNumber(value, spec.precision);

  /* ---- gesture helpers. they read refs only, so a window listener never goes stale ---- */

  const startOf = () => P.current.value ?? P.current.mixedFrom ?? 0;

  const write = (v: number, source: SliderSource) => {
    const p = P.current;
    if (!started.current) {
      started.current = true;
      startValue.current = startOf();
      p.onStart();
    }
    const kept = p.onChange(v, source);
    lastWritten.current = v;
    const d = drag.current;
    if (source === 'drag' && d && typeof kept === 'number' && Math.abs(kept - v) > spec.step / 2) {
      drag.current = keptDrag(d, kept);
      lastWritten.current = kept;
    }
  };

  const cancelPath = () => {
    if (!started.current) return;
    const p = P.current;
    if (p.onCancel) p.onCancel();
    else p.onChange(startValue.current, 'cancel');
  };

  const removeListeners = () => {
    const l = listeners.current;
    if (l) {
      window.removeEventListener('keydown', l.keydown, true);
      window.removeEventListener('keyup', l.keyup, true);
      window.removeEventListener('blur', l.blur);
      listeners.current = null;
    }
    document.documentElement.classList.remove('is-scrubbing');
  };

  const finish = () => {
    const was = mode.current;
    mode.current = 'idle';
    removeListeners();
    drag.current = null;
    if (was === 'dragging') setDragging(false);
    if (started.current) {
      P.current.onEnd?.();
      started.current = false;
    }
  };

  const cancel = () => {
    cancelPath();
    finish();
  };

  const reeval = (x: number, shift: boolean, ctrl: boolean) => {
    const d = drag.current;
    if (!d) return;
    const next = moveDrag(d, x, shift, ctrl, specOf(P.current));
    drag.current = next;
    if (next.out !== lastWritten.current) write(next.out, 'drag');
  };

  const api = useRef({ cancel, finish, reeval });
  api.current = { cancel, finish, reeval };

  const addListeners = () => {
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        api.current.cancel();
        return;
      }
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta') {
        const d = drag.current;
        if (d) api.current.reeval(d.lastX, e.shiftKey, e.ctrlKey || e.metaKey);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    const keyup = (e: KeyboardEvent) => {
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta') {
        const d = drag.current;
        if (d) api.current.reeval(d.lastX, e.shiftKey, e.ctrlKey || e.metaKey);
      }
    };
    const blur = () => api.current.finish();
    listeners.current = { keydown, keyup, blur };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('keyup', keyup, true);
    window.addEventListener('blur', blur);
    document.documentElement.classList.add('is-scrubbing');
  };

  useEffect(
    () => () => {
      if (mode.current === 'dragging') api.current.finish();
      else removeListeners();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const selectSoon = () => {
    // now, and again next frame: a hidden page may never run the frame
    inputRef.current?.select();
    requestAnimationFrame(() => inputRef.current?.select());
  };

  /* ---- typing ---- */

  const commit = () => {
    const d = draftRef.current;
    setDraft(null);
    if (d === null) return;
    const shown = mixed ? '' : formatNumber(P.current.value ?? 0, specOf(P.current).precision);
    if (d.trim().replace(',', '.') === shown) return;
    const n = parseTyped(d);
    if (n === null) return;
    const s = specOf(P.current);
    const c = clampHard(n, s);
    if (P.current.value !== null && c === P.current.value) return;
    write(c, 'type');
  };

  /* ---- pointer ---- */

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = P.current;
    if (p.disabled) return;
    if (mode.current === 'dragging' || mode.current === 'pressed') return;
    if (mode.current === 'typing') {
      const near = Math.abs(e.clientX - enteredSpot.current.x) <= DOUBLE_CLICK_PX && Math.abs(e.clientY - enteredSpot.current.y) <= DOUBLE_CLICK_PX;
      if (e.button === 0 && Date.now() - enteredAt.current < DOUBLE_CLICK_MS && near && p.rest !== null && p.rest !== undefined) {
        e.preventDefault();
        write(p.rest, 'reset');
        setDraft(null);
        enteredAt.current = 0;
        selectSoon();
      }
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    const active = document.activeElement;
    if (active && active !== inputRef.current && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) (active as HTMLElement).blur();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // a synthetic event may carry an id the browser does not know
    }
    mode.current = 'pressed';
    press.current = { x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType };
    p.onPress?.();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((mode.current === 'pressed' || mode.current === 'dragging') && e.pointerId !== press.current.id) return;
    /* the right button of a chord arrives as a move with button 2, not as a down */
    if (mode.current === 'dragging' && e.button === 2) {
      e.preventDefault();
      noMenuUntil.current = Date.now() + 500;
      cancel();
      return;
    }
    if (mode.current === 'pressed') {
      if (!isPastThreshold(e.clientX - press.current.x, press.current.type)) return;
      mode.current = 'dragging';
      width.current = rootRef.current?.getBoundingClientRect().width ?? 0;
      drag.current = beginDrag(startOf(), e.clientX, specOf(P.current), width.current, e.shiftKey, e.ctrlKey || e.metaKey);
      lastWritten.current = drag.current.out;
      setDragging(true);
      addListeners();
      return;
    }
    if (mode.current === 'dragging') reeval(e.clientX, e.shiftKey, e.ctrlKey || e.metaKey);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((mode.current === 'pressed' || mode.current === 'dragging') && e.pointerId !== press.current.id) return;
    if (mode.current === 'pressed') {
      mode.current = 'idle';
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // nothing held
      }
      inputRef.current?.focus();
      inputRef.current?.select();
      enteredAt.current = Date.now();
      enteredSpot.current = { x: e.clientX, y: e.clientY };
      mode.current = 'typing';
      return;
    }
    if (mode.current === 'dragging') finish();
  };

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((mode.current === 'pressed' || mode.current === 'dragging') && e.pointerId !== press.current.id) return;
    if (mode.current === 'dragging') finish();
    else if (mode.current === 'pressed') mode.current = 'idle';
  };

  /* ---- render ---- */

  const face = value === null ? null : faceOf(value, spec.soft, spec.origin);
  const hint = gestureHint(
    unitText(formatNumber(spec.snap, 0), props.suffix ?? ''),
    props.rest === null || props.rest === undefined ? null : unitText(formatNumber(props.rest, 0), props.suffix ?? ''),
  );
  const title = [!mixed && text.length > 6 ? text : null, props.title, hint].filter((s): s is string => !!s).join('\n');

  const shown = draft ?? (dragging && props.dragText != null ? props.dragText : text);
  const classes = [
    'number-field',
    'slider-field',
    !spec.soft ? 'is-jog' : '',
    mixed ? 'is-mixed' : '',
    typing ? 'is-typing' : '',
    face?.pin === 'over' ? 'is-over' : '',
    face?.pin === 'under' ? 'is-under' : '',
    props.disabled ? 'is-disabled' : '',
    props.className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  const style = face ? ({ '--a': face.a, '--b': face.b, '--v': face.v } as React.CSSProperties) : undefined;

  return (
    <div
      ref={rootRef}
      className={classes}
      style={style}
      title={title}
      onMouseDown={(e) => {
        if (mode.current !== 'typing' && !props.disabled) e.preventDefault();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onContextMenu={(e) => {
        if (mode.current === 'dragging' || Date.now() < noMenuUntil.current) e.preventDefault();
      }}
    >
      {props.label ? <span className="number-field-label">{props.label}</span> : null}
      <input
        ref={inputRef}
        className={`number-field-input mono${shown.length > 6 ? ' is-long' : ''}`}
        type="text"
        inputMode="decimal"
        spellCheck={false}
        autoComplete="off"
        role="spinbutton"
        aria-valuenow={mixed ? undefined : value}
        aria-valuemin={Number.isFinite(spec.min) ? spec.min : undefined}
        aria-valuemax={Number.isFinite(spec.max) ? spec.max : undefined}
        aria-valuetext={mixed ? 'mixed' : unitText(text, props.suffix ?? '')}
        aria-label={props.ariaLabel ?? props.title ?? props.label}
        placeholder={mixed ? 'mixed' : undefined}
        disabled={props.disabled}
        value={shown}
        onFocus={(e) => {
          if (mode.current === 'dragging') return;
          mode.current = 'typing';
          setTyping(true);
          started.current = false;
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (skipBlur.current) skipBlur.current = false;
          else commit();
          if (started.current) {
            P.current.onEnd?.();
            started.current = false;
          }
          if (mode.current === 'typing') mode.current = 'idle';
          setTyping(false);
          setDraft(null);
        }}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          if (e.key === 'Enter') {
            commit();
            skipBlur.current = true;
            el.blur();
          } else if (e.key === 'Escape') {
            setDraft(null);
            cancelPath();
            if (started.current) {
              P.current.onEnd?.();
              started.current = false;
            }
            skipBlur.current = true;
            el.blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'PageUp' || e.key === 'PageDown') {
            e.preventDefault();
            const dir = e.key === 'ArrowUp' || e.key === 'PageUp' ? 1 : -1;
            const big = e.shiftKey || e.key === 'PageUp' || e.key === 'PageDown';
            const d = draftRef.current;
            const base = (d !== null ? parseTyped(d) : null) ?? P.current.value ?? P.current.mixedFrom ?? 0;
            // an arrow after typing starts from the typed value, so it is a set, not a step
            write(nudge(base, dir, big, specOf(P.current)), d !== null && parseTyped(d) !== null ? 'type' : 'key');
            setDraft(null);
            selectSoon();
          }
        }}
      />
      {props.suffix ? <span className="number-field-suffix">{props.suffix}</span> : null}
    </div>
  );
}
