/** font picker: a button showing the family in its own font, with a searchable popover of every available font. */
import { Check, ChevronDown, Search, Upload, X } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  canLoadLocalFonts,
  ensureFont,
  importFontFile,
  listFonts,
  loadLocalFonts,
  noteFontUsed,
  onFontsChanged,
  recentFonts,
  removeImportedFont,
  type FontCategory,
  type FontInfo,
} from '../../lib/fonts';
import { useUi } from '../../store/ui';
import './fontPicker.css';

export interface FontPickerProps {
  /** css font-family of the clip */
  value: string;
  onChange(family: string): void;
  id?: string;
}

type Chip = 'all' | FontCategory;
const CHIPS: Chip[] = ['all', 'sans', 'serif', 'display', 'handwriting', 'mono', 'system', 'local', 'imported'];

const ROW_H = 28;
const HEAD_H = 22;
const LIST_H = 264;
const OVERSCAN = 6;
const POP_W = 280;
const POP_H = 400;

type Item = { kind: 'head'; key: string; label: string } | { kind: 'font'; key: string; font: FontInfo };

function quote(family: string): string {
  return `"${family.replace(/"/g, '')}"`;
}

/** subscribe to the font list (same array until something is added / removed) */
function useFontList(): FontInfo[] {
  return useSyncExternalStore(onFontsChanged, listFonts, listFonts);
}

/** true once the family is usable on screen. loads it lazily, after a short pause so fast scrolling loads nothing. */
function useFontReady(family: string, delay: number): boolean {
  const [readyFor, setReadyFor] = useState('');
  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      void ensureFont(family, 400, false, family).then(() => {
        if (live) setReadyFor(family);
      });
    }, delay);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [family, delay]);
  return readyFor === family;
}

interface RowProps {
  font: FontInfo;
  top: number;
  active: boolean;
  selected: boolean;
  id: string;
  onPick(family: string): void;
  onHover(key: string): void;
  itemKey: string;
}

const FontRow = memo(function FontRow({ font, top, active, selected, id, onPick, onHover, itemKey }: RowProps) {
  const ready = useFontReady(font.family, 60);
  const style: CSSProperties = { transform: `translate3d(0, ${top}px, 0)` };
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className={`fp-row${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}`}
      style={style}
      onPointerMove={() => onHover(itemKey)}
      onClick={() => onPick(font.family)}
    >
      <span className="fp-name" style={ready ? { fontFamily: `${quote(font.family)}, var(--font)` } : undefined}>
        {font.family}
      </span>
      {selected && <Check size={12} aria-hidden="true" className="fp-check" />}
      {font.category === 'imported' && (
        <button
          type="button"
          className="icon-btn icon-btn-sm fp-remove"
          title="remove this font"
          aria-label={`remove ${font.family}`}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            void removeImportedFont(font.family);
          }}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
});

