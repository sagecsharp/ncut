/**
 * dom overlay on top of the preview canvas: click-to-select, selection boxes with scale / rotate
 * handles, drag to move with center snapping.
 *
 * nothing here renders per frame: boxes position themselves from store subscriptions through refs,
 * and pointer moves are coalesced to one store update per animation frame.
 */
import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Clip, VisualClip } from '../../types';
import { isVisualClip } from '../../types';
import { getClipBox, hitTestBox, visibleClipsAt } from '../../engine/draw';
import { clipEnd } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';

const SNAP_PX = 6;
const DRAG_THRESHOLD_PX = 2;
const MIN_SCALE = 0.02;
const MAX_SCALE = 20;

/** shared, mutable view info (css px per canvas px) plus the boxes to refresh when it changes */
interface View {
  f: number;
  fns: Set<() => void>;
}

function normalizeAngle(a: number): number {
  const r = ((((a + 180) % 360) + 360) % 360) - 180;
  return r === -180 ? 180 : r;
}

const SelBox = memo(function SelBox({ clipId, view }: { clipId: string; view: View }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let shown = false;
    let lastClip: Clip | undefined;
    let lw = '';
    let lh = '';
    let lt = '';

    const inRange = (c: Clip, time: number) => time >= c.start - 1e-6 && time < clipEnd(c) - 1e-6;
    const hide = () => {
      if (shown) {
        el.style.display = 'none';
        shown = false;
      }
    };

    const update = () => {
      const project = useEditor.getState().project;
      const clip = project?.clips.find((c) => c.id === clipId);
      lastClip = clip;
      if (!project || !clip || !isVisualClip(clip) || view.f <= 0) return hide();
      const track = project.tracks.find((t) => t.id === clip.trackId);
      if (!track || track.hidden || !inRange(clip, usePlayback.getState().time)) return hide();
      const box = getClipBox(project, clip);
      const f = view.f;
      const w = box.width * f;
      const h = box.height * f;
      const ws = `${w}px`;
      const hs = `${h}px`;
      const ts = `translate3d(${box.cx * f - w / 2}px, ${box.cy * f - h / 2}px, 0) rotate(${box.rotation}deg)`;
      if (!shown) {
        el.style.display = 'block';
        shown = true;
      }
      if (ws !== lw) el.style.width = lw = ws;
      if (hs !== lh) el.style.height = lh = hs;
      if (ts !== lt) el.style.transform = lt = ts;
      el.dataset.locked = track.locked ? '1' : '0';
    };

    view.fns.add(update);
    update();
    const unProject = useEditor.subscribe((s, p) => {
      if (s.project !== p.project) update();
    });
    const unTime = usePlayback.subscribe((s, p) => {
      if (s.time === p.time || !lastClip) return;
      if (inRange(lastClip, s.time) !== shown) update();
    });
    return () => {
      view.fns.delete(update);
      unProject();
      unTime();
    };
  }, [clipId, view]);

  return (
    <div ref={ref} className="preview-box" style={{ display: 'none' }}>
      <div className="preview-handle preview-handle-nw" data-handle="scale" data-clip={clipId} title="scale" />
      <div className="preview-handle preview-handle-ne" data-handle="scale" data-clip={clipId} title="scale" />
      <div className="preview-handle preview-handle-sw" data-handle="scale" data-clip={clipId} title="scale" />
      <div className="preview-handle preview-handle-se" data-handle="scale" data-clip={clipId} title="scale" />
      <div className="preview-rotate-stem" />
      <div className="preview-handle preview-handle-rotate" data-handle="rotate" data-clip={clipId} title="rotate (shift = 15 degree steps)" />
    </div>
  );
});

type Gesture =
  | {
      kind: 'move';
      pointerId: number;
      startX: number;
      startY: number;
      started: boolean;
      primary: string;
      items: Array<{ id: string; x: number; y: number }>;
    }
  | { kind: 'scale'; pointerId: number; id: string; cx: number; cy: number; d0: number; s0: number; started: boolean }
  | { kind: 'rotate'; pointerId: number; id: string; cx: number; cy: number; a0: number; r0: number; started: boolean };

