/**
 * the rows of the keyframe panel: dom labels for the visible rows, one canvas for the diamonds, the playhead as a div.
 * a press on a diamond selects it, a drag moves the selected ones (alt: stretches them around the playhead), a drag on empty
 * space is a box. nothing here writes keyframes except through applyKeyPlan.
 */
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { KeyRef } from '../../store/ui';
import type { Clip, Project } from '../../types';
import { tip } from '../shell/tip';
import { drawKeyShape, keyShape, KEY_MERGE_PX } from './keyGeometry';
import { keyDragTarget, keySnapPoints, selHas, stretchFactor, stretchPivot } from './keyDrag';
import { applyKeyPlan, keyStopText } from './keyLaneActions';
import { buildLaneRows, hasKeyAt, hitLane, keysInBox, laneKeyX, rowAt, rowKeyRefs, visibleRows, visibleTimes } from './keyLanesModel';
import type { LaneRow } from './keyLanesModel';
import { keyPanelDebug } from './keyPanelState';
import { planKeyMove, planKeyScale } from './keyPlan';
import { KEY_REF_EPS, hasRef, keyRefsAt, laneId, liveKeySel, pickKeys, selByLane, shownKeyClips } from './keySelection';
import type { PickMode } from './keySelection';
import type { KeyMenuOpen } from './KeyMenu';
import { HEADER_W } from './layout';
import { formatTrimDelta } from './trimDrag';
import { cssVar, getAppearanceGen, interaction, markUserScroll, notifyView, subscribeView, view } from './view';

export interface KeyLanesProps {
  getScroller(): HTMLDivElement | null;
  folded: ReadonlySet<string>;
  onFold(next: ReadonlySet<string>): void;
  onMenu(open: KeyMenuOpen): void;
  anchor: RefObject<(() => KeyMenuOpen) | null>;
}

/** a press moves less than this and it is a click */
const DRAG_THRESHOLD = 3;
/** the band at the side of the lanes where a drag scrolls the timeline */
const EDGE = 36;
const EDGE_STEP = 18;

interface Gesture {
  kind: 'key' | 'empty';
  /** client position at the press and now */
  cx0: number;
  cy0: number;
  cx: number;
  cy: number;
  /** lane x at the press, and the timeline scroll then */
  lx0: number;
  sl0: number;
  mode: PickMode;
  refs: KeyRef[];
  /** a plain press on a selected key: the selection narrows to it on release when nothing was dragged */
  narrow: boolean;
  moved: boolean;
  dragging: boolean;
  box: boolean;
  baseSel: KeyRef[];
  base: Project | null;
  /** the pressed key, timeline seconds */
  a0: number;
  points: number[];
  stretch: boolean;
  pivot: number;
  lastTime: number;
  /** the amount of the plan that is on screen (the last one applied) */
  shown: number;
  raf: number;
  stop(): void;
}

const modeOf = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): PickMode => (e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'add' : 'replace');
const sameRange = (a: readonly [number, number], b: readonly [number, number]) => a[0] === b[0] && a[1] === b[1];
const chipOf = (clip: Clip | undefined): string => (!clip ? 'effect' : clip.type === 'camera' ? 'shape' : clip.type);

