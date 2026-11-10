import { Fragment, memo } from 'react';
import { Dialog } from '../../components/ui/Dialog';
import { SHORTCUTS, SHORTCUT_GROUPS } from './shortcuts';
import type { Shortcut } from './shortcuts';
import './shell.css';

export interface ShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
}

const ShortcutRow = memo(function ShortcutRow({ shortcut }: { shortcut: Shortcut }) {
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

export function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  if (!open) return null;
  return (
    <Dialog open={open} title="keyboard shortcuts" onClose={onClose} width={720}>
      <div className="shell-shortcuts">
        {SHORTCUT_GROUPS.map((group) => (
          <section className="shell-shortcut-group" key={group}>
            <h3 className="shell-shortcut-title">{group}</h3>
            {SHORTCUTS.filter((s) => s.group === group).map((s) => (
              <ShortcutRow key={s.id} shortcut={s} />
            ))}
          </section>
        ))}
      </div>
    </Dialog>
  );
}
