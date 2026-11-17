import { useEffect, useRef } from 'react';
import { faderPos, newMeter } from '../../../lib/meter';
import type { MeterState } from '../../../lib/meter';
import { gainToDb } from '../../../lib/mix';
import { tip } from '../../shell/tip';
import { clearMeterOver, watchMeter } from './meterLoop';
import { meterColors, onMeterColors } from './meterColors';

const BAR = 4;
const GAP = 1;
/** zone edges on the fader scale */
const MID_POS = faderPos(-9);
const TOP_POS = faderPos(0);

interface Box { w: number; h: number; dpr: number }

/** the zone color of a position: low below -9 db, mid up to 0 db, high above */
function zoneOf(pos: number, c: ReturnType<typeof meterColors>): string {
  return pos < MID_POS ? c.low : pos < TOP_POS ? c.mid : c.high;
}

/** two bars (left, right) on the fader scale: peak faint, rms solid, the hold line on top. along the long side, vertical bars grow upward */
function paint(cv: HTMLCanvasElement, box: Box, s: MeterState, horizontal: boolean): void {
  const cx = cv.getContext('2d');
  if (!cx || box.w === 0 || box.h === 0) return;
  const c = meterColors();
  const len = horizontal ? box.w : box.h;
  cx.setTransform(box.dpr, 0, 0, box.dpr, 0, 0);
  cx.clearRect(0, 0, box.w, box.h);
  // the bars sit centered across the short side
  const across = BAR * 2 + GAP;
  const start = Math.round(((horizontal ? box.h : box.w) - across) / 2);
  const rect = (side: number, from: number, to: number) => {
    const a = start + side * (BAR + GAP);
    if (horizontal) cx.fillRect(from, a, to - from, BAR);
    else cx.fillRect(a, len - to, BAR, to - from);
  };
  /** one bar from 0 to pos in its zone colors */
  const fill = (side: number, pos: number, alpha: number) => {
    if (pos <= 0) return;
    cx.globalAlpha = alpha;
    const edges = [0, MID_POS, TOP_POS, 1];
    for (let z = 0; z < 3; z++) {
      const a = edges[z]!;
      const b = Math.min(pos, edges[z + 1]!);
      if (b <= a) break;
      cx.fillStyle = z === 0 ? c.low : z === 1 ? c.mid : c.high;
      rect(side, a * len, b * len);
    }
    cx.globalAlpha = 1;
  };
  for (let side = 0; side < 2; side++) {
    cx.fillStyle = c.empty;
    rect(side, 0, len);
    const pos = (v: number) => faderPos(gainToDb(v));
    fill(side, pos(s.peak[side]!), 0.45);
    fill(side, pos(s.rms[side]!), 1);
    const h = pos(s.hold[side]!);
    if (h > 0) {
      cx.fillStyle = zoneOf(h, c);
      const at = Math.min(len - 1, Math.max(0, h * len - 0.5));
      rect(side, at, at + 1);
    }
  }
}

/** the level of one tap (a track id or the output): two bars and the over light. a vertical meter fills the height its parent gives it */
export function Meter({ tap, horizontal }: { tap: string; horizontal?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const dot = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = root.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    const box: Box = { w: 0, h: 0, dpr: 1 };
    let state: MeterState = newMeter();
    let stop: (() => void) | null = null;
    const draw = (s: MeterState) => {
      state = s;
      dot.current?.classList.toggle('is-over', s.over);
      paint(cv, box, s, !!horizontal);
    };
    const size = () => {
      const r = cv.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      box.w = r.width;
      box.h = r.height;
      box.dpr = dpr;
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
      draw(state);
    };
    size();
    // the listener in meterColors only works once a color was asked for, so ask now
    meterColors();
    const unTheme = onMeterColors(() => draw(state));
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(size);
    ro?.observe(cv);
    const on = () => {
      if (!stop) stop = watchMeter(tap, draw);
    };
    const off = () => {
      stop?.();
      stop = null;
      draw(newMeter());
    };
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'undefined') on();
    else {
      io = new IntersectionObserver((entries) => {
        const lastEntry = entries[entries.length - 1];
        if (lastEntry?.isIntersecting) on();
        else off();
      });
      io.observe(el);
    }
    return () => {
      unTheme();
      io?.disconnect();
      ro?.disconnect();
      stop?.();
      stop = null;
    };
  }, [tap, horizontal]);

  return (
    <div ref={root} className={'mixer-meter' + (horizontal ? ' is-horizontal' : '')}>
      <canvas ref={canvas} className="mixer-meter-canvas" aria-hidden="true" />
      <button
        ref={dot}
        type="button"
        className="mixer-over"
        aria-label="over: click to clear"
        {...tip('over', { does: 'the sound went past 0 db, the loudest a file holds, and may crackle in the export. click to clear' })}
        onClick={(e) => {
          e.stopPropagation();
          clearMeterOver(tap);
        }}
      />
    </div>
  );
}
