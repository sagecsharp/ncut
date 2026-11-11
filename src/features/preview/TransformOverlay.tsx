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
import { isVisualClip, stretchX, stretchY } from '../../types';
import { getClipBox, visibleClipsAt } from '../../engine/draw';
import { faceSourceSet } from '../../engine/scene3d/faces';
import { cameraClipAt, projectPoint, rayPlane, screenRay } from '../../engine/scene3d/camera';
import type { CameraRig } from '../../engine/scene3d/camera';
import { resolveClip } from '../../lib/anim';
import { clipEnd } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { SceneOverlay } from './SceneOverlay';
import { type Edge, type EdgeStart, type Quad, boxBounds, clipQuad, edgeMode, edgeResize, edgeStretch, hitTestKept, keptBox, pointInQuad, projectRig, rotateValue, snapAxis, unwrapStep } from './overlayMath';
import { localDelta, withoutRidingChildren, worldClip } from './attached';
import { beginPreviewGesture, endPreviewGesture, installGestureGuard } from './gesture';
import { movableClipsAt } from './nudge';

const SNAP_PX = 6;
const DRAG_THRESHOLD_PX = 2;
const MIN_SCALE = 0.02;
const MAX_SCALE = 20;
/** thin things (a line shape) can still be grabbed: every hit box is at least this many css px thick */
const MIN_HIT_PX = 12;
const MIN_SHAPE_PX = 4;
const CORNERS = ['nw', 'ne', 'se', 'sw'] as const;

/** shared, mutable view info (css px per canvas px) plus the boxes to refresh when it changes */
interface View {
  f: number;
  fns: Set<() => void>;
}

const inRangeAt = (c: Clip, time: number) => time >= c.start - 1e-6 && time < clipEnd(c) - 1e-6;

