import { useEffect, useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { ActionOpts } from '../../../store/editorStore';
import { faderDb, faderPos, roundFaderDb } from '../../../lib/meter';
import { dbToGain, formatDb, gainToDb, OFF_DB } from '../../../lib/mix';
import { beginEdit, cancelEdit, endEdit, liveOpts } from '../../properties/edit';
import { tip } from '../../shell/tip';

interface Props {
  /** the level, linear */
  gain: number;
  /** null = 0 db */
  write(gain: number | null, opts?: ActionOpts): void;
}

const START_PX = 3;
const DETENT_PX = 3;
const KEY_STEP = 0.5;
const KEY_BIG = 5;

const toGain = (db: number): number | null => (db === 0 ? null : dbToGain(db));

/** the db after one key press, or null when the key does nothing */
function fadeKey(db: number, key: string, shift: boolean): number | null {
  if (key === 'Home') return 0;
  if (key === 'End') return -Infinity;
  const big = shift || key === 'PageUp' || key === 'PageDown';
  const size = big ? KEY_BIG : KEY_STEP;
  if (key === 'ArrowUp' || key === 'ArrowRight' || key === 'PageUp') {
    if (!(db > OFF_DB)) return -60;
    return Math.min(12, roundFaderDb(db + size));
  }
  if (key === 'ArrowDown' || key === 'ArrowLeft' || key === 'PageDown') {
    if (!(db > OFF_DB)) return -Infinity;
    const next = db - size;
    return next < -60 ? -Infinity : roundFaderDb(next);
  }
  return null;
}

/** the level of a track or of the output: a vertical slider on the fader scale. drag anywhere on it, it moves relative to where you grabbed it */
export function Fader({ gain, write }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const W = useRef(write);
  W.current = write;
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);

  const db = gainToDb(gain);
  const pos = faderPos(db);
  const shown = db > OFF_DB ? Math.round(db) : OFF_DB;

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || stopDrag.current) return;
    const el = root.current;
    if (!el) return;
    const track = el.querySelector('.mixer-fader-track')?.getBoundingClientRect();
    const H = track?.height ?? 0;
    if (H <= 0) return;
    el.focus({ preventScroll: true });
    el.setPointerCapture(e.pointerId);
    const id = e.pointerId;
    const y0 = e.clientY;
    let lastY = y0;
    let cur = faderPos(gainToDb(gain));
    let moving = false;
    let dead = false;
    let noMenuUntil = 0;
    let pending: number | null | undefined;
    let raf = 0;

    const flush = () => {
      raf = 0;
      if (pending === undefined) return;
      const g = pending;
      pending = undefined;
      W.current(g, liveOpts());
    };
    const queue = (g: number | null) => {
      pending = g;
      if (!raf) raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(flush) : (flush(), 0);
    };
    const move = (ev: globalThis.PointerEvent) => {
      if (dead || ev.pointerId !== id) return;
      // the right button while the left is held comes as a move with button 2
      if (ev.button === 2) {
        ev.preventDefault();
        noMenuUntil = Date.now() + 500;
        cancel();
        return;
      }
      if (!moving) {
        if (Math.abs(ev.clientY - y0) < START_PX) return;
        moving = true;
        lastY = ev.clientY;
        beginEdit();
      }
      cur = Math.min(1, Math.max(0, cur + ((lastY - ev.clientY) / H) * (ev.shiftKey ? 0.1 : 1)));
      lastY = ev.clientY;
      let d = faderDb(cur);
      if (ev.ctrlKey) d = Math.round(d);
      else d = roundFaderDb(d);
      if (Math.abs(cur - faderPos(0)) * H < DETENT_PX) d = 0;
      queue(toGain(d));
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('pointerdown', other, true);
      window.removeEventListener('blur', leave);
      window.removeEventListener('contextmenu', menu, true);
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
      stopDrag.current = null;
      try {
        el.releasePointerCapture(id);
      } catch {
        // the capture is gone already
      }
    };
    const cancel = () => {
      if (dead) return;
      dead = true;
      pending = undefined;
      if (moving) cancelEdit();
    };
    /** the gesture ends as it is: the level so far is kept as one step */
    const commit = () => {
      if (!dead && moving) {
        if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
        raf = 0;
        flush();
        endEdit();
      }
      dead = true;
      finish();
    };
    const up = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== id) return;
      commit();
    };
    const leave = () => commit();
    // a key during the drag does not reach the shortcuts (ctrl+z would run mid gesture)
    const key = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === 'Shift' || ev.key === 'Control' || ev.key === 'Meta') return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.key === 'Escape') cancel();
    };
    const other = (ev: globalThis.PointerEvent) => {
      if (ev.button === 2) {
        ev.preventDefault();
        cancel();
      }
    };
    const menu = (ev: Event) => {
      if (moving || dead || Date.now() < noMenuUntil) ev.preventDefault();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', other, true);
    window.addEventListener('contextmenu', menu, true);
    window.addEventListener('blur', leave);
    // the strip went away mid drag: the level so far stays
    stopDrag.current = commit;
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const next = fadeKey(db, e.key, e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    const g = toGain(next);
    // a key that changes nothing (already at the top, already off) writes nothing
    if (next === db || (g === null && gain === 1)) return;
    W.current(g);
  };

  return (
    <div
      ref={root}
      className="mixer-fader"
      role="slider"
      aria-orientation="vertical"
      aria-valuemin={-90}
      aria-valuemax={12}
      aria-valuenow={shown}
      aria-valuetext={formatDb(db)}
      aria-label="fader"
      tabIndex={0}
      {...tip('fader', { does: 'the level of this track in db. 0 db = as recorded. drag up or down (shift: finer, ctrl: whole db). double click: 0 db', keys: 'field-fader-keys' })}
      onPointerDown={onDown}
      onDoubleClick={() => W.current(null)}
      onKeyDown={onKey}
    >
      <div className="mixer-fader-track">
        <div className="mixer-fader-cap" style={{ bottom: `${pos * 100}%` }} />
      </div>
    </div>
  );
}
