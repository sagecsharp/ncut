/**
 * dom overlay on top of the preview canvas: click-to-select, selection boxes with scale / rotate
 * handles, drag to move with center snapping. 3d clips get their real projected outline.
 * in scene mode the overlay is the SceneOverlay (orbit camera, move gizmo) instead.
 *
 * nothing here renders per frame: boxes position themselves from store subscriptions through refs,
 * and pointer moves are coalesced to one store update per animation frame.
 */
import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Clip, Project, VisualClip } from '../../types';
import { isVisualClip } from '../../types';
import { getClipBox, hitTestBox, visibleClipsAt } from '../../engine/draw';
import { cameraClipAt, projectPoint, rayPlane, screenRay } from '../../engine/scene3d/camera';
import type { CameraRig } from '../../engine/scene3d/camera';
import { resolveClip } from '../../lib/anim';
import { clipEnd } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { SceneOverlay } from './SceneOverlay';
import { type Quad, clipQuad, pointInQuad, projectRig } from './overlayMath';

const SNAP_PX = 6;
const DRAG_THRESHOLD_PX = 2;
const MIN_SCALE = 0.02;
const MAX_SCALE = 20;
const CORNERS = ['nw', 'ne', 'se', 'sw'] as const;

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
  const quadRef = useRef<HTMLDivElement>(null);
  const polyRef = useRef<SVGPolygonElement>(null);
  const underRef = useRef<SVGPolygonElement>(null);
  const cornerRefs = useRef<Array<HTMLDivElement | null>>([null, null, null, null]);

  useLayoutEffect(() => {
    const el = ref.current;
    const quadEl = quadRef.current;
    const poly = polyRef.current;
    const under = underRef.current;
    if (!el || !quadEl || !poly || !under) return;
    let shown2d = false;
    let shown3d = false;
    let lastClip: Clip | undefined;
    let dynamic = false;
    let lw = '';
    let lh = '';
    let lt = '';
    let lp = '';
    const scratch: Quad = { p: [0, 0, 0, 0, 0, 0, 0, 0], visible: true, depth: 0, world: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], cx: 0, cy: 0 };

    const inRange = (c: Clip, time: number) => time >= c.start - 1e-6 && time < clipEnd(c) - 1e-6;
    const hide = () => {
      if (shown2d) {
        el.style.display = 'none';
        shown2d = false;
      }
      if (shown3d) {
        quadEl.style.display = 'none';
        shown3d = false;
      }
    };

    const update = () => {
      const project = useEditor.getState().project;
      const clip = project?.clips.find((c) => c.id === clipId);
      lastClip = clip;
      dynamic = false;
      if (!project || !clip || !isVisualClip(clip) || view.f <= 0) return hide();
      const track = project.tracks.find((t) => t.id === clip.trackId);
      const time = usePlayback.getState().time;
      if (!track || track.hidden || !inRange(clip, time)) return hide();
      // keyframes move the box, a 3d clip also follows the camera (which may be animated)
      dynamic = !!clip.keyframes || !!clip.threeD || project.clips.some((c) => c.type === 'camera');
      const f = view.f;
      const locked = track.locked ? '1' : '0';

      if (clip.threeD) {
        const rig = projectRig(project, time);
        const q = clipQuad(project, clip, time, rig, scratch);
        if (shown2d) {
          el.style.display = 'none';
          shown2d = false;
        }
        if (!q.visible) {
          if (shown3d) {
            quadEl.style.display = 'none';
            shown3d = false;
          }
          return;
        }
        if (!shown3d) {
          quadEl.style.display = 'block';
          shown3d = true;
        }
        const pts = `${q.p[0] * f},${q.p[1] * f} ${q.p[2] * f},${q.p[3] * f} ${q.p[4] * f},${q.p[5] * f} ${q.p[6] * f},${q.p[7] * f}`;
        if (pts !== lp) {
          lp = pts;
          poly.setAttribute('points', pts);
          under.setAttribute('points', pts);
          for (let i = 0; i < 4; i++) {
            const c = cornerRefs.current[i];
            if (c) c.style.transform = `translate3d(${q.p[i * 2]! * f - 4.5}px, ${q.p[i * 2 + 1]! * f - 4.5}px, 0)`;
          }
        }
        quadEl.dataset.locked = locked;
        return;
      }

      if (shown3d) {
        quadEl.style.display = 'none';
        shown3d = false;
      }
      const box = getClipBox(project, resolveClip(clip, time));
      const w = box.width * f;
      const h = box.height * f;
      const ws = `${w}px`;
      const hs = `${h}px`;
      const ts = `translate3d(${box.cx * f - w / 2}px, ${box.cy * f - h / 2}px, 0) rotate(${box.rotation}deg)`;
      if (!shown2d) {
        el.style.display = 'block';
        shown2d = true;
      }
      if (ws !== lw) el.style.width = lw = ws;
      if (hs !== lh) el.style.height = lh = hs;
      if (ts !== lt) el.style.transform = lt = ts;
      el.dataset.locked = locked;
    };

    view.fns.add(update);
    update();
    const unProject = useEditor.subscribe((s, p) => {
      if (s.project !== p.project) update();
    });
    const unTime = usePlayback.subscribe((s, p) => {
      if (s.time === p.time || !lastClip) return;
      if (dynamic || inRange(lastClip, s.time) !== (shown2d || shown3d)) update();
    });
    return () => {
      view.fns.delete(update);
      unProject();
      unTime();
    };
  }, [clipId, view]);

  return (
    <>
      <div ref={ref} className="preview-box" style={{ display: 'none' }}>
        <div className="preview-handle preview-handle-nw" data-handle="scale" data-clip={clipId} title="scale" />
        <div className="preview-handle preview-handle-ne" data-handle="scale" data-clip={clipId} title="scale" />
        <div className="preview-handle preview-handle-sw" data-handle="scale" data-clip={clipId} title="scale" />
        <div className="preview-handle preview-handle-se" data-handle="scale" data-clip={clipId} title="scale" />
        <div className="preview-rotate-stem" />
        <div className="preview-handle preview-handle-rotate" data-handle="rotate" data-clip={clipId} title="rotate (shift = 15 degree steps)" />
      </div>
      <div ref={quadRef} className="preview-quad" style={{ display: 'none' }}>
        <svg className="preview-quad-svg" aria-hidden="true">
          <polygon ref={underRef} className="preview-quad-under" />
          <polygon ref={polyRef} className="preview-quad-line" />
        </svg>
        {CORNERS.map((c, i) => (
          <div
            key={c}
            ref={(n) => {
              cornerRefs.current[i] = n;
            }}
            className="preview-handle preview-quad-handle"
            data-handle="scale"
            data-clip={clipId}
            title="scale"
          />
        ))}
      </div>
    </>
  );
});

