import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { paletteActions } from './paletteActions';
import { searchItems } from './paletteSearch';
import { closePalette, usePalette } from './paletteStore';
import './shell.css';

function Keys({ keys }: { keys: readonly (readonly string[])[] }) {
  return (
    <span className="shell-shortcut-keys">
      {keys.map((combo, i) => (
        <Fragment key={combo.join('+')}>
          {i > 0 ? <span className="shell-shortcut-or">or</span> : null}
          {combo.map((cap, j) => (
            <kbd className="kbd" key={j}>
              {cap}
            </kbd>
          ))}
        </Fragment>
      ))}
    </span>
  );
}

function PaletteBody() {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // where the pointer last really was: the list scrolling under a resting pointer also fires mousemove
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const actions = useMemo(paletteActions, []);
  const results = useMemo(() => searchItems(query, actions), [query, actions]);

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => before?.focus?.();
  }, []);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, results]);

  const run = (i: number) => {
    const action = results[i];
    if (!action) return;
    closePalette();
    action.run();
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
      e.preventDefault();
      e.stopPropagation();
      closePalette();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(active);
    }
  };

  return (
    <div className="shell-palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closePalette()}>
      <div className="shell-palette" role="dialog" aria-modal="true" aria-label="search actions" onKeyDown={onKeyDown}>
        <div className="shell-palette-field">
          <Search size={14} />
          <input
            ref={inputRef}
            className="input"
            value={query}
            placeholder="search actions"
            aria-label="search actions"
            aria-controls="shell-palette-list"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
        </div>
        <div className="shell-palette-list" id="shell-palette-list" role="listbox" ref={listRef}>
          {results.length === 0 ? <div className="shell-palette-empty">no matching actions</div> : null}
          {results.map((a, i) => (
            <div
              key={a.id}
              role="option"
              aria-selected={i === active}
              className={`shell-palette-row${i === active ? ' is-active' : ''}`}
              onMouseMove={(e) => {
                const was = pointer.current;
                pointer.current = { x: e.clientX, y: e.clientY };
                if (was && (was.x !== e.clientX || was.y !== e.clientY) && i !== active) setActive(i);
              }}
              onClick={() => run(i)}
            >
              <span className="shell-palette-title">{a.title}</span>
              <span className="shell-palette-group">{a.group}</span>
              <Keys keys={a.keys} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CommandPalette() {
  const open = usePalette((s) => s.open);
  // leaving the editor with the palette open must not leave it open for the next project
  useEffect(() => closePalette, []);
  if (!open) return null;
  return createPortal(<PaletteBody />, document.body);
}
