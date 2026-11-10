import { useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { NumberField } from '../../components/ui/NumberField';
import { beginEdit, isHex, toColorInput } from './edit';

/** remembered per section name while the app is open */
const openState = new Map<string, boolean>();

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(() => openState.get(id) ?? true);
  return (
    <section className="props-section">
      <button
        type="button"
        className="props-section-head"
        title={open ? `collapse ${title}` : `expand ${title}`}
        aria-expanded={open}
        onClick={() => {
          openState.set(id, !open);
          setOpen(!open);
        }}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{title}</span>
      </button>
      {open ? <div className="props-section-body">{children}</div> : null}
    </section>
  );
}

export function Row({ label, title, wide, children }: { label: string; title?: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className="props-row" title={title}>
      <span className={`field-label props-label${wide ? ' props-label-wide' : ''}`}>{label}</span>
      <div className="props-control">{children}</div>
    </div>
  );
}

export function Pair({ children }: { children: ReactNode }) {
  return <div className="props-pair">{children}</div>;
}

interface SliderRowProps {
  label: string;
  title: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  precision?: number;
  suffix?: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}

/** .range slider + number field bound to the same value */
export function SliderRow({ label, title, value, min, max, step = 1, precision = 0, suffix, disabled, onChange }: SliderRowProps) {
  return (
    <Row label={label} title={title}>
      <input
        type="range"
        className="range props-range"
        title={title}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={Math.min(max, Math.max(min, value))}
        onPointerDown={beginEdit}
        onKeyDown={(e) => {
          if (!e.repeat) beginEdit();
        }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <NumberField
        className="props-num"
        title={title}
        value={value}
        min={min}
        max={max}
        step={step}
        precision={precision}
        suffix={suffix}
        disabled={disabled}
        onStart={beginEdit}
        onChange={onChange}
      />
    </Row>
  );
}

interface ColorFieldProps {
  value: string;
  title: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}

/** color swatch + hex text */
export function ColorField({ value, title, disabled, onChange }: ColorFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="props-color">
      <input
        type="color"
        className="input props-swatch"
        title={title}
        disabled={disabled}
        value={toColorInput(value)}
        onFocus={beginEdit}
        onPointerDown={beginEdit}
        onChange={(e) => onChange(e.target.value + (value.length === 9 && isHex(value) ? value.slice(7) : ''))}
      />
      <input
        type="text"
        className="input mono props-hex"
        title={`${title} (hex)`}
        spellCheck={false}
        maxLength={9}
        disabled={disabled}
        value={draft ?? value}
        onFocus={beginEdit}
        onChange={(e) => {
          let v = e.target.value.trim();
          if (v && !v.startsWith('#')) v = `#${v}`;
          setDraft(v);
          if ((v.length === 7 || v.length === 9) && isHex(v)) onChange(v.toLowerCase());
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'Escape') {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}

/** clear on / off switch: a button that reads "on" or "off" */
export function Switch({ checked, title, onChange }: { checked: boolean; title: string; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`btn btn-sm props-switch${checked ? ' btn-primary' : ''}`}
      title={title}
      aria-label={title}
      onClick={() => onChange(!checked)}
    >
      {checked ? 'on' : 'off'}
    </button>
  );
}

/** a plain select row. options are [value, label]. */
export function SelectRow({
  label,
  title,
  value,
  options,
  wide,
  onChange,
}: {
  wide?: boolean;
  label: string;
  title: string;
  value: string;
  options: [value: string, label: string][];
  onChange: (v: string) => void;
}) {
  return (
    <Row label={label} title={title} wide={wide}>
      <select className="select" title={title} aria-label={title} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </Row>
  );
}