export function FontPicker({ value, onChange, id }: FontPickerProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uidBase = useId();
  const listId = `${uidBase}-list`;

  const fonts = useFontList();
  const buttonReady = useFontReady(value, 0);

  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<Chip>('all');
  const [activeKey, setActiveKey] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxH: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }, []);

  // anchor the popover to the button (position: fixed, so the scrolling inspector never clips it)
  useLayoutEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(r.width, POP_W);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const flip = below < 260 && above > below;
    const maxH = Math.min(POP_H, flip ? above : below);
    setPos({ left, width, maxH, top: flip ? Math.max(8, r.top - 4 - maxH) : r.bottom + 4 });
  }, [open]);

  // outside click / escape handled on the input; scrolling or resizing the page moves the anchor, so just close
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (popRef.current?.contains(t) || btnRef.current?.contains(t))) return;
      close(false);
    };
    const scroll = (e: Event) => {
      const t = e.target as Node | null;
      if (t && popRef.current?.contains(t)) return;
      close(false);
    };
    const resize = () => close(false);
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
    };
  }, [open, close]);

  const openPicker = () => {
    setQuery('');
    setChip('all');
    setScrollTop(0);
    setActiveKey('');
    setOpen(true);
  };

  // categories that have at least one font
  const chips = useMemo(() => {
    const have = new Set(fonts.map((f) => f.category));
    return CHIPS.filter((c) => c === 'all' || have.has(c));
  }, [fonts]);
  const chipNow: Chip = chips.includes(chip) ? chip : 'all';

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (f: FontInfo) => (chipNow === 'all' || f.category === chipNow) && (!q || f.family.toLowerCase().includes(q));
    const out: Item[] = [];
    const byName = new Map(fonts.map((f) => [f.family, f]));
    const recent = recentFonts()
      .map((r) => byName.get(r))
      .filter((f): f is FontInfo => !!f && match(f));
    if (recent.length) {
      out.push({ kind: 'head', key: 'h:recent', label: 'recent' });
      for (const f of recent) out.push({ kind: 'font', key: `r:${f.family}`, font: f });
    }
    const rest = fonts.filter(match);
    if (chipNow === 'all') {
      for (const cat of CHIPS) {
        if (cat === 'all') continue;
        const inCat = rest.filter((f) => f.category === cat);
        if (!inCat.length) continue;
        out.push({ kind: 'head', key: `h:${cat}`, label: cat });
        for (const f of inCat) out.push({ kind: 'font', key: f.family, font: f });
      }
    } else {
      for (const f of rest) out.push({ kind: 'font', key: f.family, font: f });
    }
    return out;
  }, [fonts, query, chipNow]);

  // offsets for the windowing (rows have two fixed heights)
  const layout = useMemo(() => {
    const tops: number[] = [];
    let y = 0;
    for (const it of items) {
      tops.push(y);
      y += it.kind === 'head' ? HEAD_H : ROW_H;
    }
    return { tops, total: y };
  }, [items]);

  const fontItems = useMemo(() => items.filter((i): i is Extract<Item, { kind: 'font' }> => i.kind === 'font'), [items]);
  const activeNow = fontItems.some((i) => i.key === activeKey) ? activeKey : (fontItems[0]?.key ?? '');

  // start on the current font when the list opens
  useEffect(() => {
    if (!open) return;
    const cur = fontItems.find((i) => i.font.family === value);
    if (cur) {
      setActiveKey(cur.key);
      const idx = items.indexOf(cur);
      const top = Math.max(0, layout.tops[idx] - LIST_H / 2 + ROW_H / 2);
      requestAnimationFrame(() => {
        if (listRef.current) listRef.current.scrollTop = top;
      });
    }
    inputRef.current?.focus();
    // only when it opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const scrollToKey = useCallback(
    (key: string) => {
      const el = listRef.current;
      if (!el) return;
      const idx = items.findIndex((i) => i.key === key);
      if (idx < 0) return;
      const top = layout.tops[idx];
      if (top < el.scrollTop) el.scrollTop = top - (idx > 0 && items[idx - 1].kind === 'head' ? HEAD_H : 0);
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    },
    [items, layout],
  );

  const pick = useCallback(
    (family: string) => {
      // start loading both weights now, the canvas redraws when they are ready
      void ensureFont(family, 400);
      void ensureFont(family, 700);
      noteFontUsed(family);
      onChange(family);
      close(true);
    },
    [onChange, close],
  );

  const move = (delta: number | 'first' | 'last') => {
    if (!fontItems.length) return;
    const cur = fontItems.findIndex((i) => i.key === activeNow);
    let next = delta === 'first' ? 0 : delta === 'last' ? fontItems.length - 1 : Math.max(0, Math.min(fontItems.length - 1, cur + delta));
    if (next < 0) next = 0;
    const key = fontItems[next].key;
    setActiveKey(key);
    scrollToKey(key);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      move(8);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      move(-8);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = fontItems.find((i) => i.key === activeNow);
      if (it) pick(it.font.family);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
    } else if ((e.key === 'Home' || e.key === 'End') && e.ctrlKey) {
      e.preventDefault();
      move(e.key === 'Home' ? 'first' : 'last');
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const info = await importFontFile(file);
      pick(info.family);
    } catch (err) {
      useUi.getState().toast(err instanceof Error ? err.message : 'could not import that font', 'error');
    } finally {
      setBusy(false);
    }
  };

  const onLocal = async () => {
    setBusy(true);
    try {
      const n = await loadLocalFonts();
      if (n > 0) {
        setChip('local');
        useUi.getState().toast(`added ${n} fonts from this computer`, 'success');
      } else {
        useUi.getState().toast('no new fonts found', 'info');
      }
    } catch (err) {
      const denied = err instanceof DOMException && err.name === 'NotAllowedError';
      useUi.getState().toast(denied ? 'permission to read fonts was denied' : 'could not read the fonts on this computer', 'error');
    } finally {
      setBusy(false);
    }
  };

  // windowed rows
  const viewH = listRef.current?.clientHeight || LIST_H;
  let first = 0;
  while (first < items.length - 1 && layout.tops[first + 1] <= scrollTop) first++;
  first = Math.max(0, first - OVERSCAN);
  let last = first;
  while (last < items.length && layout.tops[last] < scrollTop + viewH) last++;
  last = Math.min(items.length, last + OVERSCAN);

  const activeId = activeNow ? `${uidBase}-opt-${items.findIndex((i) => i.key === activeNow)}` : undefined;

  return (
    <>
      <button
        ref={btnRef}
        id={id}
        type="button"
        className="select fp-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="choose a font"
        onClick={() => (open ? close(false) : openPicker())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            openPicker();
          }
        }}
      >
        <span className="fp-button-name" style={buttonReady ? { fontFamily: `${quote(value)}, var(--font)` } : undefined}>
          {value}
        </span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className="fp-pop menu"
            style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxH }}
            onKeyDown={onKeyDown}
          >
            <div className="fp-search">
              <Search size={12} aria-hidden="true" />
              <input
                ref={inputRef}
                className="input input-sm"
                type="text"
                role="combobox"
                aria-label="search fonts"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={activeId}
                placeholder="search fonts"
                spellCheck={false}
                autoComplete="off"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setScrollTop(0);
                  if (listRef.current) listRef.current.scrollTop = 0;
                }}
              />
            </div>
            <div className="fp-chips" role="group" aria-label="font categories">
              {chips.map((c) => (
                <button
                  key={c}
                  type="button"
                  tabIndex={-1}
                  className={`fp-chip${c === chipNow ? ' is-active' : ''}`}
                  aria-pressed={c === chipNow}
                  onClick={() => {
                    setChip(c);
                    setScrollTop(0);
                    if (listRef.current) listRef.current.scrollTop = 0;
                    inputRef.current?.focus();
                  }}
                >
                  {c}
                </button>
              ))}
            </div>
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label="fonts"
              className="fp-list"
              onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            >
              {items.length === 0 ? (
                <div className="fp-empty">no fonts match</div>
              ) : (
                <div className="fp-inner" style={{ height: layout.total }}>
                  {items.slice(first, last).map((it, i) => {
                    const idx = first + i;
                    const top = layout.tops[idx];
                    if (it.kind === 'head') {
                      return (
                        <div key={it.key} className="fp-head" role="presentation" style={{ transform: `translate3d(0, ${top}px, 0)` }}>
                          {it.label}
                        </div>
                      );
                    }
                    return (
                      <FontRow
                        key={it.key}
                        id={`${uidBase}-opt-${idx}`}
                        itemKey={it.key}
                        font={it.font}
                        top={top}
                        active={it.key === activeNow}
                        selected={it.font.family === value}
                        onPick={pick}
                        onHover={setActiveKey}
                      />
                    );
                  })}
                </div>
              )}
            </div>
            <div className="fp-foot">
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                title="add a .ttf, .otf, .woff or .woff2 file"
                onClick={() => fileRef.current?.click()}
              >
                <Upload size={12} aria-hidden="true" />
                import font file
              </button>
              {canLoadLocalFonts() && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  title="list the fonts installed on this computer (asks for permission)"
                  onClick={() => void onLocal()}
                >
                  use fonts from this computer
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                hidden
                accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  void onFile(f);
                }}
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
