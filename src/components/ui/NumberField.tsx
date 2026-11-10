import { useEffect, useRef, useState } from 'react';
import { clamp } from '../../lib/time';

export interface NumberFieldProps {
  value: number;
  /** fires on every change (typing commit, arrow keys, label drag) */
  onChange: (value: number) => void;
  /** fires once when an interaction starts (focus / drag start). use it to pushHistory(). */
  onStart?: () => void;
  min?: number;
  max?: number;
  step?: number;
  /** decimals shown. default 0 */
  precision?: number;
  /** short text shown inside the field on the left (x, y, w...). drag it sideways to scrub. */
  label?: string;
  /** unit shown after the number (px, %, s, °) */
  suffix?: string;
  disabled?: boolean;
  className?: string;
  title?: string;
}

/**
 * compact numeric input. type a value + enter, use arrow up/down (shift = x10),
 * or drag the label sideways to scrub.
 */
export function NumberField({
  value,
  onChange,
  onStart,
  min = -Infinity,
  max = Infinity,
  step = 1,
  precision = 0,
  label,
  suffix,
  disabled,
  className,
  title,
}: NumberFieldProps) {
  const format = (v: number) => (Number.isFinite(v) ? v.toFixed(precision) : '0');
  const [draft, setDraft] = useState<string | null>(null);
  const drag = useRef<{ x: number; start: number; moved: boolean } | null>(null);

  useEffect(() => {
    setDraft(null);
  }, [value]);

  const commit = (text: string) => {
    const n = Number(text.replace(',', '.'));
    setDraft(null);
    if (text.trim() === '' || !Number.isFinite(n)) return;
    const next = clamp(n, min, max);
    if (next !== value) onChange(next);
  };

  const nudge = (dir: number, big: boolean) => {
    const next = clamp(Number((value + dir * step * (big ? 10 : 1)).toFixed(6)), min, max);
    if (next !== value) onChange(next);
  };

  return (
    <label className={`number-field${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`} title={title}>
      {label ? (
        <span
          className="number-field-label"
          onPointerDown={(e) => {
            if (disabled) return;
            e.preventDefault();
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, start: value, moved: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dx = e.clientX - d.x;
            if (!d.moved && Math.abs(dx) < 3) return;
            if (!d.moved) {
              d.moved = true;
              onStart?.();
            }
            const next = clamp(Number((d.start + dx * step * (e.shiftKey ? 10 : 1)).toFixed(6)), min, max);
            onChange(next);
          }}
          onPointerUp={(e) => {
            (e.target as HTMLElement).releasePointerCapture(e.pointerId);
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          {label}
        </span>
      ) : null}
      <input
        className="number-field-input mono"
        type="text"
        inputMode="decimal"
        disabled={disabled}
        value={draft ?? format(value)}
        onFocus={(e) => {
          onStart?.();
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          if (draft !== null) commit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            nudge(1, e.shiftKey);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            nudge(-1, e.shiftKey);
          }
        }}
      />
      {suffix ? <span className="number-field-suffix">{suffix}</span> : null}
    </label>
  );
}