/** shows "3d camera" while a camera clip is in charge at the playhead */
function CameraBadge() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let hasCam = false;
    let shown = false;
    const refresh = () => {
      const project = useEditor.getState().project;
      const on = hasCam && !!project && !!cameraClipAt(project, usePlayback.getState().time);
      if (on !== shown) {
        shown = on;
        el.style.display = on ? 'block' : 'none';
      }
    };
    const scan = () => {
      hasCam = !!useEditor.getState().project?.clips.some((c) => c.type === 'camera');
      refresh();
    };
    scan();
    const unProject = useEditor.subscribe((s, p) => {
      if (s.project !== p.project) scan();
    });
    const unTime = usePlayback.subscribe((s, p) => {
      if (hasCam && s.time !== p.time) refresh();
    });
    return () => {
      unProject();
      unTime();
    };
  }, []);
  return (
    <div ref={ref} className="preview-badge" style={{ display: 'none' }} title="a camera clip is in charge here">
      3d camera
    </div>
  );
}

interface MoveItem {
  id: string;
  x: number;
  y: number;
  threeD: boolean;
  /** world point under the pointer at gesture start, on the plane parallel to the canvas at the clip's depth */
  p0: [number, number, number] | null;
  z: number;
}

type Gesture =
  | {
      kind: 'move';
      pointerId: number;
      startX: number;
      startY: number;
      started: boolean;
      primary: string;
      items: MoveItem[];
      rig: CameraRig;
    }
  | { kind: 'scale'; pointerId: number; startX: number; startY: number; id: string; cx: number; cy: number; d0: number; s0: number; started: boolean }
  | { kind: 'rotate'; pointerId: number; startX: number; startY: number; id: string; cx: number; cy: number; a0: number; r0: number; started: boolean };

