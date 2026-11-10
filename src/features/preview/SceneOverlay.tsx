/**
 * overlay of the scene view: orbit / pan / dolly navigation of the free editor camera, click to select a
 * 3d plane, a move gizmo (x, y, z axes) for the selected 3d clip or camera clip.
 *
 * like the output overlay nothing renders per frame in react: the svg is rewritten imperatively from store
 * subscriptions, and pointer moves are coalesced to one update per animation frame.
 */
import { useLayoutEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from 'react';
import { getClipBox, visibleClipsAt } from '../../engine/draw';
import { type CameraRig, cameraClipAt, cameraRig, homeDistance, projectPoint, screenRay } from '../../engine/scene3d/camera';
import { type Vec3, add, dot, scale as vscale } from '../../engine/scene3d/math';
import { resolveClip } from '../../lib/anim';
import { clipEnd } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import type { Project } from '../../types';
import { isVisualClip } from '../../types';
import { type Quad, clipQuad, closestOnAxis, rayQuad, segDist } from './overlayMath';
import { type Orbit, currentOrbit, toCamera3D, useSceneCamera } from './sceneCamera';

const GIZMO_PX = 84;
const AXIS_HIT_PX = 8;
const CAMERA_HIT_PX = 12;
const DRAG_THRESHOLD_PX = 3;
const ORBIT_DEG_PER_PX = 0.3;
const AXES: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const AXIS_NAMES = ['x', 'y', 'z'] as const;
const SVG_NS = 'http://www.w3.org/2000/svg';

interface Target {
  id: string;
  center: Vec3;
  /** current x y z (clip.transform or camera values) */
  v: [number, number, number];
}

interface GizmoState {
  visible: boolean;
  /** css px relative to the overlay */
  cx: number;
  cy: number;
  tips: Array<{ x: number; y: number; ok: boolean }>;
  target: Target | null;
}

type SceneGesture =
  | { kind: 'orbit'; pointerId: number; startX: number; startY: number; o0: Orbit; moved: boolean; click: boolean }
  | { kind: 'pan'; pointerId: number; startX: number; startY: number; o0: Orbit; moved: boolean; click: boolean }
  | {
      kind: 'axis';
      pointerId: number;
      startX: number;
      startY: number;
      started: boolean;
      axis: number;
      id: string;
      t0: number;
      c0: Vec3;
      v0: number;
      rig: CameraRig;
    };

interface PointerSnapshot {
  x: number;
  y: number;
}

function viewRig(project: Project): CameraRig {
  return cameraRig(toCamera3D(currentOrbit(project), project), project.width, project.height);
}

/** the selected clip the gizmo moves: the first selected 3d clip or camera clip that is active now */
function gizmoTarget(project: Project, selection: string[], time: number): Target | null {
  for (const id of selection) {
    const clip = project.clips.find((c) => c.id === id);
    if (!clip || time < clip.start - 1e-6 || time >= clipEnd(clip) - 1e-6) continue;
    if (clip.type === 'camera') {
      const r = resolveClip(clip, time);
      return {
        id,
        center: [project.width / 2 + r.x, project.height / 2 + r.y, -homeDistance(project.height) + r.z],
        v: [r.x, r.y, r.z],
      };
    }
    if (isVisualClip(clip) && clip.threeD) {
      const r = resolveClip(clip, time);
      const box = getClipBox(project, r);
      const z = r.transform.z ?? 0;
      return { id, center: [box.cx, box.cy, z], v: [r.transform.x, r.transform.y, z] };
    }
  }
  return null;
}

/** what is under a canvas point in the scene view: the project camera (its eye) or the nearest 3d plane */
function sceneHit(project: Project, time: number, rig: CameraRig, px: number, py: number, f: number): string | null {
  const camClip = cameraClipAt(project, time);
  if (camClip) {
    const r = resolveClip(camClip, time);
    const e = projectPoint(rig, project.width / 2 + r.x, project.height / 2 + r.y, -homeDistance(project.height) + r.z, project.width, project.height);
    if (e.visible && Math.hypot(e.x - px, e.y - py) * f <= CAMERA_HIT_PX) return camClip.id;
  }
  const ray = screenRay(rig, px, py, project.width, project.height);
  let best: string | null = null;
  let bestT = Infinity;
  for (const clip of visibleClipsAt(project, time)) {
    if (!clip.threeD) continue;
    const track = project.tracks.find((t) => t.id === clip.trackId);
    if (!track || track.locked) continue;
    const q = clipQuad(project, clip, time, rig);
    const t = rayQuad(ray.origin, ray.dir, q.world);
    if (t !== null && t < bestT) {
      best = clip.id;
      bestT = t;
    }
  }
  return best;
}

export function SceneOverlay() {
  const rootRef = useRef<HTMLDivElement>(null);
  const polyGroup = useRef<SVGGElement>(null);
  const axisLine = useRef<Array<SVGLineElement | null>>([null, null, null]);
  const axisUnder = useRef<Array<SVGLineElement | null>>([null, null, null]);
  const axisTip = useRef<Array<SVGRectElement | null>>([null, null, null]);
  const axisText = useRef<Array<SVGTextElement | null>>([null, null, null]);
  const axisGroup = useRef<Array<SVGGElement | null>>([null, null, null]);
  const centerDot = useRef<SVGCircleElement>(null);
  const viewF = useRef(0);
  const redrawRef = useRef<() => void>(() => undefined);
  const gizmo = useRef<GizmoState>({ visible: false, cx: 0, cy: 0, tips: [0, 1, 2].map(() => ({ x: 0, y: 0, ok: false })), target: null });
  const hoverAxis = useRef(-1);
  const gestureRef = useRef<SceneGesture | null>(null);
  const pendingRef = useRef<PointerSnapshot | null>(null);
  const rafRef = useRef(0);
  const originRef = useRef({ left: 0, top: 0 });

  /* ---------- imperative drawing ---------- */
  useLayoutEffect(() => {
    const root = rootRef.current;
    const group = polyGroup.current;
    if (!root || !group) return;
    const unders: SVGPolygonElement[] = [];
    const lines: SVGPolygonElement[] = [];
    const scratch: Quad = { p: [0, 0, 0, 0, 0, 0, 0, 0], visible: true, depth: 0, world: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], cx: 0, cy: 0 };

    const poly = (i: number) => {
      while (unders.length <= i) {
        const u = document.createElementNS(SVG_NS, 'polygon');
        u.setAttribute('class', 'scene-poly-under');
        const l = document.createElementNS(SVG_NS, 'polygon');
        l.setAttribute('class', 'scene-poly');
        group.appendChild(u);
        group.appendChild(l);
        unders.push(u);
        lines.push(l);
      }
      return i;
    };

    const redraw = () => {
      const project = useEditor.getState().project;
      const f = viewF.current;
      const gz = gizmo.current;
      let used = 0;
      gz.visible = false;
      gz.target = null;
      if (project && f > 0) {
        const time = usePlayback.getState().time;
        const selection = useEditor.getState().selection;
        const rig = viewRig(project);
        // outlines of the selected 3d planes
        for (const id of selection) {
          const clip = project.clips.find((c) => c.id === id);
          if (!clip || !isVisualClip(clip) || !clip.threeD) continue;
          if (time < clip.start - 1e-6 || time >= clipEnd(clip) - 1e-6) continue;
          const q = clipQuad(project, clip, time, rig, scratch);
          if (!q.visible) continue;
          const i = poly(used++);
          const pts = `${q.p[0] * f},${q.p[1] * f} ${q.p[2] * f},${q.p[3] * f} ${q.p[4] * f},${q.p[5] * f} ${q.p[6] * f},${q.p[7] * f}`;
          unders[i]!.setAttribute('points', pts);
          lines[i]!.setAttribute('points', pts);
        }
        // the move gizmo
        const target = gizmoTarget(project, selection, time);
        if (target) {
          const c = projectPoint(rig, target.center[0], target.center[1], target.center[2], project.width, project.height);
          if (c.visible) {
            const focal = project.height / 2 / rig.tanHalf;
            const len = ((GIZMO_PX / f) * c.depth) / focal;
            gz.visible = true;
            gz.target = target;
            gz.cx = c.x * f;
            gz.cy = c.y * f;
            for (let a = 0; a < 3; a++) {
              const ax = AXES[a]!;
              const t = projectPoint(
                rig,
                target.center[0] + ax[0] * len,
                target.center[1] + ax[1] * len,
                target.center[2] + ax[2] * len,
                project.width,
                project.height,
              );
              const tip = gz.tips[a]!;
              tip.ok = t.visible;
              tip.x = t.x * f;
              tip.y = t.y * f;
            }
          }
        }
      }
      for (let i = 0; i < unders.length; i++) {
        const show = i < used ? '' : 'none';
        unders[i]!.style.display = show;
        lines[i]!.style.display = show;
      }
      for (let a = 0; a < 3; a++) {
        const g = axisGroup.current[a];
        if (!g) continue;
        const tip = gz.tips[a]!;
        if (!gz.visible || !tip.ok) {
          g.style.display = 'none';
          continue;
        }
        g.style.display = '';
        const x1 = String(gz.cx);
        const y1 = String(gz.cy);
        const x2 = String(tip.x);
        const y2 = String(tip.y);
        for (const ln of [axisLine.current[a], axisUnder.current[a]]) {
          if (!ln) continue;
          ln.setAttribute('x1', x1);
          ln.setAttribute('y1', y1);
          ln.setAttribute('x2', x2);
          ln.setAttribute('y2', y2);
        }
        axisTip.current[a]?.setAttribute('x', String(tip.x - 4));
        axisTip.current[a]?.setAttribute('y', String(tip.y - 4));
        const text = axisText.current[a];
        if (text) {
          // the label sits a little past the tip, along the axis
          const dx = tip.x - gz.cx;
          const dy = tip.y - gz.cy;
          const l = Math.hypot(dx, dy) || 1;
          text.setAttribute('x', String(tip.x + (dx / l) * 12));
          text.setAttribute('y', String(tip.y + (dy / l) * 12 + 4));
        }
        const active = hoverAxis.current === a || (gestureRef.current?.kind === 'axis' && gestureRef.current.axis === a);
        g.classList.toggle('is-active', active);
      }
      const dot = centerDot.current;
      if (dot) {
        dot.style.display = gz.visible ? '' : 'none';
        dot.setAttribute('cx', String(gz.cx));
        dot.setAttribute('cy', String(gz.cy));
      }
    };
    redrawRef.current = redraw;

    let lastW = 0;
    const measure = (w: number) => {
      lastW = w;
      const project = useEditor.getState().project;
      viewF.current = project && project.width > 0 ? w / project.width : 0;
      redraw();
    };
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) measure(e.contentRect.width);
    });
    ro.observe(root);

    const unEditor = useEditor.subscribe((s, p) => {
      if (s.project && p.project && s.project.width !== p.project.width && lastW > 0) measure(lastW);
      else if (s.project !== p.project || s.selection !== p.selection) redraw();
    });
    const unTime = usePlayback.subscribe((s, p) => {
      if (s.time !== p.time && useEditor.getState().selection.length > 0) redraw();
    });
    const unCam = useSceneCamera.subscribe(redraw);
    redraw();
    return () => {
      ro.disconnect();
      unEditor();
      unTime();
      unCam();
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  /* ---------- gestures ---------- */

  const nearestAxis = (x: number, y: number): number => {
    const gz = gizmo.current;
    if (!gz.visible) return -1;
    let best = -1;
    let bestD = AXIS_HIT_PX;
    for (let a = 0; a < 3; a++) {
      const tip = gz.tips[a]!;
      if (!tip.ok) continue;
      const d = segDist(x, y, gz.cx, gz.cy, tip.x, tip.y);
      if (d <= bestD) {
        best = a;
        bestD = d;
      }
    }
    return best;
  };

  const apply = (snap: PointerSnapshot) => {
    const g = gestureRef.current;
    const store = useEditor.getState();
    const project = store.project;
    const f = viewF.current;
    if (!g || !project || f <= 0) return;
    const dx = snap.x - g.startX;
    const dy = snap.y - g.startY;
    if (g.kind === 'orbit') {
      if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      g.moved = true;
      useSceneCamera.getState().set({ ...g.o0, yaw: g.o0.yaw + dx * ORBIT_DEG_PER_PX, pitch: g.o0.pitch - dy * ORBIT_DEG_PER_PX });
      return;
    }
    if (g.kind === 'pan') {
      if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      g.moved = true;
      const rig = cameraRig(toCamera3D(g.o0, project), project.width, project.height);
      // world units per css px at the distance of the target
      const k = (2 * rig.tanHalf * g.o0.distance) / (project.height * f);
      useSceneCamera.getState().set({
        ...g.o0,
        targetX: g.o0.targetX - (rig.right[0] * dx + rig.down[0] * dy) * k,
        targetY: g.o0.targetY - (rig.right[1] * dx + rig.down[1] * dy) * k,
        targetZ: g.o0.targetZ - (rig.right[2] * dx + rig.down[2] * dy) * k,
      });
      return;
    }
    // axis drag
    if (!g.started) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      g.started = true;
      store.pushHistory();
    }
    const origin = originRef.current;
    const px = (snap.x - origin.left) / f;
    const py = (snap.y - origin.top) / f;
    const ray = screenRay(g.rig, px, py, project.width, project.height);
    const t1 = closestOnAxis(ray.origin, ray.dir, g.c0, AXES[g.axis]!);
    if (t1 === null) return;
    const time = usePlayback.getState().time;
    store.setClipValue(g.id, AXIS_NAMES[g.axis]!, time, Math.round((g.v0 + (t1 - g.t0)) * 100) / 100, { skipHistory: true });
  };

  const queue = (e: ReactPointerEvent<HTMLDivElement>) => {
    pendingRef.current = { x: e.clientX, y: e.clientY };
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const snap = pendingRef.current;
        pendingRef.current = null;
        if (snap) apply(snap);
      });
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const project = useEditor.getState().project;
    if (!root || !project || gestureRef.current) return;
    e.preventDefault();
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0) return;
    originRef.current = { left: rect.left, top: rect.top };
    viewF.current = rect.width / project.width;
    const o0 = currentOrbit(project);
    const base = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };

    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) {
      gestureRef.current = { kind: 'pan', ...base, o0, moved: false, click: false };
      root.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    if (e.altKey) {
      gestureRef.current = { kind: 'orbit', ...base, o0, moved: false, click: false };
      root.setPointerCapture(e.pointerId);
      return;
    }

    const lx = e.clientX - rect.left;
    const ly = e.clientY - rect.top;
    const axis = nearestAxis(lx, ly);
    const target = gizmo.current.target;
    if (axis >= 0 && target) {
      const rig = viewRig(project);
      const f = viewF.current;
      const ray = screenRay(rig, lx / f, ly / f, project.width, project.height);
      const t0 = closestOnAxis(ray.origin, ray.dir, target.center, AXES[axis]!);
      if (t0 !== null) {
        gestureRef.current = { kind: 'axis', ...base, started: false, axis, id: target.id, t0, c0: target.center, v0: target.v[axis]!, rig };
        root.setPointerCapture(e.pointerId);
        redrawRef.current();
        return;
      }
    }
    gestureRef.current = { kind: 'orbit', ...base, o0, moved: false, click: true };
    root.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g) {
      // hover highlight of the gizmo axes. the overlay origin is cached from the last gesture / hover
      const root = rootRef.current;
      if (!root || !gizmo.current.visible) return;
      if (e.movementX === 0 && e.movementY === 0) return;
      const a = nearestAxis(e.clientX - originRef.current.left, e.clientY - originRef.current.top);
      if (a !== hoverAxis.current) {
        hoverAxis.current = a;
        root.style.cursor = a >= 0 ? 'pointer' : '';
        redrawRef.current();
      }
      return;
    }
    if (g.pointerId !== e.pointerId) return;
    queue(e);
  };

  // measured once when the pointer arrives (not per move)
  const onPointerEnter = () => {
    const root = rootRef.current;
    if (!root) return;
    const r = root.getBoundingClientRect();
    originRef.current = { left: r.left, top: r.top };
  };

  const onPointerLeave = () => {
    if (hoverAxis.current >= 0 && !gestureRef.current) {
      hoverAxis.current = -1;
      if (rootRef.current) rootRef.current.style.cursor = '';
      redrawRef.current();
    }
  };

  const endGesture = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    if (e.type === 'pointerup') apply({ x: e.clientX, y: e.clientY });
    pendingRef.current = null;
    gestureRef.current = null;
    const root = rootRef.current;
    if (root && root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    // a click (no drag) selects the plane under the pointer, or clears the selection on empty space
    if (g.kind === 'orbit' && g.click && !g.moved && e.type === 'pointerup' && root) {
      const store = useEditor.getState();
      const project = store.project;
      const f = viewF.current;
      if (project && f > 0) {
        const o = originRef.current;
        const id = sceneHit(project, usePlayback.getState().time, viewRig(project), (e.clientX - o.left) / f, (e.clientY - o.top) / f, f);
        if (id) store.select([id], 'replace');
        else store.clearSelection();
      }
    }
    redrawRef.current();
  };

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const project = useEditor.getState().project;
    if (!root || !project) return;
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0) return;
    const f = rect.width / project.width;
    const o = currentOrbit(project);
    const d0 = homeDistance(project.height);
    const factor = Math.exp(Math.max(-200, Math.min(200, e.deltaY)) * 0.0015);
    const distance = Math.min(d0 * 60, Math.max(20, o.distance * factor));
    const k = distance / o.distance;
    // keep the point under the pointer where it is: it lies on the plane through the target facing the camera
    const rig = cameraRig(toCamera3D(o, project), project.width, project.height);
    const ray = screenRay(rig, (e.clientX - rect.left) / f, (e.clientY - rect.top) / f, project.width, project.height);
    const along = dot(ray.dir, rig.forward);
    const p: Vec3 = along > 1e-6 ? add(ray.origin, vscale(ray.dir, o.distance / along)) : [o.targetX, o.targetY, o.targetZ];
    useSceneCamera.getState().set({
      ...o,
      targetX: o.targetX + (p[0] - o.targetX) * (1 - k),
      targetY: o.targetY + (p[1] - o.targetY) * (1 - k),
      targetZ: o.targetZ + (p[2] - o.targetZ) * (1 - k),
      distance,
    });
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const project = useEditor.getState().project;
    if (!root || !project || e.altKey || e.shiftKey) return;
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0) return;
    const f = rect.width / project.width;
    const time = usePlayback.getState().time;
    const rig = viewRig(project);
    const id = sceneHit(project, time, rig, (e.clientX - rect.left) / f, (e.clientY - rect.top) / f, f);
    if (!id) return;
    const clip = project.clips.find((c) => c.id === id);
    if (!clip) return;
    let center: Vec3;
    let radius: number;
    if (clip.type === 'camera') {
      const r = resolveClip(clip, time);
      center = [project.width / 2 + r.x, project.height / 2 + r.y, -homeDistance(project.height) + r.z];
      radius = project.height * 0.5;
    } else if (isVisualClip(clip)) {
      const q = clipQuad(project, clip, time, rig);
      const w = q.world;
      center = [(w[0][0] + w[2][0]) / 2, (w[0][1] + w[2][1]) / 2, (w[0][2] + w[2][2]) / 2];
      radius = Math.max(20, Math.hypot(w[0][0] - w[2][0], w[0][1] - w[2][1], w[0][2] - w[2][2]) / 2);
    } else return;
    const o = currentOrbit(project);
    const distance = Math.max(20, (radius * 1.25) / (rig.tanHalf * Math.min(1, rig.aspect)));
    useEditor.getState().select([id], 'replace');
    useSceneCamera.getState().set({ ...o, targetX: center[0], targetY: center[1], targetZ: center[2], distance });
  };

  return (
    <div
      ref={rootRef}
      className="preview-overlay scene-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg className="scene-svg" aria-hidden="true">
        <g ref={polyGroup} />
        {AXIS_NAMES.map((name, a) => (
          <g
            key={name}
            className="scene-axis"
            ref={(n) => {
              axisGroup.current[a] = n;
            }}
          >
            <line
              className="scene-axis-under"
              ref={(n) => {
                axisUnder.current[a] = n;
              }}
            />
            <line
              className="scene-axis-line"
              ref={(n) => {
                axisLine.current[a] = n;
              }}
            />
            <rect
              className="scene-axis-tip"
              width="8"
              height="8"
              ref={(n) => {
                axisTip.current[a] = n;
              }}
            />
            <text
              className="scene-axis-label"
              textAnchor="middle"
              ref={(n) => {
                axisText.current[a] = n;
              }}
            >
              {name}
            </text>
          </g>
        ))}
        <circle ref={centerDot} className="scene-center" r="3" />
      </svg>
      <div className="preview-scene-hint">drag: orbit   shift drag: pan   wheel: zoom</div>
    </div>
  );
}
