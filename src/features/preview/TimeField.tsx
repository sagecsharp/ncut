import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { formatTimeAs } from '../../lib/time';
import { usePlayback } from '../../store/playback';
import { TIME_DISPLAYS, useTimeDisplay } from '../../store/timeDisplay';
import { useUi } from '../../store/ui';
import { useFloatingMenu } from '../timeline/menuBehavior';
import { tip } from '../shell/tip';
import { closeTimeEntry, getTimeEntry, goToTime, registerTimeField, subscribeTimeEntry } from './timeEntry';
import { applyEntryPlan, planEntryNow } from './timeEntryApply';
import { ENTRY_TEXT } from './timeEntryPlan';
import './timeField.css';

function TimeDisplayMenu({ x, y, onClose }: { x: number; y: number; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const mode = useTimeDisplay((s) => s.mode);
  const pos = useFloatingMenu(ref, x, y, onClose, { focusFirst: true });
  // keyboard: focus the current choice on open (useFloatingMenu does the arrows and escape)
  useEffect(() => {
    const items = ref.current?.querySelectorAll<HTMLButtonElement>('button');
    const i = TIME_DISPLAYS.findIndex((d) => d.id === mode);
    items?.[i >= 0 ? i : 0]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={ref} className="menu preview-time-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      {TIME_DISPLAYS.map((d) => (
        <button
          key={d.id}
          className="menu-item"
          role="menuitemradio"
          aria-checked={mode === d.id}
          title={`show times as ${d.title}`}
          onClick={() => {
            useTimeDisplay.getState().setMode(d.id);
            onClose();
          }}
        >
          {d.label}
          {mode === d.id && <span className="menu-hint">on</span>}
        </button>
      ))}
    </div>
  );
}

export const TimeField = memo(function TimeField({ fps, total }: { fps: number; total: number }) {
  const mode = useTimeDisplay((s) => s.mode);
  const req = useSyncExternalStore(subscribeTimeEntry, getTimeEntry, getTimeEntry);
  useEffect(() => registerTimeField(), []);
  const editing = req !== null;
  const nowRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // true once the field really has the focus: a blur after that ends the entry
  const took = useRef(false);
  const frames = useRef<number[]>([]);
  const [text, setText] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  // the current time is written straight to the dom: it changes every frame while playing
  useEffect(() => {
    let last = '';
    const write = (t: number) => {
      const s = formatTimeAs(t, fps, mode);
      if (s !== last && nowRef.current) {
        nowRef.current.textContent = s;
        last = s;
      }
    };
    write(usePlayback.getState().time);
    return usePlayback.subscribe((s, prev) => {
      if (s.time !== prev.time) write(s.time);
    });
  }, [fps, mode]);

  const later = (fn: () => void) => {
    frames.current.push(requestAnimationFrame(fn));
  };
  useEffect(() => () => frames.current.forEach((id) => cancelAnimationFrame(id)), []);

  // a new request: the time now, selected. a frame later, so a closing palette has given the focus back first
  const n = req?.n;
  useEffect(() => {
    if (n === undefined) return;
    took.current = false;
    setText(formatTimeAs(usePlayback.getState().time, fps, mode));
    const id = requestAnimationFrame(() => {
      const el = inputRef.current;
      // the transport is outside the fullscreen stage: leave fullscreen so the field can be seen
      const fs = document.fullscreenElement;
      if (el && fs && !fs.contains(el)) void document.exitFullscreen().catch(() => undefined);
      el?.focus();
      el?.select();
      if (el && document.activeElement === el) took.current = true;
      else {
        closeTimeEntry();
        useUi.getState().toast(ENTRY_TEXT.noField);
      }
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);

  const plan = req ? planEntryNow(text, req.from, mode) : null;
  const bad = !!plan && (plan.kind === 'error' || ((plan.kind === 'move' || plan.kind === 'trim') && plan.blocked));

  const finish = (back: boolean) => {
    const to = getTimeEntry()?.returnTo ?? null;
    closeTimeEntry();
    if (back && to) {
      later(() => {
        if (to.isConnected && to.getClientRects().length > 0) to.focus();
        else inputRef.current?.blur();
      });
    } else inputRef.current?.blur();
  };

  const openAt = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    // the transport sits at the bottom: open upwards (the menu clamps itself into the window)
    setMenu({ x: r.left, y: r.top - TIME_DISPLAYS.length * 30 - 8 });
  };
  const openMenu = (e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    openAt(e.currentTarget);
  };
  const menuKey = (e: KeyboardEvent<HTMLElement>) => {
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      // the clip menu row must not run
      e.preventDefault();
      openAt(e.currentTarget);
    }
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (req && applyEntryPlan(planEntryNow(e.currentTarget.value, req.from, mode))) finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(true);
    } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      // never leave the page: a browser back closes the project
      e.preventDefault();
    }
  };

  return (
    <div className="preview-time mono">
      <button
        type="button"
        className="preview-time-now"
        hidden={editing}
        {...tip('playhead time', { does: 'click to type a time: 1:30:00, 90f or 12.5s goes there, +15 or -1:00 moves the playhead by that much. right click: show times as timecode, frames or seconds', keys: 'go-to-time', why: 'go-to-time' })}
        onClick={(e) => goToTime('playhead', e.detail === 0 ? e.currentTarget : null)}
        onContextMenu={openMenu}
        onKeyDown={menuKey}
      >
        <span ref={nowRef}>{formatTimeAs(0, fps, mode)}</span>
      </button>
      {editing && (
        <input
          ref={inputRef}
          className="input input-sm mono preview-time-input"
          aria-label="type a time"
          aria-describedby="preview-time-hint"
          spellCheck={false}
          autoComplete="off"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onInputKey}
          onBlur={() => {
            if (took.current) closeTimeEntry();
          }}
        />
      )}
      <span className="preview-time-sep">/</span>
      <span className="preview-time-total" {...tip('project length', { does: 'the end of the last clip. right click: show times as timecode, frames or seconds' })} onContextMenu={openMenu}>
        {formatTimeAs(total, fps, mode)}
      </span>
      {editing && plan && (
        <div id="preview-time-hint" className={`preview-time-hint${bad ? ' is-error' : ''}`} role="status">
          {plan.text}
        </div>
      )}
      {menu && <TimeDisplayMenu x={menu.x} y={menu.y} onClose={closeMenu} />}
    </div>
  );
});