const SelBox = memo(function SelBox({ clipId, view }: { clipId: string; view: View }) {
  const ref = useRef<HTMLDivElement>(null);
  const quadRef = useRef<HTMLDivElement>(null);
  const polyRef = useRef<SVGPolygonElement>(null);
  const underRef = useRef<SVGPolygonElement>(null);
  const cornerRefs = useRef<Array<HTMLDivElement | null>>([null, null, null, null]);
  // a shape's edges change its width / height, every other clip's edges stretch it
  const isShape = useEditor((s) => s.project?.clips.find((c) => c.id === clipId)?.type === 'shape');
  const wTitle = isShape ? 'width' : 'stretch';
  const hTitle = isShape ? 'height' : 'stretch';

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
      // a clip that lives on a side of a solid is not painted on its own: no box to grab
      if (faceSourceSet(project).has(clip.id)) return hide();
      // keyframes move the box, a 3d clip also follows the camera (which may be animated)
      dynamic = !!clip.keyframes || !!clip.threeD || !!clip.parent || project.clips.some((c) => c.type === 'camera');
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
      // the outline hugs the kept rectangle of a cropped clip
      // (the crop as it is at this time: it may be keyed)
      const shown = worldClip(project, clip, time);
      const box = keptBox(getClipBox(project, shown), shown.crop);
      // edge handles: a plain shape's own width / height, a stretch for anything else. not on a cropped clip.
      const edges = edgeMode(shown) ? '1' : '0';
      if (el.dataset.edges !== edges) el.dataset.edges = edges;
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
        <div className="preview-handle preview-handle-edge preview-handle-w" data-handle="edge" data-edge="l" data-clip={clipId} title={wTitle} />
        <div className="preview-handle preview-handle-edge preview-handle-e" data-handle="edge" data-edge="r" data-clip={clipId} title={wTitle} />
        <div className="preview-handle preview-handle-edge preview-handle-n" data-handle="edge" data-edge="t" data-clip={clipId} title={hTitle} />
        <div className="preview-handle preview-handle-edge preview-handle-s" data-handle="edge" data-edge="b" data-clip={clipId} title={hTitle} />
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
  /** the clip's own x / y at gesture start (what gets written) */
  x: number;
  y: number;
  /** where the clip really is: its offsets in the world (same as x / y without a parent) */
  wx: number;
  wy: number;
  clip: VisualClip;
  threeD: boolean;
  /** 2d: half extents of the kept box's bounds and the offset of its center from the clip center (canvas px) */
  hw: number;
  hh: number;
  ox: number;
  oy: number;
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
  | {
      kind: 'edge';
      pointerId: number;
      startX: number;
      startY: number;
      id: string;
      edge: Edge;
      start: EdgeStart;
      /** a stretch drag (not a shape's own size): the prop it writes and its value at the grab */
      stretch: { prop: 'scaleX' | 'scaleY'; s0: number } | null;
      x0: number;
      y0: number;
      started: boolean;
    }
  | { kind: 'scale'; pointerId: number; startX: number; startY: number; id: string; cx: number; cy: number; d0: number; s0: number; started: boolean }
  | {
      kind: 'rotate';
      pointerId: number;
      startX: number;
      startY: number;
      id: string;
      cx: number;
      cy: number;
      /** pointer angle at the last step, degrees (atan2 range) */
      last: number;
      /** unwrapped pointer rotation since the grab, degrees */
      acc: number;
      r0: number;
      started: boolean;
    };

interface PointerSnapshot {
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
}

/**
 * top-most visual clip under a canvas point (skips locked tracks). 2d clips use their rotated box,
 * 3d clips their projected quad; a run of consecutive 3d clips is depth sorted like the renderer does.
 */
function hitTest(project: Project, time: number, rig: CameraRig, px: number, py: number, minHit: number): VisualClip | null {
  const visible = visibleClipsAt(project, time);
  const locked = (c: VisualClip) => project.tracks.find((t) => t.id === c.trackId)?.locked ?? true;
  let i = visible.length - 1;
  while (i >= 0) {
    const clip = visible[i]!;
    if (!clip.threeD) {
      i--;
      if (locked(clip)) continue;
      const shown = worldClip(project, clip, time);
      if (hitTestKept(keptBox(getClipBox(project, shown), shown.crop), px, py, minHit)) return clip;
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
      endPreviewGesture();
    },
    [],
  );

  /** hairlines at a canvas x / y while snapped (null = hidden). positioned with a transform, no layout */
  const showGuides = (x: number | null, y: number | null) => {
    const project = useEditor.getState().project;
    const f = viewRef.current.f;
    const v = guideV.current;
    const h = guideH.current;
    if (v) {
      v.style.display = x === null ? 'none' : 'block';
      if (x !== null && project) v.style.transform = `translate3d(${Math.min(x * f, project.width * f - 1)}px, 0, 0)`;
    }
    if (h) {
      h.style.display = y === null ? 'none' : 'block';
      if (y !== null && project) h.style.transform = `translate3d(0, ${Math.min(y * f, project.height * f - 1)}px, 0)`;
    }
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
      let atX: number | null = null;
      let atY: number | null = null;
      const pi = Math.max(0, g.items.findIndex((i) => i.id === g.primary));
      const primary = g.items[pi];
      const pd = deltas[pi];
      // snapping follows the primary clip. alt turns it off.
      if (primary && pd && !snap.alt) {
        const thr = SNAP_PX / f;
        if (primary.threeD) {
          // a 3d clip snaps its center to the canvas center only
          if (Math.abs(primary.wx + pd[0]) <= thr) {
            adjX = -primary.wx - pd[0];
            atX = project.width / 2;
          }
          if (Math.abs(primary.wy + pd[1]) <= thr) {
            adjY = -primary.wy - pd[1];
            atY = project.height / 2;
          }
        } else {
          // a 2d clip snaps its center and its edges (of the kept, rotated bounds) to the canvas center and edges
          const sx = snapAxis(project.width / 2 + primary.wx + pd[0] + primary.ox, primary.hw, project.width, thr);
          const sy = snapAxis(project.height / 2 + primary.wy + pd[1] + primary.oy, primary.hh, project.height, thr);
          if (sx) {
            adjX = sx.adj;
            atX = sx.at;
          }
          if (sy) {
            adjY = sy.adj;
            atY = sy.at;
          }
        }
      }
      showGuides(atX, atY);
      g.items.forEach((it, i) => {
        const d = deltas[i]!;
        // the pointer moves the clip in the world: an attached clip turns that into its own x / y
        const l = localDelta(project, it.clip, time, d[0] + adjX, d[1] + adjY);
        store.setClipValue(it.id, 'x', time, Math.round((it.x + l.x) * 100) / 100, { skipHistory: true });
        store.setClipValue(it.id, 'y', time, Math.round((it.y + l.y) * 100) / 100, { skipHistory: true });
      });
      return;
    }

    if (g.kind === 'rotate') {
      // follow the pointer's angle step by step so the total is unwrapped (no jump at the atan2 branch cut)
      const a = (Math.atan2(py - g.cy, px - g.cx) * 180) / Math.PI;
      g.acc += unwrapStep(g.last, a);
      g.last = a;
    }
    if (!g.started) {
      // a plain click on a handle must not start a gesture (wipes redo, snaps the value)
      if (Math.hypot(snap.x - g.startX, snap.y - g.startY) < DRAG_THRESHOLD_PX) return;
      g.started = true;
      store.pushHistory();
    }
    if (g.kind === 'edge' && g.stretch) {
      // the stretch follows the pointer (new box side / side at the grab); x / y move so the opposite edge stays put
      const r = edgeStretch(g.start, g.edge, g.stretch.s0, px, py, MIN_SHAPE_PX);
      store.setClipValue(g.id, g.stretch.prop, time, r.value, { skipHistory: true });
      const rawClip = project.clips.find((c) => c.id === g.id);
      const l = rawClip && isVisualClip(rawClip) ? localDelta(project, rawClip, time, r.dx, r.dy) : { x: r.dx, y: r.dy };
      store.setClipValue(g.id, 'x', time, Math.round((g.x0 + l.x) * 100) / 100, { skipHistory: true });
      store.setClipValue(g.id, 'y', time, Math.round((g.y0 + l.y) * 100) / 100, { skipHistory: true });
      return;
    }
    if (g.kind === 'edge') {
      const r = edgeResize(g.start, g.edge, px, py, MIN_SHAPE_PX);
      // width / height go through setClipValue like x / y: a keyed size gets its key at the playhead
      if (r.width !== undefined) store.setClipValue(g.id, 'width', time, Math.round(r.width * 100) / 100, { skipHistory: true });
      if (r.height !== undefined) store.setClipValue(g.id, 'height', time, Math.round(r.height * 100) / 100, { skipHistory: true });
      // the opposite edge stays fixed in canvas space: the center follows
      const rawClip = project.clips.find((c) => c.id === g.id);
      const l = rawClip && isVisualClip(rawClip) ? localDelta(project, rawClip, time, r.dx, r.dy) : { x: r.dx, y: r.dy };
      store.setClipValue(g.id, 'x', time, Math.round((g.x0 + l.x) * 100) / 100, { skipHistory: true });
      store.setClipValue(g.id, 'y', time, Math.round((g.y0 + l.y) * 100) / 100, { skipHistory: true });
      return;
    }
    if (g.kind === 'scale') {
      const d = Math.hypot(px - g.cx, py - g.cy);
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (g.s0 * d) / g.d0));
      store.setClipValue(g.id, 'scale', time, Math.round(scale * 1000) / 1000, { skipHistory: true });
      return;
    }
    const r = rotateValue(g.r0, g.acc, snap.shift);
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
      // only a clip that is on screen now (it has a selection box) can be dragged by its handles
      if (raw && isVisualClip(raw) && track && !track.locked && !track.hidden && inRangeAt(raw, time)) {
        const clip = resolveClip(raw, time);
        // the box sits at the world pose; the values that get written stay the clip's own
        const world = worldClip(project, raw, time);
        const box = getClipBox(project, world);
        let cx = box.cx;
        let cy = box.cy;
        if (clip.threeD) {
          const c = projectPoint(rig, box.cx, box.cy, world.transform.z ?? 0, project.width, project.height);
          if (!c.visible) return;
          cx = c.x;
          cy = c.y;
        }
        if (handle.dataset.handle === 'edge') {
          const edge = handle.dataset.edge as Edge | undefined;
          const mode = edge ? edgeMode(clip) : null;
          if (!edge || !mode) return;
          const horizontal = edge === 'l' || edge === 'r';
          gestureRef.current = {
            kind: 'edge',
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            id: clip.id,
            edge,
            // (the box of a shape that is stretched as well is its size x scale x that stretch: the new size is the new
            // side divided by all of it)
            start: {
              cx: box.cx,
              cy: box.cy,
              rotation: box.rotation,
              bw: box.width,
              bh: box.height,
              scale: world.transform.scale * (mode === 'size' ? (horizontal ? stretchX(world.transform) : stretchY(world.transform)) : 1),
            },
            stretch: mode === 'stretch' ? { prop: horizontal ? 'scaleX' : 'scaleY', s0: horizontal ? stretchX(clip.transform) : stretchY(clip.transform) } : null,
            x0: clip.transform.x,
            y0: clip.transform.y,
            started: false,
          };
        } else if (handle.dataset.handle === 'scale') {
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
            last: (Math.atan2(py - cy, px - cx) * 180) / Math.PI,
            acc: 0,
            r0: clip.transform.rotation,
            started: false,
          };
        }
        root.setPointerCapture(e.pointerId);
        beginPreviewGesture();
      }
      return;
    }

    const hit = hitTest(project, time, rig, px, py, MIN_HIT_PX / f);
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
    // selected clips that are not on screen at the playhead stay out of the drag: moving them would write
    // a stray keyframe outside their range
    // (a clip whose parent is dragged too rides along with it and is not written)
    for (const raw of withoutRidingChildren(project, movableClipsAt(project, sel, time))) {
      const clip = resolveClip(raw, time);
      const world = worldClip(project, raw, time);
      const z = world.transform.z ?? 0;
      const p0 = raw.threeD ? rayPlane(ray.origin, ray.dir, [0, 0, z], [0, 0, 1]) : null;
      let hw = 0;
      let hh = 0;
      let ox = 0;
      let oy = 0;
      if (!raw.threeD) {
        const full = getClipBox(project, world);
        const kept = keptBox(full, world.crop);
        const b = boxBounds(kept);
        hw = b.hw;
        hh = b.hh;
        ox = kept.cx - full.cx;
        oy = kept.cy - full.cy;
      }
      items.push({ id: raw.id, x: clip.transform.x, y: clip.transform.y, wx: world.transform.x, wy: world.transform.y, clip: raw, threeD: !!raw.threeD, hw, hh, ox, oy, p0, z });
    }
    if (items.length === 0) return;
    gestureRef.current = { kind: 'move', pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, started: false, primary: hit.id, items, rig };
    root.setPointerCapture(e.pointerId);
    beginPreviewGesture();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    pendingRef.current = { x: e.clientX, y: e.clientY, shift: e.shiftKey, alt: e.altKey };
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
    if (e.type === 'pointerup') pendingRef.current = { x: e.clientX, y: e.clientY, shift: e.shiftKey, alt: e.altKey };
    flush();
    gestureRef.current = null;
    endPreviewGesture();
    showGuides(null, null);
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
  // swallow keyboard shortcuts while a drag runs (undo in the middle of a drag corrupts the history)
  useEffect(() => installGestureGuard(), []);
  return mode === 'scene' ? <SceneOverlay /> : <OutputOverlay />;
}
