import { Fragment, memo, useEffect, useRef, useState } from 'react';
import { Dialog } from '../../components/ui/Dialog';
import { useSceneControls } from '../preview/sceneControls';
import { openPalette } from './paletteStore';
import { SHORTCUTS } from './shortcuts';
import { shortcutGroups } from './shortcutsView';
import type { ShortcutView } from './shortcutsView';
import './shell.css';

export interface ShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
}

const ShortcutRow = memo(function ShortcutRow({ shortcut }: { shortcut: ShortcutView }) {
  return (
    <div className="shell-shortcut">
      <span className="shell-shortcut-desc">{shortcut.description}</span>
      <span className="shell-shortcut-keys">
        {shortcut.keys.map((combo, i) => (
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
    </div>
  );
});

const PALETTE_KEYS = SHORTCUTS.find((s) => s.id === 'palette')?.keys[0] ?? [];

function ShortcutsBody({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const scheme = useSceneControls((s) => s.scheme);
  const groups = shortcutGroups(query, SHORTCUTS, scheme);

  // runs before the Dialog's own effect, which then sees the focus inside and leaves it
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <>
      <input
        ref={inputRef}
        className="input shell-shortcuts-search"
        value={query}
        placeholder="search keys and mouse moves"
        aria-label="search shortcuts"
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
      />
      {groups.length === 0 ? <div className="shell-shortcuts-empty">nothing matches</div> : null}
      <div className="shell-shortcuts">
        {groups.map((g) => (
          <section className="shell-shortcut-group" key={g.group}>
            <h3 className="shell-shortcut-title">{g.label}</h3>
            {g.rows.map((s) => (
              <ShortcutRow key={s.id} shortcut={s} />
            ))}
          </section>
        ))}
      </div>
      <div className="shell-shortcuts-foot">
        <span>actions without a key are in search actions</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            onClose();
            openPalette();
          }}
        >
          search actions
        </button>
        {PALETTE_KEYS.map((cap, j) => (
          <kbd className="kbd" key={j}>
            {cap}
          </kbd>
        ))}
      </div>
    </>
  );
}

export function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  if (!open) return null;
  return (
    <Dialog open={open} title="keyboard shortcuts" onClose={onClose} width={720}>
      <ShortcutsBody onClose={onClose} />
    </Dialog>
  );
}