export function KeyLanes({ getScroller, folded, onFold, onMenu, anchor }: KeyLanesProps) {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const zoom = useEditor((s) => s.zoom);
  const keySel = useUi((s) => s.keySel);
  const fps = project?.fps ?? 30;

  const shown = useMemo(() => (project ? shownKeyClips(project, selection) : []), [project, selection]);
  const rows = project ? buildLaneRows(project, shown, folded) : [];
  const total = rows.length > 0 ? rows[rows.length - 1]!.y + rows[rows.length - 1]!.h : 0;

  const bodyRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const snapRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const draw = useRef<{ invalidate(): void } | null>(null);
  const [bodyH, setBodyH] = useState(160);
  const [scrollTop, setScrollTop] = useState(0);

  // the render's state for handlers and the draw, which run outside react
  const [first, end] = visibleRows(rows, scrollTop - 40, bodyH + 80);
  const latest = useRef({ rows, keySel, zoom, fps, project, shown, folded, range: [first, end] as [number, number] });
  latest.current = { rows, keySel, zoom, fps, project, shown, folded, range: [first, end] };

  const selMap = useMemo(() => selByLane(keySel), [keySel]);
  const selMapRef = useRef(selMap);
  selMapRef.current = selMap;

  // ----- size of the body -----
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    setBodyH(body.clientHeight);
    const ro = new ResizeObserver(() => setBodyH(body.clientHeight));
    ro.observe(body);
    return () => ro.disconnect();
  }, []);

  // ----- the canvas: one redraw per frame, only when something it shows changed -----
  useEffect(() => {
    let raf = 0;
    let last: unknown[] | null = null;
    const paint = () => {
      raf = 0;
      const canvas = canvasRef.current;
      const body = bodyRef.current;
      if (!canvas || !body) return;
      const l = latest.current;
      const w = Math.max(1, Math.round(view.width));
      const h = Math.max(1, body.clientHeight);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const st = body.scrollTop;
      const sig = [l.rows, l.keySel, l.zoom, view.scrollLeft, w, st, h, dpr, getAppearanceGen()];
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
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.translate(0, -st);
      const sl = view.scrollLeft;
      const [a, b] = visibleRows(l.rows, st, h);
      for (let i = a; i < b; i++) {
        const row = l.rows[i]!;
        const mid = row.y + row.h / 2;
        // the stripe, then the clip's span
        ctx.globalAlpha = 1;
        ctx.fillStyle = cssVar('--surface-1');
        ctx.fillRect(0, row.y, w, row.h);
        if (i % 2 === 1) {
          ctx.globalAlpha = 0.5;
          ctx.fillStyle = cssVar('--surface-2');
          ctx.fillRect(0, row.y, w, row.h);
        }
        const x0 = Math.max(0, laneKeyX(row, 0, l.zoom, sl));
        const x1 = Math.min(w, laneKeyX(row, row.duration, l.zoom, sl));
        if (x1 > x0) {
          ctx.globalAlpha = (row.kind === 'clip' ? 0.55 : 0.3) * (row.outside ? 0.5 : 1);
          ctx.fillStyle = cssVar('--surface-3');
          ctx.fillRect(x0, row.y + 1, x1 - x0, row.h - 2);
        }
        ctx.globalAlpha = row.outside ? 0.5 : 1;
        const [ta, tb] = visibleTimes(row, l.zoom, sl, w);
        const r = row.kind === 'clip' ? 5 : 4;
        const list = row.kind === 'value' ? selMapRef.current.get(laneId(row.clipId, row.prop!)) : undefined;
        let k = ta;
        while (k < tb) {
          const gx = laneKeyX(row, row.times[k]!, l.zoom, sl);
          let m = k + 1;
          while (m < tb && laneKeyX(row, row.times[m]!, l.zoom, sl) - gx < KEY_MERGE_PX) m++;
          // how many of the group's keys are selected, of how many
          let n = 0;
          let on = 0;
          if (row.kind === 'value') {
            n = m - k;
            for (let q = k; q < m; q++) if (selHas(list, row.times[q]!)) on++;
          } else {
            for (const v of row.values ?? []) {
              const vl = selMapRef.current.get(laneId(row.clipId, v.prop));
              for (let q = k; q < m; q++) {
                const t = row.times[q]!;
                if (!hasKeyAt(v.keys, t)) continue;
                n++;
                if (selHas(vl, t)) on++;
              }
            }
          }
          let shape = { left: 'point', right: 'point' } as ReturnType<typeof keyShape>;
          if (row.kind === 'value') {
            const idx = row.from + k;
            shape = keyShape(idx === 0 ? null : row.keys[idx - 1]!.ease, idx === row.keys.length - 1 ? null : row.keys[idx]!.ease);
          }
          drawKeyShape(ctx, gx, mid, r, shape, false);
          if (n > 0 && on === n) drawKeyShape(ctx, gx, mid, r, shape, true);
          else if (on > 0) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(gx - r - 1, mid - r - 1, r + 1, 2 * r + 2);
            ctx.clip();
            drawKeyShape(ctx, gx, mid, r, shape, true);
            ctx.restore();
          }
          k = m;
        }
      }
      ctx.globalAlpha = 1;
      keyPanelDebug.draws++;
      keyPanelDebug.rows = l.rows.length;
      keyPanelDebug.lastDrawMs = performance.now() - t0;
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

  // ----- ctrl and shift wheel belong to the timeline: zoom and sideways scroll -----
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) return;
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
    };
    body.addEventListener('wheel', onWheel, { passive: false });
    return () => body.removeEventListener('wheel', onWheel);
  }, [getScroller]);

  // ----- where a keyboard opened menu goes -----
  useEffect(() => {
    anchor.current = () => {
      const body = bodyRef.current;
      const l = latest.current;
      const br = body ? body.getBoundingClientRect() : new DOMRect(0, 0, 0, 0);
      if (body && l.project) {
        for (const r of liveKeySel(l.project, useUi.getState().keySel)) {
          const row = l.rows.find((q) => q.kind === 'value' && q.clipId === r.clipId && q.prop === r.prop);
          if (!row) continue;
          const x = laneKeyX(row, r.t, l.zoom, view.scrollLeft);
          const y = row.y - body.scrollTop;
          if (x < 0 || x > view.width || y < 0 || y + row.h > body.clientHeight) continue;
          return { x: br.left + HEADER_W + x, y: br.top + y + row.h / 2, target: r };
        }
      }
      return { x: br.left + HEADER_W, y: br.top, target: null };
    };
    return () => {
      anchor.current = null;
    };
  }, [anchor]);

  // ----- pointer -----
  /** the press point in the lanes: lane x, row space y, the row under it and the keys under it */
  const hitAt = (clientX: number, clientY: number) => {
    const el = rowsRef.current;
    const l = latest.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const lx = clientX - rect.left - HEADER_W;
    const ry = clientY - rect.top;
    const i = rowAt(l.rows, ry);
    const refs = i >= 0 && lx >= 0 ? hitLane(l.rows, i, lx, l.zoom, view.scrollLeft) : [];
    return { lx, ry, i, refs };
  };

  const hideFeedback = () => {
    if (snapRef.current) snapRef.current.hidden = true;
    if (readoutRef.current) readoutRef.current.hidden = true;
    if (boxRef.current) boxRef.current.hidden = true;
  };

  const beginDrag = (g: Gesture) => {
    const l = latest.current;
    const st = useEditor.getState();
    if (!st.project) return;
    const sel = liveKeySel(st.project, useUi.getState().keySel);
    const pressed = g.refs[0];
    const clip = st.project.clips.find((c) => c.id === pressed?.clipId);
    if (!pressed || !clip || !hasRef(sel, pressed)) return;
    st.pushHistory();
    interaction.gestureActive = true;
    g.dragging = true;
    g.base = st.project;
    g.baseSel = sel;
    g.a0 = clip.start + pressed.t;
    const playhead = usePlayback.getState().time;
    g.points = keySnapPoints(st.project, l.shown, sel, playhead);
    const times = sel.map((r) => (st.project!.clips.find((c) => c.id === r.clipId)?.start ?? 0) + r.t);
    g.pivot = stretchPivot(g.a0, playhead, times, l.fps);
    g.lastTime = NaN;
  };

  const tick = (g: Gesture) => {
    g.raf = 0;
    const el = rowsRef.current;
    const body = bodyRef.current;
    if (gesture.current !== g || !g.dragging || !g.base || !el || !body) return;
    const l = latest.current;
    const rect = el.getBoundingClientRect();
    let lx = g.cx - rect.left - HEADER_W;
    // near a side the timeline scrolls under the pointer
    let scrolled = false;
    const sc = getScroller();
    if (sc && (lx < EDGE || lx > view.width - EDGE)) {
      const before = sc.scrollLeft;
      sc.scrollLeft += lx < EDGE ? -EDGE_STEP : EDGE_STEP;
      if (sc.scrollLeft !== before) {
        view.scrollLeft = sc.scrollLeft;
        markUserScroll();
        notifyView();
        scrolled = true;
      }
    }
    lx = g.cx - rect.left - HEADER_W;
    const now = (lx + view.scrollLeft) / l.zoom;
    const then = (g.lx0 + g.sl0) / l.zoom;
    const target = keyDragTarget(g.a0 + (now - then), g.points, l.zoom, l.fps, useEditor.getState().snapping);
    const plan = g.stretch ? planKeyScale(g.base, g.baseSel, g.pivot, stretchFactor(g.a0, target.time, g.pivot), 'clamp') : planKeyMove(g.base, g.baseSel, target.time - g.a0, 'clamp');
    if (target.time !== g.lastTime) {
      g.lastTime = target.time;
      // a key in the way: the keys hold at the last good spot
      if (plan.stop?.kind !== 'inTheWay') {
        applyKeyPlan(plan, { skipHistory: true });
        g.shown = plan.amount;
      }
    }
    const snap = snapRef.current;
    if (snap) {
      snap.hidden = target.hit === null;
      if (target.hit !== null) snap.style.transform = `translate3d(${HEADER_W + Math.round(target.hit * l.zoom - view.scrollLeft)}px,0,0)`;
    }
    const out = readoutRef.current;
    if (out) {
      const amount = plan.stop?.kind === 'inTheWay' ? g.shown : plan.amount;
      const base = g.stretch ? `x ${amount.toFixed(2)}` : formatTrimDelta(amount, l.fps);
      out.textContent = plan.stop ? `${base} | ${keyStopText(plan.stop)}` : base;
      const br = body.getBoundingClientRect();
      out.style.transform = `translate3d(${Math.round(g.cx - br.left + 12)}px,${Math.max(0, Math.round(g.cy - br.top - 22))}px,0)`;
      out.hidden = false;
    }
    if (scrolled) g.raf = requestAnimationFrame(() => tick(g));
  };

  const updateBox = (g: Gesture) => {
    const el = rowsRef.current;
    const box = boxRef.current;
    const body = bodyRef.current;
    if (!el || !box || !body) return;
    const l = latest.current;
    const rect = el.getBoundingClientRect();
    const lx = g.cx - rect.left - HEADER_W;
    const ry = g.cy - rect.top;
    const x0 = g.lx0;
    const y0 = g.cy0 - rect.top;
    const refs = keysInBox(l.rows, { x0, x1: lx, y0, y1: ry }, l.zoom, g.sl0);
    useUi.getState().setKeySel(pickKeys(g.baseSel, refs, g.mode));
    const left = Math.min(x0, lx);
    const top = Math.min(y0, ry) - body.scrollTop;
    box.hidden = false;
    box.style.transform = `translate3d(${HEADER_W + left}px,${top}px,0)`;
    box.style.width = `${Math.abs(lx - x0)}px`;
    box.style.height = `${Math.abs(ry - y0)}px`;
  };

  const finish = (commit: boolean) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.raf) cancelAnimationFrame(g.raf);
    g.stop();
    if (g.dragging) interaction.gestureActive = false;
    hideFeedback();
    if (!commit) return;
    if (g.kind === 'key' && !g.moved && g.narrow) useUi.getState().setKeySel(g.refs);
    if (g.kind === 'empty' && !g.moved && g.mode === 'replace') {
      useUi.getState().setKeySel([]);
      usePlayback.getState().seek(Math.max(0, (g.lx0 + g.sl0) / latest.current.zoom));
    }
  };

  // an unmount (shift+u, a mode swap) ends a running gesture: the capture goes with the element and finish would never run
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => () => finishRef.current(false), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || gesture.current) return;
    const p = useEditor.getState().project;
    const hit = hitAt(e.clientX, e.clientY);
    if (!p || !hit || hit.lx < 0) return;
    if (useUi.getState().previewMode === 'source') useUi.getState().activateProgram();
    bodyRef.current?.focus({ preventScroll: true });
    const mode = modeOf(e);
    const sel = liveKeySel(p, useUi.getState().keySel);
    const g: Gesture = {
      kind: hit.refs.length > 0 ? 'key' : 'empty',
      cx0: e.clientX,
      cy0: e.clientY,
      cx: e.clientX,
      cy: e.clientY,
      lx0: hit.lx,
      sl0: view.scrollLeft,
      mode,
      refs: hit.refs,
      narrow: false,
      moved: false,
      dragging: false,
      box: false,
      baseSel: sel,
      base: null,
      a0: 0,
      points: [],
      stretch: e.altKey,
      pivot: 0,
      lastTime: NaN,
      shown: e.altKey ? 1 : 0,
      raf: 0,
      stop: () => {},
    };
    if (g.kind === 'key') {
      // a plain press on a selected key keeps the selection for a drag and narrows to the key when released
      if (mode === 'replace' && hit.refs.every((r) => hasRef(sel, r))) g.narrow = true;
      else useUi.getState().setKeySel(pickKeys(sel, hit.refs, mode));
    }
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
    if (!g) {
      const hit = hitAt(e.clientX, e.clientY);
      if (rowsRef.current) rowsRef.current.style.cursor = hit && hit.refs.length > 0 ? (e.altKey ? 'col-resize' : 'ew-resize') : 'crosshair';
      return;
    }
    g.cx = e.clientX;
    g.cy = e.clientY;
    if (!g.moved && Math.hypot(g.cx - g.cx0, g.cy - g.cy0) >= DRAG_THRESHOLD) {
      g.moved = true;
      if (g.kind === 'key') beginDrag(g);
      else g.box = true;
    }
    if (g.dragging && !g.raf) g.raf = requestAnimationFrame(() => tick(g));
    if (g.box) updateBox(g);
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const hit = hitAt(e.clientX, e.clientY);
    const ref = hit?.refs[0];
    const clip = ref ? useEditor.getState().project?.clips.find((c) => c.id === ref.clipId) : undefined;
    if (ref && clip) usePlayback.getState().seek(Math.max(0, clip.start + ref.t));
  };

  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (useUi.getState().previewMode === 'source') useUi.getState().activateProgram();
    e.preventDefault();
    const p = useEditor.getState().project;
    const hit = hitAt(e.clientX, e.clientY);
    if (!p || !hit) return;
    const refs = hit.refs;
    if (refs.length > 0) {
      const sel = liveKeySel(p, useUi.getState().keySel);
      if (!refs.some((r) => hasRef(sel, r))) useUi.getState().setKeySel(refs);
      onMenu({ x: e.clientX, y: e.clientY, target: refs[0]! });
    } else onMenu({ x: e.clientX, y: e.clientY, target: null });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.target !== e.currentTarget || e.ctrlKey || e.altKey || e.metaKey) return;
    const p = useEditor.getState().project;
    if (!p) return;
    e.preventDefault();
    const ids = latest.current.shown.map((c) => c.id);
    const refs = keyRefsAt(p, ids, usePlayback.getState().time, 0.5 / latest.current.fps);
    const sel = liveKeySel(p, useUi.getState().keySel);
    useUi.getState().setKeySel(pickKeys(sel, refs, e.shiftKey ? 'add' : 'replace'));
  };

  const onScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    const l = latest.current;
    const st = body.scrollTop;
    if (!sameRange(visibleRows(l.rows, st - 40, body.clientHeight + 80), l.range)) setScrollTop(st);
    draw.current?.invalidate();
  };

  /** a label press picks the row's keys. the body keeps the focus */
  const pickRow = (row: LaneRow, e: ReactMouseEvent) => {
    if (useUi.getState().previewMode === 'source') useUi.getState().activateProgram();
    const p = useEditor.getState().project;
    if (!p) return;
    const sel = liveKeySel(p, useUi.getState().keySel);
    useUi.getState().setKeySel(pickKeys(sel, rowKeyRefs(row), modeOf(e)));
  };
  const keepFocus = (e: ReactMouseEvent) => {
    e.preventDefault();
    bodyRef.current?.focus({ preventScroll: true });
  };
  const toggleFold = (id: string) => {
    const next = new Set(folded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onFold(next);
  };

  const clips = new Map(shown.map((c) => [c.id, c]));

  return (
    <div
      ref={bodyRef}
      className="key-panel-body"
      tabIndex={0}
      role="group"
      aria-label="keyframes of the selected clips"
      onFocus={() => useUi.getState().setKeyFocus(true)}
      onKeyDown={onKeyDown}
      onScroll={onScroll}
    >
      <div
        ref={rowsRef}
        className="key-panel-rows"
        style={{ height: total, minHeight: bodyH }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => finish(true)}
        onPointerCancel={() => finish(false)}
        onLostPointerCapture={() => finish(false)}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        <div className="key-panel-stage" style={{ height: bodyH, marginBottom: -bodyH }}>
          <canvas ref={canvasRef} className="key-panel-canvas" style={{ left: HEADER_W }} aria-hidden="true" />
          <div ref={headRef} className="key-panel-playhead" style={{ left: HEADER_W }} />
          <div ref={snapRef} className="key-panel-snap" hidden />
          <div ref={boxRef} className="key-panel-box" hidden />
          <div ref={readoutRef} className="key-panel-readout" hidden />
          {shown.length === 0 ? <div className="key-panel-empty">select clips to see their keyframes here, one row per value</div> : null}
        </div>
        {rows.slice(first, end).map((row, k) => {
          const i = first + k;
          const clip = clips.get(row.clipId);
          const none = row.kind === 'clip' && (row.values?.length ?? 0) === 0;
          return (
            <div key={`${row.clipId}/${row.prop ?? ''}`} className={`key-row key-row-${row.kind}${i % 2 === 1 ? ' is-alt' : ''}${row.outside ? ' is-outside' : ''}`} style={{ top: row.y, height: row.h }}>
              <div className="key-row-head" style={{ width: HEADER_W }}>
                {row.kind === 'clip' ? (
                  <>
                    <button
                      type="button"
                      className="key-caret"
                      tabIndex={-1}
                      aria-label={`${row.folded ? 'unfold' : 'fold'} ${row.label}`}
                      onMouseDown={keepFocus}
                      onClick={() => toggleFold(row.clipId)}
                    >
                      {row.folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    </button>
                    <span className="key-chip" style={{ background: `var(--clip-${chipOf(clip)})` }} />
                    <button type="button" className="key-label" tabIndex={-1} onMouseDown={keepFocus} onClick={(e) => pickRow(row, e)}>
                      {row.label}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="key-label key-label-value"
                    tabIndex={-1}
                    {...tip(row.label, { does: 'click to select its keyframes' })}
                    onMouseDown={keepFocus}
                    onClick={(e) => pickRow(row, e)}
                  >
                    {row.label}
                  </button>
                )}
              </div>
              {none ? (
                <span className="key-note" style={{ left: HEADER_W + 8 }}>
                  no keyframes
                </span>
              ) : row.outside ? (
                <span className="key-note" style={{ left: HEADER_W + 8 }}>
                  keys outside the clip
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