interface PointerSnapshot {
  x: number;
  y: number;
  shift: boolean;
}

export function TransformOverlay() {
  const rootRef = useRef<HTMLDivElement>(null);
  const guideV = useRef<HTMLDivElement>(null);
  const guideH = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View>({ f: 0, fns: new Set() });
  const gestureRef = useRef<Gesture | null>(null);
  const pendingRef = useRef<PointerSnapshot | null>(null);
  const rafRef = useRef(0);
  const originRef = useRef({ left: 0, top: 0 });

  const selection = useEditor((s) => s.selection);

  // css px per canvas px, from the overlay size (a ResizeObserver: no layout reads elsewhere)
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const view = viewRef.current;
    let lastW = 0;
    const measure = (w: number) => {
      const project = useEditor.getState().project;
      lastW = w;
      view.f = project && project.width > 0 ? w / project.width : 0;
      for (const fn of Array.from(view.fns)) fn();
    };
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) measure(e.contentRect.width);
    });
    ro.observe(root);
    // the project resolution can change without a resize of the frame
    const unsub = useEditor.subscribe((s, p) => {
      if (s.project && p.project && s.project.width !== p.project.width && lastW > 0) measure(lastW);
    });
    return () => {
      ro.disconnect();
      unsub();
    };
  }, []);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const showGuides = (x: boolean, y: boolean) => {
    if (guideV.current) guideV.current.style.display = x ? 'block' : 'none';
    if (guideH.current) guideH.current.style.display = y ? 'block' : 'none';
  };

  const apply = (snap: PointerSnapshot) => {
    const g = gestureRef.current;
    const store = useEditor.getState();
    if (!g || !store.project) return;
    const f = viewRef.current.f;
    if (f <= 0) return;

    if (g.kind === 'move') {
      const sx = snap.x - g.startX;
      const sy = snap.y - g.startY;
      if (!g.started) {
        if (Math.hypot(sx, sy) < DRAG_THRESHOLD_PX) return;
        g.started = true;
        store.pushHistory();
      }
      let dx = sx / f;
      let dy = sy / f;
      const primary = g.items.find((i) => i.id === g.primary) ?? g.items[0];
      let snapX = false;
      let snapY = false;
      if (primary) {
        const thr = SNAP_PX / f;
        if (Math.abs(primary.x + dx) <= thr) {
          dx = -primary.x;
          snapX = true;
        }
        if (Math.abs(primary.y + dy) <= thr) {
          dy = -primary.y;
          snapY = true;
        }
      }
      showGuides(snapX, snapY);
      for (const it of g.items) {
        store.updateTransform(it.id, { x: Math.round((it.x + dx) * 100) / 100, y: Math.round((it.y + dy) * 100) / 100 }, { skipHistory: true });
      }
      return;
    }

    const origin = originRef.current;
    const px = (snap.x - origin.left) / f;
    const py = (snap.y - origin.top) / f;
    if (!g.started) {
      g.started = true;
      store.pushHistory();
    }
    if (g.kind === 'scale') {
      const d = Math.hypot(px - g.cx, py - g.cy);
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (g.s0 * d) / g.d0));
      store.updateTransform(g.id, { scale: Math.round(scale * 1000) / 1000 }, { skipHistory: true });
      return;
    }
    const a = (Math.atan2(py - g.cy, px - g.cx) * 180) / Math.PI;
    let r = normalizeAngle(g.r0 + (a - g.a0));
    if (snap.shift) {
      r = normalizeAngle(Math.round(r / 15) * 15);
    } else {
      for (const t of [0, 90, 180, -90]) {
        if (Math.abs(normalizeAngle(r - t)) <= 3) {
          r = t;
          break;
        }
      }
    }
    store.updateTransform(g.id, { rotation: Math.round(r * 100) / 100 }, { skipHistory: true });
  };

  const flush = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    const snap = pendingRef.current;
    pendingRef.current = null;
    if (snap) apply(snap);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || gestureRef.current) return;
    const root = rootRef.current;
    const store = useEditor.getState();
    const project = store.project;
    if (!root || !project) return;
    e.preventDefault();

    // measure once, at gesture start
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0) return;
    originRef.current = { left: rect.left, top: rect.top };
    const f = rect.width / project.width;
    viewRef.current.f = f;
    const px = (e.clientX - rect.left) / f;
    const py = (e.clientY - rect.top) / f;

    const handle = (e.target as HTMLElement).closest<HTMLElement>('[data-handle]');
    if (handle) {
      const clip = project.clips.find((c) => c.id === handle.dataset.clip);
      const track = clip ? project.tracks.find((t) => t.id === clip.trackId) : undefined;
      if (clip && isVisualClip(clip) && track && !track.locked) {
        const box = getClipBox(project, clip);
        if (handle.dataset.handle === 'scale') {
          gestureRef.current = {
            kind: 'scale',
            pointerId: e.pointerId,
            id: clip.id,
            cx: box.cx,
            cy: box.cy,
            d0: Math.max(1, Math.hypot(px - box.cx, py - box.cy)),
            s0: clip.transform.scale,
            started: false,
          };
        } else {
          gestureRef.current = {
            kind: 'rotate',
            pointerId: e.pointerId,
            id: clip.id,
            cx: box.cx,
            cy: box.cy,
            a0: (Math.atan2(py - box.cy, px - box.cx) * 180) / Math.PI,
            r0: clip.transform.rotation,
            started: false,
          };
        }
        root.setPointerCapture(e.pointerId);
      }
      return;
    }

    // top-most visual clip under the pointer (skip locked tracks)
    const visible = visibleClipsAt(project, usePlayback.getState().time);
    let hit: VisualClip | null = null;
    for (let i = visible.length - 1; i >= 0; i--) {
      const clip = visible[i]!;
      const track = project.tracks.find((t) => t.id === clip.trackId);
      if (!track || track.locked) continue;
      if (hitTestBox(getClipBox(project, clip), px, py)) {
        hit = clip;
        break;
      }
    }

    if (!hit) {
      if (!e.shiftKey) store.clearSelection();
      return;
    }
    if (e.shiftKey) {
      store.select([hit.id], 'toggle');
      if (!useEditor.getState().selection.includes(hit.id)) return;
    } else if (!store.selection.includes(hit.id)) {
      store.select([hit.id], 'replace');
    }

    const sel = useEditor.getState().selection;
    const items: Array<{ id: string; x: number; y: number }> = [];
    for (const clip of project.clips) {
      if (!sel.includes(clip.id) || !isVisualClip(clip)) continue;
      const track = project.tracks.find((t) => t.id === clip.trackId);
      if (!track || track.locked) continue;
      items.push({ id: clip.id, x: clip.transform.x, y: clip.transform.y });
    }
    if (items.length === 0) return;
    gestureRef.current = { kind: 'move', pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, started: false, primary: hit.id, items };
    root.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    pendingRef.current = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const snap = pendingRef.current;
        pendingRef.current = null;
        if (snap) apply(snap);
      });
    }
  };

  const endGesture = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    if (e.type === 'pointerup') pendingRef.current = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
    flush();
    gestureRef.current = null;
    showGuides(false, false);
    const root = rootRef.current;
    if (root && root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      ref={rootRef}
      className="preview-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
    >
      {selection.map((id) => (
        <SelBox key={id} clipId={id} view={viewRef.current} />
      ))}
      <div ref={guideV} className="preview-guide preview-guide-v" />
      <div ref={guideH} className="preview-guide preview-guide-h" />
    </div>
  );
}