interface PointerSnapshot {
  x: number;
  y: number;
  shift: boolean;
}

/**
 * top-most visual clip under a canvas point (skips locked tracks). 2d clips use their rotated box,
 * 3d clips their projected quad; a run of consecutive 3d clips is depth sorted like the renderer does.
 */
function hitTest(project: Project, time: number, rig: CameraRig, px: number, py: number): VisualClip | null {
  const visible = visibleClipsAt(project, time);
  const locked = (c: VisualClip) => project.tracks.find((t) => t.id === c.trackId)?.locked ?? true;
  let i = visible.length - 1;
  while (i >= 0) {
    const clip = visible[i]!;
    if (!clip.threeD) {
      i--;
      if (!locked(clip) && hitTestBox(getClipBox(project, resolveClip(clip, time)), px, py)) return clip;
      continue;
    }
    let best: VisualClip | null = null;
    let bestDepth = Infinity;
    while (i >= 0 && visible[i]!.threeD) {
      const c = visible[i]!;
      i--;
      if (locked(c)) continue;
      const q = clipQuad(project, c, time, rig);
      if (q.visible && pointInQuad(q.p, px, py) && q.depth < bestDepth) {
        best = c;
        bestDepth = q.depth;
      }
    }
    if (best) return best;
  }
  return null;
}

