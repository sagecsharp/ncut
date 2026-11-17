/**
 * the plot of the graph view: one canvas for the lines, keys and handles, the playhead as a div. a press on a key selects it,
 * a drag moves the selected ones in time and value (alt: stretches them around the playhead), a drag on a handle shapes the
 * ease, a drag on empty space is a box. nothing here writes keyframes except through applyKeyPlan.
 * the canvas redraws once per frame and only when something it shows changed, never per playback frame.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { formatNumber } from '../../components/ui/numberFormat';
import { isJoined, partHandles } from '../../lib/keyBezier';
import type { HandleSide } from '../../lib/keyBezier';
import { cleanRange } from '../../lib/inOut';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { KeyRef } from '../../store/ui';
import type { Clip, Project } from '../../types';
import { addKeyOnLine, graphCommands } from './graphActions';
import { drawGraph, selKey } from './graphDraw';
import type { GraphFrame } from './graphDraw';
import { handleFromPointer, hitGraph, keysInGraphBox, lineValue, valueSnap, vOf, yOf } from './graphModel';
import type { GraphHit, GraphHitIndex, GraphLine, GraphViewport } from './graphModel';
import { graphDebug, useGraph } from './graphState';
import type { GraphKind, Win } from './graphState';
import { keyDragTarget, keySnapPoints, stretchFactor, stretchPivot } from './keyDrag';
import { applyKeyPlan, keyStopText } from './keyLaneActions';
import { planGraphMove, planHandleSet } from './graphPlan';
import { planKeyScale } from './keyPlan';
import { hasRef, keyRefsAt, laneId, liveKeySel, pickKeys, refIndex } from './keySelection';
import type { PickMode } from './keySelection';
import type { KeyMenuOpen, KeyMenuProps } from './KeyMenu';
import { formatTrimDelta } from './trimDrag';
import { cssVar, getAppearanceGen, interaction, markUserScroll, notifyView, subscribeView, view } from './view';
import './graph.css';

export interface GraphPlotProps {
  /** the lines to draw (the hidden ones are already out) */
  lines: readonly GraphLine[];
  /** the shown clips, for the snap points */
  shown: readonly Clip[];
  kind: GraphKind;
  windows: Record<string, Win>;
  /** the windows hold still from a press to the release */
  freeze(w: Record<string, Win>): void;
  release(): void;
  /** the faint text when there is nothing to draw */
  emptyText: string | null;
  getScroller(): HTMLDivElement | null;
  onMenu(open: KeyMenuOpen & Pick<KeyMenuProps, 'line'>): void;
  anchor: RefObject<(() => KeyMenuOpen) | null>;
}

/** a press moves less than this and it is a click */
const DRAG_THRESHOLD = 3;
/** the band at the side of the plot where a drag scrolls the timeline */
const EDGE = 36;
const EDGE_STEP = 18;
/** handles are drawn for this many keys at most */
const MAX_HANDLED = 200;

interface Gesture {
  kind: 'key' | 'handle' | 'empty';
  /** client position at the press and now */
  cx0: number;
  cy0: number;
  cx: number;
  cy: number;
  /** plot x and y at the press, and the timeline scroll then */
  px0: number;
  py0: number;
  sl0: number;
  shift: boolean;
  alt: boolean;
  mode: PickMode;
  ref: KeyRef | null;
  side: HandleSide | null;
  lineId: string | null;
  /** a plain press on a selected key: the selection narrows to it on release when nothing was dragged */
  narrow: boolean;
  moved: boolean;
  dragging: boolean;
  box: boolean;
  baseSel: KeyRef[];
  base: Project | null;
  /** the windows at the press: they hold while the gesture runs */
  win: Record<string, Win>;
  /** stored units per px of each line, from the held windows */
  upp: Map<string, number>;
  /** the pressed key, timeline seconds, and its stored value */
  a0: number;
  v0: number;
  index: number;
  points: number[];
  stretch: boolean;
  pivot: number;
  /** the pressed line as it was at the press: the snap reads its other keys from here */
  line: GraphLine | undefined;
  lastKey: string;
  raf: number;
  stop(): void;
}

