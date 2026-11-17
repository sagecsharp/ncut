import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { ChevronDown, ChevronRight, Pipette } from 'lucide-react';
import { SliderField, type SliderSource } from '../../components/ui/SliderField';
import { beginEdit, cancelEdit, endEdit, isHex, toColorInput } from './edit';
import { FEEL, resolveFeel, type FeelEntry, type FeelKey, type FeelOverride } from './fieldFeel';
import { useFeelCtx } from './feelContext';
import { SECTION_TIPS } from './sectionTips';
import { useUi } from '../../store/ui';
import { tip } from '../shell/tip';

/** remembered per section name while the app is open */
const openState = new Map<string, boolean>();

/** the last reveal a section handled (n only grows), so a remount never scrolls again */
let revealHandled = 0;

/** `defaultOpen` (default true) is used until the user has toggled that section */
export function Section({ id, title, defaultOpen = true, children }: { id: string; title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(() => openState.get(id) ?? defaultOpen);
  const head = useRef<HTMLButtonElement>(null);
  // a number, so only the revealed section re-renders
  const revealN = useUi((s) => (s.reveal?.id === id ? s.reveal.n : 0));
  // layout effect: open first, then measure the opened body before paint
  useLayoutEffect(() => {
    if (revealN <= revealHandled) return;
    openState.set(id, true);
    if (!open) {
      setOpen(true);
      return;
    }
    revealHandled = revealN;
    const h = head.current;
    const body = h?.closest<HTMLElement>('.panel-body');
    if (h && body) body.scrollTop += h.getBoundingClientRect().top - body.getBoundingClientRect().top;
    // focus after the scroll event, or the blurb tip is hidden by it
    requestAnimationFrame(() => head.current?.focus({ preventScroll: true }));
  }, [revealN, open, id]);
  const blurb = SECTION_TIPS[id];
  const headTip = blurb ? tip(title, { does: blurb, side: 'left' }) : { title: open ? `collapse ${title}` : `expand ${title}` };
  return (
    <section className="props-section">
      <button
        ref={head}
        type="button"
        className="props-section-head"
        {...headTip}
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

export interface FeelFieldProps extends FeelOverride {
  feel: FeelKey | FeelEntry;
  /** shown value. null = mixed */
  value: number | null;
  onChange(v: number, source: SliderSource): number | void;
  /** session values that are not in the store: no undo step; escape writes the start value back */
  local?: boolean;
  /** replaces beginEdit (ClipInspector in, len and speed pass beginFollowEdit) */
  onStart?(): void;
  /** escape during a drag, after the store edit is cancelled (for values the site keeps in its own state) */
  onCancel?(): void;
  /** pointer down, before the drag starts (keyed fields pause playback here) */
  onPress?(): void;
  /** inner label (pairs) */
  label?: string;
  title: string;
  ariaLabel?: string;
  /** default 'props-grow' */
  className?: string;
  disabled?: boolean;
  mixedFrom?: number;
  dragText?: string | null;
}

const noop = (): void => undefined;

/** one slider field of the feel table: the number box is the slider */
export function FeelField(p: FeelFieldProps) {
  const ctx = useFeelCtx();
  const f = resolveFeel(typeof p.feel === 'string' ? FEEL[p.feel] : p.feel, ctx, p);
  return (
    <SliderField
      value={p.value}
      onChange={p.onChange}
      onStart={p.local ? noop : (p.onStart ?? beginEdit)}
      onPress={p.onPress}
      onEnd={p.local ? undefined : endEdit}
      onCancel={p.local ? undefined : () => {
        cancelEdit();
        p.onCancel?.();
      }}
      min={f.min}
      max={f.max}
      soft={f.soft}
      step={f.step}
      precision={f.precision}
      snap={f.snap}
      perPx={f.perPx}
      origin={f.origin}
      rest={f.rest}
      mixedFrom={p.mixedFrom}
      dragText={p.dragText}
      label={p.label}
      suffix={f.unit || undefined}
      disabled={p.disabled}
      className={p.className ?? 'props-grow'}
      title={p.title}
      ariaLabel={p.ariaLabel}
    />
  );
}

interface SliderRowProps extends FeelOverride {
  label: string;
  title: string;
  value: number;
  feel: FeelKey | FeelEntry;
  wide?: boolean;
  disabled?: boolean;
  local?: boolean;
  /** runs after the store edit has begun, at the start of a drag */
  onStart?(): void;
  onCancel?(): void;
  onChange: (v: number) => void;
}

/** a label row with one slider field */
export function SliderRow({ label, title, value, feel, wide, disabled, local, onChange, onStart, onCancel, ...over }: SliderRowProps) {
  return (
    <Row label={label} title={title} wide={wide}>
      <FeelField
        feel={feel}
        {...over}
        className="props-grow"
        ariaLabel={label}
        title={title}
        value={value}
        disabled={disabled}
        local={local}
        onChange={onChange}
        onStart={onStart ? () => {
          beginEdit();
          onStart();
        } : undefined}
        onCancel={onCancel}
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

/** the browser eyedropper (chromium). declared here because the dom lib has no type for it. */
interface EyeDropperLike {
  open(): Promise<{ sRGBHex: string }>;
}
type EyeDropperCtor = new () => EyeDropperLike;

function eyeDropper(): EyeDropperCtor | null {
  if (typeof window === 'undefined' || !('EyeDropper' in window)) return null;
  return (window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper;
}

/** color swatch + hex text (+ a pipette where the browser can pick colors from the screen) */
export function ColorField({ value, title, disabled, onChange }: ColorFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const Dropper = eyeDropper();
  const pick = () => {
    if (!Dropper) return;
    beginEdit();
    new Dropper()
      .open()
      .then((r) => onChange(r.sRGBHex.toLowerCase() + (value.length === 9 && isHex(value) ? value.slice(7) : '')))
      .catch(() => {
        /* the user aborted */
      });
  };
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
      {Dropper ? (
        <button type="button" className="icon-btn" title={`pick ${title} from the screen`} aria-label={`pick ${title} from the screen`} disabled={disabled} onClick={pick}>
          <Pipette size={14} />
        </button>
      ) : null}
    </div>
  );
}

export { Switch } from '../../components/ui/Switch';

export interface SelectOpenHandlers {
  onPointerDown: () => void;
  onKeyDown: () => void;
  onFocus: () => void;
  onBlur: () => void;
}

/**
 * for selects with a long list: `open` turns true as soon as the select is touched, focused or gets a key
 * (before the dropdown opens: pointer down and key down are flushed at once) and false when it loses focus.
 * render the full list while open and just the selected choice otherwise.
 */
export function useSelectOpen(): { open: boolean; handlers: SelectOpenHandlers } {
  const [open, setOpen] = useState(false);
  const on = useRef(false);
  const handlers = useMemo<SelectOpenHandlers>(() => {
    const start = (sync: boolean) => {
      if (on.current) return;
      on.current = true;
      if (sync) flushSync(() => setOpen(true));
      else setOpen(true);
    };
    return {
      onPointerDown: () => start(true),
      onKeyDown: () => start(true),
      onFocus: () => start(false),
      onBlur: () => {
        on.current = false;
        setOpen(false);
      },
    };
  }, []);
  return { open, handlers };
}

/** a plain select row. options are [value, label]. handlers: see useSelectOpen. */
export function SelectRow({
  label,
  title,
  value,
  options,
  wide,
  onChange,
  handlers,
}: {
  handlers?: SelectOpenHandlers;
  wide?: boolean;
  label: string;
  title: string;
  value: string;
  options: [value: string, label: string][];
  onChange: (v: string) => void;
}) {
  return (
    <Row label={label} title={title} wide={wide}>
      <select className="select" title={title} aria-label={title} value={value} onChange={(e) => onChange(e.target.value)} {...handlers}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </Row>
  );
}
