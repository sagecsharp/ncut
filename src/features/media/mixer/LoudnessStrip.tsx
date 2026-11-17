import { useEffect, useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useLoudnessPref } from '../../export/loudnessPrefs';
import { tip } from '../../shell/tip';
import { resetLoudness, watchLoudness } from './loudnessLoop';
import { LOUD_TICKS, NO_VIEW, loudPos, meterText, tpOver } from './loudnessView';
import type { LoudName, LoudView } from './loudnessView';
import { meterColors, onMeterColors } from './meterColors';

const KEY = 'ncut-loudness-strip';
const NAME_TIP = 'how loud the mix sounds while it plays, in lufs. close to the export: measure mix gives the exact numbers. solo counts here, never in the export';

interface Box { w: number; h: number; dpr: number }

function readFolded(): boolean {
  try {
    return localStorage.getItem(KEY) === 'folded';
  } catch {
    return false;
  }
}

function saveFolded(folded: boolean): void {
  try {
    localStorage.setItem(KEY, folded ? 'folded' : 'open');
  } catch {
    // no storage: it stays open next time
  }
}

/** the bar from -50 to -5 lufs, growing upward: the short term fill (accent, warn above the target), the momentary line, the integrated mark, the target line, a tick every 10 */
function paint(cv: HTMLCanvasElement, box: Box, v: LoudView, target: number | null): void {
  const cx = cv.getContext('2d');
  if (!cx || box.w === 0 || box.h === 0) return;
  const c = meterColors();
  const len = box.h;
  cx.setTransform(box.dpr, 0, 0, box.dpr, 0, 0);
  cx.clearRect(0, 0, box.w, box.h);
  const rect = (from: number, to: number, thick = to - from) => cx.fillRect(0, len - to, box.w, thick);
  cx.fillStyle = c.empty;
  rect(0, len);
  const at = loudPos(target ?? -Infinity);
  const s = loudPos(v.shortTerm);
  cx.globalAlpha = 0.55;
  if (s > 0) {
    const split = target === null ? s : Math.min(s, at);
    cx.fillStyle = c.low;
    rect(0, split * len);
    if (split < s) {
      cx.fillStyle = c.mid;
      rect(split * len, s * len);
    }
  }
  cx.globalAlpha = 0.5;
  cx.fillStyle = c.low;
  for (const t of LOUD_TICKS) cx.fillRect(0, Math.min(len - 1, Math.max(0, len - loudPos(t) * len - 0.5)), 3, 1);
  cx.globalAlpha = 1;
  cx.fillStyle = c.low;
  const m = loudPos(v.momentary);
  if (m > 0) cx.fillRect(0, Math.min(len - 1, Math.max(0, len - m * len - 0.5)), box.w, 1);
  const i = loudPos(v.integrated);
  if (i > 0) cx.fillRect(0, Math.min(len - 3, Math.max(0, len - i * len - 1.5)), box.w, 3);
  if (target !== null) {
    cx.fillStyle = c.high;
    cx.fillRect(0, Math.min(len - 1, Math.max(0, len - at * len - 0.5)), box.w, 1);
  }
}

/** the live loudness of the mix: a bar and five numbers. close to the export, never exact. folds to its name */
export function LoudnessStrip() {
  const [folded, setFolded] = useState(readFolded);
  const { target, ceiling } = useLoudnessPref((s) => s.loudness);
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const spans = useRef<Partial<Record<LoudName, HTMLSpanElement | null>>>({});
  /** the choice the drawing reads, and what the last draw was, so a change of choice repaints without a new frame */
  const pref = useRef({ target, ceiling });
  const redraw = useRef<(() => void) | null>(null);

  useEffect(() => {
    pref.current = { target, ceiling };
    redraw.current?.();
  }, [target, ceiling]);

  useEffect(() => {
    if (folded) return;
    const el = root.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    const box: Box = { w: 0, h: 0, dpr: 1 };
    let view: LoudView = { ...NO_VIEW };
    const texts: Partial<Record<LoudName, string>> = {};
    const put = (name: LoudName, text: string) => {
      if (texts[name] === text) return;
      texts[name] = text;
      const s = spans.current[name];
      if (s) s.textContent = text;
    };
    const draw = (v: LoudView) => {
      view = v;
      put('m', meterText('m', v.momentary));
      put('s', meterText('s', v.shortTerm));
      put('i', meterText('i', v.integrated));
      put('lra', meterText('lra', v.lra));
      put('tp', meterText('tp', v.truePeak));
      spans.current.m?.classList.toggle('is-dim', !v.playing);
      spans.current.s?.classList.toggle('is-dim', !v.playing);
      spans.current.tp?.classList.toggle('is-over', tpOver(v.truePeak, pref.current.ceiling));
      paint(cv, box, v, pref.current.target);
    };
    redraw.current = () => draw(view);
    const size = () => {
      const r = cv.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      box.w = r.width;
      box.h = r.height;
      box.dpr = dpr;
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
      draw(view);
    };
    size();
    // the listener in meterColors only works once a color was asked for, so ask now
    meterColors();
    const unTheme = onMeterColors(() => draw(view));
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(size);
    ro?.observe(cv);
    let stop: (() => void) | null = null;
    const on = () => {
      if (!stop) stop = watchLoudness(draw);
    };
    const off = () => {
      stop?.();
      stop = null;
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
      redraw.current = null;
      unTheme();
      io?.disconnect();
      ro?.disconnect();
      off();
    };
  }, [folded]);

  const toggle = () => {
    saveFolded(!folded);
    setFolded(!folded);
  };
  const num = (name: LoudName, label: string, does: string) => (
    <span ref={(n) => { spans.current[name] = n; }} className="mixer-loud-num" data-loud={name} {...tip(label, { does })}>
      {meterText(name, name === 'lra' ? 0 : -Infinity)}
    </span>
  );

  return (
    <div ref={root} className={'mixer-strip is-loudness' + (folded ? ' is-folded' : '')} data-strip="loudness">
      <div className="mixer-name-row">
        <button
          type="button"
          className="mixer-loud-name"
          aria-label="loudness"
          aria-expanded={!folded}
          {...tip('loudness', { does: NAME_TIP + (folded ? '. click to open' : '. click to fold') })}
          onClick={toggle}
        >
          {folded ? <ChevronLeft size={13} /> : 'loudness'}
        </button>
      </div>
      {folded ? null : (
        <>
          <div className="mixer-pan-row" />
          <div className="mixer-fader-row mixer-loud-row">
            <div className="mixer-loud-bar">
              <canvas ref={canvas} className="mixer-meter-canvas" aria-hidden="true" />
            </div>
            <div className="mixer-loud-nums">
              {num('m', 'momentary', 'the last 0.4 s')}
              {num('s', 'short term', 'the last 3 s')}
              {num('i', 'integrated', 'since the reset')}
              {num('lra', 'loudness range', 'how much the loudness moves, in lu')}
              {num('tp', 'true peak', 'the highest point, between the samples too, in dbtp')}
            </div>
          </div>
          <div className="mixer-level-row mixer-loud-unit">lufs, lu, dbtp</div>
          <div className="mixer-btn-row">
            <button
              type="button"
              className="btn btn-sm"
              {...tip('reset', { does: 'start the integrated, range and true peak again' })}
              onClick={() => resetLoudness()}
            >
              reset
            </button>
          </div>
        </>
      )}
    </div>
  );
}