const modeOf = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): PickMode => (e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'add' : 'replace');

/** the line a hit belongs to, as a line id */
function hitLineId(hit: GraphHit): string | null {
  if (hit.kind === 'key' || hit.kind === 'handle') return laneId(hit.ref.clipId, hit.ref.prop);
  return hit.kind === 'line' ? hit.line : null;
}

export function GraphPlot(props: GraphPlotProps) {
  const { lines, kind, windows, emptyText, getScroller, onMenu, anchor } = props;
  const project = useEditor((s) => s.project);
  const zoom = useEditor((s) => s.zoom);
  const keySel = useUi((s) => s.keySel);
  const active = useGraph((s) => s.active);
  const fps = project?.fps ?? 30;
  const handlesOff = keySel.length > MAX_HANDLED;
  const range = project ? cleanRange(project.range) : null;

  const plotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const draw = useRef<{ invalidate(): void } | null>(null);
  const hits = useRef<GraphHitIndex>({ kx: new Float32Array(0), ky: new Float32Array(0), kref: [], kn: 0, hx: new Float32Array(0), hy: new Float32Array(0), href: [], hn: 0 });
  /** what a draw shows besides the props: the hovered line, the snap line and the box */
  const fx = useRef<{ hover: string | null; snapY: number | null; box: GraphFrame['box'] }>({ hover: null, snapY: null, box: null });
  const [size, setSize] = useState({ w: 600, h: 200 });

  const selSet = useMemo(() => {
    const set = new Set<string>();
    const byId = new Map(lines.map((l) => [l.id, l]));
    for (const r of keySel) {
      const ln = byId.get(laneId(r.clipId, r.prop));
      if (!ln) continue;
      const i = refIndex(ln.clip, r);
      if (i >= 0) set.add(selKey(ln.id, i));
    }
    return set;
  }, [keySel, lines]);

  // the render's state for handlers and the draw, which run outside react
  const latest = useRef({ lines, kind, windows, zoom, fps, project, size, selSet, active, handlesOff, rangeIn: range?.in, rangeOut: range?.out, props });
  latest.current = { lines, kind, windows, zoom, fps, project, size, selSet, active, handlesOff, rangeIn: range?.in, rangeOut: range?.out, props };

  /** the plot as the model sees it */
  const vpOf = (): GraphViewport => ({ zoom: latest.current.zoom, scrollLeft: view.scrollLeft, width: latest.current.size.w, height: latest.current.size.h });

  // ----- size -----
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const measure = () => setSize({ w: Math.max(1, Math.round(el.clientWidth)), h: Math.max(1, Math.round(el.clientHeight)) });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ----- the canvas: one redraw per frame, only when something it shows changed -----
  useEffect(() => {
    let raf = 0;
    let last: unknown[] | null = null;
    const paint = () => {
      raf = 0;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const l = latest.current;
      const w = l.size.w;
      const h = l.size.h;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const f = fx.current;
      const sig = [l.lines, l.kind, l.windows, l.selSet, l.zoom, view.scrollLeft, w, h, dpr, getAppearanceGen(), f.hover, l.active, f.snapY, f.box, l.handlesOff, l.rangeIn, l.rangeOut];
      if (last && sig.every((v, i) => v === last![i])) return;
      last = sig;
      const t0 = performance.now();
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const pw = Math.round(w * dpr);
      const ph = Math.round(h * dpr);
      if (canvas.width !== pw) canvas.width = pw;
      if (canvas.height !== ph) canvas.height = ph;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const frame: GraphFrame = {
        lines: l.lines,
        kind: l.kind,
        windows: l.windows,
        vp: { zoom: l.zoom, scrollLeft: view.scrollLeft, width: w, height: h },
        dpr,
        active: l.active,
        hover: f.hover,
        sel: l.selSet,
        range: l.rangeIn === undefined && l.rangeOut === undefined ? null : { in: l.rangeIn, out: l.rangeOut },
        snapY: f.snapY,
        box: f.box,
        handlesOff: l.handlesOff,
      };
      const { segments } = drawGraph(ctx, frame, cssVar, hits.current);
      graphDebug.draws++;
      graphDebug.lines = l.lines.length;
      graphDebug.segments = segments;
      graphDebug.lastDrawMs = performance.now() - t0;
    };
    const invalidate = () => {
      if (!raf) raf = requestAnimationFrame(paint);
    };
    draw.current = { invalidate };
    const off = subscribeView(invalidate);
    invalidate();
    return () => {
      off();
      if (raf) cancelAnimationFrame(raf);
      draw.current = null;
    };
  }, []);
  // every render that changed what the canvas shows asks for one frame (the draw drops it when its inputs are the same)
  useEffect(() => {
    draw.current?.invalidate();
  });

  // ----- the playhead: a div moved by a transform, playback touches nothing else -----
  useEffect(() => {
    const el = headRef.current;
    if (!el) return;
    const place = () => {
      const x = Math.round(usePlayback.getState().time * useEditor.getState().zoom) - view.scrollLeft;
      el.style.transform = `translate3d(${x}px,0,0)`;
      el.style.display = x < -1 || x > view.width ? 'none' : 'block';
    };
    place();
    const offTime = usePlayback.subscribe((s, p) => {
      if (s.time !== p.time) place();
    });
    const offZoom = useEditor.subscribe((s, p) => {
      if (s.zoom !== p.zoom) place();
    });
    const offView = subscribeView(place);
    return () => {
      offTime();
      offZoom();
      offView();
    };
  }, []);

  // ----- the wheel: ctrl and shift go to the timeline, a plain wheel moves the values, alt zooms them -----
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.shiftKey) {
        const sc = getScroller();
        if (!sc) return;
        e.preventDefault();
        sc.dispatchEvent(
          new WheelEvent('wheel', {
            deltaX: e.deltaX,
            deltaY: e.deltaY,
            deltaZ: e.deltaZ,
            deltaMode: e.deltaMode,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            metaKey: e.metaKey,
            clientX: e.clientX,
            clientY: e.clientY,
            bubbles: true,
            cancelable: true,
          }),
        );
        return;
      }
      e.preventDefault();
      const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (d === 0) return;
      const l = latest.current;
      const y = e.clientY - el.getBoundingClientRect().top;
      const next: Record<string, Win> = {};
      for (const [g, w] of Object.entries(l.windows)) {
        if (e.altKey) {
          const k = d > 0 ? 1.15 : 1 / 1.15;
          const vc = vOf(y, w, l.size.h);
          next[g] = { lo: vc - (vc - w.lo) * k, hi: vc + (w.hi - vc) * k };
        } else {
          const shift = (d > 0 ? -1 : 1) * 0.12 * (w.hi - w.lo);
          next[g] = { lo: w.lo + shift, hi: w.hi + shift };
        }
      }
      const g = useGraph.getState();
      g.setAutoFit(false);
      g.setWindows(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [getScroller]);

  // ----- where a keyboard opened menu goes: the first selected key on screen, else the plot's top left -----
  useEffect(() => {
    anchor.current = () => {
      const el = plotRef.current;
      const r = el ? el.getBoundingClientRect() : new DOMRect(0, 0, 0, 0);
      const l = latest.current;
      const h = hits.current;
      if (l.project) {
        for (const ref of liveKeySel(l.project, useUi.getState().keySel)) {
          for (let i = 0; i < h.kn; i++) {
            const k = h.kref[i]!;
            if (k.clipId === ref.clipId && k.prop === ref.prop && Math.abs(k.t - ref.t) < 1e-4) return { x: r.left + h.kx[i]!, y: r.top + h.ky[i]!, target: ref };
          }
        }
      }
      return { x: r.left, y: r.top, target: null };
    };
    return () => {
      anchor.current = null;
    };
  }, [anchor]);

  // ----- pointer -----
  /** a client point in the plot's css px */
  const pointAt = (clientX: number, clientY: number) => {
    const r = plotRef.current?.getBoundingClientRect();
    return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) };
  };
  const hitAt = (x: number, y: number): GraphHit => {
    const l = latest.current;
    return hitGraph(hits.current, l.lines, l.windows, l.kind, vpOf(), x, y);
  };
  const lineOf = (id: string | null): GraphLine | undefined => (id === null ? undefined : latest.current.lines.find((q) => q.id === id));

  const hideFeedback = () => {
    fx.current.snapY = null;
    fx.current.box = null;
    if (readoutRef.current) readoutRef.current.hidden = true;
    draw.current?.invalidate();
  };
  const showReadout = (text: string, cx: number, cy: number) => {
    const out = readoutRef.current;
    const el = plotRef.current;
    if (!out || !el) return;
    out.textContent = text;
    const r = el.getBoundingClientRect();
    out.style.transform = `translate3d(${Math.round(cx - r.left + 12)}px,${Math.max(0, Math.round(cy - r.top - 22))}px,0)`;
    out.hidden = false;
  };

  const beginDrag = (g: Gesture) => {
    const l = latest.current;
    const st = useEditor.getState();
    if (!st.project || !g.ref) return;
    const sel = liveKeySel(st.project, useUi.getState().keySel);
    const clip = st.project.clips.find((c) => c.id === g.ref!.clipId);
    if (!clip) return;
    const index = refIndex(clip, g.ref);
    if (index < 0) return;
    if (g.kind === 'key' && !hasRef(sel, g.ref)) return;
    st.pushHistory();
    interaction.gestureActive = true;
    g.dragging = true;
    g.base = st.project;
    g.baseSel = sel;
    g.index = index;
    g.v0 = clip.keyframes![g.ref.prop]![index]!.v;
    g.a0 = clip.start + g.ref.t;
    g.win = l.windows;
    g.line = lineOf(g.lineId);
    for (const ln of l.lines) {
      const w = g.win[ln.group];
      if (w) g.upp.set(ln.id, (w.hi - w.lo) / l.size.h / ln.feel.scale);
    }
    if (g.kind === 'key') {
      const playhead = usePlayback.getState().time;
      g.points = keySnapPoints(st.project, l.props.shown, sel, playhead);
      const times = sel.map((r) => (st.project!.clips.find((c) => c.id === r.clipId)?.start ?? 0) + r.t);
      g.pivot = stretchPivot(g.a0, playhead, times, l.fps);
    }
    g.lastKey = '';
  };

  const tickKey = (g: Gesture) => {
    g.raf = 0;
    const el = plotRef.current;
    if (gesture.current !== g || !g.dragging || !g.base || !el) return;
    const l = latest.current;
    const rect = el.getBoundingClientRect();
    let lx = g.cx - rect.left;
    // near a side the timeline scrolls under the pointer
    let scrolled = false;
    const sc = getScroller();
    if (sc && (lx < EDGE || lx > l.size.w - EDGE)) {
      const before = sc.scrollLeft;
      sc.scrollLeft += lx < EDGE ? -EDGE_STEP : EDGE_STEP;
      if (sc.scrollLeft !== before) {
        view.scrollLeft = sc.scrollLeft;
        markUserScroll();
        notifyView();
        scrolled = true;
      }
    }
    lx = g.cx - rect.left;
    const now = (lx + view.scrollLeft) / l.zoom;
    const then = (g.px0 + g.sl0) / l.zoom;
    const target = keyDragTarget(g.a0 + (now - then), g.points, l.zoom, l.fps, useEditor.getState().snapping);
    let dt = target.time - g.a0;
    let dyPx = 0;
    const line = g.line;
    const u = g.lineId ? (g.upp.get(g.lineId) ?? 0) : 0;
    let snapY: number | null = null;
    if (line && l.kind === 'value' && u > 0) {
      const dy = g.cy - g.cy0;
      const s = valueSnap(g.v0 - dy * u, line, g.index, u, useEditor.getState().snapping);
      dyPx = (g.v0 - s.v) / u;
      const w = g.win[line.group];
      if (s.hit !== null && w) snapY = yOf(s.v * line.feel.scale, w, l.size.h);
    }
    // shift: only the way the pointer moved more
    if (g.shift) {
      if (Math.abs(g.cx - g.cx0) >= Math.abs(g.cy - g.cy0)) {
        dyPx = 0;
        snapY = null;
      } else dt = 0;
    }
    const plan = g.stretch ? planKeyScale(g.base, g.baseSel, g.pivot, stretchFactor(g.a0, g.a0 + dt, g.pivot), 'clamp') : planGraphMove(g.base, g.baseSel, dt, dyPx, g.upp, 'clamp');
    const key = `${dt}|${dyPx}`;
    if (key !== g.lastKey) {
      g.lastKey = key;
      // a key in the way: the keys hold at the last good spot
      if (plan.stop?.kind !== 'inTheWay') applyKeyPlan(plan, { skipHistory: true });
    }
    fx.current.snapY = snapY;
    const text = g.stretch ? `x ${plan.amount.toFixed(2)}` : formatTrimDelta(plan.amount, l.fps);
    const value = line ? `  ${formatNumber((g.v0 - dyPx * u) * line.feel.scale, line.feel.precision)} ${line.feel.unit}`.trimEnd() : '';
    showReadout(plan.stop ? `${text}${g.stretch ? '' : value} | ${keyStopText(plan.stop)}` : `${text}${g.stretch ? '' : value}`, g.cx, g.cy);
    draw.current?.invalidate();
    if (scrolled) g.raf = requestAnimationFrame(() => tickKey(g));
  };

  const tickHandle = (g: Gesture) => {
    g.raf = 0;
    const el = plotRef.current;
    const ref = g.ref;
    if (gesture.current !== g || !g.dragging || !g.base || !el || !ref || !g.side) return;
    const l = latest.current;
    const clip = g.base.clips.find((c) => c.id === ref.clipId);
    const keys = clip?.keyframes?.[ref.prop];
    const line = lineOf(g.lineId);
    const win = line ? g.win[line.group] : undefined;
    if (!clip || !keys || !line || !win) return;
    const i = refIndex(clip, ref);
    const ph = i < 0 ? null : g.side === 'out' ? (i < keys.length - 1 ? partHandles(keys[i]!, keys[i + 1]!) : null) : i > 0 ? partHandles(keys[i - 1]!, keys[i]!) : null;
    if (!ph) return;
    const rect = el.getBoundingClientRect();
    const t = (g.cx - rect.left + view.scrollLeft) / l.zoom - line.start;
    const v = vOf(g.cy - rect.top, win, l.size.h) / line.feel.scale;
    const h = handleFromPointer(keys, i, g.side, t, v, l.kind, g.side === 'out' ? ph.out : ph.in);
    const key = `${h.speed}|${h.influence}|${g.alt}`;
    if (key !== g.lastKey) {
      g.lastKey = key;
      applyKeyPlan(planHandleSet(g.base, [ref], g.side, h, g.alt), { skipHistory: true });
      // the plan names the one key: the selection stays as it was
      useUi.getState().setKeySel(g.baseSel);
    }
    const now = useEditor.getState().project?.clips.find((c) => c.id === ref.clipId)?.keyframes?.[ref.prop];
    const joined = !!now && isJoined(now, i);
    showReadout(`${g.side} ${formatNumber(h.speed * line.feel.scale, 1)} ${line.feel.unit}/s, ${formatNumber(h.influence * 100, 0)} %${joined ? ' | joined' : ' | one side'}`, g.cx, g.cy);
  };

  const updateBox = (g: Gesture) => {
    const el = plotRef.current;
    if (!el) return;
    const l = latest.current;
    const rect = el.getBoundingClientRect();
    const x = g.cx - rect.left;
    const y = g.cy - rect.top;
    const box = { x0: Math.min(g.px0, x), x1: Math.max(g.px0, x), y0: Math.min(g.py0, y), y1: Math.max(g.py0, y) };
    fx.current.box = box;
    useUi.getState().setKeySel(pickKeys(g.baseSel, keysInGraphBox(l.lines, l.windows, l.kind, vpOf(), box), g.mode));
    draw.current?.invalidate();
  };

  const finish = (commit: boolean) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.raf) cancelAnimationFrame(g.raf);
    g.stop();
    if (g.dragging) interaction.gestureActive = false;
    hideFeedback();
    latest.current.props.release();
    if (!commit) return;
    if (g.kind === 'key' && !g.moved && g.narrow && g.ref) useUi.getState().setKeySel([g.ref]);
    if (g.kind === 'empty' && !g.moved && g.mode === 'replace') useUi.getState().setKeySel([]);
  };

  // an unmount (shift+u, a mode swap) ends a running gesture: the capture goes with the element and finish would never run
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => () => finishRef.current(false), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || gesture.current) return;
    const p = useEditor.getState().project;
    if (!p) return;
    const ui = useUi.getState();
    if (ui.previewMode === 'source') ui.activateProgram();
    plotRef.current?.focus({ preventScroll: true });
    const l = latest.current;
    const pt = pointAt(e.clientX, e.clientY);
    const hit = hitAt(pt.x, pt.y);
    const mode = modeOf(e);
    const sel = liveKeySel(p, ui.keySel);
    const lineId = hitLineId(hit);
    const g: Gesture = {
      kind: hit.kind === 'key' ? 'key' : hit.kind === 'handle' ? 'handle' : 'empty',
      cx0: e.clientX,
      cy0: e.clientY,
      cx: e.clientX,
      cy: e.clientY,
      px0: pt.x,
      py0: pt.y,
      sl0: view.scrollLeft,
      shift: e.shiftKey,
      alt: e.altKey,
      mode,
      ref: hit.kind === 'key' || hit.kind === 'handle' ? hit.ref : null,
      side: hit.kind === 'handle' ? hit.side : null,
      lineId,
      narrow: false,
      moved: false,
      dragging: false,
      box: false,
      baseSel: sel,
      base: null,
      win: l.windows,
      upp: new Map(),
      a0: 0,
      v0: 0,
      index: -1,
      points: [],
      stretch: e.altKey,
      pivot: 0,
      line: undefined,
      lastKey: '',
      raf: 0,
      stop: () => {},
    };
    l.props.freeze(l.windows);
    if (lineId !== null) useGraph.getState().setActive(lineId);
    if (hit.kind === 'key') {
      useGraph.getState().setActiveKey(hit.ref);
      // a plain press on a selected key keeps the selection for a drag and narrows to the key when released
      if (mode === 'replace' && hasRef(sel, hit.ref)) g.narrow = true;
      else ui.setKeySel(pickKeys(sel, [hit.ref], mode));
    } else if (hit.kind === 'handle') useGraph.getState().setActiveKey(hit.ref);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !g.dragging) return;
      ev.preventDefault();
      ev.stopPropagation();
      useEditor.getState().rollback();
      useUi.getState().setKeySel(g.baseSel);
      g.dragging = false;
      interaction.gestureActive = false;
      hideFeedback();
    };
    const onBlur = () => finish(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    g.stop = () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
    gesture.current = g;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const el = plotRef.current;
    if (!g) {
      if (!el) return;
      const pt = pointAt(e.clientX, e.clientY);
      const hit = hitAt(pt.x, pt.y);
      el.style.cursor = hit.kind === 'key' || hit.kind === 'handle' ? 'move' : hit.kind === 'line' ? 'pointer' : 'crosshair';
      const id = hitLineId(hit);
      if (fx.current.hover !== id) {
        fx.current.hover = id;
        draw.current?.invalidate();
      }
      const line = lineOf(id);
      if (!line) {
        if (readoutRef.current) readoutRef.current.hidden = true;
        return;
      }
      const l = latest.current;
      let v = 0;
      if (hit.kind === 'line') v = lineValue(line, l.kind, hit.t);
      else if (hit.kind === 'key' || hit.kind === 'handle') {
        const i = refIndex(line.clip, hit.ref);
        v = i < 0 ? 0 : l.kind === 'speed' ? lineValue(line, 'speed', line.keys[i]!.t) : line.int ? Math.round(line.keys[i]!.v) : line.keys[i]!.v;
      }
      const unit = l.kind === 'speed' ? `${line.feel.unit}/s` : line.feel.unit;
      showReadout(`${line.label} of ${line.clipName}: ${formatNumber(v * line.feel.scale, line.feel.precision)} ${unit}`.trimEnd(), e.clientX, e.clientY);
      return;
    }
    g.cx = e.clientX;
    g.cy = e.clientY;
    g.shift = e.shiftKey;
    g.alt = g.kind === 'handle' ? e.altKey : g.alt;
    if (!g.moved && Math.hypot(g.cx - g.cx0, g.cy - g.cy0) >= DRAG_THRESHOLD) {
      g.moved = true;
      if (g.kind === 'empty') g.box = true;
      else beginDrag(g);
    }
    if (g.dragging && !g.raf) g.raf = requestAnimationFrame(() => (g.kind === 'handle' ? tickHandle(g) : tickKey(g)));
    if (g.box) updateBox(g);
  };

  const onPointerLeave = () => {
    if (gesture.current) return;
    if (fx.current.hover !== null) {
      fx.current.hover = null;
      draw.current?.invalidate();
    }
    if (readoutRef.current) readoutRef.current.hidden = true;
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const pt = pointAt(e.clientX, e.clientY);
    const hit = hitAt(pt.x, pt.y);
    if (hit.kind === 'key') {
      const clip = useEditor.getState().project?.clips.find((c) => c.id === hit.ref.clipId);
      if (clip) usePlayback.getState().seek(Math.max(0, clip.start + hit.ref.t));
    } else if (hit.kind === 'line') {
      const line = lineOf(hit.line);
      if (line) addKeyOnLine(line.clipId, line.prop, hit.t);
    }
  };

  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const p = useEditor.getState().project;
    if (!p) return;
    const pt = pointAt(e.clientX, e.clientY);
    const hit = hitAt(pt.x, pt.y);
    if (hit.kind === 'key' || hit.kind === 'handle') {
      const sel = liveKeySel(p, useUi.getState().keySel);
      if (!hasRef(sel, hit.ref)) useUi.getState().setKeySel([hit.ref]);
      onMenu({ x: e.clientX, y: e.clientY, target: hit.ref });
    } else if (hit.kind === 'line') {
      const line = lineOf(hit.line);
      onMenu({ x: e.clientX, y: e.clientY, target: null, line: line ? { clipId: line.clipId, prop: line.prop, t: hit.t } : null });
    } else onMenu({ x: e.clientX, y: e.clientY, target: null });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    // f frames the selected keyframes, none selected: every line
    if (e.key === 'f' && !e.shiftKey) {
      e.preventDefault();
      graphCommands.frameSelected?.();
      return;
    }
    if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
    const p = useEditor.getState().project;
    if (!p) return;
    e.preventDefault();
    const l = latest.current;
    const ids = [...new Set(l.lines.map((q) => q.clipId))];
    const here = new Set(l.lines.map((q) => q.id));
    const refs = keyRefsAt(p, ids, usePlayback.getState().time, 0.5 / l.fps).filter((r) => here.has(laneId(r.clipId, r.prop)));
    const sel = liveKeySel(p, useUi.getState().keySel);
    useUi.getState().setKeySel(pickKeys(sel, refs, e.shiftKey ? 'add' : 'replace'));
  };

  return (
    <div
      ref={plotRef}
      className="graph-plot"
      tabIndex={0}
      role="group"
      aria-label="plot of the selected keyframes"
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
      onPointerLeave={onPointerLeave}
      onLostPointerCapture={() => finish(false)}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <canvas ref={canvasRef} className="graph-canvas" aria-hidden="true" />
      <div ref={headRef} className="graph-playhead" />
      <div ref={readoutRef} className="graph-readout" hidden />
      {emptyText ? <div className="graph-empty">{emptyText}</div> : null}
      {handlesOff && !emptyText ? <div className="graph-handles-note">select fewer keyframes to see their handles</div> : null}
    </div>
  );
}
