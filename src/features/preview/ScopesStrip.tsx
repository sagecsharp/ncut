/**
 * the scopes strip: waveform, parade, vectorscope and histogram of the picture you look at, next to the preview
 * (right of it or below it, see scopesLayout.ts). closed: nothing is mounted and nothing listens to the tap.
 * the runner (scopeRunner.ts) reads and bins, this file lays out and paints.
 */
import { X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { useEditor } from '../../store/editorStore';
import { REASON_TEXT } from '../shell/reasons';
import { tip } from '../shell/tip';
import { paintScope, plotScratch, statsLine, type PlotScratch } from './scopePlot';
import { ScopeRunner } from './scopeRunner';
import { cellGrid, placeScopes, scopesSize, type ScopesPlace } from './scopesLayout';
import { BELOW_HEIGHT_DEFAULT, SCOPE_KINDS, SIDE_WIDTH_DEFAULT, useScopes, type ScopeKind } from './scopesState';
import './scopes.css';

export interface ScopesStripProps {
  /** the .preview-body element: the strip measures it and sets data-scopes on it */
  bodyRef: RefObject<HTMLDivElement | null>;
  /** PreviewEngine.exactFrame(true, true): null without an engine, during an export or when it cannot be made */
  exactFrame: () => Promise<OffscreenCanvas | null>;
}

const KIND_DOES: Record<ScopeKind, string> = {
  waveform: 'how bright each column of the picture is: 0 at the bottom, 100 at the top',
  parade: 'the waveform of r, g and b side by side. on something gray, equal traces mean no color cast',
  vectorscope: 'the colors of the picture: the angle is the hue, the distance from the middle is how strong it is. skin sits near the skin line',
  histogram: 'how many pixels sit at each level, for r, g, b and luma. marks at the ends mean clipping',
};

interface CellHandle {
  canvas: HTMLCanvasElement;
  stats: HTMLElement;
}

const pixelScale = (): number => Math.min(2, window.devicePixelRatio || 1);

function Cell({ kind, reg, onSized }: { kind: ScopeKind; reg: (kind: ScopeKind, h: CellHandle | null) => void; onSized: () => void }) {
  const plotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statsRef = useRef<HTMLDivElement>(null);
  const zoom = useScopes((s) => s.vectorZoom);
  const setZoom = useScopes((s) => s.setVectorZoom);

  useLayoutEffect(() => {
    const plot = plotRef.current;
    const canvas = canvasRef.current;
    const stats = statsRef.current;
    if (!plot || !canvas || !stats) return;
    // the backing size is the css size x the pixel ratio (at most 2); a resize clears the canvas, so it paints again
    const fit = (): boolean => {
      const k = pixelScale();
      const w = Math.max(1, Math.round(plot.clientWidth * k));
      const h = Math.max(1, Math.round(plot.clientHeight * k));
      if (canvas.width === w && canvas.height === h) return false;
      canvas.width = w;
      canvas.height = h;
      return true;
    };
    fit();
    reg(kind, { canvas, stats });
    const ro = new ResizeObserver(() => {
      if (fit()) onSized();
    });
    ro.observe(plot);
    onSized();
    return () => {
      ro.disconnect();
      reg(kind, null);
    };
  }, [kind, reg, onSized]);

  return (
    <div className="scopes-cell">
      <div ref={plotRef} className="scopes-plot">
        <canvas ref={canvasRef} className="scopes-canvas" role="img" aria-label={`${kind} of the picture`} />
        {kind === 'vectorscope' && (
          <button
            type="button"
            className={`preview-seg-btn scopes-zoom${zoom === 2 ? ' is-active' : ''}`}
            aria-label="vectorscope zoom"
            aria-pressed={zoom === 2}
            {...tip('vectorscope zoom', { does: 'twice as big, for pictures with little color', on: zoom === 2 })}
            onClick={() => setZoom(zoom === 2 ? 1 : 2)}
          >
            2x
          </button>
        )}
      </div>
      <div ref={statsRef} className="scopes-stats" />
    </div>
  );
}

function StripBody({ bodyRef, exactFrame }: ScopesStripProps) {
  const kinds = useScopes((s) => s.kinds);
  const exact = useScopes((s) => s.exact);
  const projW = useEditor((s) => s.project?.width ?? 0);
  const projH = useEditor((s) => s.project?.height ?? 0);
  const [view, setView] = useState<{ place: ScopesPlace; min: number; max: number; now: number }>({ place: 'side', min: 0, max: 0, now: 0 });
  const stripRef = useRef<HTMLDivElement>(null);
  const cellsRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const placeRef = useRef<ScopesPlace>('side');
  const runnerRef = useRef<ScopeRunner | null>(null);
  const cells = useRef(new Map<ScopeKind, CellHandle>());
  const scratches = useRef(new Map<ScopeKind, PlotScratch>());
  const exactRef = useRef(exactFrame);
  exactRef.current = exactFrame;
  const drag = useRef<{ x: number; y: number; start: number; size: number } | null>(null);

  const reg = useCallback((kind: ScopeKind, h: CellHandle | null) => {
    if (h) cells.current.set(kind, h);
    else cells.current.delete(kind);
  }, []);
  const onSized = useCallback(() => runnerRef.current?.rebin(), []);

  /** the body: the ref, or the strip's parent when the strip mounts in the same commit and the ref is not attached yet */
  const getBody = useCallback(() => bodyRef.current ?? (stripRef.current?.parentElement as HTMLDivElement | null), [bodyRef]);

  /** the size of the strip now: the stored size clamped to the body */
  const place = useCallback((): { place: ScopesPlace; min: number; max: number; now: number; bw: number; bh: number } | null => {
    const body = getBody();
    if (!body) return null;
    const bw = body.clientWidth,
      bh = body.clientHeight;
    const p = placeScopes(bw, bh, projW, projH, placeRef.current);
    const s = useScopes.getState();
    const stored = p === 'side' ? s.sideWidth : s.belowHeight;
    const now = Math.round(scopesSize(p, stored, bw, bh));
    const lo = Math.round(scopesSize(p, 0, bw, bh));
    const hi = Math.round(scopesSize(p, 1e9, bw, bh));
    return { place: p, min: lo, max: hi, now, bw, bh };
  }, [getBody, projW, projH]);

  /** sets data-scopes on the body, the strip's size and the cells' grid; react state only when something shown changes */
  const layout = useCallback(() => {
    const body = getBody(),
      strip = stripRef.current,
      grid = cellsRef.current;
    const m = place();
    if (!body || !strip || !m) return;
    placeRef.current = m.place;
    body.dataset.scopes = m.place;
    strip.style.flex = `0 0 ${drag.current?.size ?? m.now}px`;
    if (grid) {
      const g = cellGrid(useScopes.getState().kinds.length, grid.clientWidth, grid.clientHeight);
      grid.style.gridTemplateColumns = `repeat(${g.cols}, minmax(0, 1fr))`;
      grid.style.gridTemplateRows = `repeat(${g.rows}, minmax(0, 1fr))`;
    }
    setView((v) => (v.place === m.place && v.min === m.min && v.max === m.max && v.now === m.now ? v : { place: m.place, min: m.min, max: m.max, now: m.now }));
  }, [getBody, place]);

  useLayoutEffect(() => {
    const body = getBody();
    if (!body) return;
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(body);
    if (cellsRef.current) ro.observe(cellsRef.current);
    const off = useScopes.subscribe((s, p) => {
      if (s.sideWidth !== p.sideWidth || s.belowHeight !== p.belowHeight || s.kinds !== p.kinds) layout();
    });
    return () => {
      ro.disconnect();
      off();
      delete body.dataset.scopes;
    };
  }, [getBody, layout]);

  // the cells' grid follows the number of shown kinds
  useLayoutEffect(() => {
    layout();
  }, [kinds.length, layout]);

  useEffect(() => {
    const runner = new ScopeRunner({
      exactFrame: () => exactRef.current(),
      paint(bins, hist, pixels, reading) {
        const s = useScopes.getState();
        const k = pixelScale();
        for (const kind of SCOPE_KINDS) {
          const cell = cells.current.get(kind);
          if (!cell) continue;
          const ctx = cell.canvas.getContext('2d', { alpha: false });
          if (!ctx) continue;
          let scratch = scratches.current.get(kind);
          if (!scratch) scratches.current.set(kind, (scratch = plotScratch()));
          paintScope(ctx, kind, bins, hist, pixels, { w: cell.canvas.width, h: cell.canvas.height, k, zoom: bins?.zoom ?? s.vectorZoom }, scratch);
          cell.stats.textContent = hist ? statsLine(kind, hist, pixels) : '';
        }
        if (labelRef.current) labelRef.current.textContent = reading ? `${reading.how} ${reading.w} x ${reading.h}` : '';
      },
      note(text) {
        const el = noteRef.current;
        if (!el) return;
        el.textContent = text;
        el.hidden = text === '';
      },
      visible: () => document.visibilityState === 'visible' && !document.fullscreenElement,
    });
    runnerRef.current = runner;
    runner.start();
    return () => {
      runner.stop();
      runnerRef.current = null;
    };
  }, []);

  const close = () => {
    bodyRef.current?.querySelector<HTMLElement>('.preview-stage')?.focus();
    useScopes.getState().setOpen(false);
  };

  // ----- the edge -----
  const store = (size: number) => {
    const s = useScopes.getState();
    if (placeRef.current === 'side') s.setSideWidth(size);
    else s.setBelowHeight(size);
  };
  const onEdgeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const m = place();
    if (!m || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, start: m.now, size: m.now };
  };
  const onEdgeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const m = place();
    const strip = stripRef.current;
    if (!d || !m || !strip) return;
    // left grows the strip at the side, up grows it below
    const delta = m.place === 'side' ? d.x - e.clientX : d.y - e.clientY;
    d.size = Math.round(scopesSize(m.place, d.start + delta, m.bw, m.bh));
    strip.style.flex = `0 0 ${d.size}px`;
  };
  const onEdgeUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d) store(d.size);
  };
  const reset = () => {
    const m = place();
    if (!m) return;
    store(Math.round(scopesSize(m.place, m.place === 'side' ? SIDE_WIDTH_DEFAULT : BELOW_HEIGHT_DEFAULT, m.bw, m.bh)));
  };
  const onEdgeKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const arrows = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (!arrows.includes(e.key) && e.key !== 'Enter') return;
    // the shortcut table skips a separator, so the edge says the key is used, also for the arrows that do nothing here
    e.preventDefault();
    const m = place();
    if (!m) return;
    if (e.key === 'Enter') return reset();
    const side = m.place === 'side';
    const grow = side ? e.key === 'ArrowLeft' : e.key === 'ArrowUp';
    const shrink = side ? e.key === 'ArrowRight' : e.key === 'ArrowDown';
    if (!grow && !shrink) return;
    const step = e.shiftKey ? 64 : 16;
    store(Math.round(scopesSize(m.place, m.now + (grow ? step : -step), m.bw, m.bh)));
  };

  const toggleKind = useScopes((s) => s.toggleKind);
  const setExact = useScopes((s) => s.setExact);
  const last = kinds.length === 1;

  return (
    <div ref={stripRef} className="scopes-strip">
      <div
        className="scopes-edge"
        role="separator"
        aria-orientation={view.place === 'side' ? 'vertical' : 'horizontal'}
        aria-label="scopes size"
        aria-valuenow={view.now}
        aria-valuemin={view.min}
        aria-valuemax={view.max}
        tabIndex={0}
        {...tip('scopes size', { does: 'drag to resize. double click: back to the default size' })}
        onPointerDown={onEdgeDown}
        onPointerMove={onEdgeMove}
        onPointerUp={onEdgeUp}
        onPointerCancel={onEdgeUp}
        onKeyDown={onEdgeKey}
        onDoubleClick={reset}
      />
      <div className="scopes-head">
        <span ref={labelRef} className="scopes-reading" />
        <button
          type="button"
          className={`preview-seg-btn${exact ? ' is-active' : ''}`}
          aria-pressed={exact}
          {...tip('exact', { does: 'while paused, measure every pixel of the frame the export draws (in the source view: the media at its own size). slower than live', on: exact })}
          onClick={() => setExact(!exact)}
        >
          exact
        </button>
        <span className="scopes-spacer" />
        <button type="button" className="icon-btn" aria-label="close the scopes" {...tip('close the scopes', { keys: 'toggle-scopes' })} onClick={close}>
          <X size={14} />
        </button>
      </div>
      <div ref={noteRef} className="scopes-note" hidden />
      <div className="scopes-kinds" role="group" aria-label="scopes shown">
        {SCOPE_KINDS.map((kind) => {
          const shown = kinds.includes(kind);
          return (
            <button
              key={kind}
              type="button"
              className={`preview-seg-btn${shown ? ' is-active' : ''}`}
              aria-pressed={shown}
              {...tip(kind, { does: KIND_DOES[kind], on: shown, off: shown && last ? REASON_TEXT.lastScope : null })}
              onClick={() => toggleKind(kind)}
            >
              {kind}
            </button>
          );
        })}
      </div>
      <div ref={cellsRef} className="scopes-cells">
        {SCOPE_KINDS.filter((k) => kinds.includes(k)).map((kind) => (
          <Cell key={kind} kind={kind} reg={reg} onSized={onSized} />
        ))}
      </div>
    </div>
  );
}

export function ScopesStrip(props: ScopesStripProps) {
  const open = useScopes((s) => s.open);
  if (!open) return null;
  return <StripBody {...props} />;
}