function OutputOverlay() {
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
    const project = store.project;
    if (!g || !project) return;
    const f = viewRef.current.f;
    if (f <= 0) return;
    const time = usePlayback.getState().time;
    const origin = originRef.current;
    const px = (snap.x - origin.left) / f;
    const py = (snap.y - origin.top) / f;

    if (g.kind === 'move') {
      const sx = snap.x - g.startX;
      const sy = snap.y - g.startY;
      if (!g.started) {
        if (Math.hypot(sx, sy) < DRAG_THRESHOLD_PX) return;
        g.started = true;
        store.pushHistory();
      }
      // a 3d clip moves in the plane parallel to the canvas at its own depth
      const ray = g.items.some((i) => i.threeD) ? screenRay(g.rig, px, py, project.width, project.height) : null;
      const deltas: Array<[number, number]> = [];
      for (const it of g.items) {
        if (it.threeD && ray && it.p0) {
          const p1 = rayPlane(ray.origin, ray.dir, [0, 0, it.z], [0, 0, 1]);
          deltas.push(p1 ? [p1[0] - it.p0[0], p1[1] - it.p0[1]] : [0, 0]);
        } else deltas.push([sx / f, sy / f]);
      }
      let adjX = 0;
      let adjY = 0;
      let snapX = false;
      let snapY = false;
      const pi = Math.max(0, g.items.findIndex((i) => i.id === g.primary));
      const primary = g.items[pi];
      const pd = deltas[pi];
      if (primary && pd) {
        const thr = SNAP_PX / f;
        if (Math.abs(primary.x + pd[0]) <= thr) {
          adjX = -primary.x - pd[0];
          snapX = true;
        }
        if (Math.abs(primary.y + pd[1]) <= thr) {
          adjY = -primary.y - pd[1];
          snapY = true;
        }
      }
      showGuides(snapX, snapY);
      g.items.forEach((it, i) => {
        const d = deltas[i]!;
        store.setClipValue(it.id, 'x', time, Math.round((it.x + d[0] + adjX) * 100) / 100, { skipHistory: true });
        store.setClipValue(it.id, 'y', time, Math.round((it.y + d[1] + adjY) * 100) / 100, { skipHistory: true });
      });
      return;
    }

    if (!g.started) {
      // a plain click on a handle must not start a gesture (wipes redo, snaps the value)
      if (Math.hypot(snap.x - g.startX, snap.y - g.startY) < DRAG_THRESHOLD_PX) return;
      g.started = true;
      store.pushHistory();
    }
    if (g.kind === 'scale') {
      const d = Math.hypot(px - g.cx, py - g.cy);
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (g.s0 * d) / g.d0));
      store.setClipValue(g.id, 'scale', time, Math.round(scale * 1000) / 1000, { skipHistory: true });
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
    store.setClipValue(g.id, 'rotation', time, Math.round(r * 100) / 100, { skipHistory: true });
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
    // preventDefault suppresses the focus change: drop focus from inputs so shortcuts work again
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();

    // measure once, at gesture start
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0) return;
    originRef.current = { left: rect.left, top: rect.top };
    const f = rect.width / project.width;
    viewRef.current.f = f;
    const px = (e.clientX - rect.left) / f;
    const py = (e.clientY - rect.top) / f;
    const time = usePlayback.getState().time;
    const rig = projectRig(project, time);

    const handle = (e.target as HTMLElement).closest<HTMLElement>('[data-handle]');
    if (handle) {
      const raw = project.clips.find((c) => c.id === handle.dataset.clip);
      const track = raw ? project.tracks.find((t) => t.id === raw.trackId) : undefined;
      if (raw && isVisualClip(raw) && track && !track.locked) {
        const clip = resolveClip(raw, time);
        const box = getClipBox(project, clip);
        let cx = box.cx;
        let cy = box.cy;
        if (clip.threeD) {
          const c = projectPoint(rig, box.cx, box.cy, clip.transform.z ?? 0, project.width, project.height);
          if (!c.visible) return;
          cx = c.x;
          cy = c.y;
        }
        if (handle.dataset.handle === 'scale') {
          gestureRef.current = {
            kind: 'scale',
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            id: clip.id,
            cx,
            cy,
            d0: Math.max(1, Math.hypot(px - cx, py - cy)),
            s0: clip.transform.scale,
            started: false,
          };
        } else {
          gestureRef.current = {
            kind: 'rotate',
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            id: clip.id,
            cx,
            cy,
            a0: (Math.atan2(py - cy, px - cx) * 180) / Math.PI,
            r0: clip.transform.rotation,
            started: false,
          };
        }
        root.setPointerCapture(e.pointerId);
      }
      return;
    }

    const hit = hitTest(project, time, rig, px, py);
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
    const ray = screenRay(rig, px, py, project.width, project.height);
    const items: MoveItem[] = [];
    for (const raw of project.clips) {
      if (!sel.includes(raw.id) || !isVisualClip(raw)) continue;
      const track = project.tracks.find((t) => t.id === raw.trackId);
      if (!track || track.locked) continue;
      const clip = resolveClip(raw, time);
      const z = clip.transform.z ?? 0;
      const p0 = raw.threeD ? rayPlane(ray.origin, ray.dir, [0, 0, z], [0, 0, 1]) : null;
      items.push({ id: raw.id, x: clip.transform.x, y: clip.transform.y, threeD: !!raw.threeD, p0, z });
    }
    if (items.length === 0) return;
    gestureRef.current = { kind: 'move', pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, started: false, primary: hit.id, items, rig };
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
      <CameraBadge />
    </div>
  );
}

export function TransformOverlay() {
  const mode = useUi((s) => s.previewMode);
  return mode === 'scene' ? <SceneOverlay /> : <OutputOverlay />;
}
