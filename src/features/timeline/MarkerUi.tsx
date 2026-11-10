import { memo, useEffect, useRef } from 'react';
import { Flag, MoveHorizontal, Pencil, Trash2 } from 'lucide-react';
import { snapToFrame } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { insertGapAt } from './actions';
import { useFloatingMenu } from './menuBehavior';

/** a hairline per marker down through the tracks. positioned with transforms, only re-rendered when markers or zoom change. */
export const MarkerLines = memo(function MarkerLines() {
  const markers = useEditor((s) => s.project?.markers);
  const zoom = useEditor((s) => s.zoom);
  if (!markers || markers.length === 0) return null;
  return (
    <>
      {markers.map((m) => (
        <div key={m.id} className="timeline-marker-line" style={{ transform: `translate3d(${Math.round(m.time * zoom)}px,0,0)` }} />
      ))}
    </>
  );
});

export interface MarkerMenuRequest {
  x: number;
  y: number;
  /** the marker under the pointer, or null for the bare ruler */
  markerId: string | null;
  /** timeline time under the pointer, for "add marker here" */
  time: number;
}

interface MenuProps extends MarkerMenuRequest {
  onClose(): void;
  onRename(id: string, x: number, y: number): void;
}

/** right click menu of the ruler: rename / delete on a marker, add marker on empty ruler. */
export function MarkerMenu({ x, y, markerId, time, onClose, onRename }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useFloatingMenu(ref, x, y, onClose);
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <div ref={ref} className="menu timeline-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      {markerId ? (
        <>
          <button
            className="menu-item"
            role="menuitem"
            title="give the marker a name"
            onClick={run(() => onRename(markerId, x, y))}
          >
            <Pencil size={14} />
            rename
          </button>
          <button
            className="menu-item"
            role="menuitem"
            title="delete the marker"
            onClick={run(() => useEditor.getState().removeMarker(markerId))}
          >
            <Trash2 size={14} />
            delete
          </button>
        </>
      ) : (
        <button
          className="menu-item"
          role="menuitem"
          title="add a marker at this time"
          onClick={run(() => {
            const fps = useEditor.getState().project?.fps ?? 30;
            useEditor.getState().addMarker(snapToFrame(time, fps));
          })}
        >
          <Flag size={14} />
          add marker here
        </button>
      )}
      <div className="menu-sep" />
      <button
        className="menu-item"
        role="menuitem"
        title="push every clip that starts at or after this point right by 1 second, on all unlocked tracks"
        onClick={run(() => insertGapAt(snapToFrame(time, useEditor.getState().project?.fps ?? 30)))}
      >
        <MoveHorizontal size={14} />
        insert gap here
      </button>
    </div>
  );
}

interface RenameProps {
  id: string;
  x: number;
  y: number;
  onDone(): void;
}

/** a small floating input to name a marker. enter commits, escape cancels, leaving the field commits. */
export function MarkerRename({ id, x, y, onDone }: RenameProps) {
  const ref = useRef<HTMLInputElement>(null);
  const name = useEditor((s) => s.project?.markers?.find((m) => m.id === id)?.name);
  const finished = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const gone = name === undefined;
  useEffect(() => {
    // the marker was removed (undo) while renaming
    if (gone) onDone();
  }, [gone, onDone]);
  if (name === undefined) return null;

  const commit = (value: string) => {
    if (finished.current) return;
    finished.current = true;
    const v = value.trim();
    if (v !== name) useEditor.getState().updateMarker(id, { name: v });
    onDone();
  };

  return (
    <input
      ref={ref}
      className="input timeline-marker-input"
      style={{ left: Math.max(4, x - 12), top: y + 10 }}
      defaultValue={name}
      maxLength={60}
      placeholder="marker name"
      aria-label="marker name"
      title="enter to save, escape to cancel"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit(e.currentTarget.value);
        else if (e.key === 'Escape') {
          finished.current = true;
          onDone();
        }
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
    />
  );
}
